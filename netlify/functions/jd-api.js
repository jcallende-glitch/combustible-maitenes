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

    const JD_API_BASE = 'https://partnerapi.deere.com/platform';
    const url = `${JD_API_BASE}${endpoint}`;

    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.deere.axiom.v3+json'
      }
    });

    const data = await resp.json();
    return { statusCode: resp.status, headers, body: JSON.stringify(data) };

  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
