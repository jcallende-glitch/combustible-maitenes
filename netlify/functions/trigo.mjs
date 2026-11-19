// Netlify Function (v2): /api/trigo — precios futuros del trigo HRW (Kansas City, bolsa CME), para estimar
// cuánto valdrá el trigo internacional en los meses de cosecha. La usa el Flujo de caja (fórmula Carozzi, trigo candeal):
// el indicador de ODEPA (ICI HRW 11%) sigue al trigo HRW, así que la diferencia entre el contrato futuro del mes de
// entrega y el más cercano es lo que el mercado espera que cambie el precio.
//
// Fuente: cotizaciones de la bolsa CME (con ~10 minutos de retraso) leídas desde Yahoo Finance. No necesita clave.
// Contratos del trigo HRW: marzo (H), mayo (K), julio (N), septiembre (U) y diciembre (Z).

const LETRA = { 3: 'H', 5: 'K', 7: 'N', 9: 'U', 12: 'Z' };
let cache = null, cacheTs = 0;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

async function cotizacion(simbolo) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?range=5d&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0 (ControlLosMaitenes)', Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${simbolo}: respuesta ${r.status}`);
  const j = await r.json(), m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!m || !(m.regularMarketPrice > 0)) throw new Error(`${simbolo}: sin precio`);
  return { simbolo, centavosBushel: m.regularMarketPrice, usTon: Math.round(m.regularMarketPrice / 100 * 36.7437 * 100) / 100, fecha: new Date((m.regularMarketTime || 0) * 1000).toISOString().slice(0, 10) };
}

export const config = { path: '/api/trigo' };

export default async function handler() {
  if (cache && Date.now() - cacheTs < 3 * 3600000) return json(cache);
  try {
    // Contratos de los próximos 18 meses
    const hoy = new Date(), lista = [];
    for (let i = 0; i < 18; i++) {
      const d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1), m = d.getMonth() + 1;
      if (LETRA[m]) lista.push({ mes: `${d.getFullYear()}-${String(m).padStart(2, '0')}`, simbolo: `KE${LETRA[m]}${String(d.getFullYear()).slice(2)}.CBT` });
    }
    const frente = await cotizacion('KE=F');
    const contratos = [];
    for (const c of lista) { try { contratos.push({ mes: c.mes, ...(await cotizacion(c.simbolo)) }); } catch (e) { /* contrato sin cotización: se omite */ } }
    const resp = { ok: true, frente, contratos, fuente: 'Trigo HRW Kansas City (CME), vía Yahoo Finance', ts: Date.now() };
    cache = resp; cacheTs = Date.now();
    return json(resp);
  } catch (e) {
    return json({ ok: false, error: e.message }, 502);
  }
}
