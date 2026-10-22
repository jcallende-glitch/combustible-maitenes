// Netlify Function (v2): lee una foto de factura o guía de despacho con IA (visión) y devuelve los datos en JSON.
// Se publica en /api/leer-documento. Variables de entorno (Netlify → Site configuration → Environment variables):
//   ANTHROPIC_API_KEY  clave de la API de Anthropic (marcarla como secreta)
//   ADMIN_PIN          opcional: PIN del administrador fijo de la app
// Seguridad: solo responde si el PIN enviado existe en config/pines de Firestore (o es ADMIN_PIN),
// y limita el tamaño de las imágenes. Además conviene fijar un límite de gasto mensual en la consola de Anthropic.

const FIRESTORE_PIN_URL = 'https://firestore.googleapis.com/v1/projects/combustible-los-maitenes/databases/(default)/documents/config/pines?key=AIzaSyAVsios3N97MQVPJLC94qEOXGJNmKzK9RI';
const MODELO = 'claude-sonnet-5-5';
const MAX_BYTES_TOTAL = 6 * 1024 * 1024;

const HERRAMIENTA = {
  name: 'registrar_documento',
  description: 'Registra los datos leídos de una factura o guía de despacho chilena (productos agrícolas).',
  input_schema: {
    type: 'object',
    properties: {
      legible: { type: 'boolean', description: 'false si la imagen no permite leer el documento' },
      tipo_documento: { type: 'string', enum: ['factura', 'guia_despacho', 'otro'] },
      proveedor: { type: 'string', description: 'Razón social del emisor' },
      rut_proveedor: { type: 'string' },
      numero_documento: { type: 'string', description: 'Folio / N° de factura o guía' },
      fecha: { type: 'string', description: 'Fecha de emisión AAAA-MM-DD' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nombre_comercial: { type: 'string', description: 'Nombre del producto tal como figura en el documento' },
            cantidad: { type: 'number' },
            unidad: { type: 'string', enum: ['L', 'kg', 'g', 'mL', 't'], description: 'Unidad de medida del producto; omitir si no se puede saber' },
            valor_neto_unitario: { type: 'number', description: 'Precio unitario NETO en pesos (sin IVA); omitir si el documento no trae precios' },
            total_neto_linea: { type: 'number' },
          },
          required: ['nombre_comercial', 'cantidad'],
        },
      },
      total_neto: { type: 'number' },
      observaciones: { type: 'string', description: 'Dudas de lectura o datos que faltan' },
    },
    required: ['legible', 'items'],
  },
};

const PROMPT = `Lee este documento (factura o guía de despacho de Chile, productos agrícolas: agroquímicos, fertilizantes, insumos).
Extrae el proveedor, el folio, la fecha y TODAS las líneas de productos con su nombre comercial, cantidad, unidad y valor neto unitario (sin IVA).
Reglas:
- No inventes datos. Si algo no se ve con claridad, omítelo y explícalo en "observaciones".
- Si el precio unitario viene con IVA incluido, conviértelo a neto y dilo en observaciones.
- Cantidades con coma decimal chilena (1.234,5) deben salir como número normal.
- Si ves un envase como "20 L" o "25 kg", la cantidad es cuántos envases o cuántos litros/kilos según cómo lo cobra el documento; indica en observaciones cómo la interpretaste.
Responde solo usando la herramienta registrar_documento.`;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function pinValido(usuario, pin, env) {
  if (!pin) return false;
  if (env.ADMIN_PIN && pin === env.ADMIN_PIN) return true;
  try {
    const r = await fetch(FIRESTORE_PIN_URL);
    if (!r.ok) return false;
    const campos = (await r.json()).fields || {};
    const f = campos[usuario];
    return !!(f && f.stringValue === pin);
  } catch (e) { return false; }
}

export const config = { path: '/api/leer-documento' };

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  const env = { ANTHROPIC_API_KEY: Netlify.env.get('ANTHROPIC_API_KEY'), ADMIN_PIN: Netlify.env.get('ADMIN_PIN') };
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'La lectura automática no está configurada (falta la clave de IA).' }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Solicitud inválida' }, 400); }
  const { usuario, pin, imagenes } = body || {};
  if (!(await pinValido(usuario, pin, env))) return json({ error: 'No autorizado' }, 401);
  if (!Array.isArray(imagenes) || !imagenes.length || imagenes.length > 3) return json({ error: 'Envía entre 1 y 3 fotos' }, 400);
  let total = 0;
  const contenido = [];
  for (const dataUrl of imagenes) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) return json({ error: 'Formato de imagen no válido' }, 400);
    total += m[2].length * 0.75;
    if (total > MAX_BYTES_TOTAL) return json({ error: 'Las fotos pesan demasiado' }, 413);
    contenido.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  contenido.push({ type: 'text', text: PROMPT });
  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODELO, max_tokens: 3000, temperature: 0, tools: [HERRAMIENTA], tool_choice: { type: 'tool', name: 'registrar_documento' }, messages: [{ role: 'user', content: contenido }] }),
    });
  } catch (e) { return json({ error: 'No se pudo contactar el servicio de IA' }, 502); }
  if (!resp.ok) return json({ error: 'El servicio de IA respondió con error (' + resp.status + ')' }, 502);
  const data = await resp.json();
  const uso = (data.content || []).find(b => b.type === 'tool_use');
  if (!uso) return json({ error: 'No se pudo leer el documento' }, 502);
  return json({ ok: true, documento: uso.input });
}
