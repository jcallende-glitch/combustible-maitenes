// netlify/functions/shelly-status.js
//
// Proxy server-side para consultar el estado real (online/offline) del Shelly
// que controla la bomba "Petróleo", vía Shelly Cloud — mismo motivo que
// shelly-control.js: evitar CORS desde el navegador y no exponer la Auth Key.
// Usa las mismas constantes/variable de entorno que shelly-control.js.

const SHELLY_SERVER = 'https://shelly-275-eu.shelly.cloud';
const SHELLY_DEVICE_ID = 'd885acf0b964';
const SHELLY_AUTH_KEY_FALLBACK = 'NDVmMTk3dWlk0167718175DB38F81DA5C7CA339041319E247739E9DF934C52B5F8F05EE32F9503C876005A3CACE9';

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido' }) };
  }
  const authKey = process.env.SHELLY_AUTH_KEY || SHELLY_AUTH_KEY_FALLBACK;
  try {
    const params = new URLSearchParams({
      id: SHELLY_DEVICE_ID,
      auth_key: authKey
    });
    const resp = await fetch(`${SHELLY_SERVER}/device/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* respuesta no era JSON */ }
    const online = !!(resp.ok && data && data.isok === true && data.data && data.data.online === true);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ online, raw: data || text })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ online: false, error: e.message })
    };
  }
};
