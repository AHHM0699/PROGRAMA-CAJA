// Autoriza a camara.js a subir videos a Google Drive (se hace UNA vez).
// Uso (en Termux):  cd ~/servidor-caja && node autorizar-drive.js
//
// Permiso pedido: drive.file — solo los archivos que crea este programa;
// no puede ver ni borrar nada más del Drive.
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^﻿/, ''));
const { clientId, clientSecret } = CONFIG.drive || {};
if (!clientId || !clientSecret) {
  console.log('Falta "drive": { "clientId", "clientSecret" } en config.json');
  process.exit(1);
}

const verifier  = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url, 'http://127.0.0.1');
  const code = url.searchParams.get('code');
  if (!code) { res.end(url.searchParams.get('error') || 'Sin código'); return; }
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect,
      grant_type: 'authorization_code', code_verifier: verifier
    })
  });
  const j = await r.json();
  if (!j.refresh_token) {
    res.end('Error: ' + JSON.stringify(j));
    console.log('Error:', j);
    process.exit(1);
  }
  fs.writeFileSync(path.join(__dirname, 'drive-token.json'),
    JSON.stringify({ refresh_token: j.refresh_token }), { mode: 0o600 });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h2>Listo. Drive autorizado; ya puedes volver a Termux.</h2>');
  console.log('Drive autorizado. Reinicia la cámara:  pkill -f camara.js');
  setTimeout(() => process.exit(0), 500);
});

server.listen(0, '127.0.0.1', () => {
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline', prompt: 'consent',
    code_challenge: challenge, code_challenge_method: 'S256'
  });
  console.log('Abre este enlace en el navegador DEL CELULAR y entra con tu Gmail:\n\n' + auth + '\n');
  execFile('termux-open-url', [auth], () => {});
});
