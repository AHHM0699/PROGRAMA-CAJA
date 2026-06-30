'use strict';

// ============================================================
//  FIREBASE CONFIG
// ============================================================
const firebaseConfig = {
  apiKey:            'AIzaSyAhujUO4G1CMgdXXecomb1oMBiW9uWwkHY',
  authDomain:        'programa-caja.firebaseapp.com',
  projectId:         'programa-caja',
  storageBucket:     'programa-caja.firebasestorage.app',
  messagingSenderId: '622065869233',
  appId:             '1:622065869233:web:60a043430ee81937e29d90',
};

firebase.initializeApp(firebaseConfig);
const auth         = firebase.auth();
const db           = firebase.firestore();
const historialCol = db.collection('historial');
const configRef    = db.doc('config/global');

// cajaRef() apunta al documento activo — cambia al seleccionar una caja
function cajaRef() { return db.doc(`cajas/${currentCajaId}`); }

// ============================================================
//  CONSTANTS
// ============================================================
// ── Helpers de fecha/hora siempre en zona horaria de Perú ──────────────────
const TZ = 'America/Lima';
function _todayPE() { return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date()); }
function _mesPE()   { return _todayPE().slice(0, 7); }
function _fmtDT(d, opts)  { return new Date(d).toLocaleString('es-PE',     { timeZone: TZ, ...(opts||{}) }); }
function _fmtD(d, opts)   { return new Date(d).toLocaleDateString('es-PE',  { timeZone: TZ, ...(opts||{}) }); }
function _fmtT(d, opts)   { return new Date(d).toLocaleTimeString('es-PE',  { timeZone: TZ, ...(opts||{}) }); }

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

const STATE_FIELDS = [
  'cajaAbierta', 'nombre', 'cajaInicial', 'ventasHastaAhora', 'ultimoYape',
  'aperturaFecha', 'inicialMode', 'inicialBreakdown',
  'eventos', 'yapesRaw', 'aperturasCaja', 'rcRegistros', '_ts', 'historialBorradorId',
  'conteoEmpleado',
];

// ============================================================
//  STATE
// ============================================================
function _defaultState() {
  return {
    cajaAbierta: false, nombre: '', cajaInicial: 0,
    ventasHastaAhora: 0, ultimoYape: 0, aperturaFecha: null,
    inicialMode: 'monto', inicialBreakdown: null,
    eventos: [], yapesRaw: '', aperturasCaja: [], rcRegistros: [], _ts: 0,
    historialBorradorId: null, conteoEmpleado: null,
  };
}

let state            = _defaultState();
let globalConfig     = {};        // { lastDenomQtys: [...] }
let currentCajaId    = null;
let currentCajaNombre = null;

let cierreMode           = 'monto';
let userRole             = 'admin';
let _pipWindow           = null;
let _unsubscribeSync     = null;
let _estadoPushTimer     = null;
let _inactivityTimer     = null;
let _reportesCache       = [];
let _warningTimer        = null;
let _countdownInterval   = null;

let currentEventoTipo    = 'Egreso';
let currentEventoSubtipo = 'Efectivo';

// Flujo de caja mensual
let _currentFlujoMes  = null;
let _flujoUnsub       = null;
let _egresoscajaCache = [];
let _flujoDocCache    = {};
let _flujoCharts      = {};

// ============================================================
//  INIT
// ============================================================
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveStateNow();
});
window.addEventListener('beforeunload', () => { saveStateNow(); });

window.addEventListener('DOMContentLoaded', () => {
  buildDenomTable('inicial',   'inicialDenomTable');
  buildDenomTable('cierre',    'cierreDenomTable');
  buildDenomTable('empConteo', 'empConteoDenomTable');

  const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  document.getElementById('headerDate').textContent =
    new Date().toLocaleDateString('es-PE', { ...opts, timeZone: TZ });

  auth.onAuthStateChanged(async (user) => {
    if (user) {
      await _initSession(user);
    } else {
      _showLoginScreen();
    }
  });
});

async function _initSession(user) {
  // Role desde Firestore
  try {
    const snap = await db.doc(`usuarios/${user.uid}`).get();
    userRole = snap.exists ? (snap.data().role || 'employee') : 'admin';
  } catch (e) { userRole = 'admin'; }

  // Config global (lastDenomQtys, etc.)
  try {
    const snap = await configRef.get();
    if (snap.exists) globalConfig = snap.data();
  } catch (e) {}

  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainApp').style.display     = 'block';
  _applyRoleUI();
  _aperturasDiaListenStart();
  if (userRole === 'employee') {
    await showCajaSelector();
  } else {
    showHomeView();
  }
}

function _showLoginScreen() {
  stopRealtimeSync();
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('mainApp').style.display     = 'none';
  document.getElementById('emailInput').focus();
  state             = _defaultState();
  currentCajaId     = null;
  currentCajaNombre = null;
}

// ============================================================
//  AUTH
// ============================================================
async function login() {
  const email = document.getElementById('emailInput').value.trim();
  const pass  = document.getElementById('passInput').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!email || !pass) { errEl.textContent = 'Ingresa tu correo y contraseña.'; return; }

  try {
    await auth.signInWithEmailAndPassword(email, pass);
    document.getElementById('passInput').value  = '';
    document.getElementById('emailInput').value = '';
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainApp').style.display     = 'block';
  } catch (e) {
    document.getElementById('passInput').value = '';
    const msgs = {
      'auth/user-not-found':    'Usuario no encontrado.',
      'auth/wrong-password':    'Contraseña incorrecta.',
      'auth/invalid-email':     'Correo inválido.',
      'auth/invalid-credential':'Correo o contraseña incorrectos.',
      'auth/too-many-requests': 'Demasiados intentos. Intenta más tarde.',
    };
    errEl.textContent = msgs[e.code] || 'Error al iniciar sesión.';
    const input = document.getElementById('passInput');
    input.classList.add('shake');
    input.addEventListener('animationend', () => input.classList.remove('shake'), { once: true });
    document.getElementById('emailInput').focus();
  }
}

function _applyRoleUI() {
  const isEmp = userRole === 'employee';
  document.getElementById('empleadoBadge').classList.toggle('hidden', !isEmp);
  document.getElementById('btnHistorial').classList.toggle('hidden', isEmp);
  document.getElementById('btnFlujo').classList.toggle('hidden', isEmp);
  document.getElementById('btnCajas').classList.toggle('hidden', false);
}

let _yapesWin = null;
function openYapesWidget() {
  const W   = 200, H = 90;
  const url = 'yapes-widget.html' + (currentCajaId ? '?cajaId=' + currentCajaId : '');

  // Si ya está abierto, enfocar
  if (_yapesWin && !_yapesWin.closed) { _yapesWin.focus(); _triggerTopmost(); return; }

  // Abrir popup independiente: sobrevive al cierre de la webapp
  _yapesWin = window.open(url, 'YapesWidget',
    `popup,width=${W},height=${H},left=${screen.availLeft+10},top=${screen.availTop+screen.availHeight-H-10}`);

  // Aplicar HWND_TOPMOST via protocolo (requiere haber ejecutado crear-acceso-directo.ps1)
  // Brave pedirá permiso la primera vez → marcar "Siempre permitir"
  setTimeout(_triggerTopmost, 1000);
}

function _triggerTopmost() {
  try {
    const a = document.createElement('a');
    a.href = 'cheplastopmost://go';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 500);
  } catch(e) {}
}

async function logout() {
  stopRealtimeSync();
  if (_pipWindow && !_pipWindow.closed) _pipWindow.close();
  _pipWindow        = null;
  currentCajaId     = null;
  currentCajaNombre = null;
  userRole          = 'admin';
  await auth.signOut();
}

// ============================================================
//  CAJA SELECTOR
// ============================================================
function showHomeView() {
  stopRealtimeSync();
  if (_pipWindow && !_pipWindow.closed) _pipWindow.close();
  _pipWindow = null;
  if (_flujoUnsub) { _flujoUnsub(); _flujoUnsub = null; }
  ['viewApertura','viewCierre','viewReportes','viewEmpleado','viewFlujo','viewCajaSelector'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  document.getElementById('viewHome').classList.remove('hidden');
}

async function showCajaSelector() {
  stopRealtimeSync();
  if (_pipWindow && !_pipWindow.closed) _pipWindow.close();
  _pipWindow = null;

  // Mostrar selector, ocultar todas las demás vistas
  ['viewHome','viewApertura','viewCierre','viewReportes','viewEmpleado','viewFlujo'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  document.getElementById('viewCajaSelector').classList.remove('hidden');
  if (_flujoUnsub) { _flujoUnsub(); _flujoUnsub = null; }

  // Solo admin puede abrir nueva caja
  const btnNueva = document.getElementById('btnNuevaCaja');
  if (btnNueva) btnNueva.style.display = userRole === 'admin' ? '' : 'none';

  await _renderCajasLista();
}

async function _renderCajasLista() {
  const lista = document.getElementById('cajasLista');
  lista.innerHTML = '<p style="color:#9ca3af;text-align:center;padding:12px">Cargando...</p>';

  const ccCard = document.getElementById('selectorAperturaCC');
  const showCcCard = (hayAlgunaAbierta) => {
    if (!ccCard) return;
    const visible = userRole === 'employee' && !hayAlgunaAbierta;
    ccCard.classList.toggle('hidden', !visible);
    if (visible) _actualizarContadorSelectorCC();
  };

  try {
    const snap  = await db.collection('cajas').get();
    const cajas = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      // Ignorar documentos fantasma (sin nombre, sin fecha de apertura, sin monto inicial)
      .filter(c => !c.eliminada && (c.nombre || c.aperturaFecha || c.cajaInicial > 0 || c.cajaAbierta))
      .sort((a, b) => new Date(b.aperturaFecha || 0) - new Date(a.aperturaFecha || 0));

    if (cajas.length === 0) {
      lista.innerHTML = '<p class="no-cajas-msg">No hay cajas abiertas</p>';

      // Empleado sin cajas → mensaje de espera
      if (userRole === 'employee') {
        lista.innerHTML = '<p class="no-cajas-msg">⏳ Esperando apertura de caja…</p>';
      }
      showCcCard(false);
      return;
    }

    // Empleado con una sola caja → auto-seleccionar
    if (userRole === 'employee' && cajas.length === 1) {
      await selectCaja(cajas[0].id);
      return;
    }

    showCcCard(cajas.some(c => c.cajaAbierta));

    const isAdmin = userRole === 'admin';
    lista.innerHTML = cajas.map(c => `
      <div class="caja-item" onclick="selectCaja('${c.id}')">
        <div>
          <div class="caja-item-name">${escHtml(c.nombre || 'Sin nombre')}</div>
          <div class="caja-item-meta">
            ${c.aperturaFecha ? new Date(c.aperturaFecha).toLocaleString('es-PE', { timeZone: TZ }) : '—'}
            &nbsp;·&nbsp; Inicial: ${fmt(c.cajaInicial || 0)}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          ${isAdmin ? `<button class="btn-caja-del" title="Eliminar caja" onclick="event.stopPropagation();eliminarCajaDeListado('${c.id}')">🗑</button>` : ''}
          <span class="caja-item-arrow">›</span>
        </div>
      </div>`).join('');
  } catch (e) {
    lista.innerHTML = '<p style="color:#dc2626;text-align:center">Error cargando cajas</p>';
    console.error(e);
    showCcCard(false);
  }
}

// Muestra el modal de confirmación de eliminación; devuelve una Promise<boolean>
let _eliminarResolve = null;
function _confirmarEliminar(nombre) {
  return new Promise(resolve => {
    _eliminarResolve = resolve;
    const modal = document.getElementById('eliminarConfirmModal');
    document.getElementById('eliminarCajaNombre').textContent = nombre || 'esta caja';
    document.getElementById('eliminarConfirmBtn').onclick = () => { modal.classList.add('hidden'); resolve(true); };
    modal.classList.remove('hidden');
  });
}
function _cancelEliminar() {
  document.getElementById('eliminarConfirmModal').classList.add('hidden');
  if (_eliminarResolve) { _eliminarResolve(false); _eliminarResolve = null; }
}

async function eliminarCajaDeListado(cajaId) {
  // Leer nombre y borrador ID antes de eliminar el documento
  let cajaNombre = '', historialBorradorId = null;
  try {
    const s = await db.doc(`cajas/${cajaId}`).get();
    if (s.exists) { cajaNombre = s.data().nombre || ''; historialBorradorId = s.data().historialBorradorId || null; }
  } catch (_) {}
  if (!await _confirmarEliminar(cajaNombre)) return;
  const ref = db.doc(`cajas/${cajaId}`);
  let ok = false;
  try { await ref.delete(); ok = true; } catch (_) {}
  if (!ok) {
    try { await ref.set({ eliminada: true, cajaAbierta: false, _ts: Date.now() }, { merge: true }); ok = true; } catch (e) { console.error(e); }
  }
  if (!ok) { alert('No se pudo eliminar la caja. Verifica tu conexión.'); return; }
  if (historialBorradorId) {
    db.collection('historial').doc(historialBorradorId).delete().catch(() => {});
  }
  await _renderCajasLista();
}

async function selectCaja(cajaId) {
  currentCajaId = cajaId;
  cierreMode = 'monto';
  _conteoEmpleadoPrefillDone = false;
  _conteoCierrePrefillDone   = false;

  state = _defaultState();
  await _loadStateFromFirestore();
  currentCajaNombre = state.nombre || '';
  startRealtimeSync();

  document.getElementById('viewCajaSelector').classList.add('hidden');
  _applyRoleUI(); // restaurar Flujo e Historial según rol
  _updateCajaHeader();
  showView('auto');
}

function iniciarNuevaCaja() {
  currentCajaId     = null;
  currentCajaNombre = null;
  state             = _defaultState();

  document.getElementById('viewCajaSelector').classList.add('hidden');
  // Limpiar campos de apertura
  ['cajaInicialExacto','ventasHastaAhora','ultimoYape','cajaNombreInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('inicialDenomTotal').textContent = 'S/. 0.00';
  DENOMS.forEach((_, i) => {
    const q = document.getElementById(`inicialQty${i}`);
    const s = document.getElementById(`inicialSub${i}`);
    if (q) q.value = '';
    if (s) s.textContent = 'S/. 0.00';
  });
  setMode('inicial', 'monto');
  prefillInicialDenoms();

  ['viewApertura','viewCierre','viewReportes','viewEmpleado','viewFlujo'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  document.getElementById('viewApertura').classList.remove('hidden');
}

function _updateCajaHeader() {
  const badge = document.getElementById('cajaNombreDisplay');
  if (badge) {
    badge.textContent = currentCajaNombre || 'Caja';
    badge.classList.toggle('hidden', !currentCajaNombre);
  }
}

// ============================================================
//  VIEWS
// ============================================================
function showView(view) {
  if (userRole === 'employee') { _showEmployeeView(); return; }
  if (view === 'auto') view = state.cajaAbierta ? 'cierre' : 'apertura';

  ['viewHome','viewApertura','viewCierre','viewReportes','viewEmpleado','viewFlujo','viewCajaSelector'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  const cap = view.charAt(0).toUpperCase() + view.slice(1);
  document.getElementById('view' + cap).classList.remove('hidden');

  if (view === 'apertura') prefillInicialDenoms();
  if (view === 'cierre')   {
    renderResumen(); renderEventos(); _syncYapesToDom(); calcularEsperado(); openReporteCaja();
    _renderConteoEmpleadoBanner();
    cargarConteoEmpleadoEnCierre(false);
  }
  if (view === 'reportes') renderReportes();
}

function _showEmployeeView() {
  ['viewHome','viewApertura','viewCierre','viewReportes','viewEmpleado','viewCajaSelector'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  document.getElementById('viewEmpleado').classList.remove('hidden');

  const open = state.cajaAbierta;
  document.getElementById('empCajaCerrada').classList.toggle('hidden', open);
  document.getElementById('empCajaAbierta').classList.toggle('hidden', !open);
  if (!open) _actualizarContadorCC();

  if (open) {
    const fechaStr = state.aperturaFecha
      ? escHtml(new Date(state.aperturaFecha).toLocaleString('es-PE', { timeZone: TZ })) : 'N/A';
    document.getElementById('empResumenGrid').innerHTML = `
      <div class="info-item"><div class="info-label">Caja Inicial</div>
        <div class="info-val">${fmt(state.cajaInicial)}</div></div>
      <div class="info-item"><div class="info-label">Ventas hasta ahora</div>
        <div class="info-val">${fmt(state.ventasHastaAhora)}</div></div>
      <div class="info-item"><div class="info-label">Último Yape</div>
        <div class="info-val">${fmt(state.ultimoYape)}</div></div>
      <div class="info-item"><div class="info-label">Apertura</div>
        <div class="info-val" style="font-size:12px;line-height:1.4">${fechaStr}</div></div>`;
    renderEventos();
    _renderEmpYapesList();
    _renderAperturasCaja();
    _renderConteoEmpleadoSide();
  }
}

function _renderEmpYapesList() {
  const body = document.getElementById('empYapesListBody');
  if (!body) return;
  const items = (state.yapesRaw || '').split('\n')
    .map(s => parseFloat(s.trim())).filter(v => !isNaN(v) && v > 0);
  if (items.length === 0) {
    body.innerHTML = '<p style="color:#9ca3af;font-size:13px">No hay yapes registrados aún.</p>';
    return;
  }
  const total = round2(items.reduce((s, v) => s + v, 0));
  body.innerHTML =
    items.map((v, i) => `
      <div style="display:flex;justify-content:space-between;padding:6px 0;
                  border-bottom:1px solid #f3f4f6;font-size:14px">
        <span style="color:#6b7280">#${i + 1}</span>
        <span style="font-weight:600;color:#111827">S/. ${v.toFixed(2)}</span>
      </div>`).join('') +
    `<div style="display:flex;justify-content:space-between;padding:8px 0 2px;
                font-size:14px;font-weight:700;color:#2563eb">
       <span>Total</span><span>S/. ${total.toFixed(2)}</span>
     </div>`;
}

function refreshCurrentView() {
  const views = {
    viewCierre:   () => {
      renderResumen(); renderEventos(); _syncYapesToDom(); calcularEsperado();
      _renderConteoEmpleadoBanner();
      cargarConteoEmpleadoEnCierre(false);
    },
    viewEmpleado: () => _showEmployeeView(),
    viewApertura: () => prefillInicialDenoms(),
  };
  for (const [id, fn] of Object.entries(views)) {
    if (!document.getElementById(id)?.classList.contains('hidden')) { fn(); break; }
  }
}

// ============================================================
//  DOM SYNC HELPERS
// ============================================================
function _syncYapesToDom() {
  const el = document.getElementById('yapesInput');
  if (el && el.value !== state.yapesRaw) {
    el.value = state.yapesRaw || '';
    onYapesInput();
  }
}

function _el(id) {
  return document.getElementById(id) ||
    (_pipWindow && !_pipWindow.closed && _pipWindow.document.getElementById(id));
}

// ── Aperturas a nivel de día (compartidas entre turnos/sesiones) ──────────
// Antes las aperturas "con caja cerrada" vivían solo en localStorage del
// dispositivo y nunca llegaban a los reportes. Ahora todo (fisica, fisica-
// cerrada, registro) se guarda también en aperturasDia/{fecha} en Firestore,
// para que un cierre de Tarde pueda mostrar lo que pasó en la Mañana.
const aperturasDiaCol = db.collection('aperturasDia');
let _aperturasDiaCache = { fecha: null, lista: [] };
let _aperturasDiaUnsub = null;

function _turnoDe(iso) {
  const h = parseInt(
    new Intl.DateTimeFormat('es-PE', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(iso)),
    10
  );
  return h < 12 ? 'AM' : 'PM';
}
function _turnoLabel(t) { return t === 'AM' ? 'Mañana' : 'Tarde'; }
function _ccTurnoActual() { return _turnoDe(new Date().toISOString()); }

function _aperturasDiaListenStart() {
  const hoy = _todayPE();
  if (_aperturasDiaUnsub) _aperturasDiaUnsub();
  _aperturasDiaCache = { fecha: hoy, lista: [] };
  _aperturasDiaUnsub = aperturasDiaCol.doc(hoy).onSnapshot(snap => {
    _aperturasDiaCache = { fecha: hoy, lista: snap.exists ? (snap.data().lista || []) : [] };
    _actualizarContadorCC();
    _actualizarContadorSelectorCC();
  }, () => {});
}

function _aperturasDiaListaHoy() {
  return _aperturasDiaCache.fecha === _todayPE() ? _aperturasDiaCache.lista : [];
}

function _ccUsadasTurno(turno) {
  return _aperturasDiaListaHoy().filter(a => a.tipo === 'fisica-cerrada' && a.turno === turno).length;
}

async function _aperturasDiaPush(entry) {
  const hoy = _todayPE();
  try {
    await aperturasDiaCol.doc(hoy).set(
      { lista: firebase.firestore.FieldValue.arrayUnion(entry) },
      { merge: true }
    );
  } catch (e) { console.warn('Error registrando apertura del día:', e); }
}

async function _aperturasDiaFetch(fecha) {
  try {
    const snap = await aperturasDiaCol.doc(fecha).get();
    return snap.exists ? (snap.data().lista || []) : [];
  } catch (e) { return null; } // null = sin red/error, el llamador decide el fallback
}

async function _buildAperturasReporte() {
  const fecha = _rcFechaCaja();
  const dia   = await _aperturasDiaFetch(fecha);
  if (dia === null) return state.aperturasCaja || []; // sin red: usar solo lo de esta sesión
  return dia.slice().sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
}

// ── Apertura de gaveta POS-D via protocolo cajaabierta:// ────
function _registrarAperturaCaja({ motivo, tipo }) {
  const fecha = new Date().toISOString();
  const turno = _turnoDe(fecha);
  if (!Array.isArray(state.aperturasCaja)) state.aperturasCaja = [];
  state.aperturasCaja.push({ motivo, tipo, fecha, turno });
  saveState();
  _aperturasDiaPush({ motivo, tipo, fecha, turno });
  _renderAperturasCaja();
  _rcRenderAperturasEmp();
}

function _validarMotivoApertura() {
  const motInp = document.getElementById('posMotivo');
  const fb     = document.getElementById('posFeedback');
  const motivo = (motInp?.value || '').trim();
  if (!motivo) {
    if (motInp) { motInp.focus(); motInp.style.borderColor = '#dc2626'; }
    if (fb) fb.textContent = 'Escribe el motivo antes de continuar.';
    return null;
  }
  if (motInp) motInp.style.borderColor = '';
  if (fb)     fb.textContent = '';
  return { motivo, motInp, fb };
}

async function abrirCajaPOS() {
  const v = _validarMotivoApertura();
  if (!v) return;
  const { motivo, motInp, fb } = v;
  const btn = document.getElementById('btnAbrirCajaPOS');
  if (btn) btn.disabled = true;

  try {
    const a = document.createElement('a');
    a.href = 'cajaabierta://abrir';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    _registrarAperturaCaja({ motivo, tipo: 'fisica' });

    if (motInp) motInp.value = '';
    if (fb) { fb.textContent = '✔ Gaveta abierta'; setTimeout(() => { if (fb) fb.textContent = ''; }, 2500); }
  } catch (e) {
    if (fb) fb.textContent = 'Error: ' + e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _actualizarContadorCC() {
  const el  = document.getElementById('empCerradaContador');
  const btn = document.getElementById('btnAbrirCC');
  if (!el) return;
  const turno     = _ccTurnoActual();
  const usadas    = _ccUsadasTurno(turno);
  const restantes = 3 - usadas;
  const label     = _turnoLabel(turno).toLowerCase();
  el.textContent  = restantes > 0 ? `${restantes}/3 disponibles (${label})` : `0/3 — límite ${label} alcanzado`;
  el.style.color  = restantes > 0 ? '#6b7280' : '#dc2626';
  if (btn) btn.disabled = restantes <= 0;
}

function abrirGavetaCajaCerrada() {
  const motInp = document.getElementById('posMotivoCC');
  const fb     = document.getElementById('empCerradaFeedback');
  const motivo = (motInp?.value || '').trim();
  if (!motivo) {
    if (motInp) { motInp.focus(); motInp.style.borderColor = '#dc2626'; }
    if (fb) fb.textContent = 'Escribe el motivo antes de continuar.';
    return;
  }
  if (motInp) motInp.style.borderColor = '';

  const turno  = _ccTurnoActual();
  const usadas = _ccUsadasTurno(turno);
  if (usadas >= 3) {
    if (fb) fb.textContent = `⚠ Límite alcanzado: ya abriste la gaveta 3 veces esta ${_turnoLabel(turno).toLowerCase()}.`;
    return;
  }

  const btn = document.getElementById('btnAbrirCC');
  if (btn) btn.disabled = true;

  try {
    const a = document.createElement('a');
    a.href = 'cajaabierta://abrir';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch(e) {}

  if (currentCajaId) {
    _registrarAperturaCaja({ motivo, tipo: 'fisica-cerrada' });
  } else {
    _aperturasDiaPush({ motivo, tipo: 'fisica-cerrada', fecha: new Date().toISOString(), turno });
  }
  if (motInp) motInp.value = '';

  const restantes = 2 - usadas;
  if (fb) {
    fb.textContent = restantes > 0
      ? `✔ Gaveta abierta — quedan ${restantes} apertura${restantes !== 1 ? 's' : ''} esta ${_turnoLabel(turno).toLowerCase()}`
      : '✔ Gaveta abierta — límite del turno alcanzado';
    setTimeout(() => { if (fb) fb.textContent = ''; }, 3000);
  }
  _actualizarContadorCC();
}

// ── Apertura física desde el selector cuando no hay cajas abiertas ──
function _renderSelectorCCList() {
  const el = document.getElementById('selectorCCList');
  if (!el) return;
  const list = _aperturasDiaListaHoy().filter(a => a.tipo === 'fisica-cerrada');
  if (list.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML =
    '<div style="font-size:12px;color:#6b7280;margin-bottom:4px">Aperturas de hoy</div>' +
    list.map((a, i) => {
      const d = new Date(a.fecha);
      const hora = d.toLocaleTimeString('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
      return `<div style="display:flex;justify-content:space-between;align-items:center;
                          padding:5px 0;border-bottom:1px solid #f0f0f0;font-size:13px">
        <span style="color:#374151;min-width:0;overflow:hidden;text-overflow:ellipsis">
          ${i+1}. <span style="background:#fef3c7;color:#92400e;font-size:11px;padding:1px 6px;border-radius:10px;margin-right:6px">🔒 ${_turnoLabel(a.turno || _turnoDe(a.fecha))}</span>${escHtml(a.motivo)}
        </span>
        <span style="color:#6b7280;white-space:nowrap;margin-left:10px">${hora}</span>
      </div>`;
    }).join('');
}

function _actualizarContadorSelectorCC() {
  const el  = document.getElementById('selectorCCContador');
  const btn = document.getElementById('btnAbrirSelectorCC');
  if (!el) return;
  const turno     = _ccTurnoActual();
  const usadas    = _ccUsadasTurno(turno);
  const restantes = 3 - usadas;
  const label     = _turnoLabel(turno).toLowerCase();
  el.textContent  = restantes > 0 ? `${restantes}/3 disponibles (${label})` : `0/3 — límite ${label} alcanzado`;
  el.style.color  = restantes > 0 ? '#6b7280' : '#dc2626';
  if (btn) btn.disabled = restantes <= 0;
  _renderSelectorCCList();
}

function abrirCajaSinCajaActiva() {
  const motInp = document.getElementById('selectorMotivoCC');
  const fb     = document.getElementById('selectorCCFeedback');
  const motivo = (motInp?.value || '').trim();
  if (!motivo) {
    if (motInp) { motInp.focus(); motInp.style.borderColor = '#dc2626'; }
    if (fb) fb.textContent = 'Escribe el motivo antes de continuar.';
    return;
  }
  if (motInp) motInp.style.borderColor = '';

  const turno  = _ccTurnoActual();
  const usadas = _ccUsadasTurno(turno);
  if (usadas >= 3) {
    if (fb) fb.textContent = `⚠ Límite alcanzado: ya abriste la caja 3 veces esta ${_turnoLabel(turno).toLowerCase()}.`;
    _actualizarContadorSelectorCC();
    return;
  }

  const btn = document.getElementById('btnAbrirSelectorCC');
  if (btn) btn.disabled = true;

  try {
    const a = document.createElement('a');
    a.href = 'cajaabierta://abrir';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (_) {}

  _aperturasDiaPush({ motivo, tipo: 'fisica-cerrada', fecha: new Date().toISOString(), turno });

  if (motInp) motInp.value = '';
  const restantes = 2 - usadas;
  if (fb) {
    fb.textContent = restantes > 0
      ? `✔ Caja abierta — quedan ${restantes} apertura${restantes !== 1 ? 's' : ''} esta ${_turnoLabel(turno).toLowerCase()}`
      : '✔ Caja abierta — límite del turno alcanzado';
    setTimeout(() => { if (fb) fb.textContent = ''; }, 3000);
  }
  _actualizarContadorSelectorCC();
}

function registrarAperturaSinAbrir() {
  const v = _validarMotivoApertura();
  if (!v) return;
  const { motivo, motInp, fb } = v;
  const btn = document.getElementById('btnRegistrarApertura');
  if (btn) btn.disabled = true;

  try {
    _registrarAperturaCaja({ motivo, tipo: 'registro' });
    if (motInp) motInp.value = '';
    if (fb) { fb.textContent = '✔ Evento registrado (sin abrir gaveta)'; setTimeout(() => { if (fb) fb.textContent = ''; }, 2500); }
  } catch (e) {
    if (fb) fb.textContent = 'Error: ' + e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _renderAperturasCaja() {
  const lista = state.aperturasCaja || [];
  const html = lista.length === 0
    ? '<p style="color:#9ca3af;font-size:13px">Sin aperturas registradas.</p>'
    : lista.map((a, i) => {
        const d     = new Date(a.fecha);
        const fecha = d.toLocaleDateString('es-PE', { timeZone: TZ, day: '2-digit', month: '2-digit' });
        const hora  = d.toLocaleTimeString('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
        const badge = a.tipo === 'registro'
          ? '<span style="background:#e5e7eb;color:#374151;font-size:11px;padding:1px 6px;border-radius:10px;margin-right:6px">📝 Registro</span>'
          : a.tipo === 'fisica-cerrada'
            ? '<span style="background:#fef3c7;color:#92400e;font-size:11px;padding:1px 6px;border-radius:10px;margin-right:6px">🔒 C.Cerrada</span>'
            : '<span style="background:#dcfce7;color:#166534;font-size:11px;padding:1px 6px;border-radius:10px;margin-right:6px">🔓 Gaveta</span>';
        return `<div style="display:flex;justify-content:space-between;align-items:center;
                            padding:5px 0;border-bottom:1px solid #f0f0f0;font-size:13px">
          <span style="color:#374151;min-width:0;overflow:hidden;text-overflow:ellipsis">
            ${i+1}. ${badge}${escHtml(a.motivo)}
          </span>
          <span style="color:#6b7280;white-space:nowrap;margin-left:10px">${fecha} ${hora}</span>
        </div>`;
      }).join('');

  const emp   = document.getElementById('empAperturasCajaList');
  const admin = document.getElementById('adminAperturasCajaList');
  if (emp) emp.innerHTML = lista.length === 0 ? '' : html;
}

function addEmpYape() {
  const input    = _el('empYapeInput');
  const feedback = _el('empYapeFeedback');
  if (!input) return;
  const v = round2(parseFloat(input.value));
  if (isNaN(v) || v <= 0) { input.focus(); return; }

  state.yapesRaw = (state.yapesRaw ? state.yapesRaw.trimEnd() + '\n' : '') + v.toFixed(2);
  const adminEl  = document.getElementById('yapesInput');
  if (adminEl) { adminEl.value = state.yapesRaw; onYapesInput(); }

  input.value = '';
  input.focus();
  saveState();
  _renderEmpYapesList();

  if (feedback) {
    feedback.textContent = `✓ S/. ${v.toFixed(2)} registrado`;
    setTimeout(() => { if (feedback) feedback.textContent = ''; }, 2500);
  }
}

// ============================================================
//  PICTURE-IN-PICTURE YAPE WIDGET
// ============================================================
async function openYapeWidget() {
  if (!('documentPictureInPicture' in window)) {
    alert('Tu versión de Brave/Chrome no soporta esta función (requiere v116+).');
    return;
  }
  if (_pipWindow && !_pipWindow.closed) { _pipWindow.focus(); return; }

  const placeholder = document.getElementById('empYapePipPlaceholder');

  _pipWindow = await window.documentPictureInPicture.requestWindow({
    width: 100, height: 40, disallowReturnToOpener: false,
  });

  const D = _pipWindow.document;
  const style = D.createElement('style');
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
    html.faded, html.faded body { background: transparent !important; opacity: 0.08; }
    .w { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
    .p { position: absolute; left: 5px; font-size: 10px; font-weight: 700;
         color: #94a3b8; pointer-events: none; user-select: none; }
    #pi { width: 100%; height: 26px; padding: 0 4px 0 22px;
          border: none; border-radius: 4px; font-size: 12px; font-family: inherit;
          outline: none; background: #fff; }
    #pi:focus { box-shadow: 0 0 0 2px #60a5fa; }
    #pb { flex-shrink: 0; width: 26px; height: 26px; background: #2563eb; color: #fff;
          border: none; border-radius: 4px; font-size: 17px; font-weight: 700;
          cursor: pointer; line-height: 1; display: flex; align-items: center; justify-content: center; }
    #pb:hover { background: #1d4ed8; }
    #pk { flex-shrink: 0; width: 14px; font-size: 11px; font-weight: 700;
          color: #86efac; text-align: center; }
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
    const adminEl  = document.getElementById('yapesInput');
    if (adminEl) { adminEl.value = state.yapesRaw; onYapesInput(); }
    saveState();
    _renderEmpYapesList();
    pipInput.value = '';
    pipInput.focus();
    pipOk.textContent = '✓';
    setTimeout(() => { pipOk.textContent = ''; }, 1000);
  }

  D.getElementById('pb').addEventListener('click', pipAdd);
  pipInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pipAdd(); } });

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
    s.src = url; s.integrity = integrity;
    s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer';
    s.onload  = () => { _loadedScripts.add(url); resolve(); };
    s.onerror = () => reject(new Error('No se pudo cargar: ' + url));
    document.head.appendChild(s);
  });
}

const CHARTJS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';
const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const JSPDF_SRI = 'sha512-qZvrmS2ekKPF2mSznTQsxqPgnpkI4DNTlrdUmTzrDgektczlKNRRhy5X5AAOnx5S09ydFYWWNSfcEqDTTHgtNA==';
const XLSX_URL  = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.mini.min.js';
const XLSX_SRI  = 'sha512-NDQhXrK2pOCL18FV5/Nc+ya9Vz+7o8dJV1IGRwuuYuRMFhAR0allmjWdZCSHFLDYgMvXKyN2jXlSy2JJEmq+ZA==';

// ============================================================
//  STATE — FIRESTORE PERSISTENCE + REAL-TIME SYNC
// ============================================================
function _stateToDoc() {
  const doc = {};
  STATE_FIELDS.forEach(k => { doc[k] = state[k] !== undefined ? state[k] : null; });
  return doc;
}

// ---- Borrador helpers (historial en tiempo real) ----
function _calcTotalYapesFromRaw(raw) {
  return round2((raw || '').split('\n').reduce((sum, s) => {
    const v = parseFloat(s.trim());
    return sum + (isNaN(v) || v < 0 ? 0 : v);
  }, 0));
}

function _borradorRef() {
  return state.historialBorradorId ? historialCol.doc(state.historialBorradorId) : null;
}

function _buildBorradorDoc() {
  return {
    estado:          'borrador',
    fecha:           state.aperturaFecha || new Date().toISOString(),
    aperturaFecha:   state.aperturaFecha,
    cajaId:          currentCajaId,
    cajaNombre:      currentCajaNombre || state.nombre || '',
    cajaInicial:     state.cajaInicial     || 0,
    ventasHastaAhora: state.ventasHastaAhora || 0,
    ultimoYape:      state.ultimoYape      || 0,
    inicialMode:     state.inicialMode     || 'monto',
    inicialBreakdown: state.inicialBreakdown || null,
    yapesRaw:        state.yapesRaw        || '',
    totalYapes:      _calcTotalYapesFromRaw(state.yapesRaw),
    eventos:         state.eventos         || [],
    aperturasCaja:   state.aperturasCaja   || [],
    rcRegistros:     state.rcRegistros     || [],
  };
}

async function _syncBorrador() {
  const ref = _borradorRef();
  if (!ref) return;
  try {
    const snap = await ref.get();
    if (snap.exists && snap.data().estado === 'cerrado') return;
    if (!_borradorRef()) return; // cerrarCaja() corrió durante el await — abortar
    await ref.set(_buildBorradorDoc());
  } catch (e) { console.warn('Error sincronizando borrador:', e); }
}
// ---- fin borrador helpers ----

function saveStateNow() {
  if (!currentCajaId) return;
  clearTimeout(_estadoPushTimer);
  state._ts = Date.now();
  cajaRef().set(_stateToDoc()).catch(e => console.warn('saveStateNow error:', e));
  _syncBorrador();
}

function saveState() {
  if (!currentCajaId) return;
  state._ts = Date.now();
  clearTimeout(_estadoPushTimer);
  _estadoPushTimer = setTimeout(() => {
    if (!currentCajaId) return;  // guard: caja puede haberse cerrado durante el delay
    cajaRef().set(_stateToDoc()).catch(e => console.warn('saveState error:', e));
    _syncBorrador();
  }, 1200);
}

async function _loadStateFromFirestore() {
  if (!currentCajaId) return;
  try {
    const snap = await cajaRef().get();
    if (snap.exists) _applyRemoteState(snap.data());
  } catch (e) { console.warn('Error cargando caja:', e); }
}

function _applyRemoteState(remote) {
  STATE_FIELDS.forEach(k => {
    if (Object.prototype.hasOwnProperty.call(remote, k)) state[k] = remote[k];
  });
  if (!Array.isArray(state.eventos))    state.eventos  = [];
  if (typeof state.yapesRaw !== 'string') state.yapesRaw = '';

  if (state.cajaAbierta) {
    setMode('inicial', state.inicialMode || 'monto');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('cajaInicialExacto', state.cajaInicial      || 0);
    set('ventasHastaAhora',  state.ventasHastaAhora || 0);
    set('ultimoYape',        state.ultimoYape        || 0);
    set('yapesInput',        state.yapesRaw);
  }
}

function startRealtimeSync() {
  if (_unsubscribeSync) _unsubscribeSync();
  if (!currentCajaId) return;
  _unsubscribeSync = cajaRef().onSnapshot(snap => {
    if (!snap.exists) {
      // Caja eliminada (cerrada por otro dispositivo) → volver al selector
      showSyncToast('📋 Caja cerrada en otro dispositivo');
      stopRealtimeSync();
      currentCajaId     = null;
      currentCajaNombre = null;
      state             = _defaultState();
      setTimeout(() => showCajaSelector(), 2000);
      return;
    }
    const remote = snap.data();
    if ((remote._ts || 0) <= (state._ts || 0)) return;
    _applyRemoteState(remote);
    showSyncToast('🔄 Sincronizado');
    refreshCurrentView();
  }, err => console.warn('Sync error:', err));
}

function stopRealtimeSync() {
  if (_unsubscribeSync) { _unsubscribeSync(); _unsubscribeSync = null; }
}

function showSyncToast(msg) {
  const el = document.getElementById('syncToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3500);
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

const DENOM_TOTAL_IDS = {
  inicial:    'inicialDenomTotal',
  cierre:     'cierreDenomTotal',
  empConteo:  'empConteoDenomTotal',
};

function onDenomInput(section, idx) {
  const qty     = parseFloat(document.getElementById(`${section}Qty${idx}`).value) || 0;
  document.getElementById(`${section}Sub${idx}`).textContent = fmt(round2(qty * DENOMS[idx].val));
  const total   = getDenomTotal(section);
  const totalId = DENOM_TOTAL_IDS[section];
  if (totalId) document.getElementById(totalId).textContent = fmt(total);
  if (section === 'cierre')    calcularDiferencia();
  if (section === 'empConteo') _saveConteoEmpleado();
}

function getDenomTotal(section) {
  return round2(DENOMS.reduce((sum, _, i) => {
    return sum + (parseFloat(document.getElementById(`${section}Qty${i}`)?.value) || 0) * DENOMS[i].val;
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
    : (parseFloat(document.getElementById('cajaFinalExacto')?.value) || 0);
}

function getTotalUSD() {
  return round2((state.eventos || []).reduce((s, e) => e.tipo === 'Divisa' ? s + (e.usd || 0) : s, 0));
}

function getEventosEgresos() {
  return round2((state.eventos || []).reduce((s, e) =>
    (e.tipo === 'Egreso' || e.tipo === 'Divisa') ? s + e.monto : s, 0));
}

function getEventosIngresos() {
  return round2((state.eventos || []).reduce((s, e) =>
    (e.tipo === 'Ingreso' && e.subtipo === 'Efectivo') ? s + e.monto : s, 0));
}

function getEsperado() {
  const vf  = parseFloat(document.getElementById('ventasFinal')?.value) || 0;
  return round2(vf - (state.ventasHastaAhora || 0) - getTotalYapes()
    + (state.cajaInicial || 0) - getEventosEgresos() + getEventosIngresos());
}

// ============================================================
//  APERTURA
// ============================================================
function guardarApertura() {
  const nombreInput = document.getElementById('cajaNombreInput')?.value.trim();
  const nombre = nombreInput ||
    `Caja ${new Date().toLocaleString('es-PE', { timeZone: TZ, day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})}`;

  currentCajaNombre = nombre;
  state.cajaAbierta      = true;
  state.nombre           = nombre;
  state.cajaInicial      = getCajaInicial();
  state.ventasHastaAhora = parseFloat(document.getElementById('ventasHastaAhora').value) || 0;
  state.ultimoYape       = parseFloat(document.getElementById('ultimoYape').value) || 0;
  state.aperturaFecha    = new Date().toISOString();
  state.inicialBreakdown = state.inicialMode === 'denom' ? getDenomBreakdown('inicial') : null;
  state.yapesRaw         = '';
  state.eventos          = [];
  state._ts              = Date.now();

  // Crear nuevo documento en la colección cajas
  const newRef  = db.collection('cajas').doc();
  currentCajaId = newRef.id;

  // Crear borrador en historial (se actualiza en tiempo real; se convierte en cierre al cerrar)
  const borradorRef = historialCol.doc();
  state.historialBorradorId = borradorRef.id;

  newRef.set(_stateToDoc()).catch(e => console.error('Error creando caja:', e));
  borradorRef.set(_buildBorradorDoc()).catch(e => console.warn('Error creando borrador:', e));

  startRealtimeSync();
  _updateCajaHeader();
  showView('cierre');
}

function renderResumen() {
  const fechaStr = state.aperturaFecha
    ? escHtml(new Date(state.aperturaFecha).toLocaleString('es-PE', { timeZone: TZ })) : 'N/A';
  document.getElementById('resumenGrid').innerHTML = `
    <div class="info-item"><div class="info-label">Caja Inicial</div>
      <div class="info-val">${fmt(state.cajaInicial)}</div></div>
    <div class="info-item"><div class="info-label">Ventas hasta ahora</div>
      <div class="info-val">${fmt(state.ventasHastaAhora)}</div></div>
    <div class="info-item"><div class="info-label">Último Yape</div>
      <div class="info-val">${fmt(state.ultimoYape)}</div></div>
    <div class="info-item"><div class="info-label">Apertura</div>
      <div class="info-val" style="font-size:12px;line-height:1.4">${fechaStr}</div></div>`;
}

function prefillInicialDenoms() {
  const saved = globalConfig.lastDenomQtys;
  if (!Array.isArray(saved)) return;
  saved.forEach((qty, i) => {
    if (!qty) return;
    const input = document.getElementById(`inicialQty${i}`);
    if (input) { input.value = qty; onDenomInput('inicial', i); }
  });
}

// ============================================================
//  CONTEO DE EFECTIVO DEL EMPLEADO
//  El empleado cuenta el efectivo por denominación, sin ver si
//  cuadra contra lo esperado — esos datos solo le sirven al
//  administrador para agilizar su propio cierre.
// ============================================================
function _saveConteoEmpleado() {
  const qtys  = DENOMS.map((_, i) => parseFloat(document.getElementById(`empConteoQty${i}`)?.value) || 0);
  const total = getDenomTotal('empConteo');
  if (!qtys.some(q => q > 0)) {
    state.conteoEmpleado = null;
  } else {
    state.conteoEmpleado = { qtys, total, fecha: new Date().toISOString() };
  }
  saveState();
  const fb = document.getElementById('empConteoGuardado');
  if (fb) {
    fb.textContent = state.conteoEmpleado
      ? `✔ Guardado ${new Date().toLocaleTimeString('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}`
      : '';
  }
}

let _conteoEmpleadoPrefillDone = false;

function _renderConteoEmpleadoSide() {
  if (_conteoEmpleadoPrefillDone) return;
  _conteoEmpleadoPrefillDone = true;
  const qtys = state.conteoEmpleado?.qtys;
  if (!Array.isArray(qtys)) return;
  qtys.forEach((qty, i) => {
    if (!qty) return;
    const input = document.getElementById(`empConteoQty${i}`);
    if (input) { input.value = qty; onDenomInput('empConteo', i); }
  });
  const fb = document.getElementById('empConteoGuardado');
  if (fb && state.conteoEmpleado?.fecha) {
    const hora = new Date(state.conteoEmpleado.fecha).toLocaleTimeString('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    fb.textContent = `✔ Guardado ${hora}`;
  }
}

function _renderConteoEmpleadoBanner() {
  const banner = document.getElementById('conteoEmpleadoBanner');
  if (!banner) return;
  const c = state.conteoEmpleado;
  if (!c || !c.qtys?.some(q => q > 0)) { banner.classList.add('hidden'); return; }
  const hora = new Date(c.fecha).toLocaleTimeString('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  document.getElementById('conteoEmpleadoBannerTxt').innerHTML =
    `📋 El empleado contó <b>${fmt(c.total)}</b> a las ${hora}`;
  banner.classList.remove('hidden');
}

// force=false (llamada automática): solo rellena una vez por sesión de caja, y solo si
//   los campos de cierre siguen vacíos — así no pisa el modo "monto" que el admin haya
//   elegido a propósito en una sincronización posterior.
// force=true (botón manual): siempre sobreescribe, pidiendo confirmación si ya hay datos.
let _conteoCierrePrefillDone = false;

function cargarConteoEmpleadoEnCierre(force) {
  const qtys = state.conteoEmpleado?.qtys;
  if (!Array.isArray(qtys) || !qtys.some(q => q > 0)) return;

  if (!force) {
    if (_conteoCierrePrefillDone) return;
    _conteoCierrePrefillDone = true;
  }

  const allEmpty = DENOMS.every((_, i) => !(parseFloat(document.getElementById(`cierreQty${i}`)?.value) || 0));
  if (!force && !allEmpty) return;
  if (force && !allEmpty) {
    if (!confirm('Esto reemplazará los valores que ya ingresaste por el conteo del empleado. ¿Continuar?')) return;
  }

  setMode('cierre', 'denom');
  DENOMS.forEach((_, i) => {
    const input = document.getElementById(`cierreQty${i}`);
    const qty   = qtys[i] || 0;
    if (input) { input.value = qty || ''; onDenomInput('cierre', i); }
  });
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
    if (!isNaN(v) && v >= 0) { total += v; html += `<span class="chip chip-ok">S/. ${v.toFixed(2)}</span>`; }
    else if (p)               { html += `<span class="chip chip-err">${escHtml(p)} ⚠</span>`; }
  });
  total = round2(total);
  document.getElementById('yapesChips').innerHTML          = html;
  document.getElementById('totalYapesDisplay').textContent = fmt(total);
  state.yapesRaw = document.getElementById('yapesInput').value;
  calcularEsperado();
  saveState();
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
  set('fVF', vf); set('fVHA', vha); set('fTY', ty); set('fCI', ci);

  const egrRow = document.getElementById('fRowEgr');
  const ingRow = document.getElementById('fRowIng');
  if (egrRow) { egrRow.style.display = egr > 0 ? '' : 'none'; set('fEGR', egr); }
  if (ingRow) { ingRow.style.display = ing > 0 ? '' : 'none'; set('fING', ing); }

  const espEl = document.getElementById('fEsperado');
  if (espEl) { espEl.textContent = fmt(esp); espEl.style.color = esp >= 0 ? '#4338ca' : '#dc2626'; }

  calcularDiferencia();
}

function calcularDiferencia() {
  const esp  = getEsperado();
  const real = getCajaFinal();
  const diff = round2(real - esp);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
  set('diffEsperado', esp); set('diffReal', real);

  const iconEl = document.getElementById('diffIcon');
  const textEl = document.getElementById('diffText');
  const amtEl  = document.getElementById('diffAmount');
  const card   = document.getElementById('cardDiff');
  if (!iconEl) return;

  if (real === 0 && esp === 0) {
    iconEl.textContent = '—'; textEl.textContent = 'Ingrese los montos para ver el resultado';
    amtEl.textContent = ''; card.className = 'card card-diff';
    return;
  }
  if (diff === 0) {
    iconEl.textContent = '✅'; textEl.textContent = 'Caja exacta — todo cuadra';
    amtEl.textContent = ''; card.className = 'card card-diff diff-ok';
  } else if (diff > 0) {
    iconEl.textContent = '💰'; textEl.textContent = 'Sobra dinero';
    amtEl.textContent = fmt(diff); card.className = 'card card-diff diff-over';
  } else {
    iconEl.textContent = '⚠️'; textEl.textContent = 'Falta dinero';
    amtEl.textContent = fmt(Math.abs(diff)); card.className = 'card card-diff diff-under';
  }
}

// ============================================================
//  CLOSE CASH & GENERATE PDF
// ============================================================
function confirmarCierre() {
  if (!_rcReporteHecho()) {
    _rcSetMsg('⚠ Debes completar el Reporte de Caja antes de cerrar.', false);
    document.getElementById('rcCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const esperado  = getEsperado();
  const real      = getCajaFinal();
  const diferencia = round2(real - esperado);

  document.getElementById('ccEsperado').textContent = fmt(esperado);
  document.getElementById('ccReal').textContent     = fmt(real);

  const ccDiff    = document.getElementById('ccDiff');
  const ccWarning = document.getElementById('ccWarning');
  ccDiff.textContent = (diferencia >= 0 ? '+' : '') + fmt(diferencia);
  ccDiff.className   = 'cc-val cc-diff-val ' + (diferencia > 0 ? 'diff-pos' : diferencia < 0 ? 'diff-neg' : 'diff-zero');

  const limite = 20;
  ccWarning.classList.toggle('hidden', Math.abs(diferencia) <= limite);

  document.getElementById('cierreConfirmModal').classList.remove('hidden');
}

function closeCierreConfirm() {
  document.getElementById('cierreConfirmModal').classList.add('hidden');
}

async function generarArqueo() {
  if (!_rcReporteHecho()) {
    _rcSetMsg('⚠ Debes completar el Reporte de Caja antes de generar el arqueo.', false);
    document.getElementById('rcCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const ventasFinal      = parseFloat(document.getElementById('ventasFinal').value) || 0;
  const totalYapes       = getTotalYapes();
  const yapesList        = getYapesList();
  const efectivoReal     = getCajaFinal();
  const efectivoEsperado = getEsperado();
  const diferencia       = round2(efectivoReal - efectivoEsperado);
  const aperturasReporte = await _buildAperturasReporte();

  const report = {
    arqueo: true,
    fecha: new Date().toISOString(), cajaId: currentCajaId, cajaNombre: currentCajaNombre || '',
    cajaInicial: state.cajaInicial, ventasHastaAhora: state.ventasHastaAhora,
    ultimoYape: state.ultimoYape, aperturaFecha: state.aperturaFecha,
    inicialMode: state.inicialMode, inicialBreakdown: state.inicialBreakdown || null,
    ventasFinal, totalYapes, yapesList, yapesRaw: state.yapesRaw,
    eventos: state.eventos || [], aperturasCaja: aperturasReporte, rcRegistros: state.rcRegistros || [], cierreMode,
    cierreBreakdown: cierreMode === 'denom' ? getDenomBreakdown('cierre') : null,
    efectivoEsperado, efectivoReal, diferencia,
  };

  await generarPDF(report);
}

async function cerrarCaja() {
  closeCierreConfirm();
  clearTimeout(_estadoPushTimer);
  // Nulificar historialBorradorId INMEDIATAMENTE antes de cualquier await:
  // hace que _borradorRef() devuelva null en cualquier _syncBorrador() concurrente,
  // eliminando la race condition aunque saveStateNow/beforeunload disparen durante el cierre.
  const _borradorIdParaCierre = state.historialBorradorId;
  state.historialBorradorId = null;
  const ventasFinal      = parseFloat(document.getElementById('ventasFinal').value) || 0;
  const totalYapes       = getTotalYapes();
  const yapesList        = getYapesList();
  const efectivoReal     = getCajaFinal();
  const efectivoEsperado = getEsperado();
  const diferencia       = round2(efectivoReal - efectivoEsperado);
  const aperturasReporte = await _buildAperturasReporte();

  const report = {
    fecha: new Date().toISOString(), cajaId: currentCajaId, cajaNombre: currentCajaNombre || '',
    cajaInicial: state.cajaInicial, ventasHastaAhora: state.ventasHastaAhora,
    ultimoYape: state.ultimoYape, aperturaFecha: state.aperturaFecha,
    inicialMode: state.inicialMode, inicialBreakdown: state.inicialBreakdown || null,
    ventasFinal, totalYapes, yapesList, yapesRaw: state.yapesRaw,
    eventos: state.eventos || [], aperturasCaja: aperturasReporte, rcRegistros: state.rcRegistros || [], cierreMode,
    cierreBreakdown: cierreMode === 'denom' ? getDenomBreakdown('cierre') : null,
    efectivoEsperado, efectivoReal, diferencia,
  };

  // Guardar denominaciones del cierre en config global para prefill del próximo día
  if (cierreMode === 'denom') {
    const lastDenomQtys = DENOMS.map((_, i) =>
      parseFloat(document.getElementById(`cierreQty${i}`)?.value) || 0
    );
    globalConfig.lastDenomQtys = lastDenomQtys;
    configRef.set({ lastDenomQtys }, { merge: true }).catch(() => {});
  }

  // Actualizar el borrador con datos finales (usa el ID capturado antes de nulificar)
  const bRef = _borradorIdParaCierre ? historialCol.doc(_borradorIdParaCierre) : null;
  if (bRef) {
    try { await bRef.set({ ...report, estado: 'cerrado' }); }
    catch (e) {
      console.error('Error actualizando borrador al cierre:', e);
      // Guardar copia nueva con estado correcto y eliminar el borrador huérfano
      await saveReport({ ...report, estado: 'cerrado' });
      try { await bRef.delete(); } catch (_) {}
    }
  } else {
    await saveReport({ ...report, estado: 'cerrado' });
  }

  // Capturar la ref antes de nularla para que saveStateNow() no pueda recrear la caja
  const _refFinal = cajaRef();
  currentCajaId = null;

  clearTimeout(_estadoPushTimer);
  try { await _refFinal.set(_stateToDoc()); } catch (_) {}

  // Eliminar la caja de Firestore (el historial ya la tiene)
  try { await _refFinal.delete(); } catch (_) {
    try { await _refFinal.set({ eliminada: true, cajaAbierta: false, _ts: Date.now() }, { merge: true }); } catch (e2) { console.warn('Error eliminando caja:', e2); }
  }

  await generarPDF(report);
  resetAfterClose();
}

function resetAfterClose() {
  stopRealtimeSync();
  currentCajaId     = null;
  currentCajaNombre = null;
  state             = _defaultState();

  // Limpiar formulario
  ['ventasFinal','yapesInput','cajaFinalExacto'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('yapesChips').innerHTML          = '';
  document.getElementById('totalYapesDisplay').textContent = 'S/. 0.00';
  document.getElementById('cierreDenomTotal').textContent  = 'S/. 0.00';
  DENOMS.forEach((_, i) => {
    const q = document.getElementById(`cierreQty${i}`);
    const s = document.getElementById(`cierreSub${i}`);
    if (q) q.value = ''; if (s) s.textContent = 'S/. 0.00';
  });
  const cardEv = document.getElementById('cardEventos');
  if (cardEv) cardEv.style.display = 'none';

  const badge = document.getElementById('cajaNombreDisplay');
  if (badge) badge.classList.add('hidden');

  showCajaSelector();
}

async function eliminarCajaActual() {
  if (!await _confirmarEliminar(state.nombre || currentCajaNombre || '')) return;

  stopRealtimeSync();

  const bRef = _borradorRef();
  if (bRef) {
    try { await bRef.delete(); } catch (e) { console.warn('Error eliminando borrador:', e); }
  }

  if (currentCajaId) {
    let removed = false;
    // Intentar borrar; si las reglas de Firestore no permiten delete, hacer soft-delete
    try { await cajaRef().delete(); removed = true; } catch (_) {}
    if (!removed) {
      try {
        await cajaRef().set({ eliminada: true, cajaAbierta: false, _ts: Date.now() }, { merge: true });
        removed = true;
      } catch (e2) {
        console.error('Error al eliminar caja:', e2);
        alert('No se pudo eliminar la caja. Verifica tu conexión e intenta de nuevo.');
        startRealtimeSync();
        return;
      }
    }
  }

  resetAfterClose();
}

// ============================================================
//  REPORTS — FIRESTORE HISTORIAL
// ============================================================
async function saveReport(report) {
  try {
    await historialCol.add(report);
  } catch (e) {
    console.error('Error guardando reporte:', e);
    alert('Error al guardar el reporte. Verifica tu conexión.');
  }
}

async function getAllReports() {
  try {
    const snap = await historialCol.orderBy('fecha', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    try {
      const snap = await historialCol.get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    } catch (e2) { console.error(e2); return []; }
  }
}

async function renderReportes() {
  const syncEl = document.getElementById('syncIndicator');
  if (syncEl) syncEl.classList.remove('hidden');
  const allReports = await getAllReports();
  if (syncEl) syncEl.classList.add('hidden');

  const desde = document.getElementById('filtroDesde')?.value;
  const hasta  = document.getElementById('filtroHasta')?.value;
  let reports  = allReports;
  if (desde) reports = reports.filter(r => new Date(r.fecha) >= new Date(desde));
  if (hasta) { const h = new Date(hasta); h.setHours(23,59,59); reports = reports.filter(r => new Date(r.fecha) <= h); }

  const tbody  = document.getElementById('reportesTbody');
  const noData = document.getElementById('noReportes');
  if (reports.length === 0) { tbody.innerHTML = ''; noData.classList.remove('hidden'); return; }
  noData.classList.add('hidden');

  _reportesCache = reports;

  tbody.innerHTML = reports.map((r, i) => {
    const fechaStr = new Date(r.fecha).toLocaleString('es-PE', { timeZone: TZ });
    const nombreHtml = r.cajaNombre ? `<br><small style="color:#6b7280">${escHtml(r.cajaNombre)}</small>` : '';
    const pdfBtn = `<button class="btn btn-secondary btn-sm" onclick="descargarReportePDF(${i})">⬇ PDF</button>`;

    if (r.estado === 'borrador') {
      const evCnt  = (r.eventos || []).length;
      const evNote = evCnt ? ` · ${evCnt} evento${evCnt > 1 ? 's' : ''}` : '';
      return `<tr style="background:#fffbeb">
        <td>${fechaStr}${nombreHtml}<br><span style="font-size:11px;font-weight:700;color:#d97706;background:#fef3c7;padding:1px 6px;border-radius:4px">ACTIVA${evNote}</span></td>
        <td>${fmt(r.cajaInicial)}</td>
        <td>${fmt(r.ventasHastaAhora)}</td>
        <td style="color:#9ca3af;font-size:12px">—</td>
        <td>${r.totalYapes != null ? fmt(r.totalYapes) : '—'}</td>
        <td style="color:#9ca3af;font-size:12px">—</td>
        <td style="color:#9ca3af;font-size:12px">—</td>
        <td style="color:#9ca3af;font-size:12px">En curso</td>
        <td></td>
      </tr>`;
    }

    if (r.tipo === 'apertura') {
      return `<tr style="background:#f0fdf4">
        <td>${fechaStr}${nombreHtml}<br><span style="font-size:11px;font-weight:700;color:#16a34a;background:#dcfce7;padding:1px 6px;border-radius:4px">APERTURA</span></td>
        <td>${fmt(r.cajaInicial)}</td>
        <td>${fmt(r.ventasHastaAhora)}</td>
        <td colspan="5" style="color:#6b7280;font-size:12px;text-align:center">— Reporte de apertura —</td>
        <td>${pdfBtn}</td>
      </tr>`;
    }

    const diffClass = r.diferencia > 0 ? 'diff-pos' : r.diferencia < 0 ? 'diff-neg' : 'diff-zero';
    const diffText  = r.diferencia === 0 ? '✓ Exacto'
      : r.diferencia > 0 ? `+${fmt(r.diferencia)}` : `−${fmt(Math.abs(r.diferencia))}`;
    return `<tr>
      <td>${fechaStr}${nombreHtml}</td>
      <td>${fmt(r.cajaInicial)}</td><td>${fmt(r.ventasHastaAhora)}</td>
      <td>${fmt(r.ventasFinal)}</td><td>${fmt(r.totalYapes)}</td>
      <td>${fmt(r.efectivoEsperado)}</td><td>${fmt(r.efectivoReal)}</td>
      <td class="${diffClass}">${diffText}</td>
      <td>${pdfBtn}</td>
    </tr>`;
  }).join('');
}

async function descargarReportePDF(idx) {
  const r = _reportesCache[idx];
  if (!r) return;
  try {
    await generarPDF(r);
  } catch(e) {
    console.error('PDF error:', e);
    alert('Error al generar el PDF: ' + e.message);
  }
}

function limpiarFiltros() {
  document.getElementById('filtroDesde').value = '';
  document.getElementById('filtroHasta').value = '';
  renderReportes();
}

async function exportarExcel() {
  const allReports = await getAllReports();
  const desde = document.getElementById('filtroDesde')?.value;
  const hasta  = document.getElementById('filtroHasta')?.value;
  let reports  = allReports;
  reports = reports.filter(r => r.estado !== 'borrador' && r.tipo !== 'apertura');
  if (desde) reports = reports.filter(r => new Date(r.fecha) >= new Date(desde));
  if (hasta) { const h = new Date(hasta); h.setHours(23,59,59); reports = reports.filter(r => new Date(r.fecha) <= h); }
  if (reports.length === 0) { alert('No hay reportes para exportar.'); return; }

  await loadScript(XLSX_URL, XLSX_SRI);
  const data = reports.map(r => ({
    'Caja':                     r.cajaNombre || '',
    'Fecha Cierre':             new Date(r.fecha).toLocaleString('es-PE', { timeZone: TZ }),
    'Caja Inicial (S/.)':       r.cajaInicial,
    'Ventas hasta ahora (S/.)': r.ventasHastaAhora,
    'Ventas Final (S/.)':       r.ventasFinal,
    'Total Yapes (S/.)':        r.totalYapes,
    'Efectivo Esperado (S/.)':  r.efectivoEsperado,
    'Efectivo Real (S/.)':      r.efectivoReal,
    'Diferencia (S/.)':         r.diferencia,
    'Resultado':                r.diferencia === 0 ? 'Exacto' : r.diferencia > 0 ? 'Sobra' : 'Falta',
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{wch:18},{wch:22},{wch:18},{wch:22},{wch:18},{wch:16},{wch:22},{wch:18},{wch:16},{wch:10}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Reportes de Caja');
  XLSX.writeFile(wb, `Reportes_Caja_${new Date().toLocaleDateString('es-PE', { timeZone: TZ }).replace(/\//g,'-')}.xlsx`);
}

// ============================================================
//  EVENTOS
// ============================================================
function openEventosModal() {
  currentEventoTipo = 'Egreso'; currentEventoSubtipo = 'Efectivo';
  ['evDesc','evDivisaDesc'].forEach(id => { document.getElementById(id).value = ''; });
  ['evMonto','evUSD','evTC'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('evDivisaSoles').textContent = 'S/. 0.00';
  ['tglEvEgreso','tglEvDivisa','tglEvIngreso'].forEach(id => document.getElementById(id).classList.remove('active'));
  document.getElementById('tglEvEgreso').classList.add('active');
  document.getElementById('evFieldsBasic').style.display = '';
  document.getElementById('evFieldsDivisa').classList.add('hidden');
  document.getElementById('evSubtipoWrap').style.display = 'none';
  document.getElementById('tglSubEfectivo').classList.add('active');
  document.getElementById('tglSubYape').classList.remove('active');
  document.getElementById('evIncluirFlujo').checked = true;
  document.getElementById('evIncluirFlujoWrap').style.display = '';
  document.getElementById('eventosModal').classList.remove('hidden');
}

function closeEventosModal() { document.getElementById('eventosModal').classList.add('hidden'); }

function setEventoTipo(tipo) {
  currentEventoTipo = tipo;
  ['tglEvEgreso','tglEvDivisa','tglEvIngreso'].forEach(id => document.getElementById(id).classList.remove('active'));
  const map = { Egreso:'tglEvEgreso', Divisa:'tglEvDivisa', Ingreso:'tglEvIngreso' };
  document.getElementById(map[tipo]).classList.add('active');
  document.getElementById('evFieldsBasic').style.display  = tipo === 'Divisa' ? 'none' : '';
  document.getElementById('evFieldsDivisa').classList.toggle('hidden', tipo !== 'Divisa');
  document.getElementById('evSubtipoWrap').style.display  = tipo === 'Ingreso' ? '' : 'none';
  document.getElementById('evIncluirFlujoWrap').style.display = tipo === 'Egreso' ? '' : 'none';
}

function setEventoSubtipo(subtipo) {
  currentEventoSubtipo = subtipo;
  document.getElementById('tglSubEfectivo').classList.toggle('active', subtipo === 'Efectivo');
  document.getElementById('tglSubYape').classList.toggle('active', subtipo === 'Yape');
}

function calcDivisa() {
  const usd = parseFloat(document.getElementById('evUSD').value) || 0;
  const tc  = parseFloat(document.getElementById('evTC').value)  || 0;
  document.getElementById('evDivisaSoles').textContent = fmt(round2(usd * tc));
}

function addEvento() {
  let monto = 0, desc = '', usd = 0, tc = 0;
  if (currentEventoTipo === 'Divisa') {
    usd = parseFloat(document.getElementById('evUSD').value) || 0;
    tc  = parseFloat(document.getElementById('evTC').value)  || 0;
    monto = round2(usd * tc);
    desc  = document.getElementById('evDivisaDesc').value.trim() || `$${usd.toFixed(2)} × ${tc}`;
    if (!usd || !tc) { alert('Ingresa el monto en USD y el tipo de cambio.'); return; }
  } else {
    monto = parseFloat(document.getElementById('evMonto').value) || 0;
    desc  = document.getElementById('evDesc').value.trim();
    if (!monto) { alert('Ingresa un monto válido.'); return; }
  }
  if (!state.eventos) state.eventos = [];
  const incluirFlujoEl = document.getElementById('evIncluirFlujo');
  state.eventos.push({
    id: Date.now(), tipo: currentEventoTipo,
    subtipo: currentEventoTipo === 'Ingreso' ? currentEventoSubtipo : null,
    desc, monto,
    usd:           currentEventoTipo === 'Divisa' ? usd : null,
    tc:            currentEventoTipo === 'Divisa' ? tc  : null,
    fecha:         new Date().toISOString(),
    incluirEnFlujo: currentEventoTipo === 'Egreso' ? (incluirFlujoEl ? incluirFlujoEl.checked : true) : null,
  });
  saveStateNow(); renderEventos(); calcularEsperado(); closeEventosModal();
}

function eliminarEvento(idx) {
  state.eventos.splice(idx, 1);
  saveStateNow(); renderEventos(); calcularEsperado();
}

function renderEventos() {
  _renderEventosInto('cardEventos',    'eventosList');
  _renderEventosInto('cardEventosEmp', 'eventosListEmp');
}

function _renderEventosInto(cardId, listId) {
  const card = document.getElementById(cardId);
  const list = document.getElementById(listId);
  if (!card || !list) return;
  const eventos  = state.eventos || [];
  const totalEgr = getEventosEgresos();
  const totalIng = getEventosIngresos();
  const totalUSD = getTotalUSD();

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
    if      (e.tipo === 'Egreso')  { badgeClass='ev-egreso';     badgeLabel='Egreso';    montoClass='ev-monto-egr'; }
    else if (e.tipo === 'Divisa')  { badgeClass='ev-divisa';     badgeLabel='Divisa';    montoClass='ev-monto-egr'; }
    else if (e.subtipo === 'Yape') { badgeClass='ev-ingreso-yp'; badgeLabel='Ing. Yape'; montoClass='ev-monto-ing'; }
    else                           { badgeClass='ev-ingreso-ef'; badgeLabel='Ing. Ef.';  montoClass='ev-monto-ing'; }
    const sign       = (e.tipo === 'Egreso' || e.tipo === 'Divisa') ? '−' : '+';
    const divisaNote = e.tipo === 'Divisa'
      ? `<span style="font-size:11px;color:#64748b"> ($${(+e.usd).toFixed(2)} × ${e.tc})</span>` : '';
    const horaStr = e.fecha
      ? new Date(e.fecha).toLocaleTimeString('es-PE', { timeZone: TZ, hour:'2-digit', minute:'2-digit' }) : '';
    const notaHtml = e.desc
      ? `<div class="evento-nota">${escHtml(e.desc)}${divisaNote}</div>`
      : divisaNote ? `<div class="evento-nota">${divisaNote}</div>` : '';
    return `<div class="evento-item">
      <span class="evento-badge ${badgeClass}">${badgeLabel}</span>
      <div class="evento-info">
        ${notaHtml}
        <div class="evento-monto ${montoClass}">${sign} ${fmt(e.monto)}${horaStr ? `<span class="evento-hora">${horaStr}</span>` : ''}</div>
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
  if (d.tipo === 'apertura') { await _generarPDFApertura(d); return; }
  await loadScript(JSPDF_URL, JSPDF_SRI);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const mg = 18;

  const BLUE=[30,58,95], LBLUE=[239,246,255], GREEN=[5,150,105], RED=[220,38,38];
  const ORANGE=[194,65,12], GRAY=[100,116,139], DARK=[26,32,44], INDIGO=[67,56,202];

  function newPageIfNeeded(y, needed) {
    if (y + needed > ph - 22) { doc.addPage(); return mg; } return y;
  }

  const GREEN_DARK = [20,83,45];
  const headerColor = d.arqueo ? [30,58,95] : GREEN_DARK;
  doc.setFillColor(...headerColor); doc.rect(0, 0, pw, 32, 'F');
  doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(16);
  doc.text(d.arqueo ? 'ARQUEO PARCIAL DE CAJA' : 'REPORTE DE CIERRE DE CAJA', pw/2, 14, { align:'center' });
  doc.setFont('helvetica','normal'); doc.setFontSize(9);
  const opts = { weekday:'long', year:'numeric', month:'long', day:'numeric' };
  doc.text(`${new Date(d.fecha).toLocaleDateString('es-PE', { ...opts, timeZone: TZ })}  |  ${new Date(d.fecha).toLocaleTimeString('es-PE', { timeZone: TZ })}`, pw/2, 22, { align:'center' });
  if (d.cajaNombre) { doc.setFontSize(8); doc.text(`Caja: ${d.cajaNombre}`, pw/2, 28, { align:'center' }); }

  let y = 40;
  y = pdfSec(doc,'DATOS DE APERTURA',y,pw,mg,BLUE,LBLUE);
  if (d.aperturaFecha) y = pdfRow(doc,'Fecha apertura',new Date(d.aperturaFecha).toLocaleString('es-PE', { timeZone: TZ }),y,mg,pw,DARK,BLUE);
  y = pdfRow(doc,'Caja Inicial',fmt(d.cajaInicial),y,mg,pw,DARK,BLUE);
  y = pdfRow(doc,'Ventas hasta ahora',fmt(d.ventasHastaAhora),y,mg,pw,DARK,BLUE);
  y = pdfRow(doc,'Último Yape',fmt(d.ultimoYape),y,mg,pw,DARK,BLUE);

  if (d.inicialMode === 'denom' && d.inicialBreakdown?.length) {
    y = newPageIfNeeded(y, d.inicialBreakdown.length*4+8); y+=2;
    doc.setFont('helvetica','italic'); doc.setFontSize(9); doc.setTextColor(...GRAY);
    doc.text('Detalle caja inicial:', mg, y); y+=4.5;
    d.inicialBreakdown.forEach(item => { doc.text(`   ${item.label} × ${item.qty} = S/. ${item.subtotal.toFixed(2)}`, mg+4, y); y+=4; });
  }
  y+=5;

  y = newPageIfNeeded(y,30);
  y = pdfSec(doc,'VENTAS Y YAPES',y,pw,mg,BLUE,LBLUE);
  y = pdfRow(doc,'Ventas Final',fmt(d.ventasFinal),y,mg,pw,DARK,BLUE);
  if (d.yapesList?.length) {
    y = newPageIfNeeded(y, d.yapesList.length*4+10); y+=2;
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
    doc.text('Yapes recibidos:', mg, y); y+=5;
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...GRAY);
    d.yapesList.forEach((v,i) => { doc.text(`   Yape ${i+1}: S/. ${v.toFixed(2)}`, mg+4, y); y+=4; }); y+=1;
  }
  y = pdfRow(doc,'Total Yapes',fmt(d.totalYapes),y,mg,pw,DARK,BLUE); y+=5;

  if (d.eventos?.length) {
    y = newPageIfNeeded(y, d.eventos.length*6+20);
    y = pdfSec(doc,'EVENTOS DE CAJA',y,pw,mg,BLUE,LBLUE);
    d.eventos.forEach(ev => {
      const sign = (ev.tipo==='Egreso'||ev.tipo==='Divisa') ? '−' : '+';
      const col  = (ev.tipo==='Egreso'||ev.tipo==='Divisa') ? RED : GREEN;
      doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
      doc.text(`[${ev.tipo}${ev.subtipo?'/'+ev.subtipo:''}] ${ev.desc||''}`, mg+2, y);
      doc.setFont('helvetica','bold'); doc.setTextColor(...col);
      doc.text(`${sign} ${fmt(ev.monto)}`, pw-mg-2, y, { align:'right' });
      doc.setDrawColor(235,235,235); doc.line(mg, y+2.5, pw-mg, y+2.5); y+=8;
    }); y+=2;
  }

  if (d.aperturasCaja?.length) {
    y = newPageIfNeeded(y, d.aperturasCaja.length*7+20);
    y = pdfSec(doc,'APERTURAS DE GAVETA',y,pw,mg,BLUE,LBLUE);
    d.aperturasCaja.forEach((a, i) => {
      const dt    = new Date(a.fecha);
      const fecha = dt.toLocaleDateString('es-PE', { timeZone: TZ, day:'2-digit', month:'2-digit', year:'numeric' });
      const hora  = dt.toLocaleTimeString('es-PE', { timeZone: TZ, hour:'2-digit', minute:'2-digit', second:'2-digit' });
      const tag    = a.tipo === 'registro' ? '[Solo registro]' : a.tipo === 'fisica-cerrada' ? '[Caja cerrada]' : '[Gaveta]';
      const turno  = a.turno || _turnoDe(a.fecha);
      const turnoTag = `[${_turnoLabel(turno)}]`;
      doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
      doc.text(`${i+1}. ${turnoTag} ${tag} ${a.motivo}`, mg+2, y);
      doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...GRAY);
      doc.text(`${fecha} ${hora}`, pw-mg-2, y, { align:'right' });
      doc.setDrawColor(235,235,235); doc.line(mg, y+2.5, pw-mg, y+2.5); y+=7;
    }); y+=2;
  }

  if (d.rcRegistros?.length) {
    y = newPageIfNeeded(y, d.rcRegistros.length*7+20);
    y = pdfSec(doc,'CONTROL DE COMPROBANTES SAS',y,pw,mg,BLUE,LBLUE);
    d.rcRegistros.forEach((r, i) => {
      const hora     = new Date(r.fecha).toLocaleTimeString('es-PE', { timeZone: TZ, hour:'2-digit', minute:'2-digit' });
      const bat      = r.aperturasBat ?? r.aperturas ?? 0;
      const emp      = r.aperturasEmp ?? 0;
      const comp     = r.comprobantes ?? 0;
      const esperado = comp + emp;
      const diff     = bat - esperado;
      const color    = diff === 0 ? GREEN : RED;
      const label    = diff === 0 ? '✔ Cuadra' : diff > 0 ? `⚠ Faltan ${diff}` : `⚠ Sobran ${Math.abs(diff)}`;
      y = newPageIfNeeded(y, 14);
      doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...color);
      doc.text(`${i+1}. ${label}${r.manual ? ' (manual)' : ''}`, mg+2, y);
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...GRAY);
      doc.text(hora, pw-mg-2, y, { align:'right' });
      y += 5;
      doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...DARK);
      doc.text(`Bat: ${bat}  =  Comprobantes: ${comp}  +  Empleado: ${emp}${diff !== 0 ? `  (suma: ${esperado})` : ''}`, mg+4, y);
      doc.setDrawColor(235,235,235); doc.line(mg, y+3, pw-mg, y+3); y+=7;
    }); y+=2;
  }

  const evExtraRows = ((d.eventos||[]).some(e=>e.tipo==='Egreso'||e.tipo==='Divisa')?1:0)
                    + ((d.eventos||[]).some(e=>e.tipo==='Ingreso'&&e.subtipo==='Efectivo')?1:0);
  const calcBoxH = 50 + evExtraRows*7;
  y = newPageIfNeeded(y, calcBoxH+14);
  y = pdfSec(doc,'CÁLCULO — EFECTIVO ESPERADO',y,pw,mg,BLUE,LBLUE);
  doc.setFillColor(245,243,255); doc.setDrawColor(199,195,245);
  doc.roundedRect(mg, y, pw-mg*2, calcBoxH, 3, 3, 'FD');
  let fy = y+8; const c1=mg+8, c2=pw-mg-8;
  const fRow = (lbl,val,col) => {
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...DARK); doc.text(lbl,c1,fy);
    doc.setFont('helvetica','bold'); doc.setTextColor(...col); doc.text(fmt(val),c2,fy,{align:'right'}); fy+=7;
  };
  fRow('Ventas Final',d.ventasFinal,DARK); fRow('− Ventas hasta ahora',d.ventasHastaAhora,ORANGE);
  fRow('− Total Yapes',d.totalYapes,ORANGE);
  const egr=(d.eventos||[]).reduce((s,e)=>(e.tipo==='Egreso'||e.tipo==='Divisa')?s+e.monto:s,0);
  const ing=(d.eventos||[]).reduce((s,e)=>(e.tipo==='Ingreso'&&e.subtipo==='Efectivo')?s+e.monto:s,0);
  if(egr>0) fRow('− Egresos / Divisa',round2(egr),ORANGE);
  if(ing>0) fRow('+ Ingresos (efectivo)',round2(ing),GREEN);
  fRow('+ Caja Inicial',d.cajaInicial,GREEN);
  doc.setDrawColor(...GRAY); doc.line(c1,fy-1,c2,fy-1); fy+=4;
  doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(...INDIGO);
  doc.text('= Efectivo esperado',c1,fy); doc.text(fmt(d.efectivoEsperado),c2,fy,{align:'right'}); y=fy+10;

  y = newPageIfNeeded(y,30); y+=2;
  y = pdfSec(doc,'EFECTIVO REAL EN CAJA',y,pw,mg,BLUE,LBLUE);
  y = pdfRow(doc,'Efectivo real contado',fmt(d.efectivoReal),y,mg,pw,DARK,BLUE);
  if (d.cierreMode==='denom' && d.cierreBreakdown?.length) {
    y = newPageIfNeeded(y, d.cierreBreakdown.length*4+8); y+=2;
    doc.setFont('helvetica','italic'); doc.setFontSize(9); doc.setTextColor(...GRAY);
    doc.text('Detalle denominaciones:',mg,y); y+=4.5;
    d.cierreBreakdown.forEach(item=>{doc.text(`   ${item.label} × ${item.qty} = S/. ${item.subtotal.toFixed(2)}`,mg+4,y);y+=4;});
  }
  y+=6;

  y = newPageIfNeeded(y,28);
  y = pdfSec(doc,'RESULTADO FINAL',y,pw,mg,BLUE,LBLUE);
  const diffColor = d.diferencia<0 ? RED : GREEN;
  const diffBg    = d.diferencia<0 ? [254,226,226] : [220,252,231];
  const diffText  = d.diferencia===0 ? '✓  Caja exacta — todo cuadra'
    : d.diferencia>0 ? `Sobra   ${fmt(d.diferencia)}` : `Falta   ${fmt(Math.abs(d.diferencia))}`;
  doc.setFillColor(...diffBg); doc.setDrawColor(...diffColor);
  doc.roundedRect(mg,y,pw-mg*2,16,3,3,'FD');
  doc.setFont('helvetica','bold'); doc.setFontSize(13); doc.setTextColor(...diffColor);
  doc.text(diffText,pw/2,y+10,{align:'center'}); y+=22;

  const totalUSDPDF=(d.eventos||[]).reduce((s,e)=>e.tipo==='Divisa'?s+(e.usd||0):s,0);
  if(totalUSDPDF>0){
    y=newPageIfNeeded(y,14);
    doc.setFillColor(239,246,255); doc.setDrawColor(191,219,254);
    doc.roundedRect(mg,y,pw-mg*2,11,2,2,'FD');
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(30,64,175);
    doc.text(`💵 USD en caja: $${round2(totalUSDPDF).toFixed(2)}`,pw/2,y+7.5,{align:'center'}); y+=16;
  }

  doc.setDrawColor(...GRAY); doc.line(mg,ph-14,pw-mg,ph-14);
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...GRAY);
  doc.text('Reporte generado por Control de Caja',pw/2,ph-8,{align:'center'});
  doc.text(new Date(d.fecha).toLocaleString('es-PE', { timeZone: TZ }),pw/2,ph-4,{align:'center'});

  const prefix = d.arqueo ? 'Arqueo' : 'Cierre';
  const hora   = new Date(d.fecha).toLocaleTimeString('es-PE', { timeZone: TZ, hour:'2-digit',minute:'2-digit'}).replace(':','-');
  doc.save(`${prefix}_${(d.cajaNombre||'Caja').replace(/\s+/g,'_')}_${new Date(d.fecha).toLocaleDateString('es-PE', { timeZone: TZ }).replace(/\//g,'-')}_${hora}.pdf`);
}

async function _generarPDFApertura(d) {
  await loadScript(JSPDF_URL, JSPDF_SRI);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pw = doc.internal.pageSize.getWidth();
  const mg = 18;
  const BLUE=[30,58,95], LBLUE=[239,246,255], DARK=[26,32,44], GRAY=[100,116,139], GREEN_DARK=[20,83,45];

  doc.setFillColor(...GREEN_DARK); doc.rect(0, 0, pw, 32, 'F');
  doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(16);
  doc.text('REPORTE DE APERTURA DE CAJA', pw/2, 14, { align:'center' });
  doc.setFont('helvetica','normal'); doc.setFontSize(9);
  const opts = { weekday:'long', year:'numeric', month:'long', day:'numeric' };
  doc.text(`${new Date(d.fecha).toLocaleDateString('es-PE', { ...opts, timeZone: TZ })}  |  ${new Date(d.fecha).toLocaleTimeString('es-PE', { timeZone: TZ })}`, pw/2, 22, { align:'center' });
  if (d.cajaNombre) { doc.setFontSize(8); doc.text(`Caja: ${d.cajaNombre}`, pw/2, 28, { align:'center' }); }

  let y = 40;
  y = pdfSec(doc,'DATOS DE APERTURA',y,pw,mg,BLUE,LBLUE);
  y = pdfRow(doc,'Nombre de caja', d.cajaNombre||'—', y,mg,pw,DARK,BLUE);
  y = pdfRow(doc,'Fecha y hora',   new Date(d.fecha).toLocaleString('es-PE', { timeZone: TZ }), y,mg,pw,DARK,BLUE);
  y = pdfRow(doc,'Caja Inicial',   fmt(d.cajaInicial), y,mg,pw,DARK,BLUE);
  if (d.ventasHastaAhora) y = pdfRow(doc,'Ventas hasta ahora', fmt(d.ventasHastaAhora), y,mg,pw,DARK,BLUE);
  if (d.ultimoYape)       y = pdfRow(doc,'Último Yape',        fmt(d.ultimoYape),        y,mg,pw,DARK,BLUE);
  y += 4;

  if (d.inicialMode === 'denom' && d.inicialBreakdown?.length) {
    y = pdfSec(doc,'DETALLE DENOMINACIONES — CAJA INICIAL',y,pw,mg,BLUE,LBLUE);
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...GRAY);
    d.inicialBreakdown.forEach(item => {
      doc.text(`${item.label}  ×  ${item.qty}  =  S/. ${item.subtotal.toFixed(2)}`, mg+4, y);
      y += 5;
    });
    y += 4;
    doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...BLUE);
    doc.text(`Total: ${fmt(d.cajaInicial)}`, pw-mg-2, y, { align:'right' }); y += 10;
  }

  doc.setFillColor(240,253,244); doc.setDrawColor(...GREEN_DARK);
  doc.roundedRect(mg, y, pw-mg*2, 14, 3, 3, 'FD');
  doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...GREEN_DARK);
  doc.text('Caja abierta correctamente', pw/2, y+9, { align:'center' }); y += 22;

  doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(...GRAY);
  doc.text('Che plaS — Control de Caja', pw/2, doc.internal.pageSize.getHeight()-8, { align:'center' });

  const hora = new Date(d.fecha).toLocaleTimeString('es-PE', { timeZone: TZ, hour:'2-digit',minute:'2-digit'}).replace(':','-');
  doc.save(`Apertura_${(d.cajaNombre||'Caja').replace(/\s+/g,'_')}_${new Date(d.fecha).toLocaleDateString('es-PE', { timeZone: TZ }).replace(/\//g,'-')}_${hora}.pdf`);
}

function pdfSec(doc,title,y,pw,mg,BLUE,LBLUE){
  doc.setFillColor(...LBLUE); doc.setDrawColor(...BLUE);
  doc.roundedRect(mg,y,pw-mg*2,9,2,2,'FD');
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...BLUE);
  doc.text(title,mg+4,y+6.5); return y+14;
}

function pdfRow(doc,label,value,y,mg,pw,DARK,BLUE){
  doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
  doc.text(label+':',mg+2,y);
  doc.setFont('helvetica','bold'); doc.setTextColor(...BLUE);
  doc.text(value,pw-mg-2,y,{align:'right'});
  doc.setDrawColor(235,235,235); doc.line(mg,y+2.5,pw-mg,y+2.5); return y+8;
}

// ============================================================
//  FLUJO DE CAJA MENSUAL
// ============================================================

function _flujoMesActual() { return _mesPE(); }

function flujoRef(mes) { return db.doc(`flujo/${mes}`); }

function _getMesLabel(mes) {
  const [y, m] = mes.split('-').map(Number);
  const names = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                 'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  return `${names[m-1]} ${y}`;
}

function showFlujoView() {
  ['viewHome','viewApertura','viewCierre','viewReportes','viewEmpleado','viewCajaSelector'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  document.getElementById('viewFlujo').classList.remove('hidden');
  initFlujoView(_currentFlujoMes || _flujoMesActual());
}

function cambiarMesFlujo(delta) {
  const [y, m] = _currentFlujoMes.split('-').map(Number);
  let nm = m + delta, ny = y;
  if (nm < 1)  { nm = 12; ny--; }
  if (nm > 12) { nm = 1;  ny++; }
  initFlujoView(`${ny}-${String(nm).padStart(2,'0')}`);
}

async function initFlujoView(mes) {
  _currentFlujoMes = mes;
  document.getElementById('flujoMesLabel').textContent = _getMesLabel(mes);

  if (_flujoUnsub) { _flujoUnsub(); _flujoUnsub = null; }

  // Cargar Chart.js si no está
  await loadScript(CHARTJS_URL);
  if (!_flujoCharts.bars) _initFlujoCharts();

  // Snapshot en tiempo real del doc de flujo del mes
  _flujoUnsub = flujoRef(mes).onSnapshot(snap => {
    _flujoDocCache = snap.exists ? snap.data() : {};
    _renderFlujoDashboard();
  }, e => console.warn('flujo snapshot:', e));

  // Egresos de caja (carga única, con botón de refresh)
  _egresoscajaCache = [];
  document.getElementById('flujoEgresosCajaList').innerHTML =
    '<p class="no-data" style="padding:20px 0">Cargando…</p>';
  getEgresosCajaDelMes(mes).then(list => {
    _egresoscajaCache = list;
    _renderFlujoDashboard();
    _renderEgresosCajaList();
  });
}

async function getEgresosCajaDelMes(mes) {
  const results = [];
  const [y, m] = mes.split('-').map(Number);
  const prev = m === 1  ? `${y-1}-12` : `${y}-${String(m-1).padStart(2,'0')}`;
  const next = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;

  try {
    const snap = await historialCol
      .where('fecha', '>=', `${prev}-01`)
      .where('fecha', '<=', `${next}-31T23:59:59`)
      .get();
    snap.forEach(doc => {
      const d = doc.data();
      // Ignorar borradores: las cajas abiertas se leen por separado desde 'cajas'
      if (d.estado === 'borrador') return;
      (d.eventos || []).forEach(ev => {
        if (ev.tipo === 'Egreso' && ev.incluirEnFlujo !== false &&
            ev.fecha && new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(ev.fecha)).startsWith(mes))
          results.push({ ...ev, cajaNombre: d.cajaNombre || '', _cajaId: d.cajaId || doc.id });
      });
    });
  } catch(e) { console.warn('getEgresosCaja historial:', e); }

  try {
    // Solo cajas AÚN ABIERTAS — las cerradas ya están en historialCol como 'cerrado'
    const snap = await db.collection('cajas').where('cajaAbierta', '==', true).get();
    snap.forEach(doc => {
      const d = doc.data();
      (d.eventos || []).forEach(ev => {
        if (ev.tipo === 'Egreso' && ev.incluirEnFlujo !== false &&
            ev.fecha && new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(ev.fecha)).startsWith(mes))
          results.push({ ...ev, cajaNombre: d.nombre || '', _cajaId: doc.id });
      });
    });
  } catch(e) { console.warn('getEgresosCaja cajas:', e); }

  return results;
}

async function refreshEgresosCaja() {
  document.getElementById('flujoEgresosCajaList').innerHTML =
    '<p class="no-data" style="padding:20px 0">Cargando…</p>';
  _egresoscajaCache = await getEgresosCajaDelMes(_currentFlujoMes);
  _renderFlujoDashboard();
  _renderEgresosCajaList();
}

function _egresoExcluidoKey(cajaId, evId) { return `${cajaId || ''}::${evId}`; }

function _getEgresosCajaVisibles() {
  const excl = new Set((_flujoDocCache.egresosExcluidos || []));
  return _egresoscajaCache.filter(e => !excl.has(_egresoExcluidoKey(e._cajaId, e.id)));
}

function _getFlujoTotals() {
  const d = _flujoDocCache;
  const vHist = d.ventasHistorial  || {};
  const pHist = d.planillaHistorial || {};

  const lastV = Object.keys(vHist).sort().pop();
  const lastP = Object.keys(pHist).sort().pop();

  const ventas   = lastV ? (vHist[lastV] || 0) : 0;
  const planilla = lastP ? (pHist[lastP] || 0) : 0;
  const totalPagos      = (d.pagos || []).reduce((s, p) => s + (p.monto || 0), 0);
  const totalEgresosCaja = _getEgresosCajaVisibles().reduce((s, e) => s + (e.monto || 0), 0);
  const totalEgresos = round2(planilla + totalPagos + totalEgresosCaja);
  const utilidad     = round2(ventas - totalEgresos);

  return { ventas, planilla, totalPagos, totalEgresosCaja, totalEgresos, utilidad, vHist, pHist, lastV, lastP };
}

function _renderFlujoDashboard() {
  const { ventas, planilla, totalPagos, totalEgresosCaja,
          totalEgresos, utilidad, vHist, pHist, lastV, lastP } = _getFlujoTotals();

  // KPIs
  document.getElementById('kpiVentas').textContent  = fmt(ventas);
  document.getElementById('kpiEgresos').textContent = fmt(totalEgresos);
  const kpiU    = document.getElementById('kpiUtilidad');
  const kpiCard = document.getElementById('kpiUtilidadCard');
  const kpiIcon = document.getElementById('kpiUtilidadIcon');
  kpiU.textContent = (utilidad < 0 ? '− ' : '') + fmt(Math.abs(utilidad));
  kpiCard.classList.toggle('utilidad-neg', utilidad < 0);
  kpiIcon.textContent = utilidad >= 0 ? '✅' : '⚠️';

  // Desglose
  document.getElementById('flujoDesgPlanilla').textContent = fmt(planilla);
  document.getElementById('flujoDesgPagos').textContent    = fmt(totalPagos);
  document.getElementById('flujoDesgCaja').textContent     = fmt(totalEgresosCaja);
  document.getElementById('flujoDesgTotal').textContent    = fmt(totalEgresos);

  // Inputs (solo si no están enfocados)
  const vIn = document.getElementById('flujoVentasInput');
  const pIn = document.getElementById('flujoPlanillaInput');
  if (document.activeElement !== vIn) {
    vIn.value = lastV ? (vHist[lastV] || '') : '';
    document.getElementById('flujoVentasUlt').textContent =
      lastV ? new Date(lastV + 'T12:00:00').toLocaleDateString('es-PE', { timeZone: TZ }) : '—';
  }
  if (document.activeElement !== pIn) {
    pIn.value = lastP ? (pHist[lastP] || '') : '';
    document.getElementById('flujoPlanillaUlt').textContent =
      lastP ? new Date(lastP + 'T12:00:00').toLocaleDateString('es-PE', { timeZone: TZ }) : '—';
  }

  _renderPagosList();
  _renderEgresosCajaList();
  _updateFlujoCharts(ventas, planilla, totalPagos, totalEgresosCaja, utilidad, vHist);
}

function _renderPagosList() {
  const pagos = [...(_flujoDocCache.pagos || [])].sort((a,b) =>
    (b.fecha||'').localeCompare(a.fecha||''));
  const el = document.getElementById('flujoPagosList');
  if (!el) return;
  if (!pagos.length) {
    el.innerHTML = '<p class="no-data" style="padding:20px 0">No hay pagos registrados este mes.</p>';
    return;
  }
  el.innerHTML = pagos.map(p => `
    <div class="flujo-pago-item">
      <div class="flujo-pago-info">
        <span class="flujo-pago-cat">${escHtml(p.categoria)}</span>
        ${p.desc ? `<span class="flujo-pago-desc">${escHtml(p.desc)}</span>` : ''}
        <span class="flujo-pago-fecha">${p.fecha ? new Date(p.fecha+'T12:00:00').toLocaleDateString('es-PE', { timeZone: TZ }) : '—'}</span>
      </div>
      <div class="flujo-pago-right">
        <span class="flujo-pago-monto">− ${fmt(p.monto)}</span>
        <button class="btn-ev-del" onclick="deletePago('${escHtml(p.id)}')" title="Eliminar">✕</button>
      </div>
    </div>`).join('');
}

function _renderEgresosCajaList() {
  const el = document.getElementById('flujoEgresosCajaList');
  if (!el) return;
  const visibles = _getEgresosCajaVisibles();
  if (!visibles.length) {
    el.innerHTML = '<p class="no-data" style="padding:20px 0">No hay egresos de caja incluidos en este mes.</p>';
    return;
  }
  el.innerHTML = visibles.map(e => `
    <div class="flujo-pago-item">
      <div class="flujo-pago-info">
        <span class="flujo-pago-cat">${escHtml(e.cajaNombre || 'Caja')}</span>
        ${e.desc ? `<span class="flujo-pago-desc">${escHtml(e.desc)}</span>` : ''}
        <span class="flujo-pago-fecha">${e.fecha ? new Date(e.fecha).toLocaleDateString('es-PE', { timeZone: TZ }) : '—'}</span>
      </div>
      <div class="flujo-pago-right">
        <span class="flujo-pago-monto">− ${fmt(e.monto)}</span>
        <button class="btn-ev-del" onclick="excluirEgresoDelFlujo('${escHtml(e._cajaId || '')}','${escHtml(String(e.id))}')" title="Quitar del flujo del mes">✕</button>
      </div>
    </div>`).join('');
}

async function saveFlujoField(field, rawValue) {
  const value = parseFloat(rawValue) || 0;
  const today = _todayPE();
  const hist  = field === 'ventas' ? 'ventasHistorial' : 'planillaHistorial';
  try {
    await flujoRef(_currentFlujoMes).set(
      { mes: _currentFlujoMes, [hist]: { [today]: value } },
      { merge: true }
    );
  } catch(e) { console.error('saveFlujoField:', e); }
}

function openPagoModal() {
  document.getElementById('pagoCategoria').value = 'Proveedores';
  document.getElementById('pagoDesc').value      = '';
  document.getElementById('pagoMonto').value     = '';
  document.getElementById('pagoFecha').value     = _todayPE();
  document.getElementById('pagoModal').classList.remove('hidden');
}

function closePagoModal() {
  document.getElementById('pagoModal').classList.add('hidden');
}

async function addPago() {
  const monto = parseFloat(document.getElementById('pagoMonto').value) || 0;
  if (!monto) { alert('Ingresa un monto válido.'); return; }
  const pago = {
    id:        Date.now().toString(),
    categoria: document.getElementById('pagoCategoria').value,
    desc:      document.getElementById('pagoDesc').value.trim(),
    monto,
    fecha:     document.getElementById('pagoFecha').value,
  };
  const pagosActuales = [...(_flujoDocCache.pagos || []), pago];
  try {
    await flujoRef(_currentFlujoMes).set(
      { mes: _currentFlujoMes, pagos: pagosActuales },
      { merge: true }
    );
    closePagoModal();
  } catch(e) { console.error('addPago:', e); alert('Error al guardar el pago.'); }
}

async function deletePago(id) {
  const pagos = (_flujoDocCache.pagos || []).filter(p => p.id !== id);
  try {
    await flujoRef(_currentFlujoMes).set({ pagos }, { merge: true });
  } catch(e) { console.error('deletePago:', e); }
}

async function excluirEgresoDelFlujo(cajaId, evId) {
  if (!evId) return;
  const item = _egresoscajaCache.find(e =>
    String(e.id) === String(evId) && (e._cajaId || '') === cajaId);
  const label = item ? `${item.desc || 'Egreso'} (${fmt(item.monto)})` : 'este egreso';
  if (!confirm(`¿Quitar ${label} del flujo de este mes? El egreso seguirá registrado en su caja.`)) return;
  const key = _egresoExcluidoKey(cajaId, evId);
  const actuales = Array.isArray(_flujoDocCache.egresosExcluidos) ? _flujoDocCache.egresosExcluidos : [];
  if (actuales.includes(key)) return;
  const egresosExcluidos = [...actuales, key];
  try {
    await flujoRef(_currentFlujoMes).set(
      { mes: _currentFlujoMes, egresosExcluidos },
      { merge: true }
    );
  } catch(e) {
    console.error('excluirEgresoDelFlujo:', e);
    alert('No se pudo quitar el egreso del flujo.');
  }
}

// ── Charts ───────────────────────────────────────────────────

function _initFlujoCharts() {
  const barCtx  = document.getElementById('flujoBarChart')?.getContext('2d');
  const donaCtx = document.getElementById('flujoDonaChart')?.getContext('2d');
  const lineCtx = document.getElementById('flujoLineChart')?.getContext('2d');
  if (!barCtx || !donaCtx || !lineCtx) return;

  Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";

  _flujoCharts.bars = new Chart(barCtx, {
    type: 'bar',
    data: {
      labels: ['Ventas', 'Egresos', 'Utilidad'],
      datasets: [{ data: [0,0,0], backgroundColor: ['#22c55e','#ef4444','#16a34a'], borderRadius: 6, borderSkipped: false }]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => fmt(v) } } }
    }
  });

  _flujoCharts.dona = new Chart(donaCtx, {
    type: 'doughnut',
    data: {
      labels: ['Planilla', 'Pagos externos', 'Egresos caja'],
      datasets: [{ data: [0,0,0], backgroundColor: ['#f97316','#8b5cf6','#ef4444'], borderWidth: 2, borderColor: '#fff' }]
    },
    options: {
      responsive: true, maintainAspectRatio: true, cutout: '65%',
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 12 } } }
    }
  });

  _flujoCharts.line = new Chart(lineCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Ventas acumuladas',
        data: [], borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,.12)',
        fill: true, tension: 0.25, pointRadius: 3, pointHoverRadius: 5,
        borderWidth: 2, stepped: 'before'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => fmt(v) } } }
    }
  });
}

function _updateFlujoCharts(ventas, planilla, totalPagos, totalEgresosCaja, utilidad, vHist) {
  if (!_flujoCharts.bars) return;
  const totalEgresos = round2(planilla + totalPagos + totalEgresosCaja);

  // Bar
  _flujoCharts.bars.data.datasets[0].data = [ventas, totalEgresos, Math.abs(utilidad)];
  _flujoCharts.bars.data.datasets[0].backgroundColor =
    ['#22c55e', '#ef4444', utilidad >= 0 ? '#16a34a' : '#dc2626'];
  _flujoCharts.bars.update('none');

  // Donut
  _flujoCharts.dona.data.datasets[0].data = [planilla, totalPagos, totalEgresosCaja];
  _flujoCharts.dona.update('none');

  // Line: evolución de ventas en el mes
  const [y, m] = _currentFlujoMes.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const todayStr    = _todayPE();
  const labels = [], data = [];
  let lastVal = null;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${_currentFlujoMes}-${String(d).padStart(2,'0')}`;
    if (key > todayStr) break;
    labels.push(d);
    if (vHist[key] !== undefined) lastVal = vHist[key];
    data.push(lastVal);
  }
  _flujoCharts.line.data.labels = labels;
  _flujoCharts.line.data.datasets[0].data = data;
  _flujoCharts.line.update('none');
}

// ============================================================
//  INACTIVITY TIMER (desactivado)
// ============================================================
function startInactivityTimer()  { /* desactivado */ }
function stopInactivityTimer()   {
  clearTimeout(_inactivityTimer); clearTimeout(_warningTimer); clearInterval(_countdownInterval);
}
function resetInactivityTimer()  { /* desactivado */ }

// ============================================================
//  UTILS
// ============================================================
function round2(n) { return Math.round(n * 100) / 100; }
function fmt(n)    { return 'S/. ' + (+n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function tryParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ============================================================
//  REPORTE DE CAJA (RC) — aperturas vs comprobantes SAS
// ============================================================
let _rcCajaTimes = [];
const SAS_REPORTE_URL = 'https://cheplast.organizatic.com/principal#/reportes/ventas';

function _rcFechaCaja() {
  if (state.aperturaFecha) {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(state.aperturaFecha));
  }
  return _todayPE();
}

function _rcReporteHecho() {
  return (state.rcRegistros || []).length > 0;
}

function _rcActualizarBadge() {
  const badge = document.getElementById('rcEstadoBadge');
  if (!badge) return;
  if (_rcReporteHecho()) {
    badge.textContent = '✔ Completado';
    badge.style.background = '#dcfce7';
    badge.style.color = '#166534';
  } else {
    badge.textContent = 'Pendiente';
    badge.style.background = '#f3f4f6';
    badge.style.color = '#6b7280';
  }
}

async function openReporteCaja() {
  // Ya no navega a vista separada — sección inline en viewCierre
  document.getElementById('rcFormComprobantes').style.display = 'none';
  const picker = document.getElementById('rcFechaPicker');
  if (picker) {
    const hoy = _todayPE();
    picker.max   = hoy;
    picker.value = _rcFechaCaja();
  }
  _rcSetMsg('Haz clic en <b>&#9658; Iniciar Reporte</b> para obtener los datos de TROEFAE.', false);
  _rcRenderAperturasEmp();
  _rcRenderRegistros();
  _rcActualizarBadge();
}

function toggleListaAperturas() {
  const lista  = document.getElementById('rcAperturasEmpList');
  const btn    = document.getElementById('btnToggleAperturasRc');
  if (!lista) return;
  const visible = lista.style.display !== 'none';
  lista.style.display = visible ? 'none' : '';
  const n = _aperturasDiaListaHoy().length;
  if (btn) btn.textContent = visible ? `▼ Ver lista (${n})` : `▲ Ocultar (${n})`;
}

async function refreshAperturasEmp() {
  const btn = document.getElementById('btnRefreshAperturasRc');
  if (btn) { btn.disabled = true; btn.textContent = '↻ …'; }
  try {
    const snap = await cajaRef().get();
    if (snap.exists) {
      const remote = snap.data();
      if ((remote._ts || 0) > (state._ts || 0)) _applyRemoteState(remote);
    }
  } catch(e) { console.warn('refresh aperturas:', e); }
  _rcRenderAperturasEmp();
  if (btn) { btn.disabled = false; btn.textContent = '↻ Actualizar'; }
}

function _rcRenderAperturasEmp() {
  const el  = document.getElementById('rcAperturasEmpList');
  const btn = document.getElementById('btnToggleAperturasRc');
  if (!el) return;
  // Lista a nivel de DÍA completo (no solo la sesión actual) para que coincida
  // con aperturasEmp usado en la reconciliación RC, incluso si hubo Mañana + Tarde.
  const lista = _aperturasDiaListaHoy().slice().sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  if (lista.length === 0) {
    el.innerHTML = '<span style="color:#9ca3af">Sin aperturas registradas.</span>';
    el.style.display = 'none';
    if (btn) btn.textContent = '▼ Ver lista (0)';
    return;
  }
  el.innerHTML = lista.map((a, i) => {
    const hora  = new Date(a.fecha).toLocaleTimeString('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const turno = a.turno || _turnoDe(a.fecha);
    return `<div style="padding:5px 0;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between">
      <span style="color:#374151">${i+1}. <span style="background:#e5e7eb;color:#374151;font-size:10px;padding:1px 5px;border-radius:8px;margin-right:5px">${_turnoLabel(turno)}</span>${escHtml(a.motivo)}</span>
      <span style="color:#6b7280;white-space:nowrap;margin-left:10px">${hora}</span>
    </div>`;
  }).join('') + `<div style="padding-top:6px;font-weight:600;color:#1a6b3c">Total: ${lista.length}</div>`;
  el.style.display = '';
  if (btn) btn.textContent = `▲ Ocultar (${lista.length})`;
}

function _rcSetMsg(html, spinner) {
  document.getElementById('rcMensaje').innerHTML = html;
  document.getElementById('rcSpinner').style.display = spinner ? '' : 'none';
}

let _rcUnsubscribe = null;

function _rcParsarUpdatedAt(data) {
  if (!data.updatedAt) return null;
  return typeof data.updatedAt.toDate === 'function'
    ? data.updatedAt.toDate()
    : new Date(data.updatedAt);
}

function _rcFechaDeUpdatedAt(updatedAt) {
  if (!updatedAt) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(updatedAt);
}

let _rcAperturasEmpActual = 0;

async function _rcMostrarDatos(data, fecha, btn) {
  const cajaTimes   = Array.isArray(data.times) ? data.times : [];
  _rcCajaTimes      = cajaTimes;
  const aperturasBat = cajaTimes.length;
  // Aperturas del DÍA consultado (no solo la sesión actual), para que cuadre
  // con TROEFAE aunque haya habido una caja Mañana y otra Tarde ese día.
  const diaLista     = await _aperturasDiaFetch(fecha);
  const aperturasEmp = diaLista === null ? (state.aperturasCaja || []).length : diaLista.length;
  _rcAperturasEmpActual = aperturasEmp;

  if (aperturasBat === 0) {
    _rcSetMsg(`Sin aperturas registradas en TROEFAE para el ${fecha}.`, false);
    document.getElementById('rcFormComprobantes').style.display = 'none';
    btn.disabled = false;
    return;
  }

  const updatedAt  = _rcParsarUpdatedAt(data);
  const horaStr    = updatedAt
    ? updatedAt.toLocaleTimeString('es-PE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
    : '';
  _rcSetMsg(
    `✔ ${aperturasBat} apertura(s) de TROEFAE${horaStr ? ' (' + horaStr + ')' : ''}. Ingresa los comprobantes abajo.`,
    false
  );
  const info = document.getElementById('rcAperturasInfo');
  if (info) {
    info.innerHTML =
      `Total aperturas (TROEFAE): <b>${aperturasBat}</b> &nbsp;=&nbsp; ` +
      `Comprobantes SAS <b>(?)</b> + Aperturas empleado <b>${aperturasEmp}</b>`;
  }
  document.getElementById('rcFormComprobantes').style.display = '';
  const input = document.getElementById('rcInputComprobantes');
  if (input) { input.value = ''; input.focus(); }
  btn.disabled = false;
}

async function iniciarReporteCaja() {
  const btn = document.getElementById('btnIniciarReporte');
  btn.disabled = true;
  if (_rcUnsubscribe) { _rcUnsubscribe(); _rcUnsubscribe = null; }

  const picker = document.getElementById('rcFechaPicker');
  const fecha  = picker?.value || _todayPE();

  _rcSetMsg('Enviando solicitud a TROEFAE…', true);

  // Registrar momento exacto antes de enviar — solo aceptar respuestas posteriores
  const enviadoEn = new Date();

  try {
    await db.doc('requests/reporte-caja').set({
      fecha,
      status: 'pending',
      requestedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) {
    _rcSetMsg('Error al conectar con Firestore. Verifica tu conexión.', false);
    btn.disabled = false;
    return;
  }

  _rcSetMsg('Esperando respuesta de TROEFAE…', true);

  const timeout = setTimeout(() => {
    if (_rcUnsubscribe) { _rcUnsubscribe(); _rcUnsubscribe = null; }
    _rcSetMsg('TROEFAE no respondió. Verifica que esté encendida y con el watcher activo.', false);
    btn.disabled = false;
  }, 30000);

  _rcUnsubscribe = db.doc(`reporteCaja/${fecha}`).onSnapshot(snap => {
    if (!snap.exists) return;
    const data      = snap.data();
    const updatedAt = _rcParsarUpdatedAt(data);
    // Solo aceptar respuestas que llegaron después de enviar la solicitud (tolerancia 10s por diferencia de relojes)
    if (!updatedAt || updatedAt.getTime() < enviadoEn.getTime() - 10000) return;

    clearTimeout(timeout);
    if (_rcUnsubscribe) { _rcUnsubscribe(); _rcUnsubscribe = null; }
    _rcMostrarDatos(data, fecha, btn);
  });
}

function rcRegistrarComprobantes() {
  const input = document.getElementById('rcInputComprobantes');
  const comprobantes = parseInt(input?.value, 10);
  if (isNaN(comprobantes) || comprobantes < 0) { if (input) input.focus(); return; }

  const aperturasBat = (_rcCajaTimes || []).length;
  const aperturasEmp = _rcAperturasEmpActual;
  const esperado     = comprobantes + aperturasEmp;
  const diff         = aperturasBat - esperado;   // 0 = cuadra

  if (!Array.isArray(state.rcRegistros)) state.rcRegistros = [];
  state.rcRegistros.push({ aperturasBat, aperturasEmp, comprobantes, fecha: new Date().toISOString() });
  saveStateNow();
  _rcRenderRegistros();
  _rcActualizarBadge();
  if (input) input.value = '';

  if (diff === 0) {
    _rcSetMsg(`✔ Cuadra: ${aperturasBat} bat = ${comprobantes} comprobantes + ${aperturasEmp} empleado.`, false);
  } else if (diff > 0) {
    _rcSetMsg(`⚠ Faltan ${diff} — bat: ${aperturasBat}, comprobantes: ${comprobantes}, empleado: ${aperturasEmp} (suma: ${esperado}).`, false);
  } else {
    _rcSetMsg(`⚠ Sobran ${Math.abs(diff)} — bat: ${aperturasBat}, comprobantes: ${comprobantes}, empleado: ${aperturasEmp} (suma: ${esperado}).`, false);
  }
}

function rcDeleteRegistro(i) {
  if (!Array.isArray(state.rcRegistros)) return;
  state.rcRegistros.splice(i, 1);
  saveState();
  _rcRenderRegistros();
  _rcActualizarBadge();
}

function toggleRcManual() {
  const panel = document.getElementById('rcManualPanel');
  if (!panel) return;
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : '';
  if (!visible) setTimeout(() => document.getElementById('rcManualBat')?.focus(), 50);
}

function rcRegistrarManual() {
  const batEl  = document.getElementById('rcManualBat');
  const compEl = document.getElementById('rcManualComp');
  const bat    = parseInt(batEl?.value,  10);
  const comp   = parseInt(compEl?.value, 10);
  if (isNaN(bat)  || bat  < 0) { batEl?.focus();  return; }
  if (isNaN(comp) || comp < 0) { compEl?.focus(); return; }

  const aperturasEmp = (state.aperturasCaja || []).length;
  const esperado     = comp + aperturasEmp;
  const diff         = bat - esperado;

  if (!Array.isArray(state.rcRegistros)) state.rcRegistros = [];
  state.rcRegistros.push({
    aperturasBat: bat,
    aperturasEmp,
    comprobantes: comp,
    fecha: new Date().toISOString(),
    manual: true,
  });
  saveStateNow();
  _rcRenderRegistros();
  _rcActualizarBadge();
  if (batEl)  batEl.value  = '';
  if (compEl) compEl.value = '';
  document.getElementById('rcManualPanel').style.display = 'none';

  if (diff === 0) {
    _rcSetMsg(`✔ Manual registrado: ${bat} bat = ${comp} comprobantes + ${aperturasEmp} empleado. Cuadra.`, false);
  } else if (diff > 0) {
    _rcSetMsg(`⚠ Manual registrado — Faltan ${diff}: bat ${bat}, comp ${comp}, emp ${aperturasEmp}.`, false);
  } else {
    _rcSetMsg(`⚠ Manual registrado — Sobran ${Math.abs(diff)}: bat ${bat}, comp ${comp}, emp ${aperturasEmp}.`, false);
  }
}

function _rcRenderRegistros() {
  const el = document.getElementById('rcRegistrosList');
  if (!el) return;
  const lista = state.rcRegistros || [];
  if (lista.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="card" style="margin-bottom:18px">
    <div class="card-head"><h3>Registros del día</h3></div>
    <div class="card-body" style="padding:10px 16px">
      ${lista.map((r, i) => {
        const hora     = new Date(r.fecha).toLocaleTimeString('es-PE', { timeZone: TZ, hour:'2-digit', minute:'2-digit' });
        const bat      = r.aperturasBat ?? r.aperturas ?? 0;
        const emp      = r.aperturasEmp ?? 0;
        const comp     = r.comprobantes ?? 0;
        const esperado = comp + emp;
        const diff     = bat - esperado;
        const color    = diff === 0 ? '#15803d' : '#c2410c';
        const icon     = diff === 0 ? '✔' : '⚠';
        const estado   = diff === 0
          ? 'Cuadra'
          : diff > 0 ? `Faltan ${diff}` : `Sobran ${Math.abs(diff)}`;
        return `<div style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <span style="color:${color};font-weight:700">${icon} ${estado}</span>
              <span style="color:#9ca3af;font-size:11px;margin-left:8px">${hora}</span>
              ${r.manual ? '<span style="font-size:10px;background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 5px;margin-left:4px;font-weight:600">manual</span>' : ''}
            </div>
            <button onclick="rcDeleteRegistro(${i})"
              style="background:none;border:none;color:#dc2626;cursor:pointer;
                     font-size:15px;padding:0 4px;line-height:1" title="Eliminar">✕</button>
          </div>
          <div style="color:#374151;font-size:12px;margin-top:3px">
            Bat: <b>${bat}</b> = Comprobantes: <b>${comp}</b> + Empleado: <b>${emp}</b>
            ${diff !== 0 ? `<span style="color:${color}"> (suma: ${esperado})</span>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}
