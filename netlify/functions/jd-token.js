exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  try {
    const body = JSON.parse(event.body || '{}');
    const { grant_type, code, refresh_token, code_verifier } = body;
    const JD_CLIENT_ID = '0oavbnyqn09EHHLnh5d7';
    const JD_CLIENT_SECRET = process.env.JD_CLIENT_SECRET;
    const JD_TOKEN_URL = 'https://signin.johndeere.com/oauth2/aus78tnlaysMraFhC1t7/v1/token';
    const credentials = Buffer.from(`${JD_CLIENT_ID}:${JD_CLIENT_SECRET}`).toString('base64');
    const params = new URLSearchParams({ grant_type });
    if (grant_type === 'authorization_code') {
      params.append('code', code);
      if (code_verifier) params.append('code_verifier', code_verifier);
    }
    if (grant_type === 'refresh_token') params.append('refresh_token', refresh_token);
    const resp = await fetch(JD_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      },
      body: params
    });
    const data = await resp.json();
    return { statusCode: resp.status, headers, body: JSON.stringify(data) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
