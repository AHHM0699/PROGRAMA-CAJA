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

const vincular = process.argv.indexOf('--vincular');
const NUMERO_SAMSUNG = vincular > -1 ? String(process.argv[vincular + 1] || '').replace(/\D/g, '') : '';
if (!DESTINO && vincular < 0) { log('Falta alertas.whatsapp en config.json'); process.exit(1); }

// ════════════════════════════════════════════════════════════════════
//  WHATSAPP
// ════════════════════════════════════════════════════════════════════
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');

let sock = null;
let listo = false;
const cola = [];      // mensajes esperando conexión

async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { /* usa la de la librería */ }

  sock = makeWASocket({
    auth: state, version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // La vinculación por código solo acepta navegadores conocidos
    browser: Browsers.ubuntu('Chrome'),
  });
  sock.ev.on('creds.update', saveCreds);

  if (NUMERO_SAMSUNG && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const codigo = await sock.requestPairingCode(NUMERO_SAMSUNG);
        log(`CÓDIGO DE VINCULACIÓN: ${codigo}`);
        log('En el Samsung: WhatsApp → Dispositivos vinculados → Vincular con número de teléfono');
      } catch (e) { log('No se pudo pedir el código:', e.message); }
    }, 3000);
  }

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
        process.exit(2);
      }
      log(`WhatsApp desconectado (${codigo || 'sin código'}) — reconecto en 10s`);
      setTimeout(() => conectar().catch(e => log('Error al reconectar:', e.message)), 10000);
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
      await sock.sendMessage(`${DESTINO}@s.whatsapp.net`, { text: cola[0] });
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
  conectar().catch(e => { log('Error de WhatsApp:', e.message); process.exit(1); });
}
