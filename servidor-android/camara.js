// ════════════════════════════════════════════════════════════════════
//  CÁMARA DE CAJA — Android (Termux)  —  proceso APARTE del servidor
//
//  servidor.js avisa por UDP local (127.0.0.1) cada impresión y cada
//  apertura de gaveta; este proceso arma un video desde 10 s ANTES del
//  aviso hasta 15 s DESPUÉS y lo sube a Google Drive ("Cámara Caja").
//
//  - Para tener los segundos previos, ffmpeg está siempre conectado a la
//    cámara (sin recodificar) y aquí se guardan en RAM solo los últimos
//    ~30 s, cortados en GOPs (cada uno empieza en un fotograma clave).
//  - Con internet nada toca el almacenamiento: RAM → MP4 → Drive. Sin
//    internet el video espera en data/camara-pendientes/ y se borra en
//    cuanto se sube.
//  - Si llega otro aviso mientras se arma un video, el video se alarga.
//  - Limpieza en Drive: lo de más de 7 días y, si la carpeta pasa de
//    50 GB, lo más antiguo.
//  - Si este proceso falla o se cae, la caja sigue igual: servidor.js
//    solo manda datagramas UDP y nunca espera respuesta.
// ════════════════════════════════════════════════════════════════════
'use strict';

const dgram = require('dgram');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const { spawn } = require('child_process');

let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^﻿/, ''));
} catch (e) { /* sin config.json */ }
const CAM   = CONFIG.camara || {};
const DRIVE = CONFIG.drive  || {};

const RTSP            = CAM.rtsp;
const ANTES_MS        = (CAM.segundosAntes   || 10) * 1000;
const DESPUES_MS      = (CAM.segundosDespues || 15) * 1000;
const MAX_MS          = (CAM.maxSegundos     || 120) * 1000;  // tope si los avisos no paran
const PUERTO          = CAM.puertoAvisos  || 9199;
const CARPETA         = CAM.carpetaDrive  || 'Cámara Caja';
const DIAS            = CAM.diasRetencion || 7;
const MAX_BYTES_DRIVE = (CAM.maxGB || 50) * 1024 ** 3;
const MAX_BYTES_LOCAL = (CAM.maxGBLocal || 5) * 1024 ** 3;     // espera sin internet
const TZ              = 'America/Lima';
const TOKEN_FILE      = path.join(__dirname, 'drive-token.json');
const PENDIENTES      = path.join(__dirname, 'data', 'camara-pendientes');

// Que la cámara nunca le quite CPU al servidor de caja
try { os.setPriority(19); } catch (e) {}
fs.mkdirSync(PENDIENTES, { recursive: true });

function log(...a) {
  const ts = new Date().toLocaleString('sv-SE', { timeZone: TZ });
  console.log(`[${ts}]`, ...a);
}
function fechaPE(d) { return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d); }
function horaPE(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).format(d);
}
function prioridadBaja(proc) { try { os.setPriority(proc.pid, 19); } catch (e) {} }

if (!RTSP) { log('Falta camara.rtsp en config.json'); process.exit(1); }

// ════════════════════════════════════════════════════════════════════
//  CAPTURA CONTINUA EN RAM (MPEG-TS por stdout)
// ════════════════════════════════════════════════════════════════════
//  El video va primero (-map 0:v:0), así que su PID es 0x100; PAT y PMT
//  se guardan aparte para anteponerlos a cada video.
const PID_VIDEO = 0x100;
const PID_PAT   = 0x000;
const PID_PMT   = 0x1000;

let gops     = [];       // [{ t, partes: [Buffer], bytes }]
let pat      = null;
let pmt      = null;
let resto    = Buffer.alloc(0);
let ultimoDato = 0;
let captura  = null;

function conectarCamara() {
  gops = []; pat = pmt = null; resto = Buffer.alloc(0);
  ultimoDato = Date.now();
  // -c copy: sin recodificar (H.265 + AAC tal cual) → casi sin CPU
  captura = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp', '-timeout', '5000000',
    '-i', RTSP,
    '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
    '-f', 'mpegts', '-mpegts_start_pid', String(PID_VIDEO), '-mpegts_pmt_start_pid', String(PID_PMT),
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  prioridadBaja(captura);
  const proc = captura;
  let errores = '';
  proc.stdout.on('data', recibirTS);
  proc.stderr.on('data', d => { errores = (errores + d).slice(-500); });
  proc.on('error', e => log('No se pudo lanzar ffmpeg:', e.message));
  proc.on('close', () => {
    if (captura === proc) captura = null;
    log('Se cortó la cámara' + (errores ? `: ${errores.trim()}` : '') + ' — reconecto en 5s');
    setTimeout(conectarCamara, 5000);
  });
  log('Conectando a la cámara…');
}

// Cámara colgada sin cerrar la conexión: se reinicia la captura.
// También cierra el video pendiente aunque la cámara no mande nada.
setInterval(() => {
  revisarClip(Date.now());
  if (captura && Date.now() - ultimoDato > 15000) {
    log('La cámara no manda video, reconectando…');
    try { captura.kill('SIGKILL'); } catch (e) {}
  }
}, 5000);

function recibirTS(chunk) {
  const ahora = Date.now();
  if (!gops.length) log('Recibiendo video de la cámara');
  ultimoDato = ahora;
  let buf = resto.length ? Buffer.concat([resto, chunk]) : chunk;
  // Paquetes TS de 188 bytes; se resincroniza si hace falta
  let i = 0;
  while (i + 188 <= buf.length) {
    if (buf[i] !== 0x47) { i++; continue; }
    const p   = buf.subarray(i, i + 188);
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    if (pid === PID_PAT) pat = Buffer.from(p);
    else if (pid === PID_PMT) pmt = Buffer.from(p);
    else {
      // Fotograma clave: inicio de unidad + random_access_indicator
      const clave = pid === PID_VIDEO && (p[1] & 0x40) && (p[3] & 0x20) && p[4] > 0 && (p[5] & 0x40);
      if (clave || !gops.length) gops.push({ t: ahora, partes: [], bytes: 0 });
      const g = gops[gops.length - 1];
      g.partes.push(Buffer.from(p));
      g.bytes += 188;
    }
    i += 188;
  }
  resto = Buffer.from(buf.subarray(i));
  recortar(ahora);
  revisarClip(ahora);
}

// Se conservan solo los GOPs que pueden hacer falta para el "antes"
function recortar(ahora) {
  const desde = clip ? clip.inicio : ahora - ANTES_MS;
  while (gops.length > 1 && gops[1].t <= desde) gops.shift();
}

// ════════════════════════════════════════════════════════════════════
//  ARMADO DEL VIDEO
// ════════════════════════════════════════════════════════════════════
let clip = null;   // { inicio, fin, limite, eventos }

function evento(ev) {
  const ahora = Date.now();
  ev.t = ahora;
  if (clip) {
    clip.eventos.push(ev);
    clip.fin = Math.min(Math.max(clip.fin, ahora + DESPUES_MS), clip.limite);
    return;
  }
  if (!captura || !gops.length) log(`Aviso sin video disponible (${describir(ev)}) — se graba lo que llegue`);
  const inicio = ahora - ANTES_MS;
  clip = { inicio, fin: ahora + DESPUES_MS, limite: inicio + MAX_MS, eventos: [ev] };
  log(`Grabando: ${describir(ev)}`);
}

function revisarClip(ahora) {
  if (!clip || ahora < clip.fin) return;
  const c = clip;
  clip = null;
  // Desde el último fotograma clave anterior al "antes"
  let k = 0;
  for (let j = 0; j < gops.length; j++) if (gops[j].t <= c.inicio) k = j;
  const elegidos = gops.slice(k);
  if (!elegidos.length || !pat || !pmt) { log(`Sin video para ${describir(c.eventos[0])}, se descarta`); return; }
  // Cada flujo (audio incluido) empieza en un paquete completo: un paquete
  // de audio cortado a la mitad hace fallar el paso a MP4
  const iniciados = new Set();
  const paquetes = elegidos.flatMap(g => g.partes).filter(p => {
    const pid = ((p[1] & 0x1f) << 8) | p[2];
    if (!iniciados.has(pid) && !(p[1] & 0x40)) return false;
    iniciados.add(pid);
    return true;
  });
  const ts = Buffer.concat([pat, pmt, ...paquetes]);
  const segundos = Math.round((ahora - elegidos[0].t) / 1000);
  aMP4(ts)
    .then(mp4 => encolar(c, mp4, 'mp4', segundos))
    .catch(e => { log('No se pudo pasar a MP4:', e.message, '— se sube en .ts'); encolar(c, ts, 'ts', segundos); });
  recortar(ahora);
}

// Re-empaquetado TS → MP4 sin recodificar, todo por pipes
function aMP4(ts) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-fflags', '+genpts+discardcorrupt',
      '-f', 'mpegts', '-i', 'pipe:0',
      '-c', 'copy', '-tag:v', 'hvc1', '-bsf:a', 'aac_adtstoasc', '-avoid_negative_ts', 'make_zero',
      '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    prioridadBaja(p);
    const partes = [];
    let errores = '';
    p.stdout.on('data', d => partes.push(d));
    p.stderr.on('data', d => { if (errores.length < 600) errores += d; });
    p.on('error', reject);
    p.stdin.on('error', () => {});
    p.on('close', code => {
      const out = Buffer.concat(partes);
      code === 0 && out.length ? resolve(out) : reject(new Error(errores.trim() || `código ${code}`));
    });
    p.stdin.end(ts);
  });
}

// Como el Samsung tiene la única conexión con la impresora, una apertura
// sin impresión ni orden del celular solo puede ser con la llave (o a mano)
function etiqueta(ev) {
  if (ev.tipo === 'gaveta-directa' || ev.causa === 'boton') return 'apertura desde celular';
  if (ev.causa === 'no-autorizada') return 'apertura con llave';
  if (ev.tipo === 'impresion' || ev.causa === 'impresion') return 'impresion';
  return ev.causa || ev.tipo;
}

function describir(ev) {
  return [etiqueta(ev), ev.motivo, ev.origen].filter(Boolean).join(' · ');
}

// Un trabajo de RawBT que solo abrió la gaveta llega primero como
// "impresión" y al terminar como "gaveta-directa": cuenta como celular
function etiquetas(eventos) {
  const directas = new Set(eventos.filter(e => e.tipo === 'gaveta-directa').map(e => e.origen));
  return [...new Set(eventos
    .filter(e => !(etiqueta(e) === 'impresion' && directas.has(e.origen)))
    .map(etiqueta))].join(' + ');
}

// ════════════════════════════════════════════════════════════════════
//  GOOGLE DRIVE (REST directo, sin dependencias)
// ════════════════════════════════════════════════════════════════════
const API = 'https://www.googleapis.com/drive/v3';
let token = null;   // { access, vence }

async function accessToken() {
  if (token && Date.now() < token.vence) return token.access;
  const guardado = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: DRIVE.clientId, client_secret: DRIVE.clientSecret,
      refresh_token: guardado.refresh_token, grant_type: 'refresh_token'
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token: ${j.error_description || j.error || r.status}`);
  token = { access: j.access_token, vence: Date.now() + (j.expires_in - 120) * 1000 };
  return token.access;
}

async function api(metodo, url, cuerpo) {
  const r = await fetch(url.startsWith('http') ? url : API + url, {
    method: metodo,
    headers: { Authorization: `Bearer ${await accessToken()}`,
               ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  if (!r.ok) throw new Error(`Drive ${metodo} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

const q = s => encodeURIComponent(s);
const carpetas = new Map();   // nombre|padre → id

async function carpeta(nombre, padre) {
  const clave = `${nombre}|${padre || 'root'}`;
  if (carpetas.has(clave)) return carpetas.get(clave);
  const filtro = `mimeType='application/vnd.google-apps.folder' and trashed=false and ` +
                 `name='${nombre.replace(/'/g, "\\'")}' and '${padre || 'root'}' in parents`;
  const r = await api('GET', `/files?q=${q(filtro)}&fields=files(id)`);
  const id = r.files.length ? r.files[0].id
    : (await api('POST', '/files?fields=id', {
        name: nombre, mimeType: 'application/vnd.google-apps.folder', parents: [padre || 'root']
      })).id;
  carpetas.set(clave, id);
  return id;
}

async function subir(v, datos) {
  const raiz = await carpeta(CARPETA);
  const dia  = await carpeta(v.fecha, raiz);
  const tipo = v.ext === 'mp4' ? 'video/mp4' : 'video/mp2t';
  // Subida reanudable: sin el tope de 5 MB de la subida simple
  const ini = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`,
               'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': tipo },
    body: JSON.stringify({
      name: v.nombre, parents: [dia], description: v.descripcion,
      appProperties: { camaraCaja: '1' }
    })
  });
  if (!ini.ok) throw new Error(`Drive inicio ${ini.status}: ${(await ini.text()).slice(0, 200)}`);
  const r = await fetch(ini.headers.get('location'), {
    method: 'PUT', headers: { 'Content-Type': tipo }, body: datos
  });
  if (!r.ok) throw new Error(`Drive subida ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// ── Subida: directa desde RAM; si falla, espera en el celular ────────
const enRam = [];
let subiendo = false;

function encolar(c, datos, ext, segundos) {
  const d = new Date(c.eventos[0].t);
  enRam.push({ v: {
    fecha: fechaPE(d), ext, segundos,
    nombre: `${horaPE(d).replace(/:/g, '-')} ${etiquetas(c.eventos)}.${ext}`,
    descripcion: c.eventos.map(e => `${horaPE(new Date(e.t))} ${describir(e)}`).join('\n')
  }, datos });
  procesarSubidas();
}

function guardarLocal(v, datos) {
  const base = path.join(PENDIENTES, `${v.fecha}_${v.nombre}`);
  fs.writeFileSync(base, datos);
  fs.writeFileSync(base + '.json', JSON.stringify(v));
  // Tope de espacio: se descartan los más viejos
  const archivos = fs.readdirSync(PENDIENTES).filter(f => !f.endsWith('.json')).sort();
  let total = archivos.reduce((s, f) => s + fs.statSync(path.join(PENDIENTES, f)).size, 0);
  while (total > MAX_BYTES_LOCAL && archivos.length > 1) {
    const f = path.join(PENDIENTES, archivos.shift());
    total -= fs.statSync(f).size;
    borrarLocal(f);
    log(`Espera local llena: se descarta ${path.basename(f)}`);
  }
}
function borrarLocal(f) {
  try { fs.unlinkSync(f); } catch (e) {}
  try { fs.unlinkSync(f + '.json'); } catch (e) {}
}

async function procesarSubidas() {
  if (subiendo) return;
  subiendo = true;
  try {
    // 1) Lo recién grabado (en RAM)
    while (enRam.length) {
      const { v, datos } = enRam[0];
      try {
        await subir(v, datos);
        log(`Subido ${v.fecha}/${v.nombre} (${v.segundos}s, ${(datos.length / 1048576).toFixed(1)} MB)`);
      } catch (e) {
        guardarLocal(v, datos);
        log('Sin subir:', e.message, '— queda en el celular hasta que haya internet');
      }
      enRam.shift();
    }
    // 2) Lo que quedó esperando en el celular
    const archivos = fs.readdirSync(PENDIENTES).filter(f => !f.endsWith('.json')).sort();
    for (const nombre of archivos) {
      if (enRam.length) break;   // lo nuevo tiene prioridad
      const f = path.join(PENDIENTES, nombre);
      let v;
      try { v = JSON.parse(fs.readFileSync(f + '.json', 'utf8')); }
      catch (e) { borrarLocal(f); continue; }
      await subir(v, fs.readFileSync(f));
      borrarLocal(f);
      log(`Subido (pendiente) ${v.fecha}/${v.nombre}`);
    }
  } catch (e) {
    log('Pendientes sin subir:', e.message, '— reintento en 60s');
  } finally {
    subiendo = false;
    if (enRam.length) setImmediate(procesarSubidas);
  }
}
setInterval(procesarSubidas, 60000);
setTimeout(procesarSubidas, 15000);

// ── Limpieza en Drive: 7 días o 50 GB, lo que ocurra primero ────────
async function limpiar() {
  const raiz = await carpeta(CARPETA);
  const videos = [];
  let pagina = '';
  do {
    const r = await api('GET', `/files?q=${q("appProperties has { key='camaraCaja' and value='1' } and trashed=false")}` +
      `&fields=nextPageToken,files(id,size,createdTime)&orderBy=createdTime&pageSize=1000` +
      (pagina ? `&pageToken=${pagina}` : ''));
    videos.push(...r.files);
    pagina = r.nextPageToken;
  } while (pagina);

  const limite = Date.now() - DIAS * 86400000;
  let total = videos.reduce((s, v) => s + Number(v.size || 0), 0);
  let borrados = 0;
  for (const v of videos) {   // del más antiguo al más nuevo
    if (new Date(v.createdTime).getTime() >= limite && total <= MAX_BYTES_DRIVE) break;
    await api('DELETE', `/files/${v.id}`);   // borrado definitivo: libera espacio ya
    total -= Number(v.size || 0);
    borrados++;
  }

  // Carpetas de días anteriores que quedaron vacías
  const dias = await api('GET', `/files?q=${q(`'${raiz}' in parents and trashed=false and ` +
    `mimeType='application/vnd.google-apps.folder'`)}&fields=files(id,name)`);
  for (const d of dias.files) {
    if (d.name >= fechaPE(new Date())) continue;
    const dentro = await api('GET', `/files?q=${q(`'${d.id}' in parents and trashed=false`)}&fields=files(id)&pageSize=1`);
    if (!dentro.files.length) {
      await api('DELETE', `/files/${d.id}`);
      for (const [k, id] of carpetas) if (id === d.id) carpetas.delete(k);
    }
  }
  if (borrados) log(`Limpieza: ${borrados} video(s) borrados, quedan ${(total / 1024 ** 3).toFixed(1)} GB`);
}

function limpiarSeguro() {
  limpiar().catch(e => log('Limpieza fallida:', e.message));
}
setTimeout(limpiarSeguro, 30000);
setInterval(limpiarSeguro, 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════
//  AVISOS DEL SERVIDOR DE CAJA
// ════════════════════════════════════════════════════════════════════
const sock = dgram.createSocket('udp4');
sock.on('message', m => {
  let ev;
  try { ev = JSON.parse(m.toString()); } catch (e) { return; }
  evento(ev);
});
sock.on('error', e => { log('Avisos UDP:', e.message); process.exit(1); });
sock.bind(PUERTO, '127.0.0.1', () => log(`Cámara lista: esperando avisos en 127.0.0.1:${PUERTO}`));

if (!fs.existsSync(TOKEN_FILE)) log('FALTA autorizar Drive:  node autorizar-drive.js  (los videos esperan en el celular)');
conectarCamara();
