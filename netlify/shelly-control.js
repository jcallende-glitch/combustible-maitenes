// netlify/functions/shelly-control.js
//
// Proxy server-side para controlar la bomba "Petróleo" vía Shelly Cloud.
// La app (index.html) le pega a ESTA función en vez de llamar directo a
// Shelly Cloud desde el navegador — así se evita el problema de CORS
// (Shelly Cloud no está pensado para llamarse desde un browser) y además
// la Auth Key queda oculta del lado del servidor, no visible en el código fuente.
//
// Variable de entorno requerida en Netlify (Site settings → Environment variables):
//   SHELLY_AUTH_KEY = NDVmMTk3dWlk0167718175DB38F81DA5C7CA339041319E247739E9DF934C52B5F8F05EE32F9503C876005A3CACE9
//
// (Si no se configura la variable de entorno, se usa el valor por defecto de abajo
// como respaldo, para que funcione igual sin pasos extra — pero lo ideal es
// moverla a una variable de entorno en Netlify por seguridad.)

const SHELLY_SERVER = 'https://shelly-275-eu.shelly.cloud';
const SHELLY_DEVICE_ID = 'd885acf0b964';
const SHELLY_AUTH_KEY_FALLBACK = 'NDVmMTk3dWlk0167718175DB38F81DA5C7CA339041319E247739E9DF934C52B5F8F05EE32F9503C876005A3CACE9';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  let turn;
  try {
    const body = JSON.parse(event.body || '{}');
    turn = body.turn; // 'on' o 'off'
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  if (turn !== 'on' && turn !== 'off') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Parámetro "turn" debe ser "on" u "off"' }) };
  }

  const authKey = process.env.SHELLY_AUTH_KEY || SHELLY_AUTH_KEY_FALLBACK;

  try {
    const params = new URLSearchParams({
      id: SHELLY_DEVICE_ID,
      channel: '0',
      turn: turn,
      auth_key: authKey
    });

    const resp = await fetch(`${SHELLY_SERVER}/device/relay/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* respuesta no era JSON */ }

    const ok = resp.ok && data && data.isok === true;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: ok, raw: data || text })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: e.message })
    };
  }
};
