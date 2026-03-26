'use strict';

// ============================================================
//  CONSTANTS
// ============================================================
// Password stored as SHA-256 hash — the plain text never appears in this file.
const PASSWORD_HASH  = '2d4e7db060a92769c58c1c355d5207537ac741e43baf27712025bbb371198d5d';
const EMPLOYEE_HASH  = 'b3cfbb5c6ea591e6b21fe9720e24257bd25f2c8025a591cda2ac548ac4e3c9a9';

const DENOMS = [
  { label: 'S/. 0.10', val: 0.10, tipo: 'Moneda' },
  { label: 'S/. 0.20', val: 0.20, tipo: 'Moneda' },
  { label: 'S/. 0.50', val: 0.50, tipo: 'Moneda' },
  { label: 'S/. 1.00', val: 1.00, tipo: 'Moneda' },
  { label: 'S/. 2.00', val: 2.00, tipo: 'Moneda' },
  { label: 'S/. 5.00', val: 5.00, tipo: 'Moneda' },
  { label: 'S/. 10',   val: 10,   tipo: 'Billete' },
  { label: 'S/. 20',   val: 20,   tipo: 'Billete' },
  { label: 'S/. 50',   val: 50,   tipo: 'Billete' },
  { label: 'S/. 100',  val: 100,  tipo: 'Billete' },
  { label: 'S/. 200',  val: 200,  tipo: 'Billete' },
];

// ============================================================
//  STATE
// ============================================================
let state = {
  cajaAbierta:      false,
  cajaInicial:      0,
  ventasHastaAhora: 0,
  ultimoYape:       0,
  aperturaFecha:    null,
  inicialMode:      'monto',
  inicialBreakdown: null,
  eventos:          [],
  yapesRaw:         '',  // textarea content — synced so employee edits reach admin
  _ts:              0,   // unix ms — used for multi-device conflict resolution
};

let cierreMode = 'denom'; // denomination is default for closing

let currentEventoTipo    = 'Egreso';
let currentEventoSubtipo = 'Efectivo';
let userRole             = 'admin'; // 'admin' | 'employee'

// Inactivity timer
let _inactivityTimer   = null;
let _warningTimer      = null;
let _countdownInterval = null;
const INACTIVITY_MS    = 15 * 60 * 1000; // 15 minutes
const WARNING_AHEAD_MS =      60 * 1000; // show warning 1 min before

// ============================================================
//  INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  buildDenomTable('inicial', 'inicialDenomTable');
  buildDenomTable('cierre',  'cierreDenomTable');
  prefillInicialDenoms();

  const opts = { weekday:'long', year:'numeric', month:'long', day:'numeric' };
  document.getElementById('headerDate').textContent =
    new Date().toLocaleDateString('es-PE', opts);

  document.getElementById('passInput').focus();
});

// ============================================================
//  AUTH
// ============================================================
async function login() {
  const input = document.getElementById('passInput');
  const hash  = await sha256(input.value);

  if (hash === PASSWORD_HASH || hash === EMPLOYEE_HASH) {
    userRole = (hash === EMPLOYEE_HASH) ? 'employee' : 'admin';
    input.value = '';
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainApp').style.display    = 'block';
    document.getElementById('loginError').style.display = 'none';
    _applyRoleUI();
    loadState();
    await pullEstadoFromSheets();   // sync live state from Sheets if available
    showView('auto');
    startInactivityTimer();
    startSyncPolling();             // background poll every 30 s
  } else {
    document.getElementById('loginError').style.display = 'block';
    input.value = '';
    input.classList.add('shake');
    input.addEventListener('animationend', () => input.classList.remove('shake'), { once: true });
    input.focus();
  }
}

function _applyRoleUI() {
  const isEmp = userRole === 'employee';
  document.getElementById('empleadoBadge').classList.toggle('hidden', !isEmp);
  document.getElementById('btnHistorial').style.display = isEmp ? 'none' : '';
  document.getElementById('btnConfig').style.display    = isEmp ? 'none' : '';
}

function logout() {
  stopInactivityTimer();
  stopSyncPolling();
  if (_pipWindow && !_pipWindow.closed) _pipWindow.close();
  _pipWindow = null;
  userRole = 'admin';
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('mainApp').style.display     = 'none';
  document.getElementById('passInput').value = '';
  document.getElementById('inactivityWarning').classList.add('hidden');
}

// ============================================================
//  VIEWS  (apertura | cierre | reportes | auto)
// ============================================================
function showView(view) {
  if (userRole === 'employee') { _showEmployeeView(); return; }

  if (view === 'auto') view = state.cajaAbierta ? 'cierre' : 'apertura';

  ['viewApertura', 'viewCierre', 'viewReportes', 'viewEmpleado'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );

  const cap = view.charAt(0).toUpperCase() + view.slice(1);
  document.getElementById('view' + cap).classList.remove('hidden');

  if (view === 'cierre')   { renderResumen(); renderEventos(); _syncYapesToDom(); calcularEsperado(); }
  if (view === 'reportes') renderReportes();
}

function _showEmployeeView() {
  ['viewApertura', 'viewCierre', 'viewReportes', 'viewEmpleado'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  document.getElementById('viewEmpleado').classList.remove('hidden');

  const open = state.cajaAbierta;
  document.getElementById('empCajaCerrada').classList.toggle('hidden', open);
  document.getElementById('empCajaAbierta').classList.toggle('hidden', !open);

  if (open) {
    // Render apertura summary
    const fechaStr = state.aperturaFecha
      ? escHtml(new Date(state.aperturaFecha).toLocaleString('es-PE')) : 'N/A';
    document.getElementById('empResumenGrid').innerHTML = `
      <div class="info-item">
        <div class="info-label">Caja Inicial</div>
        <div class="info-val">${fmt(state.cajaInicial)}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Ventas hasta ahora</div>
        <div class="info-val">${fmt(state.ventasHastaAhora)}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Último Yape</div>
        <div class="info-val">${fmt(state.ultimoYape)}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Apertura</div>
        <div class="info-val" style="font-size:12px;line-height:1.4">${fechaStr}</div>
      </div>`;
    renderEventos();
  }
}

// Sync state.yapesRaw → admin yapesInput textarea
function _syncYapesToDom() {
  const el = document.getElementById('yapesInput');
  if (el && el.value !== state.yapesRaw) {
    el.value = state.yapesRaw || '';
    onYapesInput();
  }
}

// Resolves an element from main doc or the active PiP window
function _el(id) {
  return document.getElementById(id) ||
    (_pipWindow && !_pipWindow.closed && _pipWindow.document.getElementById(id));
}

// Employee appends a single amount — never sees existing values
function addEmpYape() {
  const input    = _el('empYapeInput');
  const feedback = _el('empYapeFeedback');
  if (!input) return;
  const v = round2(parseFloat(input.value));
  if (isNaN(v) || v <= 0) { input.focus(); return; }

  state.yapesRaw = (state.yapesRaw ? state.yapesRaw.trimEnd() + '\n' : '') + v.toFixed(2);

  // Keep admin textarea in sync if on same device
  const adminEl = document.getElementById('yapesInput');
  if (adminEl) { adminEl.value = state.yapesRaw; onYapesInput(); }

  input.value = '';
  input.focus();
  saveState();

  if (feedback) {
    feedback.textContent = `✓ S/. ${v.toFixed(2)} registrado`;
    setTimeout(() => { if (feedback) feedback.textContent = ''; }, 2500);
  }
}

// ============================================================
//  PICTURE-IN-PICTURE YAPE WIDGET
// ============================================================
let _pipWindow = null;

async function openYapeWidget() {
  if (!('documentPictureInPicture' in window)) {
    alert('Tu versión de Brave/Chrome no soporta esta función (requiere v116+).');
    return;
  }
  // If already open, focus it
  if (_pipWindow && !_pipWindow.closed) { _pipWindow.focus(); return; }

  const card = document.getElementById('empYapeCard');
  const wrap = document.getElementById('empYapeCardWrap');
  const placeholder = document.getElementById('empYapePipPlaceholder');

  _pipWindow = await window.documentPictureInPicture.requestWindow({
    width: 100, height: 40,
    disallowReturnToOpener: false,
  });

  const D = _pipWindow.document;
  const style = D.createElement('style');
  // Content fills whatever size the browser gives (browser has a minimum ~200px wide)
  // On fade: background becomes transparent so the OS desktop shows through the content area
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%;
      background: rgba(20,40,80,0.92);
      display: flex; align-items: center; justify-content: center;
      gap: 4px; padding: 0 6px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      transition: background 1.4s ease, opacity 1.4s ease;
    }
    html.faded, html.faded body {
      background: transparent !important;
      opacity: 0.08;
    }
    .w { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
    .p  { position: absolute; left: 5px; font-size: 10px; font-weight: 700;
          color: #94a3b8; pointer-events: none; user-select: none; }
    #pi { width: 100%; height: 26px; padding: 0 4px 0 22px;
          border: none; border-radius: 4px;
          font-size: 12px; font-family: inherit; outline: none; background: #fff; }
    #pi:focus { box-shadow: 0 0 0 2px #60a5fa; }
    #pb { flex-shrink: 0; width: 26px; height: 26px;
          background: #2563eb; color: #fff; border: none; border-radius: 4px;
          font-size: 17px; font-weight: 700; cursor: pointer; line-height: 1;
          display: flex; align-items: center; justify-content: center; }
    #pb:hover { background: #1d4ed8; }
    #pk { flex-shrink: 0; width: 14px; font-size: 11px;
          font-weight: 700; color: #86efac; text-align: center; }
  `;
  D.head.appendChild(style);

  D.body.innerHTML = `
    <div class="w"><span class="p">S/.</span>
      <input id="pi" type="number" placeholder="0.00" min="0" step="0.01" autofocus>
    </div>
    <button id="pb">+</button><span id="pk"></span>`;

  const pipInput = D.getElementById('pi');
  const pipOk    = D.getElementById('pk');

  function pipAdd() {
    const v = round2(parseFloat(pipInput.value));
    if (isNaN(v) || v <= 0) { pipInput.focus(); return; }
    state.yapesRaw = (state.yapesRaw ? state.yapesRaw.trimEnd() + '\n' : '') + v.toFixed(2);
    const adminEl = document.getElementById('yapesInput');
    if (adminEl) { adminEl.value = state.yapesRaw; onYapesInput(); }
    saveState();
    pipInput.value = '';
    pipInput.focus();
    pipOk.textContent = '✓';
    setTimeout(() => { pipOk.textContent = ''; }, 1000);
  }

  D.getElementById('pb').addEventListener('click', pipAdd);
  pipInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pipAdd(); } });

  // After 15s inactive: content area becomes transparent (shows through to OS desktop)
  let _fadeTimer = null;
  function resetFade() {
    clearTimeout(_fadeTimer);
    D.documentElement.classList.remove('faded');
    _fadeTimer = setTimeout(() => D.documentElement.classList.add('faded'), 15000);
  }
  ['mousemove','mousedown','keydown','touchstart'].forEach(ev =>
    D.addEventListener(ev, resetFade, { passive: true })
  );
  resetFade();

  if (placeholder) placeholder.classList.remove('hidden');

  _pipWindow.addEventListener('pagehide', () => {
    clearTimeout(_fadeTimer);
    if (placeholder) placeholder.classList.add('hidden');
    _pipWindow = null;
  });
}

// ============================================================
//  INPUT MODE TOGGLE
// ============================================================
function setMode(section, mode) {
  if (section === 'inicial') {
    state.inicialMode = mode;
    toggle('inicialModoMonto', mode === 'monto');
    toggle('inicialModoDenom', mode === 'denom');
    document.getElementById('tglInicialMonto').classList.toggle('active', mode === 'monto');
    document.getElementById('tglInicialDenom').classList.toggle('active', mode === 'denom');
  } else {
    cierreMode = mode;
    toggle('cierreModoDenom', mode === 'denom');
    toggle('cierreModoMonto', mode === 'monto');
    document.getElementById('tglCierreDenom').classList.toggle('active', mode === 'denom');
    document.getElementById('tglCierreMonto').classList.toggle('active', mode === 'monto');
    calcularDiferencia();
  }
}

function toggle(id, show) {
  document.getElementById(id).classList.toggle('hidden', !show);
}

// ============================================================
//  LAZY SCRIPT LOADER
// ============================================================
const _loadedScripts = new Set();
function loadScript(url, integrity) {
  if (_loadedScripts.has(url)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.integrity = integrity;
    s.crossOrigin = 'anonymous';
    s.referrerPolicy = 'no-referrer';
    s.onload  = () => { _loadedScripts.add(url); resolve(); };
    s.onerror = () => reject(new Error('No se pudo cargar: ' + url));
    document.head.appendChild(s);
  });
}

const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const JSPDF_SRI = 'sha512-qZvrmS2ekKPF2mSznTQsxqPgnpkI4DNTlrdUmTzrDgektczlKNRRhy5X5AAOnx5S09ydFYWWNSfcEqDTTHgtNA==';
const XLSX_URL  = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.mini.min.js';
const XLSX_SRI  = 'sha512-NDQhXrK2pOCL18FV5/Nc+ya9Vz+7o8dJV1IGRwuuYuRMFhAR0allmjWdZCSHFLDYgMvXKyN2jXlSy2JJEmq+ZA==';

// ============================================================
//  STATE PERSISTENCE  (local + Google Sheets live sync)
// ============================================================

// Allowed fields — whitelist protects against prototype pollution
const STATE_FIELDS = [
  'cajaAbierta','cajaInicial','ventasHastaAhora','ultimoYape',
  'aperturaFecha','inicialMode','inicialBreakdown','eventos','yapesRaw','_ts',
];

// Write to localStorage only (no Sheets push)
function saveStateLocal() {
  try { localStorage.setItem('cajaState', JSON.stringify(state)); } catch (e) {}
}

// Debounced Sheets push timer
let _estadoPushTimer = null;

// Full save: localStorage + debounced push to Sheets
function saveState() {
  state._ts = Date.now();
  saveStateLocal();
  clearTimeout(_estadoPushTimer);
  _estadoPushTimer = setTimeout(_doPushEstado, 1500); // batch rapid changes
}

// Save live state via GET — POST with no-cors loses body on Apps Script's 302 redirect;
// GET requests reach Apps Script reliably and already have CORS headers.
function _doPushEstado() {
  const url = localStorage.getItem('sheetsUrl');
  if (!url || !isValidSheetsUrl(url)) return;
  const params = new URLSearchParams({
    action: 'saveEstado',
    ts:     String(state._ts),
    estado: JSON.stringify(state),
  });
  fetch(`${url}?${params.toString()}`).catch(() => {});
}

// Pull live state from Sheets on login; returns true if remote was newer
async function pullEstadoFromSheets() {
  const url = localStorage.getItem('sheetsUrl');
  if (!url || !isValidSheetsUrl(url)) return false;
  try {
    const res  = await fetch(`${url}?action=getEstado`);
    const data = await res.json();
    if (data.ok && data.estado) {
      const remote = tryParseJSON(data.estado, null);
      if (remote && typeof remote === 'object' && !Array.isArray(remote)
          && (remote._ts || 0) > (state._ts || 0)) {
        _applyRemoteState(remote);
        return true;
      }
    }
  } catch (e) {}
  return false;
}

// Apply a remote state object (whitelist, restore form inputs)
function _applyRemoteState(remote) {
  STATE_FIELDS.forEach(k => {
    if (Object.prototype.hasOwnProperty.call(remote, k)) state[k] = remote[k];
  });
  if (!Array.isArray(state.eventos)) state.eventos = [];
  if (typeof state.yapesRaw !== 'string') state.yapesRaw = '';
  saveStateLocal();
  if (state.cajaAbierta) {
    setMode('inicial', state.inicialMode || 'monto');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('cajaInicialExacto', state.cajaInicial      || 0);
    set('ventasHastaAhora',  state.ventasHastaAhora || 0);
    set('ultimoYape',        state.ultimoYape        || 0);
    set('yapesInput', state.yapesRaw);
  }
}

// Background polling — detects changes made on another device
let _syncPollInterval = null;
function startSyncPolling() {
  stopSyncPolling();
  _syncPollInterval = setInterval(async () => {
    const synced = await pullEstadoFromSheets();
    if (synced) {
      showSyncToast('🔄 Sincronizado desde otro dispositivo');
      // Refresh the currently visible view
      const views = { viewCierre: () => { renderResumen(); renderEventos(); _syncYapesToDom(); calcularEsperado(); },
                      viewEmpleado: () => _showEmployeeView() };
      for (const [id, fn] of Object.entries(views)) {
        if (!document.getElementById(id).classList.contains('hidden')) { fn(); break; }
      }
    }
  }, 30000); // every 30 seconds
}

function stopSyncPolling() {
  clearInterval(_syncPollInterval);
  _syncPollInterval = null;
}

function showSyncToast(msg) {
  const el = document.getElementById('syncToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3500);
}

function loadState() {
  try {
    const raw = localStorage.getItem('cajaState');
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    STATE_FIELDS.forEach(k => { if (Object.prototype.hasOwnProperty.call(saved, k)) state[k] = saved[k]; });
    if (!Array.isArray(state.eventos)) state.eventos = [];
    if (state.cajaAbierta) {
      setMode('inicial', state.inicialMode || 'monto');
      document.getElementById('cajaInicialExacto').value = state.cajaInicial      || 0;
      document.getElementById('ventasHastaAhora').value  = state.ventasHastaAhora || 0;
      document.getElementById('ultimoYape').value        = state.ultimoYape        || 0;
    }
  } catch (e) {}
}

// ============================================================
//  DENOMINATION TABLES
// ============================================================
function buildDenomTable(section, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let html = `<div class="denom-table">
    <div class="denom-th">
      <span>Denominación</span><span style="text-align:center">Cantidad</span><span>Subtotal</span>
    </div>`;

  let lastTipo = '';
  DENOMS.forEach((d, i) => {
    if (d.tipo !== lastTipo) {
      html += `<div class="denom-sep">${d.tipo === 'Moneda' ? '🪙' : '💵'} ${d.tipo}s</div>`;
      lastTipo = d.tipo;
    }
    html += `
      <div class="denom-row">
        <span class="denom-lbl">${d.label}</span>
        <input class="denom-qty" type="number" id="${section}Qty${i}"
          min="0" value="" placeholder="0" oninput="onDenomInput('${section}',${i})">
        <span class="denom-sub" id="${section}Sub${i}">S/. 0.00</span>
      </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
}

function onDenomInput(section, idx) {
  const qty = parseFloat(document.getElementById(`${section}Qty${idx}`).value) || 0;
  document.getElementById(`${section}Sub${idx}`).textContent = fmt(round2(qty * DENOMS[idx].val));
  const total   = getDenomTotal(section);
  const totalId = section === 'inicial' ? 'inicialDenomTotal' : 'cierreDenomTotal';
  document.getElementById(totalId).textContent = fmt(total);
  if (section === 'cierre') calcularDiferencia();
}

function getDenomTotal(section) {
  return round2(DENOMS.reduce((sum, _, i) => {
    const qty = parseFloat(document.getElementById(`${section}Qty${i}`)?.value) || 0;
    return sum + qty * DENOMS[i].val;
  }, 0));
}

function getDenomBreakdown(section) {
  return DENOMS.reduce((arr, d, i) => {
    const qty = parseFloat(document.getElementById(`${section}Qty${i}`)?.value) || 0;
    if (qty > 0) arr.push({ label: d.label, qty, subtotal: round2(qty * d.val), tipo: d.tipo });
    return arr;
  }, []);
}

// ============================================================
//  VALUE GETTERS
// ============================================================
function getCajaInicial() {
  return state.inicialMode === 'monto'
    ? (parseFloat(document.getElementById('cajaInicialExacto').value) || 0)
    : getDenomTotal('inicial');
}

function getCajaFinal() {
  return cierreMode === 'denom'
    ? getDenomTotal('cierre')
    : (parseFloat(document.getElementById('cajaFinalExacto').value) || 0);
}

function getTotalUSD() {
  return round2((state.eventos || []).reduce((sum, e) =>
    e.tipo === 'Divisa' ? sum + (e.usd || 0) : sum, 0));
}

function getEventosEgresos() {
  return round2((state.eventos || []).reduce((sum, e) => {
    return (e.tipo === 'Egreso' || e.tipo === 'Divisa') ? sum + e.monto : sum;
  }, 0));
}

function getEventosIngresos() {
  return round2((state.eventos || []).reduce((sum, e) => {
    return (e.tipo === 'Ingreso' && e.subtipo === 'Efectivo') ? sum + e.monto : sum;
  }, 0));
}

function getEsperado() {
  const vf  = parseFloat(document.getElementById('ventasFinal')?.value) || 0;
  const vha = state.ventasHastaAhora || 0;
  const ty  = getTotalYapes();
  const ci  = state.cajaInicial || 0;
  const egr = getEventosEgresos();
  const ing = getEventosIngresos();
  return round2(vf - vha - ty + ci - egr + ing);
}

// ============================================================
//  APERTURA
// ============================================================
function guardarApertura() {
  state.cajaInicial      = getCajaInicial();
  state.ventasHastaAhora = parseFloat(document.getElementById('ventasHastaAhora').value) || 0;
  state.ultimoYape       = parseFloat(document.getElementById('ultimoYape').value) || 0;
  state.cajaAbierta      = true;
  state.aperturaFecha    = new Date().toISOString();
  state.inicialBreakdown = state.inicialMode === 'denom' ? getDenomBreakdown('inicial') : null;
  saveState();
  showView('cierre');
}

function renderResumen() {
  const fechaStr = state.aperturaFecha
    ? escHtml(new Date(state.aperturaFecha).toLocaleString('es-PE')) : 'N/A';
  document.getElementById('resumenGrid').innerHTML = `
    <div class="info-item">
      <div class="info-label">Caja Inicial</div>
      <div class="info-val">${fmt(state.cajaInicial)}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Ventas hasta ahora</div>
      <div class="info-val">${fmt(state.ventasHastaAhora)}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Último Yape</div>
      <div class="info-val">${fmt(state.ultimoYape)}</div>
    </div>
    <div class="info-item">
      <div class="info-label">Apertura</div>
      <div class="info-val" style="font-size:12px;line-height:1.4">${fechaStr}</div>
    </div>`;
}

// ============================================================
//  YAPES
// ============================================================
function onYapesInput() {
  const raw   = document.getElementById('yapesInput').value;
  const parts = raw.split('\n').map(s => s.trim()).filter(s => s !== '');
  let total = 0, html = '';

  parts.forEach(p => {
    const v = parseFloat(p);
    if (!isNaN(v) && v >= 0) {
      total += v;
      html  += `<span class="chip chip-ok">S/. ${v.toFixed(2)}</span>`;
    } else if (p) {
      html  += `<span class="chip chip-err">${escHtml(p)} ⚠</span>`;
    }
  });

  total = round2(total);
  document.getElementById('yapesChips').innerHTML          = html;
  document.getElementById('totalYapesDisplay').textContent = fmt(total);
  state.yapesRaw = document.getElementById('yapesInput').value;
  calcularEsperado();
}

function getTotalYapes() {
  const raw = document.getElementById('yapesInput')?.value || '';
  return round2(raw.split('\n').reduce((sum, s) => {
    const v = parseFloat(s.trim());
    return sum + (isNaN(v) || v < 0 ? 0 : v);
  }, 0));
}

function getYapesList() {
  const raw = document.getElementById('yapesInput')?.value || '';
  return raw.split('\n').map(s => parseFloat(s.trim())).filter(v => !isNaN(v) && v >= 0);
}

// ============================================================
//  CALCULATIONS
// ============================================================
function calcularEsperado() {
  const vf  = parseFloat(document.getElementById('ventasFinal')?.value) || 0;
  const vha = state.ventasHastaAhora || 0;
  const ty  = getTotalYapes();
  const ci  = state.cajaInicial || 0;
  const egr = getEventosEgresos();
  const ing = getEventosIngresos();
  const esp = round2(vf - vha - ty + ci - egr + ing);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
  set('fVF',  vf);
  set('fVHA', vha);
  set('fTY',  ty);
  set('fCI',  ci);

  const egrRow = document.getElementById('fRowEgr');
  const ingRow = document.getElementById('fRowIng');
  if (egrRow) { egrRow.style.display = egr > 0 ? '' : 'none'; set('fEGR', egr); }
  if (ingRow) { ingRow.style.display = ing > 0 ? '' : 'none'; set('fING', ing); }

  const espEl = document.getElementById('fEsperado');
  if (espEl) {
    espEl.textContent = fmt(esp);
    espEl.style.color = esp >= 0 ? '#4338ca' : '#dc2626';
  }

  calcularDiferencia();
}

function calcularDiferencia() {
  const esp  = getEsperado();
  const real = getCajaFinal();
  const diff = round2(real - esp);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
  set('diffEsperado', esp);
  set('diffReal',     real);

  const iconEl   = document.getElementById('diffIcon');
  const textEl   = document.getElementById('diffText');
  const amountEl = document.getElementById('diffAmount');
  const card     = document.getElementById('cardDiff');
  if (!iconEl) return;

  if (real === 0 && esp === 0) {
    iconEl.textContent   = '—';
    textEl.textContent   = 'Ingrese los montos para ver el resultado';
    amountEl.textContent = '';
    card.className       = 'card card-diff';
    return;
  }

  if (diff === 0) {
    iconEl.textContent   = '✅';
    textEl.textContent   = 'Caja exacta — todo cuadra';
    amountEl.textContent = '';
    card.className       = 'card card-diff diff-ok';
  } else if (diff > 0) {
    iconEl.textContent   = '💰';
    textEl.textContent   = 'Sobra dinero';
    amountEl.textContent = fmt(diff);
    card.className       = 'card card-diff diff-over';
  } else {
    iconEl.textContent   = '⚠️';
    textEl.textContent   = 'Falta dinero';
    amountEl.textContent = fmt(Math.abs(diff));
    card.className       = 'card card-diff diff-under';
  }
}

// ============================================================
//  CLOSE CASH & GENERATE PDF
// ============================================================
async function cerrarCaja() {
  const ventasFinal      = parseFloat(document.getElementById('ventasFinal').value) || 0;
  const totalYapes       = getTotalYapes();
  const yapesList        = getYapesList();
  const efectivoReal     = getCajaFinal();
  const efectivoEsperado = getEsperado();
  const diferencia       = round2(efectivoReal - efectivoEsperado);

  // Save cierre denomination counts for next apertura prefill
  if (cierreMode === 'denom') {
    const lastDenoms = DENOMS.map((_, i) =>
      parseFloat(document.getElementById(`cierreQty${i}`)?.value) || 0
    );
    try { localStorage.setItem('lastCierreDenoms', JSON.stringify(lastDenoms)); } catch (e) {}
  }

  const report = {
    id:               Date.now(),
    fecha:            new Date().toISOString(),
    cajaInicial:      state.cajaInicial,
    ventasHastaAhora: state.ventasHastaAhora,
    ultimoYape:       state.ultimoYape,
    aperturaFecha:    state.aperturaFecha,
    inicialMode:      state.inicialMode,
    inicialBreakdown: state.inicialBreakdown,
    ventasFinal,
    totalYapes,
    yapesList,
    eventos:          state.eventos || [],
    cierreMode,
    cierreBreakdown:  cierreMode === 'denom' ? getDenomBreakdown('cierre') : null,
    efectivoEsperado,
    efectivoReal,
    diferencia,
  };

  saveReport(report);
  await generarPDF(report);
  resetAfterClose();
}

function resetAfterClose() {
  state = {
    cajaAbierta: false, cajaInicial: 0, ventasHastaAhora: 0,
    ultimoYape: 0, aperturaFecha: null, inicialMode: 'monto', inicialBreakdown: null,
    eventos: [], yapesRaw: '',
  };
  saveState();

  // Reset cierre form fields
  ['ventasFinal', 'yapesInput', 'cajaFinalExacto'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('yapesChips').innerHTML            = '';
  document.getElementById('totalYapesDisplay').textContent   = 'S/. 0.00';
  document.getElementById('cierreDenomTotal').textContent    = 'S/. 0.00';
  DENOMS.forEach((_, i) => {
    const qEl = document.getElementById(`cierreQty${i}`);
    const sEl = document.getElementById(`cierreSub${i}`);
    if (qEl) qEl.value = '';
    if (sEl) sEl.textContent = 'S/. 0.00';
  });

  // Reset eventos UI
  const cardEv = document.getElementById('cardEventos');
  if (cardEv) cardEv.style.display = 'none';

  // Reset apertura form and prefill denoms from last cierre
  document.getElementById('cajaInicialExacto').value = '';
  document.getElementById('ventasHastaAhora').value  = '';
  document.getElementById('ultimoYape').value        = '';
  document.getElementById('inicialDenomTotal').textContent = 'S/. 0.00';
  DENOMS.forEach((_, i) => {
    const qEl = document.getElementById(`inicialQty${i}`);
    const sEl = document.getElementById(`inicialSub${i}`);
    if (qEl) qEl.value = '';
    if (sEl) sEl.textContent = 'S/. 0.00';
  });
  prefillInicialDenoms();

  showView('apertura');
}

// ============================================================
//  REPORTS  (localStorage + Google Sheets)
// ============================================================
function getLocalReports() {
  try { return JSON.parse(localStorage.getItem('cajaReportes') || '[]'); }
  catch { return []; }
}

// Keep backward-compatible alias
function getReports() { return getLocalReports(); }

function saveReport(report) {
  // 1. Save locally
  try {
    const reports = getLocalReports();
    reports.unshift(report);
    localStorage.setItem('cajaReportes', JSON.stringify(reports));
  } catch (e) {}

  // 2. Fire-and-forget to Google Sheets (no-cors avoids CORS preflight on POST)
  const url = localStorage.getItem('sheetsUrl');
  if (url && isValidSheetsUrl(url)) {
    fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify({ action: 'saveReporte', reporte: report }),
    }).catch(() => {}); // silent fail — data is safe locally
  }
}

// Fetch all reports from Google Sheets
async function fetchFromSheets() {
  const url = localStorage.getItem('sheetsUrl');
  if (!url || !isValidSheetsUrl(url)) return null;
  try {
    const res = await fetch(`${url}?action=getAll`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data.map(r => ({
      id:               r['ID'],
      fecha:            r['Fecha Cierre'],
      aperturaFecha:    r['Apertura Fecha'],
      cajaInicial:      parseFloat(r['Caja Inicial'])       || 0,
      ventasHastaAhora: parseFloat(r['Ventas hasta ahora']) || 0,
      ultimoYape:       parseFloat(r['Ultimo Yape'])        || 0,
      ventasFinal:      parseFloat(r['Ventas Final'])       || 0,
      totalYapes:       parseFloat(r['Total Yapes'])        || 0,
      yapesList:        tryParseJSON(r['Yapes Lista'], []),
      efectivoEsperado: parseFloat(r['Efectivo Esperado'])  || 0,
      efectivoReal:     parseFloat(r['Efectivo Real'])      || 0,
      diferencia:       parseFloat(r['Diferencia'])         || 0,
    }));
  } catch (e) {
    return null;
  }
}

// Get reports from Sheets if configured, else from localStorage
async function getAllReports() {
  const url = localStorage.getItem('sheetsUrl');
  if (!url || !isValidSheetsUrl(url)) return getLocalReports();

  const syncEl = document.getElementById('syncIndicator');
  if (syncEl) syncEl.classList.remove('hidden');

  const sheetsData = await fetchFromSheets();

  if (syncEl) syncEl.classList.add('hidden');

  if (sheetsData !== null) return sheetsData;

  // Sheets unreachable — show warning and use local
  if (syncEl) {
    syncEl.textContent = '⚠️ Sin conexión con Sheets — mostrando datos locales';
    syncEl.classList.remove('hidden');
    setTimeout(() => syncEl.classList.add('hidden'), 3500);
  }
  return getLocalReports();
}

async function renderReportes() {
  const allReports = await getAllReports();

  const desde = document.getElementById('filtroDesde')?.value;
  const hasta = document.getElementById('filtroHasta')?.value;
  let reports = allReports;
  if (desde) reports = reports.filter(r => new Date(r.fecha) >= new Date(desde));
  if (hasta) {
    const h = new Date(hasta); h.setHours(23, 59, 59);
    reports = reports.filter(r => new Date(r.fecha) <= h);
  }

  const tbody  = document.getElementById('reportesTbody');
  const noData = document.getElementById('noReportes');

  if (reports.length === 0) {
    tbody.innerHTML = '';
    noData.classList.remove('hidden');
    return;
  }
  noData.classList.add('hidden');

  tbody.innerHTML = reports.map(r => {
    const diffClass = r.diferencia > 0 ? 'diff-pos' : r.diferencia < 0 ? 'diff-neg' : 'diff-zero';
    const diffText  = r.diferencia === 0 ? '✓ Exacto'
      : r.diferencia > 0 ? `+${fmt(r.diferencia)}`
      : `−${fmt(Math.abs(r.diferencia))}`;
    return `<tr>
      <td>${new Date(r.fecha).toLocaleString('es-PE')}</td>
      <td>${fmt(r.cajaInicial)}</td>
      <td>${fmt(r.ventasHastaAhora)}</td>
      <td>${fmt(r.ventasFinal)}</td>
      <td>${fmt(r.totalYapes)}</td>
      <td>${fmt(r.efectivoEsperado)}</td>
      <td>${fmt(r.efectivoReal)}</td>
      <td class="${diffClass}">${diffText}</td>
    </tr>`;
  }).join('');
}

function limpiarFiltros() {
  document.getElementById('filtroDesde').value = '';
  document.getElementById('filtroHasta').value = '';
  renderReportes();
}

async function exportarExcel() {
  const allReports = await getAllReports();
  const desde = document.getElementById('filtroDesde')?.value;
  const hasta = document.getElementById('filtroHasta')?.value;

  let reports = allReports;
  if (desde) reports = reports.filter(r => new Date(r.fecha) >= new Date(desde));
  if (hasta) {
    const h = new Date(hasta); h.setHours(23, 59, 59);
    reports = reports.filter(r => new Date(r.fecha) <= h);
  }

  if (reports.length === 0) { alert('No hay reportes para exportar.'); return; }

  await loadScript(XLSX_URL, XLSX_SRI);

  const data = reports.map(r => ({
    'Fecha Cierre':             new Date(r.fecha).toLocaleString('es-PE'),
    'Caja Inicial (S/.)':       r.cajaInicial,
    'Ventas hasta ahora (S/.)': r.ventasHastaAhora,
    'Ultimo Yape (S/.)':        r.ultimoYape,
    'Ventas Final (S/.)':       r.ventasFinal,
    'Total Yapes (S/.)':        r.totalYapes,
    'Efectivo Esperado (S/.)':  r.efectivoEsperado,
    'Efectivo Real (S/.)':      r.efectivoReal,
    'Diferencia (S/.)':         r.diferencia,
    'Resultado':                r.diferencia === 0 ? 'Exacto' : r.diferencia > 0 ? 'Sobra' : 'Falta',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{wch:22},{wch:18},{wch:22},{wch:16},{wch:18},{wch:16},{wch:22},{wch:18},{wch:16},{wch:10}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Reportes de Caja');
  XLSX.writeFile(wb, `Reportes_Caja_${new Date().toLocaleDateString('es-PE').replace(/\//g,'-')}.xlsx`);
}

// ============================================================
//  GOOGLE SHEETS SETTINGS
// ============================================================
const APPS_SCRIPT_CODE = `// ── Pegar completo en Google Apps Script ──────────────────────

function doGet(e) {
  const a = (e.parameter.action || '').trim();
  if (a === 'test') return R({ok: true, msg: 'Conexion exitosa'});

  if (a === 'getAll') {
    const sh   = getSheet();
    const rows = sh.getDataRange().getValues();
    if (rows.length < 2) return R([]);
    const h = rows[0];
    return R(rows.slice(1).reverse().map(r => {
      const o = {};
      h.forEach((k, i) => o[k] = r[i]);
      return o;
    }));
  }

  if (a === 'getEstado') {
    const sh = getEstadoSheet();
    if (sh.getLastRow() < 2) return R({ok: true, ts: 0, estado: null});
    const row = sh.getRange(2, 1, 1, 2).getValues()[0];
    return R({ok: true, ts: Number(row[0]), estado: row[1]});
  }

  // saveEstado via GET — POST loses body on Apps Script's 302 redirect
  if (a === 'saveEstado') {
    const ts  = parseInt(e.parameter.ts || '0');
    const est = e.parameter.estado || '';
    if (!est) return R({ok: false, error: 'sin datos'});
    const sh = getEstadoSheet();
    if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
    sh.appendRow([ts, est]);
    return R({ok: true});
  }

  return R({error: 'accion desconocida'});
}

function doPost(e) {
  try {
    const b = JSON.parse(e.postData.contents);

    if (b.action === 'saveReporte') {
      const r   = b.reporte;
      const evs = r.eventos || [];
      const egr = evs.reduce((s, ev) =>
        (ev.tipo === 'Egreso' || ev.tipo === 'Divisa') ? s + ev.monto : s, 0);
      const ing = evs.reduce((s, ev) =>
        (ev.tipo === 'Ingreso' && ev.subtipo === 'Efectivo') ? s + ev.monto : s, 0);
      const usd = evs.reduce((s, ev) =>
        ev.tipo === 'Divisa' ? s + (ev.usd || 0) : s, 0);
      getSheet().appendRow([
        r.id, r.fecha, r.aperturaFecha,
        r.cajaInicial, r.ventasHastaAhora, r.ultimoYape,
        r.ventasFinal, r.totalYapes,
        JSON.stringify(r.yapesList || []),
        JSON.stringify(evs),
        Math.round(egr * 100) / 100,
        Math.round(ing * 100) / 100,
        Math.round(usd * 100) / 100,
        r.efectivoEsperado, r.efectivoReal, r.diferencia
      ]);
      return R({success: true});
    }
  } catch (err) { return R({error: err.toString()}); }
  return R({error: 'accion desconocida'});
}

// ── Hoja de reportes cerrados ───────────────────────────────
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Reportes');
  if (!sh) {
    sh = ss.insertSheet('Reportes');
    const cols = [
      'ID', 'Fecha Cierre', 'Apertura Fecha', 'Caja Inicial',
      'Ventas hasta ahora', 'Ultimo Yape', 'Ventas Final',
      'Total Yapes', 'Yapes Lista', 'Eventos',
      'Total Egresos', 'Total Ingresos Ef.', 'Total USD',
      'Efectivo Esperado', 'Efectivo Real', 'Diferencia'
    ];
    sh.appendRow(cols);
    sh.getRange(1, 1, 1, cols.length)
      .setFontWeight('bold').setBackground('#1e3a5f').setFontColor('#ffffff');
  }
  return sh;
}

// ── Hoja de estado en vivo (sincronización multi-dispositivo) ─
function getEstadoSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Estado');
  if (!sh) {
    sh = ss.insertSheet('Estado');
    sh.appendRow(['ts', 'estado']);
    sh.getRange(1, 1, 1, 2)
      .setFontWeight('bold').setBackground('#1e3a5f').setFontColor('#ffffff');
  }
  return sh;
}

function R(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}`;

function openSettings() {
  document.getElementById('sheetsUrlInput').value = localStorage.getItem('sheetsUrl') || '';
  document.getElementById('scriptCodePre').textContent = APPS_SCRIPT_CODE;
  document.getElementById('connStatus').className = 'conn-status hidden';
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settingsModal').classList.add('hidden');
}

function isValidSheetsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'script.google.com';
  } catch { return false; }
}

function saveSettings() {
  const url = document.getElementById('sheetsUrlInput').value.trim();
  if (url && !isValidSheetsUrl(url)) {
    setConnStatus('error', '❌ URL inválida. Debe ser https://script.google.com/...');
    return;
  }
  if (url) {
    localStorage.setItem('sheetsUrl', url);
  } else {
    localStorage.removeItem('sheetsUrl');
  }
  closeSettings();
}

async function testConnection() {
  const url = document.getElementById('sheetsUrlInput').value.trim();
  if (!url) { setConnStatus('error', 'Ingresa una URL primero.'); return; }
  if (!isValidSheetsUrl(url)) { setConnStatus('error', '❌ URL inválida. Debe ser https://script.google.com/...'); return; }

  setConnStatus('loading', 'Probando conexión...');
  try {
    const res  = await fetch(`${url}?action=test`);
    const data = await res.json();
    if (data.ok) {
      setConnStatus('ok', '✅ ' + (data.msg || 'Conexión exitosa'));
    } else {
      setConnStatus('error', '⚠️ El script respondió con error: ' + JSON.stringify(data));
    }
  } catch (e) {
    setConnStatus('error', '❌ No se pudo conectar. Verifica que el script esté desplegado con acceso "Cualquier persona".');
  }
}

function setConnStatus(type, msg) {
  const el = document.getElementById('connStatus');
  el.className = `conn-status conn-${type}`;
  el.textContent = msg;
}

function copyScript(btn) {
  navigator.clipboard.writeText(APPS_SCRIPT_CODE).then(() => {
    btn.textContent = '✅ Copiado';
    setTimeout(() => { btn.textContent = '📋 Copiar código'; }, 2000);
  }).catch(() => {
    // Fallback for browsers without clipboard API
    const el = document.getElementById('scriptCodePre');
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    btn.textContent = '✅ Copiado';
    setTimeout(() => { btn.textContent = '📋 Copiar código'; }, 2000);
  });
}

// ============================================================
//  DENOMINATION MEMORY
// ============================================================
function prefillInicialDenoms() {
  try {
    const saved = JSON.parse(localStorage.getItem('lastCierreDenoms') || 'null');
    if (!Array.isArray(saved)) return;
    saved.forEach((qty, i) => {
      if (!qty) return;
      const input = document.getElementById(`inicialQty${i}`);
      if (input) { input.value = qty; onDenomInput('inicial', i); }
    });
  } catch (e) {}
}

// ============================================================
//  EVENTOS
// ============================================================
function openEventosModal() {
  currentEventoTipo    = 'Egreso';
  currentEventoSubtipo = 'Efectivo';
  // Reset fields
  ['evDesc','evDivisaDesc'].forEach(id => { document.getElementById(id).value = ''; });
  ['evMonto','evUSD','evTC'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('evDivisaSoles').textContent = 'S/. 0.00';
  // Set type buttons
  ['tglEvEgreso','tglEvDivisa','tglEvIngreso'].forEach(id =>
    document.getElementById(id).classList.remove('active')
  );
  document.getElementById('tglEvEgreso').classList.add('active');
  document.getElementById('evFieldsBasic').style.display = '';
  document.getElementById('evFieldsDivisa').classList.add('hidden');
  document.getElementById('evSubtipoWrap').style.display = 'none';
  // Reset subtipo buttons
  document.getElementById('tglSubEfectivo').classList.add('active');
  document.getElementById('tglSubYape').classList.remove('active');
  document.getElementById('eventosModal').classList.remove('hidden');
}

function closeEventosModal() {
  document.getElementById('eventosModal').classList.add('hidden');
}

function setEventoTipo(tipo) {
  currentEventoTipo = tipo;
  ['tglEvEgreso','tglEvDivisa','tglEvIngreso'].forEach(id =>
    document.getElementById(id).classList.remove('active')
  );
  const map = { Egreso: 'tglEvEgreso', Divisa: 'tglEvDivisa', Ingreso: 'tglEvIngreso' };
  document.getElementById(map[tipo]).classList.add('active');
  document.getElementById('evFieldsBasic').style.display  = tipo === 'Divisa' ? 'none' : '';
  document.getElementById('evFieldsDivisa').classList.toggle('hidden', tipo !== 'Divisa');
  document.getElementById('evSubtipoWrap').style.display  = tipo === 'Ingreso' ? '' : 'none';
}

function setEventoSubtipo(subtipo) {
  currentEventoSubtipo = subtipo;
  document.getElementById('tglSubEfectivo').classList.toggle('active', subtipo === 'Efectivo');
  document.getElementById('tglSubYape').classList.toggle('active',     subtipo === 'Yape');
}

function calcDivisa() {
  const usd   = parseFloat(document.getElementById('evUSD').value) || 0;
  const tc    = parseFloat(document.getElementById('evTC').value)  || 0;
  const soles = round2(usd * tc);
  document.getElementById('evDivisaSoles').textContent = fmt(soles);
}

function addEvento() {
  let monto = 0, desc = '', usd = 0, tc = 0;

  if (currentEventoTipo === 'Divisa') {
    usd   = parseFloat(document.getElementById('evUSD').value) || 0;
    tc    = parseFloat(document.getElementById('evTC').value)  || 0;
    monto = round2(usd * tc);
    desc  = document.getElementById('evDivisaDesc').value.trim()
            || `$${usd.toFixed(2)} × ${tc}`;
    if (!usd || !tc) { alert('Ingresa el monto en USD y el tipo de cambio.'); return; }
  } else {
    monto = parseFloat(document.getElementById('evMonto').value) || 0;
    desc  = document.getElementById('evDesc').value.trim();
    if (!monto) { alert('Ingresa un monto válido.'); return; }
  }

  const evento = {
    id:      Date.now(),
    tipo:    currentEventoTipo,
    subtipo: currentEventoTipo === 'Ingreso' ? currentEventoSubtipo : null,
    desc,
    monto,
    usd:     currentEventoTipo === 'Divisa' ? usd : null,
    tc:      currentEventoTipo === 'Divisa' ? tc  : null,
  };

  if (!state.eventos) state.eventos = [];
  state.eventos.push(evento);
  saveState();
  renderEventos();
  calcularEsperado();
  closeEventosModal();
}

function eliminarEvento(idx) {
  state.eventos.splice(idx, 1);
  saveState();
  renderEventos();
  calcularEsperado();
}

function renderEventos() {
  _renderEventosInto('cardEventos',    'eventosList');
  _renderEventosInto('cardEventosEmp', 'eventosListEmp');
}

function _renderEventosInto(cardId, listId) {
  const card = document.getElementById(cardId);
  const list = document.getElementById(listId);
  if (!card || !list) return;

  const eventos   = state.eventos || [];
  const totalEgr  = getEventosEgresos();
  const totalIng  = getEventosIngresos();
  const totalUSD  = getTotalUSD();

  // USD banner only exists in cierre view
  if (cardId === 'cardEventos') {
    const usdBanner = document.getElementById('usdEnCaja');
    const usdVal    = document.getElementById('usdEnCajaVal');
    if (usdBanner && usdVal) {
      usdBanner.style.display = totalUSD > 0 && eventos.length > 0 ? '' : 'none';
      usdVal.textContent = `$${totalUSD.toFixed(2)}`;
    }
  }

  if (eventos.length === 0) { card.style.display = 'none'; return; }
  card.style.display = '';

  list.innerHTML = eventos.map((e, i) => {
    let badgeClass, badgeLabel, montoClass;
    if      (e.tipo === 'Egreso')              { badgeClass = 'ev-egreso';     badgeLabel = 'Egreso';    montoClass = 'ev-monto-egr'; }
    else if (e.tipo === 'Divisa')              { badgeClass = 'ev-divisa';     badgeLabel = 'Divisa';    montoClass = 'ev-monto-egr'; }
    else if (e.subtipo === 'Yape')             { badgeClass = 'ev-ingreso-yp'; badgeLabel = 'Ing. Yape'; montoClass = 'ev-monto-ing'; }
    else                                       { badgeClass = 'ev-ingreso-ef'; badgeLabel = 'Ing. Ef.';  montoClass = 'ev-monto-ing'; }

    const sign       = (e.tipo === 'Egreso' || e.tipo === 'Divisa') ? '−' : '+';
    const divisaNote = e.tipo === 'Divisa'
      ? `<span style="font-size:11px;color:#64748b"> ($${(+e.usd).toFixed(2)} × ${e.tc})</span>` : '';

    return `<div class="evento-item">
      <span class="evento-badge ${badgeClass}">${badgeLabel}</span>
      <div class="evento-info">
        <div class="evento-desc">${escHtml(e.desc || '—')}${divisaNote}</div>
        <div class="evento-monto ${montoClass}">${sign} ${fmt(e.monto)}</div>
      </div>
      <button class="btn-ev-del" onclick="eliminarEvento(${i})" title="Eliminar">✕</button>
    </div>`;
  }).join('');

  list.innerHTML += `<div class="eventos-footer">
    <span class="eventos-footer-item">Egresos: <span class="ev-foot-val ev-monto-egr">${fmt(totalEgr)}</span></span>
    <span class="eventos-footer-item">Ingresos ef.: <span class="ev-foot-val ev-monto-ing">${fmt(totalIng)}</span></span>
    ${totalUSD > 0 ? `<span class="eventos-footer-item">💵 USD: <span class="ev-foot-val" style="color:#1e40af">$${totalUSD.toFixed(2)}</span></span>` : ''}
  </div>`;
}

// ============================================================
//  PDF GENERATION
// ============================================================
async function generarPDF(d) {
  await loadScript(JSPDF_URL, JSPDF_SRI);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pw  = doc.internal.pageSize.getWidth();
  const ph  = doc.internal.pageSize.getHeight();
  const mg  = 18;

  const BLUE   = [30, 58, 95];
  const LBLUE  = [239, 246, 255];
  const GREEN  = [5, 150, 105];
  const RED    = [220, 38, 38];
  const ORANGE = [194, 65, 12];
  const GRAY   = [100, 116, 139];
  const DARK   = [26, 32, 44];
  const INDIGO = [67, 56, 202];

  function newPageIfNeeded(y, needed) {
    if (y + needed > ph - 22) { doc.addPage(); return mg; }
    return y;
  }

  // ---- HEADER ----
  doc.setFillColor(...BLUE);
  doc.rect(0, 0, pw, 32, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('REPORTE DE CIERRE DE CAJA', pw / 2, 14, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  doc.text(
    `${new Date(d.fecha).toLocaleDateString('es-PE', opts)}  |  ${new Date(d.fecha).toLocaleTimeString('es-PE')}`,
    pw / 2, 24, { align: 'center' }
  );

  let y = 40;

  // ---- APERTURA ----
  y = pdfSec(doc, 'DATOS DE APERTURA', y, pw, mg, BLUE, LBLUE);
  if (d.aperturaFecha)
    y = pdfRow(doc, 'Fecha apertura', new Date(d.aperturaFecha).toLocaleString('es-PE'), y, mg, pw, DARK, BLUE);
  y = pdfRow(doc, 'Caja Inicial',       fmt(d.cajaInicial),       y, mg, pw, DARK, BLUE);
  y = pdfRow(doc, 'Ventas hasta ahora', fmt(d.ventasHastaAhora),  y, mg, pw, DARK, BLUE);
  y = pdfRow(doc, 'Último Yape',        fmt(d.ultimoYape),         y, mg, pw, DARK, BLUE);

  if (d.inicialMode === 'denom' && d.inicialBreakdown?.length) {
    y = newPageIfNeeded(y, d.inicialBreakdown.length * 4 + 8);
    y += 2;
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...GRAY);
    doc.text('Detalle caja inicial:', mg, y); y += 4.5;
    d.inicialBreakdown.forEach(item => {
      doc.text(`   ${item.label} × ${item.qty} = S/. ${item.subtotal.toFixed(2)}`, mg + 4, y);
      y += 4;
    });
  }
  y += 5;

  // ---- VENTAS & YAPES ----
  y = newPageIfNeeded(y, 30);
  y = pdfSec(doc, 'VENTAS Y YAPES', y, pw, mg, BLUE, LBLUE);
  y = pdfRow(doc, 'Ventas Final', fmt(d.ventasFinal), y, mg, pw, DARK, BLUE);

  if (d.yapesList?.length) {
    y = newPageIfNeeded(y, d.yapesList.length * 4 + 10);
    y += 2;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
    doc.text('Yapes recibidos:', mg, y); y += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GRAY);
    d.yapesList.forEach((v, i) => {
      doc.text(`   Yape ${i + 1}: S/. ${v.toFixed(2)}`, mg + 4, y); y += 4;
    });
    y += 1;
  }
  y = pdfRow(doc, 'Total Yapes', fmt(d.totalYapes), y, mg, pw, DARK, BLUE);
  y += 5;

  // ---- EVENTOS ----
  if (d.eventos?.length) {
    y = newPageIfNeeded(y, d.eventos.length * 6 + 20);
    y = pdfSec(doc, 'EVENTOS DE CAJA', y, pw, mg, BLUE, LBLUE);
    d.eventos.forEach(ev => {
      const sign  = (ev.tipo === 'Egreso' || ev.tipo === 'Divisa') ? '−' : '+';
      const label = `[${ev.tipo}${ev.subtipo ? '/' + ev.subtipo : ''}] ${ev.desc || ''}`;
      const val   = `${sign} ${fmt(ev.monto)}`;
      const col   = (ev.tipo === 'Egreso' || ev.tipo === 'Divisa') ? RED : GREEN;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
      doc.text(label, mg + 2, y);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...col);
      doc.text(val, pw - mg - 2, y, { align: 'right' });
      doc.setDrawColor(235, 235, 235); doc.line(mg, y + 2.5, pw - mg, y + 2.5);
      y += 8;
    });
    y += 2;
  }

  // ---- CÁLCULO ----
  const evExtraRows = ((d.eventos || []).some(e => e.tipo === 'Egreso' || e.tipo === 'Divisa') ? 1 : 0)
                    + ((d.eventos || []).some(e => e.tipo === 'Ingreso' && e.subtipo === 'Efectivo') ? 1 : 0);
  const calcBoxH = 50 + evExtraRows * 7;
  y = newPageIfNeeded(y, calcBoxH + 14);
  y = pdfSec(doc, 'CÁLCULO — EFECTIVO ESPERADO', y, pw, mg, BLUE, LBLUE);
  doc.setFillColor(245, 243, 255); doc.setDrawColor(199, 195, 245);
  doc.roundedRect(mg, y, pw - mg * 2, calcBoxH, 3, 3, 'FD');
  let fy = y + 8;
  const c1 = mg + 8, c2 = pw - mg - 8;

  const fRow = (lbl, val, col) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
    doc.text(lbl, c1, fy);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...col);
    doc.text(fmt(val), c2, fy, { align: 'right' });
    fy += 7;
  };

  fRow('Ventas Final',          d.ventasFinal,         DARK);
  fRow('− Ventas hasta ahora',  d.ventasHastaAhora,    ORANGE);
  fRow('− Total Yapes',         d.totalYapes,           ORANGE);
  const egr = (d.eventos || []).reduce((s, e) =>
    (e.tipo === 'Egreso' || e.tipo === 'Divisa') ? s + e.monto : s, 0);
  const ing = (d.eventos || []).reduce((s, e) =>
    (e.tipo === 'Ingreso' && e.subtipo === 'Efectivo') ? s + e.monto : s, 0);
  if (egr > 0) fRow('− Egresos / Divisa', round2(egr), ORANGE);
  if (ing > 0) fRow('+ Ingresos (efectivo)', round2(ing), GREEN);
  fRow('+ Caja Inicial',        d.cajaInicial,          GREEN);

  doc.setDrawColor(...GRAY); doc.line(c1, fy - 1, c2, fy - 1); fy += 4;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  doc.setTextColor(...INDIGO); doc.text('= Efectivo esperado', c1, fy);
  doc.text(fmt(d.efectivoEsperado), c2, fy, { align: 'right' });
  y = fy + 10;

  // ---- EFECTIVO REAL ----
  y = newPageIfNeeded(y, 30);
  y += 2;
  y = pdfSec(doc, 'EFECTIVO REAL EN CAJA', y, pw, mg, BLUE, LBLUE);
  y = pdfRow(doc, 'Efectivo real contado', fmt(d.efectivoReal), y, mg, pw, DARK, BLUE);

  if (d.cierreMode === 'denom' && d.cierreBreakdown?.length) {
    y = newPageIfNeeded(y, d.cierreBreakdown.length * 4 + 8);
    y += 2;
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...GRAY);
    doc.text('Detalle denominaciones:', mg, y); y += 4.5;
    d.cierreBreakdown.forEach(item => {
      doc.text(`   ${item.label} × ${item.qty} = S/. ${item.subtotal.toFixed(2)}`, mg + 4, y);
      y += 4;
    });
  }
  y += 6;

  // ---- RESULTADO ----
  y = newPageIfNeeded(y, 28);
  y = pdfSec(doc, 'RESULTADO FINAL', y, pw, mg, BLUE, LBLUE);

  const diffColor = d.diferencia < 0 ? RED : GREEN;
  const diffBg    = d.diferencia < 0 ? [254, 226, 226] : [220, 252, 231];
  const diffText  = d.diferencia === 0
    ? '✓  Caja exacta — todo cuadra'
    : d.diferencia > 0
      ? `Sobra   ${fmt(d.diferencia)}`
      : `Falta   ${fmt(Math.abs(d.diferencia))}`;

  doc.setFillColor(...diffBg); doc.setDrawColor(...diffColor);
  doc.roundedRect(mg, y, pw - mg * 2, 16, 3, 3, 'FD');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...diffColor);
  doc.text(diffText, pw / 2, y + 10, { align: 'center' });
  y += 22;

  // USD en caja
  const totalUSDPDF = (d.eventos || []).reduce((s, e) =>
    e.tipo === 'Divisa' ? s + (e.usd || 0) : s, 0);
  if (totalUSDPDF > 0) {
    y = newPageIfNeeded(y, 14);
    doc.setFillColor(239, 246, 255); doc.setDrawColor(191, 219, 254);
    doc.roundedRect(mg, y, pw - mg * 2, 11, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(30, 64, 175);
    doc.text(`💵 USD en caja: $${round2(totalUSDPDF).toFixed(2)}`, pw / 2, y + 7.5, { align: 'center' });
    y += 16;
  }

  // ---- FOOTER ----
  doc.setDrawColor(...GRAY); doc.line(mg, ph - 14, pw - mg, ph - 14);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...GRAY);
  doc.text('Reporte generado por Control de Caja', pw / 2, ph - 8, { align: 'center' });
  doc.text(new Date(d.fecha).toLocaleString('es-PE'), pw / 2, ph - 4, { align: 'center' });

  doc.save(`Cierre_Caja_${new Date(d.fecha).toLocaleDateString('es-PE').replace(/\//g, '-')}.pdf`);
}

// PDF helpers
function pdfSec(doc, title, y, pw, mg, BLUE, LBLUE) {
  doc.setFillColor(...LBLUE); doc.setDrawColor(...BLUE);
  doc.roundedRect(mg, y, pw - mg * 2, 9, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...BLUE);
  doc.text(title, mg + 4, y + 6.5);
  return y + 14;
}

function pdfRow(doc, label, value, y, mg, pw, DARK, BLUE) {
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
  doc.text(label + ':', mg + 2, y);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...BLUE);
  doc.text(value, pw - mg - 2, y, { align: 'right' });
  doc.setDrawColor(235, 235, 235); doc.line(mg, y + 2.5, pw - mg, y + 2.5);
  return y + 8;
}

// ============================================================
//  INACTIVITY TIMER
// ============================================================
function startInactivityTimer() {
  if (userRole === 'employee') return; // employees stay logged in indefinitely
  ['mousemove','mousedown','keydown','touchstart','scroll','click'].forEach(ev =>
    document.addEventListener(ev, resetInactivityTimer, { passive: true })
  );
  resetInactivityTimer();
}

function stopInactivityTimer() {
  clearTimeout(_inactivityTimer);
  clearTimeout(_warningTimer);
  clearInterval(_countdownInterval);
}

function resetInactivityTimer() {
  clearTimeout(_inactivityTimer);
  clearTimeout(_warningTimer);
  clearInterval(_countdownInterval);
  document.getElementById('inactivityWarning')?.classList.add('hidden');

  _warningTimer    = setTimeout(_showInactivityWarning, INACTIVITY_MS - WARNING_AHEAD_MS);
  _inactivityTimer = setTimeout(() => { clearInterval(_countdownInterval); logout(); }, INACTIVITY_MS);
}

function _showInactivityWarning() {
  const warn = document.getElementById('inactivityWarning');
  if (!warn) return;
  warn.classList.remove('hidden');
  let secs = Math.round(WARNING_AHEAD_MS / 1000);
  document.getElementById('inactivityCountdown').textContent = secs;
  _countdownInterval = setInterval(() => {
    secs--;
    const el = document.getElementById('inactivityCountdown');
    if (el) el.textContent = secs;
    if (secs <= 0) clearInterval(_countdownInterval);
  }, 1000);
}

// ============================================================
//  UTILS
// ============================================================
function round2(n) { return Math.round(n * 100) / 100; }
function fmt(n)    { return `S/. ${(+n).toFixed(2)}`; }

// Escape HTML special characters to prevent XSS
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tryParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// SHA-256 via Web Crypto API (built into all modern browsers, no library needed)
async function sha256(str) {
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
