'use strict';

// ============================================================
//  CONSTANTS
// ============================================================
// Password stored as SHA-256 hash — the plain text never appears in this file.
const PASSWORD_HASH = '2d4e7db060a92769c58c1c355d5207537ac741e43baf27712025bbb371198d5d';

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
};

let cierreMode = 'denom'; // denomination is default for closing

// ============================================================
//  INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  buildDenomTable('inicial', 'inicialDenomTable');
  buildDenomTable('cierre',  'cierreDenomTable');

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
  if (hash === PASSWORD_HASH) {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainApp').style.display    = 'block';
    document.getElementById('loginError').style.display = 'none';
    loadState();
    showView('auto');
  } else {
    document.getElementById('loginError').style.display = 'block';
    input.value = '';
    input.classList.add('shake');
    input.addEventListener('animationend', () => input.classList.remove('shake'), { once: true });
    input.focus();
  }
}

function logout() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('mainApp').style.display     = 'none';
  document.getElementById('passInput').value = '';
}

// ============================================================
//  VIEWS  (apertura | cierre | reportes | auto)
// ============================================================
function showView(view) {
  if (view === 'auto') view = state.cajaAbierta ? 'cierre' : 'apertura';

  ['viewApertura', 'viewCierre', 'viewReportes'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );

  const cap = view.charAt(0).toUpperCase() + view.slice(1);
  document.getElementById('view' + cap).classList.remove('hidden');

  if (view === 'cierre')   { renderResumen(); calcularEsperado(); }
  if (view === 'reportes') renderReportes();
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
//  STATE PERSISTENCE
// ============================================================
function saveState() {
  try { localStorage.setItem('cajaState', JSON.stringify(state)); } catch (e) {}
}

function loadState() {
  try {
    const raw = localStorage.getItem('cajaState');
    if (!raw) return;
    Object.assign(state, JSON.parse(raw));
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

function getEsperado() {
  const vf  = parseFloat(document.getElementById('ventasFinal')?.value) || 0;
  const vha = state.ventasHastaAhora || 0;
  const ty  = getTotalYapes();
  const ci  = state.cajaInicial || 0;
  return round2(vf - vha - ty + ci);
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
    ? new Date(state.aperturaFecha).toLocaleString('es-PE') : 'N/A';
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
  const parts = raw.split(',').map(s => s.trim()).filter(s => s !== '');
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
  document.getElementById('yapesChips').innerHTML         = html;
  document.getElementById('totalYapesDisplay').textContent = fmt(total);
  calcularEsperado();
}

function getTotalYapes() {
  const raw = document.getElementById('yapesInput')?.value || '';
  return round2(raw.split(',').reduce((sum, s) => {
    const v = parseFloat(s.trim());
    return sum + (isNaN(v) || v < 0 ? 0 : v);
  }, 0));
}

function getYapesList() {
  const raw = document.getElementById('yapesInput')?.value || '';
  return raw.split(',').map(s => parseFloat(s.trim())).filter(v => !isNaN(v) && v >= 0);
}

// ============================================================
//  CALCULATIONS
// ============================================================
function calcularEsperado() {
  const vf  = parseFloat(document.getElementById('ventasFinal')?.value) || 0;
  const vha = state.ventasHastaAhora || 0;
  const ty  = getTotalYapes();
  const ci  = state.cajaInicial || 0;
  const esp = round2(vf - vha - ty + ci);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
  set('fVF',  vf);
  set('fVHA', vha);
  set('fTY',  ty);
  set('fCI',  ci);

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
function cerrarCaja() {
  const ventasFinal      = parseFloat(document.getElementById('ventasFinal').value) || 0;
  const totalYapes       = getTotalYapes();
  const yapesList        = getYapesList();
  const efectivoReal     = getCajaFinal();
  const efectivoEsperado = getEsperado();
  const diferencia       = round2(efectivoReal - efectivoEsperado);

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
    cierreMode,
    cierreBreakdown:  cierreMode === 'denom' ? getDenomBreakdown('cierre') : null,
    efectivoEsperado,
    efectivoReal,
    diferencia,
  };

  saveReport(report);
  generarPDF(report);
  resetAfterClose();
}

function resetAfterClose() {
  state = {
    cajaAbierta: false, cajaInicial: 0, ventasHastaAhora: 0,
    ultimoYape: 0, aperturaFecha: null, inicialMode: 'monto', inicialBreakdown: null,
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

  showView('apertura');
}

// ============================================================
//  REPORTS  (localStorage)
// ============================================================
function getReports() {
  try { return JSON.parse(localStorage.getItem('cajaReportes') || '[]'); }
  catch { return []; }
}

function saveReport(report) {
  try {
    const reports = getReports();
    reports.unshift(report);
    localStorage.setItem('cajaReportes', JSON.stringify(reports));
  } catch (e) {}
}

function renderReportes() {
  const desde = document.getElementById('filtroDesde')?.value;
  const hasta = document.getElementById('filtroHasta')?.value;

  let reports = getReports();
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

function exportarExcel() {
  const desde = document.getElementById('filtroDesde')?.value;
  const hasta = document.getElementById('filtroHasta')?.value;

  let reports = getReports();
  if (desde) reports = reports.filter(r => new Date(r.fecha) >= new Date(desde));
  if (hasta) {
    const h = new Date(hasta); h.setHours(23, 59, 59);
    reports = reports.filter(r => new Date(r.fecha) <= h);
  }

  if (reports.length === 0) { alert('No hay reportes para exportar.'); return; }

  const data = reports.map(r => ({
    'Fecha Cierre':                 new Date(r.fecha).toLocaleString('es-PE'),
    'Caja Inicial (S/.)':           r.cajaInicial,
    'Ventas hasta ahora (S/.)':     r.ventasHastaAhora,
    'Ultimo Yape (S/.)':            r.ultimoYape,
    'Ventas Final (S/.)':           r.ventasFinal,
    'Total Yapes (S/.)':            r.totalYapes,
    'Efectivo Esperado (S/.)':      r.efectivoEsperado,
    'Efectivo Real (S/.)':          r.efectivoReal,
    'Diferencia (S/.)':             r.diferencia,
    'Resultado':                    r.diferencia === 0 ? 'Exacto' : r.diferencia > 0 ? 'Sobra' : 'Falta',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [
    {wch:22},{wch:18},{wch:22},{wch:16},{wch:18},{wch:16},{wch:22},{wch:18},{wch:16},{wch:10}
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Reportes de Caja');
  XLSX.writeFile(wb, `Reportes_Caja_${new Date().toLocaleDateString('es-PE').replace(/\//g,'-')}.xlsx`);
}

// ============================================================
//  PDF GENERATION
// ============================================================
function generarPDF(d) {
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

  // ---- CÁLCULO ----
  y = newPageIfNeeded(y, 58);
  y = pdfSec(doc, 'CÁLCULO — EFECTIVO ESPERADO', y, pw, mg, BLUE, LBLUE);
  doc.setFillColor(245, 243, 255); doc.setDrawColor(199, 195, 245);
  doc.roundedRect(mg, y, pw - mg * 2, 50, 3, 3, 'FD');
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

// SHA-256 via Web Crypto API (built into all modern browsers, no library needed)
async function sha256(str) {
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
