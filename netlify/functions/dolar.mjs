// Netlify Function (v2): /api/dolar — el dólar de hoy y el dólar esperado, directo del Banco Central de Chile
// (API de la Base de Datos Estadísticos, BDE). La usa el Flujo de caja de la app para actualizarse sola.
//
//   Dólar de hoy:     dólar observado (serie F073.TCO.PRE.Z.D).
//   Dólar esperado:   Encuesta de Expectativas Económicas (EEE), que el Banco Central publica cada mes
//                     (mediana de lo que esperan los economistas a 2, 11 y 23 meses, según lo que publique).
//
// Variables de entorno (Netlify → Site configuration → Environment variables; marcar la clave como secreta):
//   BCCH_USER   correo con que te registraste en https://si3.bcentral.cl/Siete (registro gratis)
//   BCCH_PASS   la clave de ese registro (después de registrarte hay que "Activar uso de API" en el mismo sitio)
//   Opcionales, solo si la búsqueda automática de series no acierta: BCCH_TC2, BCCH_TC11, BCCH_TC23 (código de serie).
// Seguridad: la clave nunca llega al navegador; la app solo recibe los valores.
// Diagnóstico: /api/dolar?debug=1 muestra qué series de la encuesta encontró (nombres y códigos, sin la clave).

const API = 'https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx';
const OBSERVADO = 'F073.TCO.PRE.Z.D';
const HORAS_CACHE = 6;
let cache = null, cacheTs = 0, seriesEee = null;

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
async function buscarSeriesEee() {
  if (seriesEee) return seriesEee;
  const j = await bde({ function: 'SearchSeries', frequency: 'MONTHLY' });
  const todas = (j.SeriesInfos || []).map(s => ({ id: s.seriesId, titulo: s.spanishTitle || '', en: s.englishTitle || '', ultima: s.lastObservation || '' }));
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

export const config = { path: '/api/dolar' };

export default async function handler(request) {
  if (!env('BCCH_USER') || !env('BCCH_PASS')) return json({ ok: false, codigo: 'SIN_CLAVE', error: 'Falta configurar BCCH_USER y BCCH_PASS en Netlify (registro gratis en si3.bcentral.cl)' });
  const debug = new URL(request.url).searchParams.get('debug') === '1';
  if (!debug && cache && Date.now() - cacheTs < HORAS_CACHE * 3600000) return json(cache);
  try {
    const hoy = await ultimo(OBSERVADO, 15);
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
    const resp = { ok: true, hoy: hoy ? { valor: hoy.valor, fecha: hoy.fecha } : null, eee: eee.m11 ? { ...eee, mes, titulos } : null, fuente: 'Banco Central de Chile (Base de Datos Estadísticos)', ts: Date.now() };
    if (debug) resp.candidatas = s.candidatas.map(c => `${c.id} · ${c.titulo} · última ${c.ultima}`);
    if (!debug) { cache = resp; cacheTs = Date.now(); }
    return json(resp);
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}
