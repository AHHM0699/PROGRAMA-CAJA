// ════════════════════════════════════════════════════════════════════
//  SERVIDOR DE CAJA — Android (Termux)  —  reemplaza a la PC TROEFAE
//
//  El Samsung mantiene UNA conexión permanente con la POS-D. La impresora
//  atiende una sola conexión a la vez, así que todo lo que se imprima
//  tiene que pasar por aquí; quien intente imprimir directo a la .250
//  queda bloqueado.
//
//  1. Sensor de gaveta: ASB (GS a) hace que la impresora avise sola cada
//     vez que la gaveta se abre o se cierra. Cada apertura física queda
//     registrada y se clasifica según su causa:
//        impresion      → un trabajo pasó por el proxy justo antes
//        boton          → orden de la webapp (gavetaComandos)
//        no-autorizada  → nada la explica (llave, u otro dispositivo)
//  2. Proxy de impresión: RawBT y los demás celulares imprimen a
//     IP_DEL_SAMSUNG:9100; los trabajos se encolan y se reenvían por la
//     conexión permanente.
//  3. Gaveta remota: escucha gavetaComandos (status 'pending') y manda
//     ESC p 0 25 250.
//  4. Reporte de caja: escucha requests/reporte-caja y responde en
//     reporteCaja/{fecha} con { times: ["HH:MM:SS", ...], updatedAt }.
// ════════════════════════════════════════════════════════════════════
'use strict';

const net   = require('net');
const fs    = require('fs');
const path  = require('path');
const dgram = require('dgram');

const os    = require('os');
const { initializeApp, getApps, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// config.json es opcional: solo hace falta para cambiar los valores por defecto.
// replace: tolera el BOM que agregan algunos editores.
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^﻿/, ''));
} catch (e) { /* sin config.json */ }

const PROJECT_ID = CONFIG.projectId || 'programa-caja';
// Sesión de Gmail que deja `firebase login` en el celular
const FIREBASE_TOOLS_STORE = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
// Cliente OAuth público de firebase-tools (lib/api.js, verificado en v15.34.0):
// el refresh_token de `firebase login` solo se puede canjear con este cliente.
const FIREBASE_TOOLS_CLIENT_ID     = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_TOOLS_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

const PRINTER_HOST = CONFIG.printerHost || '192.168.1.250';
const PRINTER_PORT = CONFIG.printerPort || 9100;
const LISTEN_HOST  = CONFIG.listenHost  || '0.0.0.0';
const LISTEN_PORT  = CONFIG.listenPort  || 9100;
const TZ           = 'America/Lima';
const DATA_DIR     = path.join(__dirname, 'data');

const CMD_GAVETA   = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);  // ESC p 0 25 250
const CMD_ASB_ON   = Buffer.from([0x1d, 0x61, 0x0f]);              // GS a 15
const CMD_ESTADO   = Buffer.from([0x10, 0x04, 0x01]);              // DLE EOT 1

// Ventana para atribuir una apertura a su causa
const VENTANA_CAUSA_MS = 6000;
// Si la impresora no responde nada en este tiempo, se reconecta
const SILENCIO_MAX_MS  = 10000;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Utilidades ──────────────────────────────────────────────────────
function log(...a) {
  const ts = new Date().toLocaleString('sv-SE', { timeZone: TZ });
  console.log(`[${ts}]`, ...a);
}
function fechaPE(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d);
}
function horaPE(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(d);
}

// ── Aviso a la cámara (camara.js, proceso aparte) ──────────────────
//  Datagrama UDP local sin esperar respuesta: si camara.js no está
//  corriendo o falla, la caja no se entera.
const PUERTO_CAMARA = (CONFIG.camara && CONFIG.camara.puertoAvisos) || 9199;
let avisoCamara = null;
function avisarCamara(ev) {
  try {
    if (!avisoCamara) {
      avisoCamara = dgram.createSocket('udp4');
      avisoCamara.on('error', () => {});
      avisoCamara.unref();
    }
    avisoCamara.send(JSON.stringify({ ...ev, iso: new Date().toISOString() }),
                     PUERTO_CAMARA, '127.0.0.1', () => {});
  } catch (e) { /* nunca debe afectar a la caja */ }
}

// ── Registro local por día (respaldo sin red) ───────────────────────
function archivo(tipo, fecha) { return path.join(DATA_DIR, `${tipo}-${fecha}.json`); }
function leer(tipo, fecha) {
  try { return JSON.parse(fs.readFileSync(archivo(tipo, fecha), 'utf8')); }
  catch (e) { return []; }
}
function anotar(tipo, entry) {
  const fecha = fechaPE(new Date(entry.iso));
  const lista = leer(tipo, fecha);
  lista.push(entry);
  fs.writeFileSync(archivo(tipo, fecha), JSON.stringify(lista, null, 1));
  // Copia en Firestore: si roban el celular, el registro no se pierde
  if (db) {
    db.doc(`${tipo}/${fecha}`).set({ lista: FieldValue.arrayUnion(entry) }, { merge: true })
      .catch(e => log(`No se pudo subir ${tipo}:`, e.message));
  }
}

// ════════════════════════════════════════════════════════════════════
//  CONEXIÓN PERMANENTE CON LA IMPRESORA
// ════════════════════════════════════════════════════════════════════
let impresora     = null;    // socket
let conectada     = false;
let ultimoDato    = 0;
let gavetaAbierta = null;    // null = desconocido
let aperturaDesde = null;
let clienteActivo = null;    // socket del trabajo en curso (recibe las respuestas)
let buffer        = Buffer.alloc(0);
let fallosSeguidos = 0;
let recibioDatos   = false;   // la conexión actual ya recibió algo de la impresora
let trabajoActual  = null;    // { tipo:'impresion', origen } mientras un trabajo pasa por el proxy
let causaApertura  = null;    // causa fijada en el momento en que se abrió la gaveta

function conectarImpresora() {
  impresora = net.createConnection({ host: PRINTER_HOST, port: PRINTER_PORT });
  impresora.setNoDelay(true);
  impresora.setKeepAlive(true, 5000);

  impresora.on('connect', () => {
    conectada    = true;
    recibioDatos = false;
    ultimoDato   = Date.now();
    buffer       = Buffer.alloc(0);
    log(`Conectado a la impresora ${PRINTER_HOST}:${PRINTER_PORT}`);
    impresora.write(CMD_ASB_ON);
    procesarCola();
  });

  impresora.on('data', recibirDeImpresora);

  impresora.on('error', e => log('Impresora:', e.message));
  impresora.on('close', () => {
    if (conectada) log('Se perdió la conexión con la impresora');
    // Conexión que no llegó a recibir nada: la impresora la rechazó
    if (!recibioDatos) fallosSeguidos++;
    conectada = false;
    impresora = null;
    // Reintento cada vez más espaciado: reconectar muy seguido satura a la
    // POS-D, y si quedó trabada con una sesión vieja necesita tiempo para soltarla
    const espera = Math.min(60000, 5000 * 2 ** Math.min(fallosSeguidos, 4));
    if (fallosSeguidos) log(`Reintento con la impresora en ${espera / 1000}s`);
    setTimeout(conectarImpresora, espera);
  });
}

// Respaldo del ASB: consulta de estado por la MISMA conexión (nunca abre
// conexiones nuevas). Si la impresora deja de responder, se reconecta.
setInterval(() => {
  if (!conectada || trabajoEnCurso) return;
  if (Date.now() - ultimoDato > SILENCIO_MAX_MS) {
    log('La impresora no responde, reconectando…');
    impresora.destroy();
    return;
  }
  impresora.write(CMD_ESTADO);
}, 1000);

//  La impresora mezcla en el mismo canal:
//   - paquetes ASB de 4 bytes (primer byte con patrón 0xx1xx00 → &0x93 == 0x10)
//   - respuestas DLE EOT de 1 byte (&0x93 == 0x12)
//   - cualquier otra respuesta pedida por el cliente activo (se le reenvía)
function recibirDeImpresora(chunk) {
  ultimoDato = Date.now();
  recibioDatos = true;
  fallosSeguidos = 0;
  buffer = Buffer.concat([buffer, chunk]);
  const paraCliente = [];

  while (buffer.length) {
    const b = buffer[0];
    if ((b & 0x93) === 0x10) {                 // ASB
      if (buffer.length < 4) break;
      actualizarGaveta((b & 0x04) === 0, 'asb');
      buffer = buffer.subarray(4);
    } else if ((b & 0x93) === 0x12) {          // DLE EOT 1
      actualizarGaveta((b & 0x04) === 0, 'estado');
      if (clienteActivo) paraCliente.push(b);  // RawBT también consulta estado
      buffer = buffer.subarray(1);
    } else {
      paraCliente.push(b);
      buffer = buffer.subarray(1);
    }
  }
  if (clienteActivo && paraCliente.length) clienteActivo.write(Buffer.from(paraCliente));
}

function enviarAImpresora(data) {
  if (!conectada) throw new Error('impresora desconectada');
  impresora.write(data);
}

// ════════════════════════════════════════════════════════════════════
//  SENSOR DE GAVETA Y CLASIFICACIÓN
// ════════════════════════════════════════════════════════════════════
const causasRecientes = [];   // { tipo, ts, motivo?, origen? }

function anotarCausa(c) {
  causasRecientes.push({ ...c, ts: Date.now() });
  while (causasRecientes.length && Date.now() - causasRecientes[0].ts > 60000) causasRecientes.shift();
}

function buscarCausa(ts) {
  for (let i = causasRecientes.length - 1; i >= 0; i--) {
    const c = causasRecientes[i];
    if (!c.usada && ts - c.ts >= -500 && ts - c.ts <= VENTANA_CAUSA_MS) {
      c.usada = true;
      return c;
    }
  }
  return null;
}

function actualizarGaveta(abierta, fuente) {
  if (gavetaAbierta === null) {             // primer dato tras conectar
    gavetaAbierta = abierta;
    log(`Gaveta ${abierta ? 'ABIERTA' : 'cerrada'} (estado inicial)`);
    if (abierta) {
      aperturaDesde = new Date();
      // No se vio abrirse: no se puede saber la causa (suele ser un
      // artefacto de la reconexión); no se marca como no autorizada.
      causaApertura = { tipo: 'reconexion' };
    }
    return;
  }
  if (abierta === gavetaAbierta) return;
  gavetaAbierta = abierta;

  if (abierta) {
    aperturaDesde = new Date();
    // La causa se decide AL ABRIR: si se espera al cierre, una gaveta que
    // quedó abierta varios minutos ya no encuentra su orden.
    // Abierta mientras un trabajo pasa por el proxy: la causa es ese trabajo.
    causaApertura = trabajoActual || buscarCausa(aperturaDesde.getTime());
    log(`Gaveta ABIERTA (${fuente})`);
    avisarCamara({ tipo: 'apertura', causa: causaApertura ? causaApertura.tipo : 'no-autorizada' });
    return;
  }

  // Al cerrarse se registra la apertura completa con su duración
  const desde = aperturaDesde || new Date();
  const hasta = new Date();
  aperturaDesde = null;
  const causa = causaApertura;
  causaApertura = null;
  const entry = {
    hora:     horaPE(desde),
    iso:      desde.toISOString(),
    cerrada:  horaPE(hasta),
    segundos: Math.round((hasta - desde) / 100) / 10,
    causa:    causa ? causa.tipo : 'no-autorizada',
  };
  if (causa && causa.motivo) entry.motivo = causa.motivo;
  if (causa && causa.origen) entry.origen = causa.origen;
  anotar('aperturasFisicas', entry);
  log(`Gaveta cerrada — abierta ${entry.segundos}s desde ${entry.hora} → ${entry.causa}` +
      (entry.motivo ? ` (${entry.motivo})` : '') + (entry.origen ? ` [${entry.origen}]` : ''));
}

// ════════════════════════════════════════════════════════════════════
//  PROXY DE IMPRESIÓN (cola de trabajos)
// ════════════════════════════════════════════════════════════════════
const cola = [];
let trabajoEnCurso = false;

const proxy = net.createServer(cliente => {
  cliente.pause();
  cola.push(cliente);
  procesarCola();
});
proxy.on('error', e => { log('El proxy no pudo iniciar:', e.message); process.exit(1); });
proxy.listen(LISTEN_PORT, LISTEN_HOST, () =>
  log(`Proxy de impresión escuchando en ${LISTEN_HOST}:${LISTEN_PORT}`));

function procesarCola() {
  if (trabajoEnCurso || !conectada || !cola.length) return;
  const cliente = cola.shift();
  if (cliente.destroyed) return procesarCola();

  trabajoEnCurso = true;
  clienteActivo  = cliente;
  const origen   = (cliente.remoteAddress || '').replace('::ffff:', '');
  const inicio   = new Date();
  let bytes = 0;
  let traeGaveta = false;     // el trabajo ya incluye ESC p
  let previo = -1;            // último byte del chunk anterior (ESC p partido en dos)
  // La gaveta se abre MIENTRAS se imprime: la causa se anota al empezar
  trabajoActual = { tipo: 'impresion', origen, ts: Date.now() };
  avisarCamara({ tipo: 'impresion', origen });

  const trabajo  = trabajoActual;

  const terminar = () => {
    if (!trabajoEnCurso || clienteActivo !== cliente) return;
    clienteActivo  = null;
    trabajoEnCurso = false;
    trabajoActual  = null;
    // Solo la orden de gaveta, sin nada impreso (p. ej. el botón "abrir
    // cajón" de RawBT): se abrió la caja sin comprobante.
    if (bytes < (CONFIG.minBytesImpresion || 32) && traeGaveta) {
      trabajo.tipo = 'gaveta-directa';
      anotar('impresiones', { hora: horaPE(inicio), iso: inicio.toISOString(), origen, bytes, gaveta: 'directa sin impresion' });
      log(`Orden de gaveta DIRECTA desde ${origen} sin imprimir nada`);
    }
    if (bytes >= (CONFIG.minBytesImpresion || 32)) {
      let gaveta = traeGaveta ? 'propia' : 'no';
      // Como con la PC de antes, cada impresión abre la gaveta aunque el
      // RawBT de ese celular no tenga configurada la orden.
      if (!traeGaveta && CONFIG.abrirGavetaEnCadaImpresion !== false && conectada) {
        anotarCausa({ tipo: 'impresion', origen });
        impresora.write(CMD_GAVETA);
        gaveta = 'agregada por el servidor';
      }
      anotar('impresiones', { hora: horaPE(inicio), iso: inicio.toISOString(), origen, bytes, gaveta });
      log(`Impresión de ${origen} (${bytes} bytes) — orden de gaveta: ${gaveta}`);
    }
    // RawBT puede mandar ESC @ o desactivar el ASB: se vuelve a activar
    if (conectada) impresora.write(CMD_ASB_ON);
    setImmediate(procesarCola);
  };

  cliente.on('data', chunk => {
    bytes += chunk.length;
    if (!traeGaveta) {
      if (previo === 0x1b && chunk[0] === 0x70) traeGaveta = true;
      for (let i = 0; i < chunk.length - 1 && !traeGaveta; i++) {
        if (chunk[i] === 0x1b && chunk[i + 1] === 0x70) traeGaveta = true;
      }
      previo = chunk[chunk.length - 1];
    }
    try { enviarAImpresora(chunk); }
    catch (e) { log('Trabajo perdido:', e.message); cliente.destroy(); }
  });
  cliente.on('end',   () => cliente.end());
  cliente.on('close', terminar);
  cliente.on('error', e => log(`Error con ${origen}:`, e.message));
  // Un trabajo colgado no puede bloquear la impresora para siempre
  cliente.setTimeout(30000, () => cliente.destroy());
  cliente.resume();
}

// ════════════════════════════════════════════════════════════════════
//  FIREBASE
// ════════════════════════════════════════════════════════════════════
//  Entra con la cuenta de Gmail de `firebase login` (dueña del proyecto),
//  igual que en TROEFAE. Con firebase-admin no dependen de las reglas
//  de Firestore.
let db = null;

//  Firestore solo acepta la sesión de usuario como "Application Default
//  Credentials": se arma el archivo authorized_user a partir de la sesión
//  de firebase-tools y se apunta GOOGLE_APPLICATION_CREDENTIALS a él.
const ADC_FILE = path.join(__dirname, 'credencial-gmail.json');

function credencialGmail() {
  const store = JSON.parse(fs.readFileSync(FIREBASE_TOOLS_STORE, 'utf8'));
  const refresh = store.tokens && store.tokens.refresh_token;
  if (!refresh) throw new Error('falta la sesión: ejecuta  firebase login --no-localhost');
  fs.writeFileSync(ADC_FILE, JSON.stringify({
    type:             'authorized_user',
    client_id:        FIREBASE_TOOLS_CLIENT_ID,
    client_secret:    FIREBASE_TOOLS_CLIENT_SECRET,
    refresh_token:    refresh,
    quota_project_id: PROJECT_ID
  }), { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = ADC_FILE;
  return { cuenta: store.user && store.user.email, credential: applicationDefault() };
}

async function iniciarFirebase() {
  const { cuenta, credential } = credencialGmail();
  if (!getApps().length) initializeApp({ credential, projectId: PROJECT_ID });
  db = getFirestore();
  await db.doc('requests/reporte-caja').get();   // valida la sesión antes de escuchar
  log(`Firebase conectado como ${cuenta || '(cuenta de firebase login)'}`);
  escucharGaveta();
  escucharReporte();
}

function arrancarFirebase() {
  iniciarFirebase().catch(e => {
    log('No se pudo conectar a Firebase:', e.message, '— reintento en 60s; el sensor sigue registrando.');
    setTimeout(arrancarFirebase, 60000);
  });
}

// Si un listener se corta (sin internet, etc.) se vuelve a suscribir
function reintentar(nombre, fn) {
  return e => {
    log(`Error escuchando ${nombre}:`, e.message, '— reintento en 30s');
    setTimeout(fn, 30000);
  };
}

// ── Gaveta remota ───────────────────────────────────────────────────
const _comandosVistos = new Set();

function escucharGaveta() {
  db.collection('gavetaComandos').where('status', '==', 'pending').onSnapshot(snap => {
    snap.docChanges().forEach(async ch => {
      if (ch.type !== 'added' || _comandosVistos.has(ch.doc.id)) return;
      _comandosVistos.add(ch.doc.id);
      const data = ch.doc.data();
      // Órdenes viejas (celular apagado un rato) no se ejecutan
      const pedido = data.requestedAt && data.requestedAt.toDate ? data.requestedAt.toDate() : new Date();
      if (Date.now() - pedido.getTime() > 2 * 60 * 1000) {
        await ch.doc.ref.update({ status: 'expirado' }).catch(() => {});
        return;
      }
      try {
        anotarCausa({ tipo: 'boton', motivo: data.motivo || '' });
        enviarAImpresora(CMD_GAVETA);
        await ch.doc.ref.update({ status: 'done', doneAt: FieldValue.serverTimestamp() });
        log(`Orden de gaveta ejecutada — ${data.motivo || '(sin motivo)'}`);
      } catch (e) {
        log('No se pudo abrir la gaveta:', e.message);
        await ch.doc.ref.update({ status: 'error', error: e.message }).catch(() => {});
      }
    });
  }, reintentar('gavetaComandos', escucharGaveta));
}

// ── Reporte de caja ─────────────────────────────────────────────────
//  "times" son las aperturas FÍSICAS reales (sensor), igual que antes
//  TROEFAE entregaba una hora por cada vez que se abría la gaveta.
async function timesDelDia(fecha) {
  let lista = leer('aperturasFisicas', fecha);
  if (!lista.length) {
    const snap = await db.doc(`aperturasFisicas/${fecha}`).get().catch(() => null);
    if (snap && snap.exists) lista = snap.data().lista || [];
  }
  // Las "reconexion" no se vieron abrirse: no cuentan como apertura
  return lista.filter(e => e.causa !== 'reconexion').map(e => e.hora).sort();
}

function escucharReporte() {
  db.doc('requests/reporte-caja').onSnapshot(async snap => {
    if (!snap.exists) return;
    const req = snap.data();
    if (req.status !== 'pending') return;
    const fecha = req.fecha || fechaPE();
    // La app espera la respuesta solo 30s: una solicitud vieja (p. ej. de
    // cuando el servidor estuvo apagado) ya no tiene a quién responder.
    const pedido = req.requestedAt && req.requestedAt.toDate ? req.requestedAt.toDate() : null;
    if (!pedido || Date.now() - pedido.getTime() > 2 * 60 * 1000) {
      await snap.ref.update({ status: 'expirado' }).catch(() => {});
      log(`Solicitud de reporte ${fecha} vieja: marcada como expirada, no se responde`);
      return;
    }
    try {
      const times = await timesDelDia(fecha);
      // Nunca pisar con una lista vacía datos que ya existen (p. ej. de TROEFAE)
      if (!times.length) {
        const previo = await db.doc(`reporteCaja/${fecha}`).get();
        if (previo.exists && (previo.data().times || []).length) {
          await db.doc(`reporteCaja/${fecha}`).update({ updatedAt: FieldValue.serverTimestamp() });
          await snap.ref.update({ status: 'done' });
          log(`Reporte de caja ${fecha}: sin registros nuevos, se conservan los ${previo.data().times.length} existentes`);
          return;
        }
      }
      await db.doc(`reporteCaja/${fecha}`).set({
        fecha, times, updatedAt: FieldValue.serverTimestamp(), origen: 'android'
      });
      await snap.ref.update({ status: 'done' });
      log(`Reporte de caja ${fecha}: ${times.length} apertura(s)`);
    } catch (e) {
      log('Error respondiendo el reporte:', e.message);
    }
  }, reintentar('requests/reporte-caja', escucharReporte));
}

// ── Arranque ────────────────────────────────────────────────────────
conectarImpresora();
arrancarFirebase();
