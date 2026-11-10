// ════════════════════════════════════════════════════════════════════
//  AVISOS DE SEPARACIONES — de la app Separaciones al grupo de WhatsApp
//
//  Corre dentro de alertas.js (usa la misma sesión de WhatsApp del Samsung).
//
//  La app Separaciones (Cloudflare) deja en una cola cada pago por firmar,
//  cada firma y cada rechazo. Cada pocos segundos este módulo pide la cola
//  con su clave y publica los mensajes en el grupo (por defecto
//  "separaciones"; el nombre lo manda la app y se cambia en sus Ajustes).
//
//  config.json → "alertas": { "separaciones": { "clave": "LA_CLAVE_DE_AJUSTES" } }
//  Opcional: "url" (otra dirección de la app) y "segundos" (cada cuánto revisa).
//
//  Si la app no responde o el Samsung no está en el grupo, solo se anota en
//  el registro: las alertas de la caja y los Yapes siguen igual.
// ════════════════════════════════════════════════════════════════════
'use strict';

function normalizar(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function crear({ config, log, getSock, guardarEnviado }) {
  const URL_APP = String(config.url || 'https://separaciones.huidobroabdon.workers.dev').replace(/\/+$/, '');
  const CLAVE   = String(config.clave || '').trim();
  const CADA_MS = Math.max(5, Number(config.segundos) || 8) * 1000;
  if (!CLAVE) {
    log('Separaciones: falta alertas.separaciones.clave en config.json (la clave está en Ajustes de la app)');
    return { revisar() {} };
  }

  let jid = null, nombre = null, trabajando = false, ultimoError = '';

  async function app(ruta, opciones = {}) {
    const r = await fetch(URL_APP + ruta, {
      ...opciones,
      headers: { 'x-clave': CLAVE, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401) throw new Error('clave incorrecta (revisa alertas.separaciones.clave)');
    if (!r.ok) throw new Error('la app respondió ' + r.status);
    return r.json();
  }

  async function buscarGrupo(sock, buscado) {
    const grupos = Object.values(await sock.groupFetchAllParticipating());
    const g = grupos.find((x) => normalizar(x.subject) === normalizar(buscado));
    if (g) log(`Separaciones: grupo "${g.subject}" encontrado`);
    else log(`Separaciones: el Samsung no está en el grupo "${buscado}". Agrégalo al grupo.`);
    return g ? g.id : null;
  }

  async function revisar() {
    const sock = getSock();
    if (!sock || trabajando) return;
    trabajando = true;
    try {
      const { grupo, mensajes } = await app('/api/bot/pendientes');
      if (!jid || normalizar(grupo) !== normalizar(nombre)) { nombre = grupo; jid = await buscarGrupo(sock, grupo); }
      if (!jid) { await app('/api/bot/sin-grupo', { method: 'POST', body: '{}' }).catch(() => {}); return; }
      for (const m of mensajes) {
        try {
          const enviado = await sock.sendMessage(jid, { text: m.texto });
          if (guardarEnviado) guardarEnviado(enviado);
          await app('/api/bot/enviado', { method: 'POST', body: JSON.stringify({ id: m.id, ok: true }) });
          log('Separaciones →', m.texto.split('\n')[0]);
          await esperar(1500);
        } catch (e) {
          log('Separaciones: no se pudo enviar:', e.message);
          await app('/api/bot/enviado', { method: 'POST', body: JSON.stringify({ id: m.id, ok: false, error: String(e.message).slice(0, 200) }) }).catch(() => {});
        }
      }
      ultimoError = '';
    } catch (e) {
      // Solo se anota cuando cambia, para no llenar el registro cada 8 s
      if (e.message !== ultimoError) log('Separaciones:', e.message);
      ultimoError = e.message;
    } finally {
      trabajando = false;
    }
  }

  setInterval(revisar, CADA_MS);
  log(`Separaciones: avisos al grupo de WhatsApp, revisando cada ${CADA_MS / 1000} s`);
  return { revisar };
}

module.exports = { crear };
