// Netlify Function (v2): /api/dolar — el dólar de hoy y el dólar esperado, directo del Banco Central de Chile
// (API de la Base de Datos Estadísticos, BDE). La usa el Flujo de caja de la app para actualizarse sola.
//
//   Dólar de hoy:     dólar observado (serie F073.TCO.PRE.Z.D).
//   Dólar esperado:   Encuesta de Expectativas Económicas (EEE), que el Banco Central publica cada mes
//                     (mediana de lo que esperan los economistas a 2, 11 y 23 meses, según lo que publique).
//   Tasa:             tasa de interés promedio de colocación nominal 90/180 días del sistema financiero (la que usa
//                     el contrato Carozzi para el costo financiero del trigo), % anual.
//
// Variables de entorno (Netlify → Site configuration → Environment variables; marcar la clave como secreta):
//   BCCH_USER   correo con que te registraste en https://si3.bcentral.cl/Siete (registro gratis)
//   BCCH_PASS   la clave de ese registro (después de registrarte hay que "Activar uso de API" en el mismo sitio)
//   Opcionales, solo si la búsqueda automática de series no acierta: BCCH_TC2, BCCH_TC11, BCCH_TC23, BCCH_TASA (código de serie).
// Seguridad: la clave nunca llega al navegador; la app solo recibe los valores.
// Diagnóstico: /api/dolar?debug=1 muestra qué series de la encuesta y de la tasa encontró (nombres y códigos, sin la clave).

const API = 'https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx';
const OBSERVADO = 'F073.TCO.PRE.Z.D';
const HORAS_CACHE = 6;
let cache = null, cacheTs = 0, seriesEee = null, serieTasa = null;
const listas = {};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const env = k => ((globalThis.Netlify && Netlify.env.get(k)) || (typeof process !== 'undefined' && process.env && process.env[k]) || '').trim();
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const iso = d => d.toISOString().slice(0, 10);

async function bde(params) {
  const r = await fetch(API + '?' + new URLSearchParams({ user: env('BCCH_USER'), pass: env('BCCH_PASS'), ...params }));
  if (!r.ok) throw new Error('El Banco Central respondió ' + r.status);
  const j = await r.json();
  if (Number(j.Codigo) !== 0) throw new Error('Banco Central: ' + (j.Descripcion || 'error ' + j.Codigo));
  return j;
}
// Última observación con valor de una serie: { valor, fecha (aaaa-mm-dd) }
async function ultimo(serie, desdeDias) {
  const hasta = new Date(), desde = new Date(Date.now() - desdeDias * 86400000);
  const j = await bde({ function: 'GetSeries', timeseries: serie, firstdate: iso(desde), lastdate: iso(hasta) });
  const obs = ((j.Series && j.Series.Obs) || []).filter(o => o.statusCode === 'OK' && isFinite(parseFloat(o.value)));
  if (!obs.length) return null;
  const o = obs[obs.length - 1], [d, m, y] = String(o.indexDateString).split('-');
  return { valor: Math.round(parseFloat(o.value) * 100) / 100, fecha: `${y}-${m}-${d}`, titulo: (j.Series && j.Series.descripEsp) || '' };
}
// Busca entre las series mensuales las del dólar esperado en la Encuesta de Expectativas Económicas, por horizonte (meses)
// Lista de series del Banco Central por frecuencia (se pide una vez por instancia)
async function lista(frecuencia) {
  if (!listas[frecuencia]) listas[frecuencia] = bde({ function: 'SearchSeries', frequency: frecuencia })
    .then(j => (j.SeriesInfos || []).map(s => ({ id: s.seriesId, titulo: s.spanishTitle || '', en: s.englishTitle || '', ultima: s.lastObservation || '', frecuencia })))
    .catch(e => { delete listas[frecuencia]; throw e; });
  return listas[frecuencia];
}
async function buscarSeriesEee() {
  if (seriesEee) return seriesEee;
  const todas = await lista('MONTHLY');
  const cand = todas.filter(s => {
    const t = norm(s.titulo + ' ' + s.en);
    return /tipo de cambio|exchange rate/.test(t) && /expectativa|eee|encuesta|survey/.test(t) && !/operadores|eof|financial traders/.test(t) && /\d+\s*(mes|month)/.test(t) && !/percentil|percentile|desviacion|variacion|% /.test(t);
  });
  const porHorizonte = {};
  cand.forEach(s => {
    const h = Number((norm(s.titulo + ' ' + s.en).match(/(\d+)\s*(mes|month)/) || [])[1]);
    if (![2, 11, 23].includes(h)) return;
    const puntaje = (/mediana|median/.test(norm(s.titulo + ' ' + s.en)) ? 2 : 0) + (/expectativas economicas|economic expectations/.test(norm(s.titulo + ' ' + s.en)) ? 1 : 0);
    if (!porHorizonte[h] || puntaje > porHorizonte[h].puntaje) porHorizonte[h] = { ...s, puntaje };
  });
  seriesEee = { porHorizonte, candidatas: cand.slice(0, 40) };
  return seriesEee;
}

// Tasa promedio de colocación nominal 90/180 días del sistema financiero: busca la serie por su nombre (diaria o mensual)
const fechaObs = t => { const m = String(t || '').match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/); return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null; };
async function buscarSerieTasa() {
  if (serieTasa) return serieTasa;
  const todas = [];
  for (const f of ['DAILY', 'MONTHLY']) { try { todas.push(...await lista(f)); } catch (e) { /* sigue con la otra */ } }
  const cand = todas.map(s => {
    const t = norm(s.titulo + ' ' + s.en);
    if (!/colocacion|lending|loan/.test(t) || !/nominal|no reajustable|non-indexed|non indexed|pesos|peso/.test(t) || !/(^|\D)90(\D|$)/.test(t)) return null;
    if (/captacion|deposit|\buf\b|reajustable en|indexed to|dolar|us\$|moneda extranjera|foreign|interbancari|interbank/.test(t)) return null;
    const u = fechaObs(s.ultima), reciente = u && Date.now() - u.getTime() < 75 * 86400000;
    const puntaje = (/180/.test(t) ? 5 : 0) + (/365|1 ano|un ano|1 year|one year/.test(t) ? 4 : 0) + (/promedio|average|\btip\b/.test(t) ? 2 : 0) + (/sistema financiero|financial system/.test(t) ? 2 : 0)
      + (s.frecuencia === 'DAILY' ? 1 : 0) + (reciente ? 3 : -4) - (/consumo|consumer|vivienda|mortgage|comercial|commercial|empresa|persona/.test(t) ? 3 : 0) - (/30 a 89|30-89|30 to 89/.test(t) ? 5 : 0);
    return { ...s, puntaje };
  }).filter(Boolean).sort((a, b) => b.puntaje - a.puntaje);
  serieTasa = { mejor: cand[0] || null, candidatas: cand.slice(0, 20) };
  return serieTasa;
}
// Si la búsqueda por nombre no encuentra la serie, se prueban los códigos probables de la TIP de colocaciones 90 días a 1 año en pesos
const TASA_PROBABLES = ['F022.COL.TIP.AN01.NO.Z.D', 'F022.COL.TIP.D90.NO.Z.D', 'F022.COL.TIP.D90A1A.NO.Z.D'];
async function tasaColocacion() {
  const fijo = env('BCCH_TASA'), s = fijo ? null : await buscarSerieTasa();
  let id = fijo || (s.mejor && s.mejor.id), u = id ? await ultimo(id, 120).catch(() => null) : null;
  if (!u && !fijo) for (const c of TASA_PROBABLES) { u = await ultimo(c, 30).catch(() => null); if (u) { id = c; break; } }
  if (!u) return null;
  // El contrato la pide anual (base 360). Si la serie viene en % mensual (valores bajo 2), se pasa a anual.
  const mensual = u.valor < 2;
  return { valor: Math.round((mensual ? u.valor * 12 : u.valor) * 100) / 100, fecha: u.fecha, titulo: u.titulo || (s && s.mejor && s.mejor.titulo) || id, id, ...(mensual ? { mensualx12: true } : {}) };
}

export const config = { path: '/api/dolar' };

export default async function handler(request) {
  if (!env('BCCH_USER') || !env('BCCH_PASS')) return json({ ok: false, codigo: 'SIN_CLAVE', error: 'Falta configurar BCCH_USER y BCCH_PASS en Netlify (registro gratis en si3.bcentral.cl)' });
  const debug = new URL(request.url).searchParams.get('debug') === '1';
  if (!debug && cache && Date.now() - cacheTs < HORAS_CACHE * 3600000) return json(cache);
  try {
    const [hoy, tasa] = await Promise.all([ultimo(OBSERVADO, 15), tasaColocacion().catch(e => ({ error: e.message }))]);
    const s = await buscarSeriesEee(), eee = {}, titulos = {};
    let mes = '';
    for (const h of [2, 11, 23]) {
      const id = env('BCCH_TC' + h) || (s.porHorizonte[h] && s.porHorizonte[h].id);
      if (!id) continue;
      try {
        const u = await ultimo(id, 120);
        if (u) { eee['m' + h] = Math.round(u.valor); titulos['m' + h] = u.titulo || (s.porHorizonte[h] || {}).titulo || id; if (u.fecha.slice(0, 7) > mes) mes = u.fecha.slice(0, 7); }
      } catch (e) { titulos['m' + h] = 'error: ' + e.message; }
    }
    const resp = { ok: true, hoy: hoy ? { valor: hoy.valor, fecha: hoy.fecha } : null, eee: eee.m11 ? { ...eee, mes, titulos } : null, tasa: tasa && tasa.valor ? tasa : null, fuente: 'Banco Central de Chile (Base de Datos Estadísticos)', ts: Date.now() };
    if (debug) {
      resp.candidatas = s.candidatas.map(c => `${c.id} · ${c.titulo} · última ${c.ultima}`);
      if (tasa && tasa.error) resp.tasaError = tasa.error;
      try { resp.candidatasTasa = (await buscarSerieTasa()).candidatas.map(c => `${c.puntaje} · ${c.id} · ${c.frecuencia} · ${c.titulo} · última ${c.ultima}`); } catch (e) { resp.candidatasTasa = ['error: ' + e.message]; }
    }
    if (!debug) { cache = resp; cacheTs = Date.now(); }
    return json(resp);
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}
