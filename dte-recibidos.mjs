// Netlify Function (v2): trae las facturas y guías RECIBIDAS desde el Portal MIPYME del SII (sistema de facturación gratuito),
// usando el servicio API Gateway (https://www.apigateway.cl). Se publica en /api/dte-recibidos.
//
// Por qué así: la empresa factura con el sistema gratuito del SII, y en ese sistema la casilla de intercambio es del propio SII
// (facturacionmipyme@sii.cl). Los proveedores mandan ahí el XML, el SII lo deja en "Ver documentos recibidos" y no reenvía copias
// a ningún correo. Esta función entra al portal (con un usuario autorizado de la empresa) y baja la lista y el XML de cada documento.
//
// Variables de entorno (Netlify → Site configuration → Environment variables; marcar las claves como secretas):
//   APIGATEWAY_API_TOKEN  token de API Gateway (en tu cuenta de apigateway.cl)
//   SII_RUT_EMPRESA       RUT de la empresa receptora, ej. 76123456-7
//   SII_RUT_USUARIO       RUT de la persona que entra al SII (usuario autorizado en el portal de la empresa), ej. 12345678-9
//   SII_CLAVE             clave tributaria de esa persona
//   ADMIN_PIN             opcional: PIN del administrador fijo de la app (igual que en leer-documento)
// Seguridad: solo responde a JC Allende y Camila Faundez con su PIN de la app. La clave del SII nunca llega al navegador.

const FIRESTORE_PIN_URL = 'https://firestore.googleapis.com/v1/projects/combustible-los-maitenes/databases/(default)/documents/config/pines?key=AIzaSyAVsios3N97MQVPJLC94qEOXGJNmKzK9RI';
const API = 'https://app.apigateway.cl/api/v2';
const USUARIOS_OK = ['JC Allende', 'Camila Faundez'];
const MAX_XML_POR_LLAMADA = 3;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function pinValido(usuario, pin, adminPin) {
  if (!pin || !USUARIOS_OK.includes(usuario)) return false;
  if (adminPin && pin === adminPin) return true;
  try {
    const r = await fetch(FIRESTORE_PIN_URL);
    if (!r.ok) return false;
    const f = ((await r.json()).fields || {})[usuario];
    return !!(f && f.stringValue === pin);
  } catch (e) { return false; }
}

// "76.123.456-7" → "76123456-7"
const limpiarRut = r => String(r || '').replace(/\./g, '').replace(/\s/g, '').toUpperCase();
const rutValido = r => /^\d{7,8}-[\dK]$/.test(r);
// "15/11/2024" o "2024-11-15 10:20" → "2024-11-15"
function fechaIso(f) {
  const s = String(f || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/.exec(s); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

// El XML del SII viene casi siempre en ISO-8859-1; algunos emisores lo mandan en UTF-8 aunque declaren otra cosa.
function decodificarXml(buf) {
  const u8 = new Uint8Array(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) {}
  return new TextDecoder('windows-1252').decode(u8);
}

async function llamarApi(env, recurso, cuerpo, esperaXml) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let r;
  try {
    r = await fetch(API + recurso, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': esperaXml ? 'application/xml, application/json' : 'application/json', 'Authorization': 'Token ' + env.token },
      body: JSON.stringify({ auth: { pass: { rut: env.rutUsuario, clave: env.clave } }, ...(cuerpo || {}) }),
    });
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 504, error: e.name === 'AbortError' ? 'El SII tardó demasiado en responder' : 'No se pudo contactar API Gateway' };
  }
  clearTimeout(t);
  const buf = await r.arrayBuffer();
  const texto = decodificarXml(buf);
  if (!r.ok) {
    let msg = '';
    try { const d = JSON.parse(texto); msg = d.message || d.error || (d.errors && JSON.stringify(d.errors)) || ''; } catch (e) { msg = texto.slice(0, 300); }
    if (r.status === 401 || r.status === 402 || r.status === 403) msg = 'API Gateway rechazó la consulta (revisa el token, los créditos o el RUT/clave del SII)' + (msg ? ': ' + msg : '');
    return { ok: false, status: r.status, error: String(msg || ('error ' + r.status)).slice(0, 400) };
  }
  if (esperaXml) {
    const s = texto.replace(/^﻿/, '').trimStart();
    if (!s.startsWith('<')) {
      let msg = s.slice(0, 300);
      try { const d = JSON.parse(s); msg = d.message || d.error || msg; } catch (e) {}
      return { ok: false, status: 502, error: 'No llegó el XML: ' + msg };
    }
    return { ok: true, xml: s };
  }
  try { return { ok: true, data: JSON.parse(texto) }; } catch (e) { return { ok: false, status: 502, error: 'Respuesta no válida de API Gateway' }; }
}

export const config = { path: '/api/dte-recibidos' };

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  const g = k => (Netlify.env.get(k) || '').trim();
  const env = { token: g('APIGATEWAY_API_TOKEN'), rutEmpresa: limpiarRut(g('SII_RUT_EMPRESA')), rutUsuario: limpiarRut(g('SII_RUT_USUARIO')), clave: g('SII_CLAVE'), adminPin: g('ADMIN_PIN') };
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Solicitud inválida' }, 400); }
  const { usuario, pin, accion } = body || {};
  const faltan = [];
  if (!env.token) faltan.push('APIGATEWAY_API_TOKEN');
  if (!rutValido(env.rutEmpresa)) faltan.push('SII_RUT_EMPRESA');
  if (!rutValido(env.rutUsuario)) faltan.push('SII_RUT_USUARIO');
  if (!env.clave) faltan.push('SII_CLAVE');
  // Solo dice si está configurada (sin datos): la app lo usa para mostrar o no el botón "Traer del SII"
  if (accion === 'estado') return json({ ok: true, configurado: !faltan.length });

  if (!(await pinValido(usuario, pin, env.adminPin))) return json({ error: 'No autorizado' }, 401);
  if (faltan.length) return json({ error: 'Falta configurar en Netlify: ' + faltan.join(', '), faltan }, 503);

  // Lista de documentos recibidos en el portal, una página por llamada (el navegador pide las siguientes)
  if (accion === 'listar') {
    const desde = fechaIso(body.desde), hasta = fechaIso(body.hasta);
    if (!desde || !hasta) return json({ error: 'Fechas no válidas' }, 400);
    const pagina = Math.max(1, Math.min(50, parseInt(body.pagina, 10) || 1));
    const r = await llamarApi(env, '/sii/mipyme/recibidos/documentos/' + env.rutEmpresa, { filtros: { FEC_DESDE: desde, FEC_HASTA: hasta, NUM_PAG: pagina } });
    // 502 siempre: el 401 queda reservado para el PIN de la app
    if (!r.ok) return json({ error: r.error }, 502);
    const lista = Array.isArray(r.data && r.data.data) ? r.data.data : [];
    const meta = (r.data && r.data.metadata) || {};
    const documentos = lista.map(d => {
      const num = k => (d[k] != null && d[k] !== '' && !isNaN(Number(d[k]))) ? Number(d[k]) : null;
      return {
        codigo: d.codigo != null ? String(d.codigo) : '',
        rut: String(d.rut || '').replace(/\D/g, ''), dv: String(d.dv || '').toUpperCase(),
        razon_social: String(d.razon_social || '').trim(),
        dte: parseInt(d.dte, 10) || 0, dte_glosa: String(d.dte_glosa || ''),
        folio: parseInt(d.folio, 10) || 0,
        fecha: fechaIso(d.fecha),
        total: num('total') ?? num('monto_total') ?? num('monto') ?? num('mnt_total'),
        estado: String(d.estado || d.situacion || ''),
      };
    }).filter(d => d.rut && d.dte && d.folio);
    return json({ ok: true, documentos, pagina, n_paginas: Number(meta.n_paginas) || 1, n_documentos: Number(meta.n_documentos) || documentos.length });
  }

  // XML de unos pocos documentos (pocos por llamada para no pasar el tiempo máximo de la función)
  if (accion === 'xml') {
    const docs = (Array.isArray(body.docs) ? body.docs : []).slice(0, MAX_XML_POR_LLAMADA);
    if (!docs.length) return json({ error: 'Faltan los documentos' }, 400);
    const res = await Promise.all(docs.map(async d => {
      const rut = String(d.rut || '').replace(/\D/g, ''), dv = String(d.dv || '').toUpperCase().slice(0, 1);
      const tipo = parseInt(d.dte, 10), folio = parseInt(d.folio, 10), fecha = fechaIso(d.fecha);
      const clave = `${rut}_${tipo}_${folio}`;
      if (!rut || !dv || !tipo || !folio || !fecha) return { clave, ok: false, error: 'Datos incompletos' };
      const recurso = `/sii/mipyme/recibidos/xml/${env.rutEmpresa}/${rut}-${dv}/${tipo}/${folio}?fecha_emision=${fecha}`;
      const r = await llamarApi(env, recurso, null, true);
      return r.ok ? { clave, ok: true, xml: r.xml } : { clave, ok: false, error: r.error };
    }));
    return json({ ok: true, resultados: res });
  }

  return json({ error: 'Acción no reconocida' }, 400);
}
