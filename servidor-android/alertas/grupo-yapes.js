// ════════════════════════════════════════════════════════════════════
//  YAPES AUTOMÁTICOS — del grupo de WhatsApp a la caja abierta
//
//  Corre dentro de alertas.js (usa la misma sesión de WhatsApp).
//
//  1. Llega una foto al grupo "YAPES//TRANSFERENCIAS" (alertas.grupoYapes).
//  2. El Claude Code del celular (`claude -p` en Debian, usa el plan del
//     dueño, sin API) lee el monto del comprobante.
//  3. El monto queda en la lista del día yapesGrupo/{fecha} y a la foto se
//     le pone ✅. La webapp (única que escribe la caja) lo agrega solo a
//     los Yapes de la caja abierta de hoy, sin duplicar; el botón
//     "💚 Yapes" hace lo mismo a pedido. Así el Samsung y la webapp no se
//     pisan al guardar la caja.
//  4. Si no se puede leer, el Samsung responde a la foto en el grupo
//     pidiendo el monto como texto. Un mensaje que es SOLO un monto
//     ("25.50", "S/ 25.50") también se agrega.
//
//  Las fotos no se guardan en ningún lado: se leen y se descartan.
// ════════════════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');

const TZ = 'America/Lima';
const PROCESADOS = path.join(__dirname, 'yapes-procesados.json');
const ADC_FILE   = path.join(__dirname, 'credencial-gmail.json');
const FIREBASE_TOOLS_STORE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
// Cliente OAuth público de firebase-tools (igual que servidor.js)
const FIREBASE_TOOLS_CLIENT_ID     = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_TOOLS_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

const MAX_EDAD_MS = 12 * 3600e3;   // mensajes más viejos (p. ej. tras días apagado) no se suman
const MAX_FOTO    = 5 * 1024 * 1024;
// Un mensaje de texto cuenta como monto solo si no dice nada más
const SOLO_MONTO  = /^\s*(?:s\/\.?\s*)?(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:soles)?\s*$/i;

const PROMPT = `Esta foto se envió a un grupo de WhatsApp de una tienda en Perú para registrar un pago recibido por Yape, Plin o transferencia bancaria. Suele ser una foto tomada con cámara a la pantalla del celular del cliente o una captura de pantalla.

Devuelve:
- es_comprobante: true si la imagen muestra la constancia de un pago (Yape, Plin, transferencia, depósito).
- monto: el importe pagado en soles, como número (ej. 25.5). null si no se lee con seguridad.
- legible: true solo si estás seguro de cada dígito del monto y de la posición del punto decimal.

Si dudas entre dos montos, o una parte del número está tapada, borrosa o con reflejo, pon legible en false. Es preferible pedir el monto a equivocarse.`;

function normalizar(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}
function fechaPE(d) { return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d); }
function horaPE(d) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

function crear({ config, log, baileys, logger, getSock }) {
  const NOMBRE_GRUPO = normalizar(config.grupoYapes || 'YAPES//TRANSFERENCIAS');
  const PROJECT_ID   = config.projectId || 'programa-caja';
  const { normalizeMessageContent, downloadMediaMessage, WAMessageStubType } = baileys;

  // ── Claude Code del celular (consume el plan del dueño, sin API) ────
  //  En el Samsung, Claude Code vive en Debian (proot-distro) dentro de
  //  Termux. Se llama directo (no con el `claude` de Termux, que abre en el
  //  home y carga su CLAUDE.md): parado en la carpeta de la foto, solo con
  //  la herramienta Read, instrucciones propias cortas y sin MCP, skills ni
  //  ajustes (~5 mil tokens por foto; Claude se abre con cada foto y se cierra). La carpeta se borra al terminar.
  const PROOT  = path.join(process.env.PREFIX || '/data/data/com.termux/files/usr', 'bin', 'proot-distro');
  const DEBIAN = config.claudeDebian !== false && fs.existsSync(PROOT);
  const MODELO = config.modeloYapes || '';   // vacío: el modelo por defecto de Claude Code

  function leerMonto(buf, mime) {
    const ext = /png/.test(mime) ? 'png' : /webp/.test(mime) ? 'webp' : 'jpg';
    // os.tmpdir() es $PREFIX/tmp, que en Debian (--shared-tmp) es /tmp
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yape-'));
    const foto = 'foto.' + ext;
    fs.writeFileSync(path.join(dir, foto), buf);
    const claudeArgs = ['-p', `Lee la imagen ./${foto} con la herramienta Read.\n\n${PROMPT}\n\nResponde SOLO con un objeto JSON en una línea, sin texto adicional, con este formato: {"es_comprobante": true, "monto": 25.5, "legible": true}`,
      // Instrucciones propias de 2 líneas en vez de las de Claude Code: la mitad de tokens
      '--system-prompt', 'Lees fotos de comprobantes de pago (Yape, Plin, transferencias) de una tienda en Perú. Usa la herramienta Read para abrir la imagen indicada y responde únicamente con el JSON pedido, sin otro texto.',
      '--output-format', 'json', '--tools', 'Read', '--allowedTools', 'Read', '--max-turns', '4',
      '--strict-mcp-config', '--setting-sources', 'project', '--disable-slash-commands'];
    if (MODELO) claudeArgs.push('--model', MODELO);
    const [cmd, args] = DEBIAN
      ? [PROOT, ['login', 'debian', '--shared-tmp', '--', 'env', '-C', '/tmp/' + path.basename(dir),
                 config.claudeCmd || '/root/.local/bin/claude', ...claudeArgs]]
      : [config.claudeCmd || 'claude', claudeArgs];
    return new Promise((resolve, reject) => {
      const hijo = execFile(cmd, args, { cwd: dir, timeout: 180e3, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (err) {
          const detalle = String(stdout || '').slice(0, 300) || String(stderr || '').slice(0, 300);
          return reject(new Error(`claude: ${err.killed ? 'tardó demasiado' : 'código ' + err.code} ${detalle}`));
        }
        try {
          const salida = JSON.parse(stdout);
          if (salida.is_error) throw new Error(salida.result || salida.subtype || 'error');
          const json = String(salida.result || '').match(/\{[\s\S]*\}/);
          if (!json) throw new Error('respuesta sin JSON: ' + String(salida.result).slice(0, 120));
          resolve(JSON.parse(json[0]));
        } catch (e) { reject(new Error('claude: ' + e.message)); }
      });
      hijo.stdin.end();   // sin esto claude -p espera datos por stdin
    });
  }

  // ── Ya procesados (WhatsApp a veces entrega dos veces) ──────────────
  let procesados = [];
  try { procesados = JSON.parse(fs.readFileSync(PROCESADOS, 'utf8')); } catch (e) { /* vacío */ }
  const vistos = new Set(procesados);
  function marcar(id) {
    vistos.add(id); procesados.push(id);
    if (procesados.length > 500) vistos.delete(procesados.shift());
    try { fs.writeFileSync(PROCESADOS, JSON.stringify(procesados)); } catch (e) {}
  }

  // ── Firebase (firebase-admin viene de ../node_modules del servidor) ──
  let db = null, FieldValue = null;
  async function iniciarFirebase() {
    const { initializeApp, getApps, applicationDefault } = require('firebase-admin/app');
    const fsMod = require('firebase-admin/firestore');
    const store = JSON.parse(fs.readFileSync(FIREBASE_TOOLS_STORE, 'utf8'));
    const refresh = store.tokens && store.tokens.refresh_token;
    if (!refresh) throw new Error('falta la sesión: firebase login --no-localhost');
    fs.writeFileSync(ADC_FILE, JSON.stringify({
      type: 'authorized_user',
      client_id: FIREBASE_TOOLS_CLIENT_ID, client_secret: FIREBASE_TOOLS_CLIENT_SECRET,
      refresh_token: refresh, quota_project_id: PROJECT_ID
    }), { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = ADC_FILE;
    if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
    const base = fsMod.getFirestore();
    await base.doc('requests/reporte-caja').get();   // valida la sesión
    db = base; FieldValue = fsMod.FieldValue;
    log('Yapes: Firebase conectado');
  }
  function arrancarFirebase() {
    iniciarFirebase().catch(e => {
      log('Yapes: no se pudo conectar a Firebase:', e.message, '— reintento en 60s');
      setTimeout(arrancarFirebase, 60000);
    });
  }

  // ── ¿Es el grupo de Yapes? (se pregunta el nombre una vez por grupo) ──
  const esYapes = new Map();   // jid → Promise<boolean>
  function esGrupoYapes(jid) {
    if (!esYapes.has(jid)) {
      const sock = getSock();
      if (!sock) return Promise.reject(new Error('WhatsApp sin conexión'));
      const p = sock.groupMetadata(jid)
        .then(meta => {
          const si = normalizar(meta.subject) === NOMBRE_GRUPO;
          if (si) log(`Yapes: grupo encontrado "${meta.subject}"`);
          return si;
        })
        .catch(e => { esYapes.delete(jid); throw e; });   // reintenta en el próximo mensaje
      esYapes.set(jid, p);
    }
    return esYapes.get(jid);
  }

  async function responder(m, texto) {
    const sock = getSock();
    if (!sock) return;
    await sock.sendMessage(m.key.remoteJid, { text: texto }, { quoted: m })
      .catch(e => log('Yapes: no se pudo responder en el grupo:', e.message));
  }
  async function reaccionar(m, emoji) {
    const sock = getSock();
    if (!sock) return;
    await sock.sendMessage(m.key.remoteJid, { react: { text: emoji, key: m.key } }).catch(() => {});
  }

  // Lista del día: de aquí completa el botón "💚 Yapes" de la webapp
  async function registrarDelDia(m, monto, origen) {
    const d = new Date(Number(m.messageTimestamp || 0) * 1000 || Date.now());
    const fecha = fechaPE(d);
    await db.doc(`yapesGrupo/${fecha}`).set({
      fecha,
      lista: FieldValue.arrayUnion({ id: m.key.id, monto, hora: horaPE(d), origen }),
      actualizado: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  // Guarda el monto en la lista del día; la webapp lo pasa a la caja
  async function sumar(m, monto, origen) {
    try {
      if (!db) throw new Error('sin conexión a Firebase');
      await registrarDelDia(m, monto, origen);
    } catch (e) {
      log(`Yapes: no se pudo guardar S/ ${monto.toFixed(2)}:`, e.message);
      await responder(m, `⚠️ No pude registrar S/ ${monto.toFixed(2)}. Agrégalo a mano.`);
      return 0;
    }
    log(`Yapes: + S/ ${monto.toFixed(2)} (${origen}) en la lista del día`);
    await reaccionar(m, '✅');
    return monto;
  }

  // ── Mensajes del grupo ──────────────────────────────────────────────
  async function procesar(m) {
    const jid = m.key && m.key.remoteJid;
    if (!jid || !jid.endsWith('@g.us') || !m.key.id || vistos.has(m.key.id)) return;
    let si;
    try { si = await esGrupoYapes(jid); } catch (e) { log('Yapes: no se pudo leer el grupo:', e.message); return; }
    if (!si) return;

    if (!m.message) {
      if (m.messageStubType === WAMessageStubType.CIPHERTEXT) log('Yapes: llegó un mensaje del grupo que no se pudo descifrar');
      return;
    }
    const ts = Number(m.messageTimestamp || 0) * 1000;
    if (ts && Date.now() - ts > MAX_EDAD_MS) return;
    const c = normalizeMessageContent(m.message) || {};

    // Texto que es solo un monto
    const texto = c.conversation || (c.extendedTextMessage && c.extendedTextMessage.text);
    if (texto) {
      const t = texto.match(SOLO_MONTO);
      if (!t) return;
      const monto = Math.round(parseFloat(t[1].replace(',', '.')) * 100) / 100;
      if (!(monto > 0)) return;
      marcar(m.key.id);
      return sumar(m, monto, 'texto');
    }

    if (!c.imageMessage) return;
    marcar(m.key.id);
    let r;
    try {
      const sock = getSock();
      const buf = await downloadMediaMessage(m, 'buffer', {},
        { logger, reuploadRequest: sock ? sock.updateMediaMessage : undefined });
      if (buf.length > MAX_FOTO) throw new Error('foto demasiado grande');
      r = await leerMonto(buf, c.imageMessage.mimetype || 'image/jpeg');
    } catch (e) {
      log('Yapes: error leyendo la foto:', e.message);
      await responder(m, '⚠️ No pude leer esta foto. Escribe el monto aquí (ej. 25.50).');
      return;
    }
    const monto = typeof r.monto === 'number' ? Math.round(r.monto * 100) / 100 : 0;
    if (!r.es_comprobante) { log('Yapes: la foto no es un comprobante, se ignora'); return; }
    if (!r.legible || !(monto > 0) || monto > 99999) {
      log('Yapes: monto ilegible', JSON.stringify(r));
      await responder(m, '⚠️ No pude leer el monto de esta foto. Escribe el monto aquí (ej. 25.50).');
      return;
    }
    return sumar(m, monto, 'foto');
  }

  // Un mensaje a la vez: dos yapes seguidos no se pisan al escribir la caja
  let fila = Promise.resolve();
  function engancharSocket(sock) {
    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages || []) {
        fila = fila.then(() => procesar(m)).catch(e => log('Yapes: error procesando mensaje:', e.message));
      }
    });
  }

  arrancarFirebase();
  log(`Yapes automáticos activos (grupo "${config.grupoYapes || 'YAPES//TRANSFERENCIAS'}", lee con Claude Code${DEBIAN ? ' de Debian' : ''})`);
  return { engancharSocket };
}

module.exports = { crear };
