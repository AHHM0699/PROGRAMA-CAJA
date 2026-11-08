// ════════════════════════════════════════════════════════════════════
//  YAPES AUTOMÁTICOS — del grupo de WhatsApp a la caja abierta
//
//  Corre dentro de alertas.js (usa la misma sesión de WhatsApp).
//
//  1. Llega una foto al grupo "YAPES//TRANSFERENCIAS" (alertas.grupoYapes).
//  2. El Claude Code del celular (`claude -p` en Debian, usa el plan del
//     dueño, sin API) lee el monto del comprobante.
//  3. El monto queda en la lista del día yapesGrupo/{fecha} (aunque no
//     haya caja abierta) y se agrega al final de los Yapes de la caja
//     abierta (cajas/{id}.yapesRaw, y su id en yapesGrupoIds), igual que si
//     se escribiera a mano; la webapp se sincroniza sola. A la foto se le
//     pone ✅. El botón "💚 Yapes" de la webapp completa desde esa lista
//     lo que falte en la caja, sin duplicar.
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

  // Agrega el monto a la caja abierta (si hubiera dos, la abierta hoy).
  // Devuelve el nombre de la caja o null si no hay ninguna abierta.
  async function agregarACaja(monto, id) {
    const snap = await db.collection('cajas').where('cajaAbierta', '==', true).get();
    const abiertas = snap.docs.filter(d => !d.data().eliminada);
    if (!abiertas.length) return null;
    const hoy = fechaPE(new Date());
    const fechaDe = d => { const f = d.data().aperturaFecha; return f ? fechaPE(new Date(f)) : ''; };
    abiertas.sort((a, b) => String(b.data().aperturaFecha || '').localeCompare(String(a.data().aperturaFecha || '')));
    const caja = abiertas.find(d => fechaDe(d) === hoy) || abiertas[0];

    await db.runTransaction(async tx => {
      const s = await tx.get(caja.ref);
      const c = s.data() || {};
      let bref = null, b = null;
      if (c.historialBorradorId) {
        bref = db.doc(`historial/${c.historialBorradorId}`);
        b = await tx.get(bref);
      }
      const ids = Array.isArray(c.yapesGrupoIds) ? c.yapesGrupoIds : [];
      if (ids.includes(id)) return;   // ya lo agregó el botón de la webapp
      const raw = (typeof c.yapesRaw === 'string' && c.yapesRaw.trim() ? c.yapesRaw.trimEnd() + '\n' : '') + monto.toFixed(2);
      // _ts más nuevo: la webapp lo toma como cambio remoto y lo muestra
      tx.update(caja.ref, { yapesRaw: raw, yapesGrupoIds: [...ids, id], _ts: Date.now() });
      // El borrador del historial también lleva los Yapes y su total
      if (b && b.exists && b.data().estado !== 'cerrado') {
        const total = raw.split('\n').reduce((t, x) => { const v = parseFloat(x); return t + (isNaN(v) || v < 0 ? 0 : v); }, 0);
        tx.update(bref, { yapesRaw: raw, totalYapes: Math.round(total * 100) / 100 });
      }
    });
    return caja.data().nombre || caja.id;
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

  async function sumar(m, monto, origen) {
    if (!db) {
      log(`Yapes: S/ ${monto.toFixed(2)} sin conexión a Firebase`);
      await responder(m, `⚠️ No pude registrar S/ ${monto.toFixed(2)}. Agrégalo a mano.`);
      return 0;
    }
    try { await registrarDelDia(m, monto, origen); }
    catch (e) { log('Yapes: no se pudo guardar en la lista del día:', e.message); }
    let caja;
    try { caja = await agregarACaja(monto, m.key.id); }
    catch (e) {
      log(`Yapes: no se pudo agregar S/ ${monto.toFixed(2)}:`, e.message);
      await responder(m, `⚠️ No pude agregar S/ ${monto.toFixed(2)} a la caja. Agrégalo a mano.`);
      return 0;
    }
    if (!caja) {
      log(`Yapes: S/ ${monto.toFixed(2)} (${origen}) sin caja abierta`);
      await reaccionar(m, '📝');
      await responder(m, `📝 S/ ${monto.toFixed(2)} guardado. No hay caja abierta: al abrirla, toca "💚 Yapes" para cargarlo.`);
      return 0;
    }
    log(`Yapes: + S/ ${monto.toFixed(2)} (${origen}) → ${caja}`);
    await reaccionar(m, '✅');
    return monto;
  }

  // ── Mensajes del grupo ──────────────────────────────────────────────
  async function procesar(m, rellenando = false) {
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
    if (!rellenando && ts && Date.now() - ts > MAX_EDAD_MS) return;
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

  // ── Relleno: los yapes de HOY que llegaron antes (historial) ─────────
  //  WhatsApp solo entrega mensajes nuevos al dispositivo vinculado; los
  //  anteriores se piden al WhatsApp principal (el del mismo Samsung)
  //  tomando como punto de partida un mensaje que se manda al grupo.
  function pedirHistorial(sock, jid, key, tsMs) {
    return new Promise(resolve => {
      const lote = [];
      let fin = setTimeout(listo, 45e3);
      function listo() { clearTimeout(fin); sock.ev.off('messaging-history.set', alLlegar); resolve(lote); }
      function alLlegar({ messages }) {
        const deGrupo = (messages || []).filter(x => x.key && x.key.remoteJid === jid);
        if (!deGrupo.length) return;
        lote.push(...deGrupo);
        clearTimeout(fin); fin = setTimeout(listo, 5e3);   // por si llega en partes
      }
      sock.ev.on('messaging-history.set', alLlegar);
      sock.fetchMessageHistory(50, key, tsMs).catch(e => { log('Yapes: historial:', e.message); listo(); });
    });
  }

  let rellenandoAhora = false;
  async function rellenarHoy() {
    if (rellenandoAhora) return;
    rellenandoAhora = true;
    try {
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp sin conexión');
      const grupos = await sock.groupFetchAllParticipating();
      const g = Object.values(grupos).find(x => normalizar(x.subject) === NOMBRE_GRUPO);
      if (!g) throw new Error('no encontré el grupo');
      esYapes.set(g.id, Promise.resolve(true));
      const hoy = fechaPE(new Date());
      const ancla = await sock.sendMessage(g.id, { text: '⏳ Cargando los yapes de hoy…' });
      marcar(ancla.key.id);
      let key = ancla.key, tsMs = Number(ancla.messageTimestamp) * 1000;
      const encontrados = new Map();
      for (let pag = 0; pag < 10; pag++) {
        const lote = await pedirHistorial(sock, g.id, key, tsMs);
        const nuevos = lote.filter(x => !encontrados.has(x.key.id));
        if (!nuevos.length) break;
        nuevos.forEach(x => encontrados.set(x.key.id, x));
        const viejo = nuevos.reduce((a, x) => Number(x.messageTimestamp) < Number(a.messageTimestamp) ? x : a);
        if (fechaPE(new Date(Number(viejo.messageTimestamp) * 1000)) < hoy) break;
        key = viejo.key; tsMs = Number(viejo.messageTimestamp) * 1000;
      }
      const deHoy = [...encontrados.values()]
        .filter(x => fechaPE(new Date(Number(x.messageTimestamp) * 1000)) === hoy)
        .sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));
      log(`Yapes: relleno de hoy — ${encontrados.size} mensaje(s) recibidos del historial, ${deHoy.length} de hoy`);
      let n = 0, total = 0;
      for (const m of deHoy) {
        const monto = await procesar(m, true).catch(e => { log('Yapes: relleno:', e.message); return 0; });
        if (monto > 0) { n++; total += monto; }
      }
      const resumen = n
        ? `✅ Listo: ${n} yape(s) de hoy agregados a la caja (total S/ ${total.toFixed(2)}).`
        : '✅ Listo: no encontré yapes nuevos de hoy para agregar.';
      log('Yapes:', resumen);
      await sock.sendMessage(g.id, { text: resumen }).then(m => marcar(m.key.id)).catch(() => {});
    } catch (e) {
      log('Yapes: no se pudo rellenar hoy:', e.message);
    } finally {
      rellenandoAhora = false;
    }
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
  function rellenar() { fila = fila.then(rellenarHoy); return fila; }

  return { engancharSocket, rellenar };
}

module.exports = { crear };
