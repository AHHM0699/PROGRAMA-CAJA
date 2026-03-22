'use strict';

// ============================================================
//  CONSTANTS
// ============================================================
const PASSWORD = 'REDONDA07.';

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
//  APP STATE
// ============================================================
let state = {
  // Apertura data
  cajaInicial:       0,
  ventasHastaAhora:  0,
  ultimoYape:        0,
  aperturaGuardada:  false,
  aperturaFecha:     null,
  inicialMode:       'monto',   // 'monto' | 'denom'
  inicialBreakdown:  null,

  // Current mode selectors
  cierreMode: 'monto',  // 'monto' | 'denom'
};

// ============================================================
//  INIT
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  buildDenomTable('inicial', 'inicialDenomTable');
  buildDenomTable('cierre', 'cierreDenomTable');

  // Header date
  const opts = { weekday:'long', year:'numeric', month:'long', day:'numeric' };
  document.getElementById('headerDate').textContent =
    new Date().toLocaleDateString('es-PE', opts);

  document.getElementById('passInput').focus();
});

// ============================================================
//  AUTH
// ============================================================
function login() {
  const input = document.getElementById('passInput');
  if (input.value === PASSWORD) {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    document.getElementById('loginError').style.display = 'none';
    loadApertura();
    calcular();
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
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('passInput').value = '';
}

// ============================================================
//  TABS
// ============================================================
function switchTab(tab) {
  const isApertura = tab === 'apertura';
  document.getElementById('tabApertura').classList.toggle('hidden', !isApertura);
  document.getElementById('tabCierre').classList.toggle('hidden', isApertura);
  document.getElementById('tabBtnApertura').classList.toggle('active', isApertura);
  document.getElementById('tabBtnCierre').classList.toggle('active', !isApertura);

  if (!isApertura) {
    renderResumenApertura();
    calcular();
  }
}

// ============================================================
//  INPUT MODE TOGGLE (monto / denom)
// ============================================================
function setMode(section, mode) {
  if (section === 'inicial') {
    state.inicialMode = mode;
    document.getElementById('inicialModoMonto').classList.toggle('hidden', mode !== 'monto');
    document.getElementById('inicialModoDenom').classList.toggle('hidden', mode !== 'denom');
    document.getElementById('tglInicialMonto').classList.toggle('active', mode === 'monto');
    document.getElementById('tglInicialDenom').classList.toggle('active', mode === 'denom');
  } else {
    state.cierreMode = mode;
    document.getElementById('cierreModoMonto').classList.toggle('hidden', mode !== 'monto');
    document.getElementById('cierreModoDenom').classList.toggle('hidden', mode !== 'denom');
    document.getElementById('tglCierreMonto').classList.toggle('active', mode === 'monto');
    document.getElementById('tglCierreDenom').classList.toggle('active', mode === 'denom');
    calcular();
  }
}

// ============================================================
//  DENOMINATION TABLE
// ============================================================
function buildDenomTable(section, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let html = `<div class="denom-table">
    <div class="denom-th">
      <span>Denominación</span>
      <span style="text-align:center">Cantidad</span>
      <span>Subtotal</span>
    </div>`;

  let lastTipo = '';
  DENOMS.forEach((d, i) => {
    if (d.tipo !== lastTipo) {
      const icon = d.tipo === 'Moneda' ? '🪙' : '💵';
      html += `<div class="denom-sep">${icon} ${d.tipo}s</div>`;
      lastTipo = d.tipo;
    }
    html += `
      <div class="denom-row">
        <span class="denom-lbl">${d.label}</span>
        <input class="denom-qty" type="number" id="${section}Qty${i}"
          min="0" value="" placeholder="0"
          oninput="onDenomInput('${section}', ${i})">
        <span class="denom-sub" id="${section}Sub${i}">S/. 0.00</span>
      </div>`;
  });

  html += '</div>';
  container.innerHTML = html;
}

function onDenomInput(section, idx) {
  const qty = parseFloat(document.getElementById(`${section}Qty${idx}`).value) || 0;
  const sub = round2(qty * DENOMS[idx].val);
  document.getElementById(`${section}Sub${idx}`).textContent = fmt(sub);
  refreshDenomTotal(section);
  if (section === 'cierre') calcular();
}

function refreshDenomTotal(section) {
  const total = getDenomTotal(section);
  const elId = section === 'inicial' ? 'inicialDenomTotal' : 'cierreDenomTotal';
  document.getElementById(elId).textContent = fmt(total);
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
  return state.cierreMode === 'monto'
    ? (parseFloat(document.getElementById('cajaFinalExacto').value) || 0)
    : getDenomTotal('cierre');
}

// ============================================================
//  APERTURA
// ============================================================
function guardarApertura() {
  state.cajaInicial      = getCajaInicial();
  state.ventasHastaAhora = parseFloat(document.getElementById('ventasHastaAhora').value) || 0;
  state.ultimoYape       = parseFloat(document.getElementById('ultimoYape').value) || 0;
  state.aperturaGuardada = true;
  state.aperturaFecha    = new Date().toISOString();

  if (state.inicialMode === 'denom') {
    state.inicialBreakdown = getDenomBreakdown('inicial');
  } else {
    state.inicialBreakdown = null;
  }

  try {
    localStorage.setItem('cajaApertura', JSON.stringify({
      cajaInicial:      state.cajaInicial,
      ventasHastaAhora: state.ventasHastaAhora,
      ultimoYape:       state.ultimoYape,
      aperturaGuardada: true,
      aperturaFecha:    state.aperturaFecha,
      inicialMode:      state.inicialMode,
      inicialBreakdown: state.inicialBreakdown,
    }));
  } catch (e) { /* storage not available */ }

  const alert = document.getElementById('alertApertura');
  alert.classList.remove('hidden');
  setTimeout(() => alert.classList.add('hidden'), 4500);
}

function loadApertura() {
  try {
    const raw = localStorage.getItem('cajaApertura');
    if (!raw) return;
    const data = JSON.parse(raw);
    Object.assign(state, data);

    // Populate apertura fields
    if (data.cajaInicial !== undefined)
      document.getElementById('cajaInicialExacto').value = data.cajaInicial;
    if (data.ventasHastaAhora !== undefined)
      document.getElementById('ventasHastaAhora').value = data.ventasHastaAhora;
    if (data.ultimoYape !== undefined)
      document.getElementById('ultimoYape').value = data.ultimoYape;

    // Restore mode
    if (data.inicialMode) setMode('inicial', data.inicialMode);
  } catch (e) { /* ignore */ }
}

function renderResumenApertura() {
  const cardOk   = document.getElementById('cardResumenApertura');
  const cardWarn = document.getElementById('cardSinApertura');

  if (!state.aperturaGuardada) {
    cardOk.style.display   = 'none';
    cardWarn.style.display = 'block';
    return;
  }

  cardOk.style.display   = 'block';
  cardWarn.style.display = 'none';

  const fechaStr = state.aperturaFecha
    ? new Date(state.aperturaFecha).toLocaleString('es-PE')
    : 'N/A';

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
      <div class="info-label">Hora de apertura</div>
      <div class="info-val" style="font-size:13px">${fechaStr}</div>
    </div>`;
}

// ============================================================
//  YAPES
// ============================================================
function onYapesInput() {
  const raw    = document.getElementById('yapesInput').value;
  const parts  = raw.split(',').map(s => s.trim()).filter(s => s !== '');
  const chips  = document.getElementById('yapesChips');
  let total    = 0;
  let chipsHtml = '';

  parts.forEach(p => {
    const v = parseFloat(p);
    if (!isNaN(v) && v >= 0) {
      total += v;
      chipsHtml += `<span class="chip chip-ok">S/. ${v.toFixed(2)}</span>`;
    } else {
      chipsHtml += `<span class="chip chip-err">${p} ⚠</span>`;
    }
  });

  chips.innerHTML = chipsHtml;
  total = round2(total);
  document.getElementById('totalYapesDisplay').textContent = fmt(total);
  calcular();
}

function getTotalYapes() {
  const raw = document.getElementById('yapesInput')?.value || '';
  return round2(raw.split(',').reduce((sum, s) => {
    const v = parseFloat(s.trim());
    return sum + (isNaN(v) ? 0 : v);
  }, 0));
}

function getYapesList() {
  const raw = document.getElementById('yapesInput')?.value || '';
  return raw.split(',').map(s => parseFloat(s.trim())).filter(v => !isNaN(v) && v >= 0);
}

// ============================================================
//  CALCULATION
// ============================================================
function calcular() {
  const vf  = parseFloat(document.getElementById('ventasFinal')?.value) || 0;
  const vha = state.ventasHastaAhora || 0;
  const ty  = getTotalYapes();
  const ci  = state.cajaInicial || 0;
  const res = round2(vf - vha - ty + ci);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
  set('fVF', vf);
  set('fVHA', vha);
  set('fTY', ty);
  set('fCI', ci);

  const resEl = document.getElementById('fResultado');
  if (resEl) {
    resEl.textContent = fmt(res);
    resEl.style.color = res >= 0 ? '#059669' : '#dc2626';
  }
}

// ============================================================
//  CLOSE & PDF
// ============================================================
function cerrarCaja() {
  const ventasFinal = parseFloat(document.getElementById('ventasFinal').value) || 0;
  const totalYapes  = getTotalYapes();
  const cajaFinal   = getCajaFinal();
  const resultado   = round2(ventasFinal - (state.ventasHastaAhora || 0) - totalYapes + (state.cajaInicial || 0));

  generarPDF({
    fecha:            new Date(),
    cajaInicial:      state.cajaInicial || 0,
    inicialMode:      state.inicialMode,
    inicialBreakdown: state.inicialBreakdown,
    ventasHastaAhora: state.ventasHastaAhora || 0,
    ultimoYape:       state.ultimoYape || 0,
    aperturaFecha:    state.aperturaFecha,
    cajaFinal,
    cierreMode:       state.cierreMode,
    cierreBreakdown:  state.cierreMode === 'denom' ? getDenomBreakdown('cierre') : null,
    ventasFinal,
    yapesList:        getYapesList(),
    totalYapes,
    resultado,
  });

  // Clear stored apertura after close
  try { localStorage.removeItem('cajaApertura'); } catch (e) {}
  state.aperturaGuardada  = false;
  state.cajaInicial       = 0;
  state.ventasHastaAhora  = 0;
  state.ultimoYape        = 0;
  state.aperturaFecha     = null;
  state.inicialBreakdown  = null;
}

// ============================================================
//  PDF GENERATION  (jsPDF)
// ============================================================
function generarPDF(d) {
  const { jsPDF } = window.jspdf;
  const doc  = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pw   = doc.internal.pageSize.getWidth();
  const mg   = 20;
  const COL2 = pw - mg;

  const BLUE  = [30, 58, 95];
  const LBLUE = [239, 246, 255];
  const GREEN = [5, 150, 105];
  const GRAY  = [100, 116, 139];
  const DARK  = [26, 32, 44];

  // ---- HEADER ----
  doc.setFillColor(...BLUE);
  doc.rect(0, 0, pw, 36, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('REPORTE DE CIERRE DE CAJA', pw / 2, 16, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const fechaOpts = { weekday:'long', year:'numeric', month:'long', day:'numeric' };
  doc.text(
    `${d.fecha.toLocaleDateString('es-PE', fechaOpts)}  |  ${d.fecha.toLocaleTimeString('es-PE')}`,
    pw / 2, 27, { align: 'center' }
  );

  let y = 46;

  // ---- APERTURA ----
  y = pdfSeccion(doc, 'DATOS DE APERTURA', y, pw, mg, BLUE, LBLUE);

  if (d.aperturaFecha) {
    y = pdfFila(doc, 'Fecha de apertura',
      new Date(d.aperturaFecha).toLocaleString('es-PE'), y, mg, pw, DARK, BLUE);
  }
  y = pdfFila(doc, 'Caja Inicial',      fmt(d.cajaInicial),       y, mg, pw, DARK, BLUE);
  y = pdfFila(doc, 'Ventas hasta ahora', fmt(d.ventasHastaAhora), y, mg, pw, DARK, BLUE);
  y = pdfFila(doc, 'Último Yape',       fmt(d.ultimoYape),        y, mg, pw, DARK, BLUE);

  if (d.inicialMode === 'denom' && d.inicialBreakdown?.length) {
    y += 3;
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...GRAY);
    doc.text('Detalle denominaciones (Caja Inicial):', mg, y); y += 5;
    d.inicialBreakdown.forEach(item => {
      doc.text(`   ${item.label}  ×  ${item.qty}  =  S/. ${item.subtotal.toFixed(2)}`, mg + 4, y);
      y += 4.5;
    });
  }

  y += 6;

  // ---- CIERRE ----
  y = pdfSeccion(doc, 'DATOS DE CIERRE', y, pw, mg, BLUE, LBLUE);
  y = pdfFila(doc, 'Ventas Final',               fmt(d.ventasFinal), y, mg, pw, DARK, BLUE);
  y = pdfFila(doc, 'Efectivo en Caja al Cierre', fmt(d.cajaFinal),   y, mg, pw, DARK, BLUE);

  if (d.cierreMode === 'denom' && d.cierreBreakdown?.length) {
    y += 3;
    doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(...GRAY);
    doc.text('Detalle denominaciones (Cierre):', mg, y); y += 5;
    d.cierreBreakdown.forEach(item => {
      doc.text(`   ${item.label}  ×  ${item.qty}  =  S/. ${item.subtotal.toFixed(2)}`, mg + 4, y);
      y += 4.5;
    });
  }

  if (d.yapesList.length > 0) {
    y += 3;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
    doc.text('Yapes recibidos:', mg, y); y += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...GRAY);
    d.yapesList.forEach((v, i) => {
      doc.text(`   Yape ${i + 1}: S/. ${v.toFixed(2)}`, mg + 4, y); y += 4.5;
    });
    y += 1;
  }
  y = pdfFila(doc, 'Total Yapes', fmt(d.totalYapes), y, mg, pw, DARK, BLUE);

  y += 8;

  // ---- CÁLCULO ----
  y = pdfSeccion(doc, 'CÁLCULO', y, pw, mg, BLUE, LBLUE);

  const boxH = 58;
  doc.setFillColor(240, 253, 244);
  doc.setDrawColor(187, 247, 208);
  doc.roundedRect(mg, y, pw - mg * 2, boxH, 3, 3, 'FD');

  let fy = y + 9;
  const c1 = mg + 8, c2 = pw - mg - 8;

  const fRow = (lbl, val, color) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(...DARK);
    doc.text(lbl, c1, fy);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...color);
    doc.text(fmt(val), c2, fy, { align: 'right' });
    fy += 7.5;
  };

  fRow('Ventas Final',         d.ventasFinal,        DARK);
  fRow('− Ventas hasta ahora', d.ventasHastaAhora,   [180, 90, 20]);
  fRow('− Total Yapes',        d.totalYapes,          [180, 90, 20]);
  fRow('+ Caja Inicial',       d.cajaInicial,         GREEN);

  doc.setDrawColor(...GRAY);
  doc.line(c1, fy - 2, c2, fy - 2); fy += 4;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.setTextColor(...DARK); doc.text('= RESULTADO', c1, fy);
  doc.setTextColor(...(d.resultado >= 0 ? GREEN : [220, 38, 38]));
  doc.text(fmt(d.resultado), c2, fy, { align: 'right' });

  // ---- FOOTER ----
  const ph = doc.internal.pageSize.getHeight();
  doc.setDrawColor(...GRAY);
  doc.line(mg, ph - 16, pw - mg, ph - 16);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...GRAY);
  doc.text('Reporte generado por Control de Caja', pw / 2, ph - 10, { align: 'center' });
  doc.text(d.fecha.toLocaleString('es-PE'), pw / 2, ph - 5, { align: 'center' });

  const name = `Cierre_Caja_${d.fecha.toLocaleDateString('es-PE').replace(/\//g, '-')}.pdf`;
  doc.save(name);
}

// PDF helpers
function pdfSeccion(doc, title, y, pw, mg, BLUE, LBLUE) {
  doc.setFillColor(...LBLUE); doc.setDrawColor(...BLUE);
  doc.roundedRect(mg, y, pw - mg * 2, 10, 2, 2, 'FD');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...BLUE);
  doc.text(title, mg + 5, y + 7);
  return y + 16;
}

function pdfFila(doc, label, value, y, mg, pw, DARK, BLUE) {
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...DARK);
  doc.text(label + ':', mg + 2, y);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...BLUE);
  doc.text(value, pw - mg - 2, y, { align: 'right' });
  doc.setDrawColor(230, 230, 230);
  doc.line(mg, y + 2.5, pw - mg, y + 2.5);
  return y + 9;
}

// ============================================================
//  UTILS
// ============================================================
function round2(n) { return Math.round(n * 100) / 100; }
function fmt(n)    { return `S/. ${(+n).toFixed(2)}`; }
