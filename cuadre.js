// ════════════════════════════════════════════════════════════════════
//  CUADRE DE APERTURAS  —  motor aislado (Node + navegador)
//  Empareja: aperturas TROEFAE (impresiones) <-> comprobantes SAS
//            + justificaciones del empleado
//  NO depende del DOM ni de Firebase. Es el archivo que luego se
//  copiaria a app.js si las pruebas convencen.
// ════════════════════════════════════════════════════════════════════
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cuadre = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ── Tiempo ──────────────────────────────────────────────────────────
function horaASeg(h) {
  var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(h).trim());
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
}
function segAHora(s) {
  s = Math.round(s);
  var neg = s < 0; if (neg) s = -s;
  var p = function (n) { return String(n).padStart(2, '0'); };
  return (neg ? '-' : '') + p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
}
function desfaseTxt(d) { return (d >= 0 ? '+' : '') + d + 's'; }

// ── Config por defecto ──────────────────────────────────────────────
var TOL = {
  // Comprobante: se emite ANTES de imprimirse -> ventana asimetrica
  compAntes:   30,   // la impresion puede figurar hasta 30s ANTES (reloj desfasado)
  compDespues: 120,  // ...y hasta 120s DESPUES de la emision
  // Empleado: el boton dispara la impresion al instante -> simetrica
  empAntes:    60,
  empDespues:  60,
  // Reimpresion: una apertura huerfana cerca de un comprobante YA emparejado
  reimprMax:   600
};

// ── Parser por REGISTROS ────────────────────────────────────────────
//  No depende del orden ni del salto de linea: parte el texto en un flujo
//  de palabras y abre un registro nuevo en cada fecha ISO (YYYY-MM-DD).
//  Asi da igual si el texto viene del PDF, de pdf.js, de copiar la tabla
//  del navegador o de un pegado desordenado.
//  El encabezado usa DD-MM-YYYY ("DEL: 09-09-2026") y por eso nunca abre
//  registro: queda descartado antes del primero.
var RE_ISO     = /^\d{4}-\d{2}-\d{2}$/;
var RE_HMS     = /^\d{1,2}:\d{2}:\d{2}$/;
var RE_HM      = /^\d{1,2}:\d{2}$/;
var RE_TIPO    = /^(BV|NV|FT|NC|ND|GR|BOLETA|NOTA|FACTURA|TICKET)$/i;
var RE_SERIE   = /^[A-Z]{1,4}\d{1,4}$/;
var RE_NUM     = /^\d{1,10}$/;
var RE_ANULADO = /ANULAD|ELIMINAD/i;
var MAX_TOK    = 30;   // una fila tiene ~18 palabras; corta antes del pie de totales

function parsearComprobantes(texto) {
  var t = String(texto || '').replace(/(\d{4}-\d{2}-\d{2})T/g, '$1 ');
  var tok = t.split(/[\s ]+/).filter(Boolean);
  var avisos = [], comps = [], sinHora = 0;

  // Limites de registro: cada fecha ISO
  var ini = [];
  for (var i = 0; i < tok.length; i++) if (RE_ISO.test(tok[i])) ini.push(i);

  for (var k = 0; k < ini.length; k++) {
    var desde = ini[k];
    var hasta = Math.min(k + 1 < ini.length ? ini[k + 1] : tok.length, desde + MAX_TOK);
    var campos = tok.slice(desde, hasta);

    var hora = null, horaDebil = null, tipo = '', serie = '', num = '';
    for (var j = 0; j < campos.length; j++) {
      var c = campos[j];
      if (RE_HMS.test(c)) {
        if (c !== '00:00:00' && !hora) hora = c;                 // la hora de emision
      } else if (RE_HM.test(c)) {
        if (c !== '00:00' && !horaDebil) horaDebil = c + ':00';  // SAS sin segundos
      } else if (!tipo && RE_TIPO.test(c)) {
        tipo = c.toUpperCase();
      } else if (tipo && !serie && RE_SERIE.test(c)) {
        serie = c;
        if (campos[j + 1] && RE_NUM.test(campos[j + 1])) num = campos[j + 1];
      }
    }
    if (!hora) hora = horaDebil;
    if (!hora) { sinHora++; continue; }

    comps.push({
      hora: hora, seg: horaASeg(hora), tipo: tipo, serie: serie, num: num,
      anulado: RE_ANULADO.test(campos.join(' '))
    });
  }

  var anulados = comps.filter(function (c) { return c.anulado; });
  if (anulados.length) avisos.push(anulados.length + ' comprobante(s) anulado(s)/eliminado(s) excluido(s).');
  if (sinHora) avisos.push(sinHora + ' registro(s) sin hora de emision: se ignoraron.');
  if (!comps.length && tok.length) avisos.push('No reconoci ningun comprobante. Revisa que el reporte traiga la hora de emision.');

  var vivos = comps.filter(function (c) { return !c.anulado && c.seg !== null; });
  vivos.sort(function (a, b) { return a.seg - b.seg; });
  return {
    comprobantes: vivos, anulados: anulados, sinHora: sinHora,
    estrategia: comps.length ? 'registros' : null, avisos: avisos
  };
}

function etiqueta(c) {
  if (c.serie && c.num) return (c.tipo ? c.tipo + ' ' : '') + c.serie + '-' + c.num;
  return c.tipo || 'comprobante';
}

// ── Emparejador voraz cronologico ───────────────────────────────────
//  Ventanas monotonas (mismo ancho para todos) => el puntero avanza y
//  nunca retrocede: O(n+m) tras ordenar, y es el emparejamiento OPTIMO
//  (tomar la apertura libre mas temprana dentro de la ventana nunca
//  perjudica a un evento posterior).
function emparejar(aperturas, eventos, antes, despues) {
  var pares = [], sinApertura = [], libres = [];
  var p = 0;
  for (var i = 0; i < eventos.length; i++) {
    var ev  = eventos[i];
    var ini = ev.seg - antes, fin = ev.seg + despues;
    while (p < aperturas.length && aperturas[p].seg < ini) { libres.push(aperturas[p]); p++; }
    if (p < aperturas.length && aperturas[p].seg <= fin) {
      pares.push({ evento: ev, apertura: aperturas[p], desfase: aperturas[p].seg - ev.seg });
      p++;
    } else {
      sinApertura.push(ev);
    }
  }
  while (p < aperturas.length) { libres.push(aperturas[p]); p++; }
  return { pares: pares, sinApertura: sinApertura, libres: libres };
}

// ── Cuadre completo ─────────────────────────────────────────────────
function cuadrar(opts) {
  var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  var cfg = Object.assign({}, TOL, opts.tol || {});

  var aperturas = (opts.aperturas || []).map(function (a, i) {
    var h = typeof a === 'string' ? a : a.hora;
    return { hora: h, seg: horaASeg(h), i: i, orig: a };
  }).filter(function (a) { return a.seg !== null; })
    .sort(function (a, b) { return a.seg - b.seg; });

  var comps = (opts.comprobantes || []).slice().sort(function (a, b) { return a.seg - b.seg; });

  var just = (opts.justificaciones || []).map(function (j) {
    var h = j.hora || (j.fecha ? new Date(j.fecha).toTimeString().slice(0, 8) : null);
    return { hora: h, seg: horaASeg(h), motivo: j.motivo || '', tipo: j.tipo || '', turno: j.turno || '' };
  }).filter(function (j) { return j.seg !== null; });

  // "registro" no abre gaveta fisicamente: opcionalmente no consume apertura
  var justIgnoradas = [];
  if (opts.ignorarTipoRegistro) {
    justIgnoradas = just.filter(function (j) { return j.tipo === 'registro'; });
    just = just.filter(function (j) { return j.tipo !== 'registro'; });
  }
  just.sort(function (a, b) { return a.seg - b.seg; });

  // Paso 1 — comprobantes
  var r1 = emparejar(aperturas, comps, cfg.compAntes, cfg.compDespues);
  // Paso 2 — justificaciones del empleado sobre lo que sobro
  var libresOrd = r1.libres.slice().sort(function (a, b) { return a.seg - b.seg; });
  var r2 = emparejar(libresOrd, just, cfg.empAntes, cfg.empDespues);

  // Paso 3 — marcar posibles reimpresiones entre las huerfanas.
  //  Busca el comprobante YA emparejado inmediatamente anterior. Ambas listas
  //  vienen ordenadas por segundo, asi que un solo puntero basta: O(n+m).
  //  (La version ingenua recorria todos los pares por cada huerfana: O(n*m),
  //   250M de operaciones con 50k comprobantes.)
  var detectar = opts.detectarReimpresiones !== false;
  var q = 0, previo = null;
  var huerfanas = r2.libres.map(function (a) {
    var out = { hora: a.hora, seg: a.seg, orig: a.orig, posibleReimpresion: null };
    if (detectar) {
      while (q < r1.pares.length && r1.pares[q].evento.seg <= a.seg) { previo = r1.pares[q].evento; q++; }
      if (previo && (a.seg - previo.seg) <= cfg.reimprMax) {
        out.posibleReimpresion = { doc: etiqueta(previo), hora: previo.hora, desfase: a.seg - previo.seg };
      }
    }
    return out;
  });

  var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    porComprobante:             r1.pares,
    porEmpleado:                r2.pares,
    aperturasSinJustificar:     huerfanas,
    comprobantesSinApertura:    r1.sinApertura,
    justificacionesSinApertura: r2.sinApertura,
    justificacionesIgnoradas:   justIgnoradas,
    totales: {
      aperturas:       aperturas.length,
      comprobantes:    comps.length,
      justificaciones: just.length,
      explicadas:      r1.pares.length + r2.pares.length,
      huerfanas:       huerfanas.length
    },
    cuadra: huerfanas.length === 0 && r1.sinApertura.length === 0 && r2.sinApertura.length === 0,
    ms: t1 - t0,
    cfg: cfg
  };
}

return {
  horaASeg: horaASeg, segAHora: segAHora, desfaseTxt: desfaseTxt, etiqueta: etiqueta,
  parsearComprobantes: parsearComprobantes, emparejar: emparejar, cuadrar: cuadrar, TOL: TOL
};
}));
