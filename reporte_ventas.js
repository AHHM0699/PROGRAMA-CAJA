// ═══════════════════════════════════════════════════════════
//  REPORTE DIARIO DE VENTAS + CONTROL DE CAJA — CHE PLAST
//  1. Ejecuta REPORTE CAJA.bat  (copia tiempos al portapapeles)
//  2. Ve al SAS y ejecuta este bookmarklet
// ═══════════════════════════════════════════════════════════
(function () {

  var URL_DESTINO = 'https://cheplast.organizatic.com/principal#/reportes/ventas';

  // 1. Leer portapapeles y guardar en localStorage (misma sesión/dominio)
  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(function (texto) {
      try {
        var parsed = JSON.parse(texto);
        if (Array.isArray(parsed) && parsed.length > 0 && /^\d{2}:\d{2}:\d{2}$/.test(parsed[0])) {
          localStorage.setItem('caja_hoy_data', texto);
        }
      } catch (e) { /* no era JSON de caja */ }
    }).catch(function () { /* sin permiso */ });
  }

  // 2. Abrir nueva ventana
  var nueva = window.open(URL_DESTINO, 'ReporteVentas', 'width=1440,height=900,resizable=yes,scrollbars=yes');

  if (!nueva) {
    alert('Ventana bloqueada por el navegador.\nPermite ventanas emergentes para este sitio e intenta de nuevo.');
    return;
  }

  nueva.focus();

  // 3. Esperar que Vue renderice el formulario
  var intentos = 0;
  var formularioListo = false;
  var esperar = setInterval(function () {
    intentos++;
    try {
      var inputsFecha = Array.from(nueva.document.querySelectorAll('input'))
        .filter(function (i) { return /^\d{4}-\d{2}-\d{2}$/.test(i.value); });

      if (inputsFecha.length >= 2 && !formularioListo) {
        formularioListo = true;
        clearInterval(esperar);
        var s = nueva.document.createElement('script');
        s.textContent = '(' + ejecutar.toString() + ')()';
        nueva.document.head.appendChild(s);
      }
    } catch (e) {
      clearInterval(esperar);
      alert('Error: el bookmarklet debe usarse desde una pestaña de cheplast.organizatic.com.');
    }
    if (intentos >= 40) {
      clearInterval(esperar);
      alert('La ventana tardó demasiado en cargar. Intenta de nuevo.');
    }
  }, 500);

  // ─────────────────────────────────────────────────────────
  // ejecutar() es autocontenida — se serializa e inyecta en
  // la nueva ventana. NO puede referenciar variables externas.
  // ─────────────────────────────────────────────────────────
  function ejecutar() {

    // Fecha de hoy en hora peruana (UTC-5)
    var ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
    var yyyy  = ahora.getFullYear();
    var mm    = String(ahora.getMonth() + 1).padStart(2, '0');
    var dd    = String(ahora.getDate()).padStart(2, '0');
    var HOY   = yyyy + '-' + mm + '-' + dd;

    function llenarInput(el, valor) {
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, valor);
      ['input', 'change', 'blur'].forEach(function (t) {
        el.dispatchEvent(new Event(t, { bubbles: true }));
      });
    }

    var inputsFecha = Array.from(document.querySelectorAll('input'))
      .filter(function (i) { return /^\d{4}-\d{2}-\d{2}$/.test(i.value); });

    if (inputsFecha.length < 2) {
      alert('No encontré los campos de fecha. Recarga e intenta de nuevo.');
      return;
    }
    llenarInput(inputsFecha[0], HOY);
    llenarInput(inputsFecha[1], HOY);

    Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .filter(function (cb) {
        var lbl = cb.closest('label') || cb.parentElement || {};
        return lbl.textContent && lbl.textContent.toLowerCase().includes('eliminad');
      })
      .forEach(function (cb) { if (!cb.checked) cb.click(); });

    var btnProcesar = Array.from(document.querySelectorAll('button'))
      .find(function (b) { return b.textContent.trim() === 'Procesar'; });

    if (!btnProcesar) { alert('No encontré el botón Procesar.'); return; }
    btnProcesar.click();

    var intentos = 0;
    var esperar = setInterval(function () {
      var tbody = document.querySelector('table tbody');
      var filas = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];

      if (filas.length > 0) {
        clearInterval(esperar);
        procesarResultados(filas, HOY);
      }
      if (++intentos >= 20) {
        clearInterval(esperar);
        alert('Tiempo de espera agotado. Revisa si los resultados cargaron.');
      }
    }, 500);

    // ── Helpers ──────────────────────────────────────────────
    function timeToSec(t) {
      var p = t.split(':').map(Number);
      return p[0] * 3600 + p[1] * 60 + (p[2] || 0);
    }

    // ── Procesar filas del SAS ────────────────────────────────
    function procesarResultados(filas, fecha) {
      var conteo     = { FACTURA: 0, BOLETA: 0, NOTA: 0, OTRO: 0 };
      var eliminados = [];
      var docTimes   = []; // horas de cada documento si el SAS las muestra

      filas.forEach(function (fila) {
        var texto  = fila.textContent.toUpperCase();
        var celdas = Array.from(fila.querySelectorAll('td')).map(function (c) { return c.textContent.trim(); });

        var esEliminado =
          fila.classList.contains('table-danger')  ||
          fila.classList.contains('eliminado')      ||
          fila.classList.contains('deleted')        ||
          (fila.style && fila.style.textDecoration.includes('line-through')) ||
          texto.includes('ELIMINAD') ||
          texto.includes('ANULAD');

        if (esEliminado) {
          eliminados.push(celdas.slice(0, 5).join(' | '));
        } else {
          if      (texto.includes('FACTURA')) conteo.FACTURA++;
          else if (texto.includes('BOLETA'))  conteo.BOLETA++;
          else if (texto.includes('NOTA'))    conteo.NOTA++;
          else                                conteo.OTRO++;

          // Detectar columna de hora si existe (HH:mm o HH:mm:ss)
          celdas.forEach(function (c) {
            if (/^\d{2}:\d{2}(:\d{2})?$/.test(c)) {
              docTimes.push(c);
            }
            // Detectar datetime: "2026-03-26 14:30:00"
            var dtMatch = c.match(/\d{4}-\d{2}-\d{2}[T\s](\d{2}:\d{2}(:\d{2})?)/);
            if (dtMatch) docTimes.push(dtMatch[1]);
          });
        }
      });

      var totalDocs = conteo.FACTURA + conteo.BOLETA + conteo.NOTA + conteo.OTRO;

      // ── Leer datos de caja desde localStorage del opener ──
      var cajaTimes = [];
      try {
        var raw = window.opener && window.opener.localStorage.getItem('caja_hoy_data');
        if (raw) cajaTimes = JSON.parse(raw);
      } catch (e) { }

      mostrarPanel(conteo, totalDocs, eliminados, cajaTimes, docTimes, fecha);

      // Enviar datos al opener (PROGRAMA-CAJA) si existe
      if (window.opener && !window.opener.closed) {
        var docsPayload = [];
        filas.forEach(function(fila) {
          var texto  = fila.textContent.toUpperCase();
          var celdas = Array.from(fila.querySelectorAll('td')).map(function(c){ return c.textContent.trim(); });
          var esElim = fila.classList.contains('table-danger') || fila.classList.contains('eliminado') ||
            fila.classList.contains('deleted') || (fila.style && fila.style.textDecoration.includes('line-through')) ||
            texto.includes('ELIMINAD') || texto.includes('ANULAD');
          var hora = null;
          celdas.forEach(function(c) {
            if (/^\d{2}:\d{2}(:\d{2})?$/.test(c)) hora = c;
            var dtm = c.match(/\d{4}-\d{2}-\d{2}[T\s](\d{2}:\d{2}(:\d{2})?)/);
            if (dtm) hora = dtm[1];
          });
          var tipo = texto.includes('FACTURA') ? 'FACTURA' : texto.includes('BOLETA') ? 'BOLETA' :
            texto.includes('NOTA') ? 'NOTA' : 'OTRO';
          if (esElim) {
            docsPayload.push({ eliminado: true, texto: celdas.slice(0,5).join(' | '), hora: hora });
          } else {
            docsPayload.push({ eliminado: false, tipo: tipo, hora: hora });
          }
        });
        window.opener.postMessage({
          type: 'sasReportData',
          payload: {
            ok:    true,
            fecha: fecha,
            docs:  docsPayload.filter(function(d){ return !d.eliminado; }),
            elim:  docsPayload.filter(function(d){ return d.eliminado; })
          }
        }, '*');
      }
    }

    // ── Comparar caja con documentos ─────────────────────────
    function compararCaja(cajaTimes, docTimes, totalDocs) {
      if (cajaTimes.length === 0) return null;

      if (docTimes.length > 0) {
        // Comparación exacta ±60 segundos
        var usadas  = new Array(docTimes.length).fill(false);
        var sinMatch = [];

        cajaTimes.forEach(function (ct) {
          var ctSec   = timeToSec(ct);
          var matched = false;
          for (var i = 0; i < docTimes.length; i++) {
            if (usadas[i]) continue;
            if (Math.abs(ctSec - timeToSec(docTimes[i])) <= 300) {
              usadas[i] = true;
              matched   = true;
              break;
            }
          }
          if (!matched) sinMatch.push(ct);
        });

        return { modo: 'tiempo', sinMatch: sinMatch };

      } else {
        // Sin horas en SAS: comparación por conteo
        var extras = cajaTimes.length - totalDocs;
        return { modo: 'conteo', extras: extras };
      }
    }

    // ── Panel flotante ────────────────────────────────────────
    function mostrarPanel(conteo, totalDocs, eliminados, cajaTimes, docTimes, fecha) {
      var viejo = document.getElementById('__reporte_cheplast__');
      if (viejo) viejo.remove();

      var caja    = compararCaja(cajaTimes, docTimes, totalDocs);
      var htmlCaja = '';

      if (!caja) {
        htmlCaja = '<div style="margin-top:12px;padding:10px;background:#f5f5f5;border-radius:6px;font-size:12px;color:#999">'
          + '&#128274; Sin datos de caja. Ejecuta <b>REPORTE CAJA.bat</b> antes de este bookmarklet.'
          + '</div>';

      } else if (caja.modo === 'tiempo') {
        var color = caja.sinMatch.length > 0 ? '#e74c3c' : '#27ae60';
        htmlCaja = '<hr style="margin:12px 0;border-color:#eee">'
          + '<p style="margin:5px 0;font-size:13px"><b>&#128179; Aperturas de caja hoy: ' + cajaTimes.length + '</b>'
          + ' &nbsp;<span style="color:#777;font-weight:normal;font-size:12px">/ Documentos: ' + totalDocs + '</span></p>';

        if (caja.sinMatch.length === 0) {
          htmlCaja += '<p style="color:#27ae60;margin:4px 0;font-size:13px">&#10004; Todas las aperturas tienen comprobante asociado.</p>';
        } else {
          htmlCaja += '<p style="color:#e74c3c;font-weight:bold;margin:6px 0;font-size:13px">&#10060; '
            + caja.sinMatch.length + ' apertura(s) SIN comprobante (±300 seg):</p>'
            + '<ol style="margin:4px 0;padding-left:20px;color:#c0392b;font-size:13px">';
          caja.sinMatch.forEach(function (t) { htmlCaja += '<li>' + t + '</li>'; });
          htmlCaja += '</ol>';
        }

      } else {
        // modo conteo
        htmlCaja = '<hr style="margin:12px 0;border-color:#eee">'
          + '<p style="margin:5px 0;font-size:13px"><b>&#128179; Aperturas de caja hoy: ' + cajaTimes.length + '</b>'
          + ' &nbsp;<span style="color:#777;font-weight:normal;font-size:12px">/ Documentos: ' + totalDocs + '</span></p>';

        if (caja.extras <= 0) {
          htmlCaja += '<p style="color:#27ae60;margin:4px 0;font-size:13px">&#10004; Las aperturas coinciden con los documentos.</p>';
        } else {
          htmlCaja += '<p style="color:#e67e22;font-weight:bold;margin:6px 0;font-size:13px">&#9888; '
            + caja.extras + ' apertura(s) posiblemente sin comprobante.</p>'
            + '<p style="font-size:11px;color:#999;margin:2px 0">El SAS no muestra hora por documento. Con hora exacta la comparacion seria mas precisa.</p>';
        }
      }

      // HTML del panel
      var panel = document.createElement('div');
      panel.id  = '__reporte_cheplast__';
      panel.style.cssText = [
        'position:fixed', 'top:15px', 'right:15px', 'z-index:999999',
        'background:#fff', 'border:2px solid #2c3e50', 'border-radius:10px',
        'padding:18px 22px', 'width:440px', 'max-height:80vh', 'overflow-y:auto',
        'box-shadow:0 6px 30px rgba(0,0,0,.35)',
        'font-family:Arial,sans-serif', 'font-size:13px', 'color:#222'
      ].join(';');

      var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'
        + '<b style="font-size:15px">&#128202; Reporte de Ventas &mdash; ' + fecha + '</b>'
        + '<button onclick="document.getElementById(\'__reporte_cheplast__\').remove()" '
        + 'style="background:#e74c3c;color:#fff;border:none;border-radius:4px;padding:3px 9px;cursor:pointer;font-weight:bold">&#x2715;</button>'
        + '</div>'
        + '<hr style="margin:0 0 10px;border-color:#ddd">'
        + '<p style="margin:5px 0;font-size:14px"><b>&#9989; Total documentos emitidos: ' + totalDocs + '</b></p>'
        + '<ul style="margin:5px 0 10px;padding-left:22px;color:#2c3e50">';

      if (conteo.FACTURA) html += '<li>Facturas: <b>' + conteo.FACTURA + '</b></li>';
      if (conteo.BOLETA)  html += '<li>Boletas:  <b>' + conteo.BOLETA  + '</b></li>';
      if (conteo.NOTA)    html += '<li>Notas:    <b>' + conteo.NOTA    + '</b></li>';
      if (conteo.OTRO)    html += '<li>Otros:    <b>' + conteo.OTRO    + '</b></li>';

      html += '</ul>'
        + '<hr style="margin:0 0 10px;border-color:#ddd">'
        + '<p style="margin:5px 0;font-size:14px"><b>&#10060; Documentos eliminados: ' + eliminados.length + '</b></p>';

      if (eliminados.length > 0) {
        html += '<ol style="margin:6px 0;padding-left:20px;color:#c0392b">';
        eliminados.forEach(function (e) { html += '<li style="margin-bottom:4px">' + e + '</li>'; });
        html += '</ol>';
      } else {
        html += '<p style="color:#27ae60;margin:5px 0">&#10004; Ningún documento eliminado hoy.</p>';
      }

      html += htmlCaja;
      panel.innerHTML = html;
      document.body.appendChild(panel);
    }

  } // fin ejecutar()

})();
