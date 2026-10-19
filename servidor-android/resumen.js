// Resumen del día: aperturas de gaveta por causa e impresiones por celular.
// Uso:  node ~/servidor-caja/resumen.js [AAAA-MM-DD]
'use strict';

const fs   = require('fs');
const path = require('path');

const TZ    = 'America/Lima';
const fecha = process.argv[2] || new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
const DATA  = path.join(__dirname, 'data');

function leer(tipo) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, `${tipo}-${fecha}.json`), 'utf8')); }
  catch (e) { return []; }
}

const aperturas   = leer('aperturasFisicas');
const impresiones = leer('impresiones');

console.log(`\n=== ${fecha} ===`);
console.log(`\nAPERTURAS DE GAVETA: ${aperturas.length}  (esto es lo que recibe el Reporte de Caja)`);
const porCausa = {};
aperturas.forEach(a => { porCausa[a.causa] = (porCausa[a.causa] || 0) + 1; });
Object.entries(porCausa).forEach(([c, n]) => console.log(`  ${c.padEnd(16)} ${n}`));
console.log('');
aperturas.forEach(a => console.log(
  `  ${a.hora}  ${String(a.segundos).padStart(5)}s  ${a.causa}` +
  (a.origen ? ` [${a.origen}]` : '') + (a.motivo ? ` (${a.motivo})` : '')));

console.log(`\nIMPRESIONES: ${impresiones.length}`);
const porOrigen = {};
impresiones.forEach(i => {
  const o = porOrigen[i.origen] || (porOrigen[i.origen] = { n: 0, propia: 0, agregada: 0, no: 0 });
  o.n++;
  if (i.gaveta === 'propia') o.propia++;
  else if (i.gaveta && i.gaveta.startsWith('agregada')) o.agregada++;
  else o.no++;
});
Object.entries(porOrigen).forEach(([ip, o]) => console.log(
  `  ${ip.padEnd(15)} ${o.n} impresion(es) — gaveta propia ${o.propia}, agregada ${o.agregada}, sin dato ${o.no}`));
console.log('');
