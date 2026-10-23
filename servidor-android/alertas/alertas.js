// ════════════════════════════════════════════════════════════════════
//  ALERTAS POR WHATSAPP — Android (Termux)  —  proceso APARTE
//
//  Manda un WhatsApp desde el número del Samsung al dueño cada vez que
//  la gaveta se abre por algo que NO es una impresión de comprobante:
//  llave, botón de la webapp u orden directa de RawBT. Cuando el video
//  de esa apertura termina de subirse a Drive, manda también el enlace.
//
//  - servidor.js y camara.js avisan por UDP local (127.0.0.1) y nunca
//    esperan respuesta: si este proceso falla, la caja y la cámara siguen.
//  - Usa WhatsApp como "dispositivo vinculado" (Baileys, no oficial).
//    Primera vez:  node alertas.js --vincular 51XXXXXXXXX  (número del
//    Samsung) y escribir el código en WhatsApp → Dispositivos vinculados.
// ════════════════════════════════════════════════════════════════════
'use strict';

const dgram = require('dgram');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8').replace(/^﻿/, ''));
} catch (e) { /* sin config.json */ }
const AL = CONFIG.alertas || {};

const DESTINO   = String(AL.whatsapp || '').replace(/\D/g, '');   // número del dueño, solo dígitos
const PUERTO    = AL.puertoAvisos || 9198;
const AUTH_DIR  = path.join(__dirname, 'whatsapp-sesion');
const TZ        = 'America/Lima';
const MAX_COLA  = 50;

try { os.setPriority(19); } catch (e) {}

function log(...a) {
  const ts = new Date().toLocaleString('sv-SE', { timeZone: TZ });
  console.log(`[${ts}]`, ...a);
}
function horaPE(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(d);
}

// libsignal escribe en consola cada mensaje ENTRANTE que no logra descifrar
// (al Samsung le llegan copias de todos sus chats). No afecta las alertas,
// pero llenaba el log con cientos de líneas por minuto: se cuentan y se
// resumen cada 10 minutos (si hubo).
const RUIDO_SIGNAL = /^(Session error|Failed to decrypt|Opening session|Closing |Migrating session|Session already|Removing old closed session|Decrypted message with closed session)/;
let noDescifrados = 0;
for (const k of ['log', 'error', 'warn', 'info']) {
  const original = console[k].bind(console);
  console[k] = (...a) => {
    const t = typeof a[0] === 'string' ? a[0] : '';
    if (!RUIDO_SIGNAL.test(t)) return original(...a);
    if (t.startsWith('Failed to decrypt')) noDescifrados++;
  };
}
setInterval(() => {
  if (!noDescifrados) return;
  log(`Mensajes entrantes sin descifrar en 10 min: ${noDescifrados} (no afecta las alertas)`);
  noDescifrados = 0;
}, 600e3);

const vincular = process.argv.indexOf('--vincular');
const NUMERO_SAMSUNG = vincular > -1 ? String(process.argv[vincular + 1] || '').replace(/\D/g, '') : '';
if (!DESTINO && vincular < 0) { log('Falta alertas.whatsapp en config.json'); process.exit(1); }

// ════════════════════════════════════════════════════════════════════
//  WHATSAPP
// ════════════════════════════════════════════════════════════════════
// Baileys 7 cifra para el LID del destino (con la 6 el celular del dueño
// no descifraba la primera entrega y todo dependía del reenvío). Es un
// módulo ESM: se carga con import() al conectar.
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers,
  makeCacheableSignalKeyStore, proto;
async function cargarBaileys() {
  if (makeWASocket) return;
  ({
    default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers,
    makeCacheableSignalKeyStore, proto
  } = await import('@whiskeysockets/baileys'));
}
const pino = require('pino');
const logger = pino({ level: 'silent' });

let sock = null;
let listo = false;
const cola = [];      // mensajes esperando conexión

// ── Mensajes enviados ───────────────────────────────────────────────
// Si el celular que recibe no logra descifrar un mensaje, pide que se lo
// reenvíen. Sin el mensaje guardado no hay qué reenviar y en el destino
// queda para siempre "Esperando mensaje".
const ENVIADOS = path.join(__dirname, 'enviados.json');
const MAX_ENVIADOS = 300;
let enviados = {};
try { enviados = JSON.parse(fs.readFileSync(ENVIADOS, 'utf8')); } catch (e) { /* vacío */ }
function guardarEnviado(m) {
  if (!m || !m.key || !m.key.id || !m.message) return;
  enviados[m.key.id] = m.message;
  const ids = Object.keys(enviados);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ENVIADOS))) delete enviados[id];
  try { fs.writeFileSync(ENVIADOS, JSON.stringify(enviados)); } catch (e) { log('No se pudo guardar enviados:', e.message); }
}
async function getMessage(key) {
  const m = key && enviados[key.id];
  if (m) log('Reenviando mensaje que el destino no pudo descifrar');
  return m ? proto.Message.fromObject(m) : undefined;
}

// Cuenta los reintentos de cada mensaje (Baileys pide get/set/del/flushAll)
const reintentos = new Map();
const msgRetryCounterCache = {
  get: k => reintentos.get(k), set: (k, v) => { reintentos.set(k, v); },
  del: k => { reintentos.delete(k); }, flushAll: () => reintentos.clear(),
};

// La sesión se carga UNA vez y se comparte entre reconexiones: dos copias
// escribiendo los mismos archivos desordenan las claves de cifrado
let auth = null;
let reconexion = null;

async function conectar() {
  await cargarBaileys();
  if (!auth) auth = await useMultiFileAuthState(AUTH_DIR);
  const { state, saveCreds } = auth;
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { /* usa la de la librería */ }

  // Nunca dos conexiones a la vez: se cierra la anterior antes de abrir otra
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(undefined); } catch (e) {}
    sock = null;
  }

  sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    version, logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage, msgRetryCounterCache,
    // La vinculación por código solo acepta navegadores conocidos
    browser: Browsers.ubuntu('Chrome'),
  });
  sock.ev.on('creds.update', saveCreds);

  // Quién pide un reenvío (celular del dueño, otro dispositivo o el propio
  // Samsung): dice por qué un mensaje se queda en "Esperando mensaje"
  sock.ws.on('CB:receipt', node => {
    if (!node.attrs || node.attrs.type !== 'retry') return;
    const [usuario, dominio] = String(node.attrs.participant || node.attrs.from || '').split('@');
    const [num, disp] = usuario.split(':');
    const yo = sock.user ? [sock.user.id, sock.user.lid] : [];
    const quien = num === DESTINO ? 'dueño'
      : yo.some(j => j && j.split(/[:@]/)[0] === num) ? 'Samsung' : 'otro';
    const r = Array.isArray(node.content) && node.content.find(c => c.tag === 'retry');
    log(`Pedido de reenvío: ${quien}${dominio === 'lid' ? ' (lid)' : ''}, dispositivo ${disp || 0}, intento ${r ? r.attrs.count : '?'}`);
  });

  // El código se pide cuando WhatsApp ya está listo para vincular (evento qr)
  let pidioCodigo = false;
  sock.ev.on('connection.update', async ({ qr }) => {
    if (!qr || !NUMERO_SAMSUNG || pidioCodigo || state.creds.registered) return;
    pidioCodigo = true;
    try {
      const codigo = await sock.requestPairingCode(NUMERO_SAMSUNG);
      log(`CÓDIGO DE VINCULACIÓN: ${codigo}`);
      log('En el Samsung: WhatsApp → Dispositivos vinculados → Vincular con número de teléfono');
    } catch (e) { log('No se pudo pedir el código:', e.message); }
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      listo = true;
      log('WhatsApp conectado');
      if (vincular > -1) { log('Vinculado. Ya puedes cerrar esto (Ctrl+C).'); }
      vaciarCola();
    }
    if (connection === 'close') {
      listo = false;
      const codigo = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode : 0;
      if (codigo === DisconnectReason.loggedOut) {
        log('WhatsApp cerró la sesión: hay que volver a vincular (node alertas.js --vincular ...)');
        // Una sesión a medio vincular no sirve: se borra para empezar limpio
        if (vincular > -1) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        process.exit(2);
      }
      log(`WhatsApp desconectado (${codigo || 'sin código'}) — reconecto en 10s`);
      // Una sola reconexión pendiente aunque lleguen varios "close" seguidos
      if (reconexion) return;
      reconexion = setTimeout(() => {
        reconexion = null;
        conectar().catch(e => log('Error al reconectar:', e.message));
      }, 10000);
    }
  });
}

function enviar(texto) {
  cola.push(texto);
  while (cola.length > MAX_COLA) cola.shift();
  vaciarCola();
}

let enviando = false;
async function vaciarCola() {
  if (enviando || !listo || !cola.length) return;
  enviando = true;
  try {
    while (cola.length && listo) {
      const m = await sock.sendMessage(`${DESTINO}@s.whatsapp.net`, { text: cola[0] });
      guardarEnviado(m);
      cola.shift();
    }
  } catch (e) {
    log('No se pudo enviar:', e.message, `(${cola.length} en espera)`);
  } finally {
    enviando = false;
  }
}

// ════════════════════════════════════════════════════════════════════
//  AVISOS (servidor.js y camara.js)
// ════════════════════════════════════════════════════════════════════
function mensaje(ev) {
  const hora = horaPE(ev.iso ? new Date(ev.iso) : new Date());
  if (ev.tipo === 'apertura' && ev.causa === 'no-autorizada') {
    return `🔑 *Apertura con llave* — ${hora}\nLa gaveta se abrió sin impresión ni orden del celular.`;
  }
  if (ev.tipo === 'apertura' && ev.causa === 'boton') {
    return `📱 *Apertura desde la webapp* — ${hora}` + (ev.motivo ? `\nMotivo: ${ev.motivo}` : '');
  }
  if (ev.tipo === 'gaveta-directa') {
    return `📱 *Apertura desde celular (RawBT)* — ${hora}\nSin comprobante · ${ev.origen || ''}`;
  }
  if (ev.tipo === 'video' && ev.url) {
    return `📹 Video de la apertura de las ${ev.hora}: ${ev.url}`;
  }
  return null;   // impresiones normales: sin alerta
}

if (vincular < 0) {
  const udp = dgram.createSocket('udp4');
  udp.on('message', m => {
    let ev;
    try { ev = JSON.parse(m.toString()); } catch (e) { return; }
    const texto = mensaje(ev);
    if (!texto) return;
    log('Alerta:', texto.split('\n')[0]);
    enviar(texto);
  });
  udp.on('error', e => { log('Avisos UDP:', e.message); process.exit(1); });
  udp.bind(PUERTO, '127.0.0.1', () => log(`Alertas listas: esperando avisos en 127.0.0.1:${PUERTO}`));
}

// Sin vincular: se queda esperando sin conectar (no tiene sentido reintentar)
if (vincular < 0 && !fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
  log('FALTA vincular WhatsApp:  node alertas.js --vincular 51XXXXXXXXX');
} else {
  // Borra TODAS las sesiones de cifrado y claves de grupo (no la
  // vinculación): WhatsApp las vuelve a armar en el próximo mensaje
  if (process.argv.includes('--reiniciar-cifrado')) {
    let n = 0;
    for (const f of fs.readdirSync(AUTH_DIR)) {
      if (/^(session|sender-key)-/.test(f)) { fs.rmSync(path.join(AUTH_DIR, f)); n++; }
    }
    log(`Sesiones de cifrado borradas: ${n}`);
  }
  conectar().catch(e => { log('Error de WhatsApp:', e.message); process.exit(1); });
}
