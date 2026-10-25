// Netlify Function (v2): lee una foto de factura o guía de despacho con IA (visión) y devuelve los datos en JSON.
// Se publica en /api/leer-documento. Variables de entorno (Netlify → Site configuration → Environment variables):
//   ANTHROPIC_API_KEY  clave de la API de Anthropic (marcarla como secreta)
//   ADMIN_PIN          opcional: PIN del administrador fijo de la app
// Seguridad: solo responde si el PIN enviado existe en config/pines de Firestore (o es ADMIN_PIN),
// y limita el tamaño de las imágenes. Además conviene fijar un límite de gasto mensual en la consola de Anthropic.

const FIRESTORE_PIN_URL = 'https://firestore.googleapis.com/v1/projects/combustible-los-maitenes/databases/(default)/documents/config/pines?key=AIzaSyAVsios3N97MQVPJLC94qEOXGJNmKzK9RI';
const MODELO = 'claude-sonnet-5-5';
// Sonnet 5.5 no acepta temperature ni tool_choice forzado (tool/any): se usa tool_choice auto + instrucción en el prompt.
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

const HERRAMIENTA_SUELDOS = {
  name: 'registrar_remuneraciones',
  description: 'Registra, trabajador por trabajador, los montos de una planilla o liquidaciones de sueldo chilenas.',
  input_schema: {
    type: 'object',
    properties: {
      legible: { type: 'boolean' },
      mes: { type: 'string', description: 'Mes de la planilla AAAA-MM, si se ve' },
      filas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nombre: { type: 'string', description: 'Nombre del trabajador tal como figura' },
            rut: { type: 'string' },
            costo_empresa: { type: 'number', description: 'Costo total para la empresa en pesos (sueldo + aportes del empleador + gratificación, etc.). Si la planilla no lo trae, omitir.' },
            total_haberes: { type: 'number', description: 'Total haberes (bruto) en pesos' },
            liquido: { type: 'number', description: 'Líquido a pagar en pesos' },
            horas_extra_monto: { type: 'number', description: 'Monto pagado en horas extra en pesos, si aparece' },
            horas_extra_horas: { type: 'number', description: 'Cantidad de horas extra pagadas, si aparece' },
          },
          required: ['nombre'],
        },
      },
      observaciones: { type: 'string', description: 'Dudas de lectura, columnas que faltan o supuestos' },
    },
    required: ['legible', 'filas'],
  },
};
const PROMPT_SUELDOS = `Lee esta planilla o liquidaciones de sueldo de trabajadores agrícolas en Chile.
Extrae UNA fila por trabajador con su nombre, RUT, costo total empresa, total haberes, líquido a pagar, y si aparecen, el monto y las horas de horas extra.
Reglas: no inventes cifras; omite lo que no se vea y explícalo en "observaciones". Los montos van en pesos chilenos como número entero (sin puntos de miles). No sumes ni agregues una fila de totales.
Responde solo usando la herramienta registrar_remuneraciones.`;

const HERRAMIENTA_ELECTRICA = {
  name: 'registrar_factura_electrica',
  description: 'Registra los datos leídos de una boleta o factura de electricidad chilena (distribuidora, por ejemplo Copelec).',
  input_schema: {
    type: 'object',
    properties: {
      legible: { type: 'boolean' },
      empresa: { type: 'string', description: 'Distribuidora que emite (ej. Copelec)' },
      numero_cliente: { type: 'string', description: 'Número de cliente / suministro tal como figura' },
      numero_medidor: { type: 'string' },
      nombre_cliente: { type: 'string' },
      direccion: { type: 'string' },
      tarifa: { type: 'string', description: 'Tarifa contratada (BT1, BT2, BT3, AT2, AT3, etc.), si figura' },
      numero_documento: { type: 'string', description: 'Folio de la boleta o factura' },
      fecha_emision: { type: 'string', description: 'AAAA-MM-DD' },
      fecha_vencimiento: { type: 'string', description: 'AAAA-MM-DD' },
      periodo_desde: { type: 'string', description: 'Inicio del período facturado AAAA-MM-DD (fecha de lectura anterior)' },
      periodo_hasta: { type: 'string', description: 'Fin del período facturado AAAA-MM-DD (fecha de lectura actual)' },
      lectura_anterior: { type: 'number', description: 'Lectura anterior del medidor de energía (kWh)' },
      lectura_actual: { type: 'number', description: 'Lectura actual del medidor de energía (kWh)' },
      constante_medidor: { type: 'number', description: 'Factor o constante de multiplicación del medidor, si figura (1 si no)' },
      consumo_kwh: { type: 'number', description: 'Consumo de energía facturado en kWh' },
      demanda_maxima_kw: { type: 'number', description: 'Demanda máxima leída (kW), si figura' },
      demanda_punta_kw: { type: 'number', description: 'Demanda máxima en horas punta (kW), si figura' },
      potencia_conectada_kw: { type: 'number', description: 'Potencia conectada o contratada (kW), si figura' },
      cargos: {
        type: 'array', description: 'TODAS las líneas de cargos de la cuenta, con su monto (positivo o negativo si es descuento o saldo)',
        items: { type: 'object', properties: { concepto: { type: 'string' }, monto: { type: 'number', description: 'Pesos' }, cantidad: { type: 'number', description: 'kWh o kW si la línea lo muestra' }, precio_unitario: { type: 'number', description: 'Precio por unidad si la línea lo muestra' } }, required: ['concepto', 'monto'] },
      },
      neto: { type: 'number', description: 'Monto neto (sin IVA), si figura' },
      iva: { type: 'number' },
      total: { type: 'number', description: 'TOTAL DE FACTURA del mes en pesos (neto + IVA + otros cargos no afectos). NO es el "Total a pagar" cuando hay saldo anterior' },
      otros_no_afectos: { type: 'number', description: '"Otros cargos no afectados" / total cobros no afectos a IVA (servicio público, fondo de estabilización, etc.)' },
      saldo_anterior: { type: 'number', description: 'Saldo anterior impago arrastrado (0 si no hay)' },
      total_a_pagar: { type: 'number', description: '"TOTAL A PAGAR" final de la cuenta (total de factura + saldo anterior)' },
      interes_mora: { type: 'number', description: 'Monto del cargo "Interés por mora" (0 si no hay)' },
      cargo_factor_potencia: { type: 'number', description: 'Monto del cargo por factor de potencia' },
      factor_potencia: { type: 'number', description: 'Factor de potencia indicado entre paréntesis en el cargo (ej. 0,49 → 0.49)' },
      kvarh_anterior: { type: 'number', description: 'Lectura anterior del medidor de energía reactiva (kVArh), segunda fila de lecturas' },
      kvarh_actual: { type: 'number', description: 'Lectura actual de energía reactiva (kVArh)' },
      consumo_kvarh: { type: 'number', description: 'Consumo de energía reactiva facturado (kVArh)' },
      demanda_suministrada_kw: { type: 'number', description: 'kW de "Cargo por demanda suministrada" (ej. 228.69)' },
      consumo_referencia_kwh: { type: 'number', description: '"Consumo de referencia (kWh / mensual)"' },
      ultimo_pago_monto: { type: 'number', description: 'Monto del último pago realizado' },
      ultimo_pago_fecha: { type: 'string', description: 'Fecha del último pago AAAA-MM-DD' },
      fecha_corte: { type: 'string', description: 'Fecha de corte a partir de AAAA-MM-DD, si figura' },
      corte_en_tramite: { type: 'boolean', description: 'true si dice "Corte en trámite"' },
      fecha_fin_contrato: { type: 'string', description: 'Fecha de término de contrato AAAA-MM-DD' },
      fecha_limite_cambio_tarifa: { type: 'string', description: 'AAAA-MM-DD' },
      historial: { type: 'array', description: 'Tabla de consumos de meses anteriores si la cuenta la trae', items: { type: 'object', properties: { mes: { type: 'string', description: 'AAAA-MM' }, kwh: { type: 'number' }, monto: { type: 'number' } }, required: ['mes'] } },
      observaciones: { type: 'string', description: 'Dudas de lectura, avisos de la distribuidora, recargos, deuda anterior, datos que faltan' },
    },
    required: ['legible'],
  },
};
const PROMPT_ELECTRICA = `Lee esta boleta o factura de electricidad de Chile (distribuidora como Copelec).
Estructura típica de Copelec: arriba "Datos del cliente" y "Datos del suministro" (tarifa, potencia conectada, término de contrato); luego "Detalle de lectura/consumo" con DOS filas de medidor: la primera es energía activa (kWh) y la segunda energía reactiva (kVArh); cada fila tiene lectura anterior, lectura actual, constante y consumo. Bajo ella: consumo de referencia, "Potencia leída (kW)" (demanda máxima) y "Potencia leída horas de punta (kW)". Luego "Detalle de la cuenta": cargos de energía (administración, transporte, electricidad consumida, demanda suministrada con sus kW, demanda máxima en horas punta, factor de potencia con su valor entre paréntesis, interés por mora), otros cobros no afectos, saldo anterior, y al pie Total Neto, IVA, Otros cargos no afectados, Total de factura, Saldo anterior y TOTAL A PAGAR. A la derecha: fecha de vencimiento, fecha de corte, último pago. El gráfico de barras de 13 meses no trae cifras: no lo leas. Distingue siempre "Total de factura" (campo total) de "Total a pagar" (campo total_a_pagar).
Extrae los datos del cliente, el período, las lecturas del medidor (anterior y actual), el consumo en kWh, demanda y potencia si figuran, TODAS las líneas de cargos con su monto, neto, IVA, total y la tabla de consumos anteriores si la trae.
Reglas: no inventes cifras; si algo no se ve con claridad omítelo y explícalo en "observaciones". Montos en pesos chilenos como número (sin puntos de miles); decimales con punto. Fechas AAAA-MM-DD. En "cargos" pon solo las líneas individuales de cobro: NO pongas filas de total ni subtotal ("Total Cargos Energía", "Total Cobros no Afectos", "Total Neto", etc.). NO incluyas el saldo anterior impago ("Consumo impago de meses anteriores"): va solo en saldo_anterior. El interés por mora del mes sí es un cargo y además va en interes_mora. Menciona multas o convenios en observaciones.
Responde solo usando la herramienta registrar_factura_electrica.`;

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
  const env = { ANTHROPIC_API_KEY: (Netlify.env.get('ANTHROPIC_API_KEY') || '').trim(), ADMIN_PIN: (Netlify.env.get('ADMIN_PIN') || '').trim() };
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'La lectura automática no está configurada (falta la clave de IA).' }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Solicitud inválida' }, 400); }
  const { usuario, pin, imagenes } = body || {};
  if (!(await pinValido(usuario, pin, env))) return json({ error: 'No autorizado' }, 401);
  if (body.modo === 'electricidad') {
    const docs = body.documentos;
    if (!Array.isArray(docs) || !docs.length || docs.length > 3) return json({ error: 'Envía entre 1 y 3 archivos' }, 400);
    let tot = 0; const cont = [];
    for (const du of docs) {
      const m = /^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(du || '');
      if (!m) return json({ error: 'Formato no válido (PDF o imagen)' }, 400);
      tot += m[2].length * 0.75; if (tot > MAX_BYTES_TOTAL) return json({ error: 'Los archivos pesan demasiado' }, 413);
      cont.push(m[1] === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    }
    cont.push({ type: 'text', text: PROMPT_ELECTRICA });
    let r3;
    try {
      r3 = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODELO, max_tokens: 6000, thinking: { type: 'between_tools' }, tools: [HERRAMIENTA_ELECTRICA], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: cont }] }) });
    } catch (e) { return json({ error: 'No se pudo contactar el servicio de IA' }, 502); }
    if (!r3.ok) { let d = ''; try { const e = await r3.json(); d = (e && e.error && e.error.message) ? ': ' + e.error.message : ''; } catch (e) {} return json({ error: 'El servicio de IA respondió con error (' + r3.status + ')' + d }, 502); }
    const d3 = await r3.json(), u3 = (d3.content || []).find(b => b.type === 'tool_use' && b.name === 'registrar_factura_electrica');
    if (u3) return json({ ok: true, factura: u3.input });
    return json({ error: 'No se pudo leer la factura' }, 502);
  }
  if (body.modo === 'remuneraciones') {
    const docs = body.documentos;
    if (!Array.isArray(docs) || !docs.length || docs.length > 2) return json({ error: 'Envía 1 o 2 archivos' }, 400);
    let tot = 0; const cont = [];
    for (const du of docs) {
      const m = /^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(du || '');
      if (!m) return json({ error: 'Formato no válido (PDF o imagen)' }, 400);
      tot += m[2].length * 0.75; if (tot > MAX_BYTES_TOTAL) return json({ error: 'Los archivos pesan demasiado' }, 413);
      cont.push(m[1] === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    }
    cont.push({ type: 'text', text: PROMPT_SUELDOS });
    let r2;
    try {
      r2 = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODELO, max_tokens: 8000, thinking: { type: 'between_tools' }, tools: [HERRAMIENTA_SUELDOS], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: cont }] }) });
    } catch (e) { return json({ error: 'No se pudo contactar el servicio de IA' }, 502); }
    if (!r2.ok) { let d = ''; try { const e = await r2.json(); d = (e && e.error && e.error.message) ? ': ' + e.error.message : ''; } catch (e) {} return json({ error: 'El servicio de IA respondió con error (' + r2.status + ')' + d }, 502); }
    const d2 = await r2.json(), u2 = (d2.content || []).find(b => b.type === 'tool_use' && b.name === 'registrar_remuneraciones');
    if (u2) return json({ ok: true, remuneraciones: u2.input });
    return json({ error: 'No se pudo leer la planilla' }, 502);
  }
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
      body: JSON.stringify({ model: MODELO, max_tokens: 6000, thinking: { type: 'between_tools' }, tools: [HERRAMIENTA], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: contenido }] }),
    });
  } catch (e) { return json({ error: 'No se pudo contactar el servicio de IA' }, 502); }
  if (!resp.ok) {
    let detalle = '';
    try { const e = await resp.json(); detalle = (e && e.error && e.error.message) ? ': ' + e.error.message : ''; } catch (e) {}
    return json({ error: 'El servicio de IA respondió con error (' + resp.status + ')' + detalle }, 502);
  }
  const data = await resp.json();
  const uso = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'registrar_documento');
  if (uso) return json({ ok: true, documento: uso.input });
  // Respaldo: si el modelo respondió con texto en vez de usar la herramienta, intenta extraer el JSON.
  const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = texto.match(/\{[\s\S]*\}/);
  if (m) { try { const doc = JSON.parse(m[0]); if (doc && Array.isArray(doc.items)) return json({ ok: true, documento: doc }); } catch (e) {} }
  return json({ error: 'No se pudo leer el documento' }, 502);
}
