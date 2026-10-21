#!/data/data/com.termux/files/usr/bin/bash
# Instala o actualiza el servidor de caja en Termux.
# Uso (dentro de Termux):  bash ~/servidor-android/instalar.sh
set -e

ORIGEN="$(cd "$(dirname "$0")" && pwd)"
DESTINO="$HOME/servidor-caja"

pkg update -y
pkg install -y nodejs-lts ffmpeg git

# firebase login: deja la sesión de Gmail que usa el servidor
command -v firebase >/dev/null || npm install -g firebase-tools

mkdir -p "$DESTINO"
cp "$ORIGEN/servidor.js" "$ORIGEN/camara.js" "$ORIGEN/autorizar-drive.js" "$ORIGEN/package.json" "$DESTINO/"
[ -f "$ORIGEN/config.json" ] && cp "$ORIGEN/config.json" "$DESTINO/"
cd "$DESTINO"
npm install --omit=dev

# Alertas por WhatsApp: carpeta y dependencias propias (no tocan las del servidor)
mkdir -p "$DESTINO/alertas"
cp "$ORIGEN/alertas/alertas.js" "$ORIGEN/alertas/package.json" "$DESTINO/alertas/"
(cd "$DESTINO/alertas" && npm install --omit=dev)

# Lanzador: mantiene el celular despierto y relanza el servidor si se cae
cat > "$DESTINO/arrancar.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd "$HOME/servidor-caja"
while true; do
  node servidor.js >> "$HOME/servidor-caja/servidor.log" 2>&1
  sleep 5
done
EOF
chmod +x "$DESTINO/arrancar.sh"

# Cámara: proceso aparte con su propio lanzador; si falla, la caja sigue
cat > "$DESTINO/arrancar-camara.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/servidor-caja"
while true; do
  node camara.js >> "$HOME/servidor-caja/camara.log" 2>&1
  sleep 10
done
EOF
chmod +x "$DESTINO/arrancar-camara.sh"

# Alertas: proceso aparte con su propio lanzador; si falla, la caja sigue
cat > "$DESTINO/arrancar-alertas.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/servidor-caja/alertas"
while true; do
  node alertas.js >> "$HOME/servidor-caja/alertas.log" 2>&1
  sleep 30
done
EOF
chmod +x "$DESTINO/arrancar-alertas.sh"

# Arranque automático: cada vez que se abre Termux (p. ej. tras reiniciar
# el celular) se lanza el servidor si no está corriendo.
MARCA="# servidor-caja: arranque automatico"
if ! grep -q "$MARCA" "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<EOF

$MARCA
pgrep -f servidor-caja/arrancar.sh >/dev/null || nohup "\$HOME/servidor-caja/arrancar.sh" >/dev/null 2>&1 &
EOF
fi
MARCA_CAM="# servidor-caja: camara"
if ! grep -q "$MARCA_CAM" "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<EOF
$MARCA_CAM
pgrep -f servidor-caja/arrancar-camara.sh >/dev/null || nohup "\$HOME/servidor-caja/arrancar-camara.sh" >/dev/null 2>&1 &
EOF
fi
MARCA_AL="# servidor-caja: alertas"
if ! grep -q "$MARCA_AL" "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<EOF
$MARCA_AL
pgrep -f servidor-caja/arrancar-alertas.sh >/dev/null || nohup "\$HOME/servidor-caja/arrancar-alertas.sh" >/dev/null 2>&1 &
EOF
fi

# Arranque al encender el celular, sin abrir Termux (Termux de Google Play
# trae Termux:Boot integrado: corre lo que haya en ~/.termux/boot).
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/servidor-caja.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
for s in arrancar arrancar-camara arrancar-alertas; do
  pgrep -f "servidor-caja/$s.sh" >/dev/null || nohup "$HOME/servidor-caja/$s.sh" >/dev/null 2>&1 &
done
EOF
chmod +x "$HOME/.termux/boot/servidor-caja.sh"

echo
echo "Instalado."
[ -f "$DESTINO/drive-token.json" ] || \
  echo "FALTA: autorizar Drive ->  cd ~/servidor-caja && node autorizar-drive.js"
echo "Ver la cámara:    tail -f ~/servidor-caja/camara.log"
[ -f "$DESTINO/alertas/whatsapp-sesion/creds.json" ] || \
  echo "FALTA: vincular WhatsApp ->  cd ~/servidor-caja/alertas && node alertas.js --vincular 51NUMERO_DEL_SAMSUNG"
echo "Ver las alertas:  tail -f ~/servidor-caja/alertas.log"
[ -f "$HOME/.config/configstore/firebase-tools.json" ] || \
  echo "FALTA: inicia sesión con tu Gmail ->  firebase login --no-localhost"
echo "Ver el registro:  tail -f ~/servidor-caja/servidor.log"
