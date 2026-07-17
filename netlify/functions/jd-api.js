exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  try {
    const body = JSON.parse(event.body || '{}');
    const { endpoint, token } = body;
    if (!endpoint || !token) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Faltan endpoint o token' }) };
    }
    // La API de John Deere es hipermedia: muchas respuestas traen un "link" con la
    // URL COMPLETA a seguir (ej. para horas de un equipo específico). Si nos pasan
    // una URL completa la usamos tal cual; si es una ruta relativa, la armamos nosotros.
    let url;
    if (endpoint.startsWith('http')) {
      url = endpoint;
    } else {
      // OJO: este reemplazo SOLO aplica al listado de equipos de una organización
      // (/organizations/{id}/machines -> /organizations/{id}/equipment). NO debe tocar
      // otros endpoints que legítimamente usan "/machines/" en su ruta, como el endpoint
      // oficial /machines/{principalId}/engineHours -- de lo contrario se rompe ese
      // endpoint (fue exactamente el bug que causaba 404 en engineHours).
      const fixedEndpoint = endpoint.match(/^\/organizations\/[^/]+\/machines$/)
        ? endpoint.replace('/machines', '/equipment')
        : endpoint;
      url = 'https://partnerapi.deere.com/platform' + fixedEndpoint;
    }
    console.log('JD API call:', url);
    const resp = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.deere.axiom.v3+json'
      }
    });
    const text = await resp.text();
    console.log('JD API status:', resp.status);
    console.log('JD API response:', text.substring(0, 800));
    return { statusCode: resp.status, headers, body: text };
  } catch(e) {
    console.log('JD API error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
