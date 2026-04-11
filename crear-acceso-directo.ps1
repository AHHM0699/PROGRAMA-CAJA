# Configura el widget de Yapes:
#  1. Genera yapes.ico desde el logo real de Che plaS (sin marca de agua)
#  2. Registra el protocolo cheplas:// para abrir el widget desde la web
#  3. Crea acceso directo en el Escritorio

$scriptDir = "C:\Users\Che plas\PROGRAMA-CAJA"
$logoSrc   = "C:\Users\Che plas\OneDrive\CHE PLAST\CAJAS CHE\LOGO CAJA.png"
$iconPath  = "$scriptDir\yapes.ico"
$vbsPath   = "$scriptDir\lanzar-yapes.vbs"

# ── 1. Generar yapes.ico desde el logo real ────────────────────────────────
Add-Type -AssemblyName System.Drawing

$orig = [System.Drawing.Image]::FromFile($logoSrc)
$bmp  = New-Object System.Drawing.Bitmap($orig)
$orig.Dispose()

# Borrar marca de agua (esquina inferior derecha, fondo negro)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$wm = [int]($bmp.Width * 0.83)
$hm = [int]($bmp.Height * 0.83)
$g.FillRectangle([System.Drawing.Brushes]::Black, $wm, $hm, $bmp.Width - $wm, $bmp.Height - $hm)
$g.Dispose()

# Escalar a 256x256 para el .ico
$icon256 = New-Object System.Drawing.Bitmap($bmp, 256, 256)
$hIcon   = $icon256.GetHicon()
$icon    = [System.Drawing.Icon]::FromHandle($hIcon)
$fs      = New-Object System.IO.FileStream($iconPath, [System.IO.FileMode]::Create)
$icon.Save($fs)
$fs.Close()
$icon.Dispose(); $icon256.Dispose(); $bmp.Dispose()

Write-Host "Icono creado: $iconPath" -ForegroundColor Green

# ── 2. Registrar protocolo cheplas:// ─────────────────────────────────────
# Esto permite que el boton de la web llame window.location.href='cheplas://yapes'
# y lance el widget con HWND_TOPMOST sin ventana de consola.
$cmd = "`"wscript.exe`" `"$vbsPath`" `"%1`""

$base = "HKCU:\SOFTWARE\Classes\cheplas"
New-Item -Path $base -Force | Out-Null
Set-ItemProperty -Path $base -Name "(Default)"    -Value "URL:Che plaS Widget"
Set-ItemProperty -Path $base -Name "URL Protocol" -Value ""
New-Item -Path "$base\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$base\DefaultIcon" -Name "(Default)" -Value $iconPath
New-Item -Path "$base\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$base\shell\open\command" -Name "(Default)" -Value $cmd

Write-Host "Protocolo cheplas:// registrado" -ForegroundColor Green

# Registrar tambien cheplas://topmost → setTopmost-yapes.vbs
# Usado por el boton de la webapp para hacer la ventana siempre visible
$topmostVbs = "$scriptDir\setTopmost-yapes.vbs"
$base2 = "HKCU:\SOFTWARE\Classes\cheplastopmost"
New-Item -Path $base2 -Force | Out-Null
Set-ItemProperty -Path $base2 -Name "(Default)"    -Value "URL:Che plaS Topmost"
Set-ItemProperty -Path $base2 -Name "URL Protocol" -Value ""
New-Item -Path "$base2\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$base2\shell\open\command" -Name "(Default)" -Value "`"wscript.exe`" `"$topmostVbs`" `"%1`""

Write-Host "Protocolo cheplastopmost:// registrado" -ForegroundColor Green

# ── 3. Crear acceso directo en el Escritorio ───────────────────────────────
$desktop  = [System.Environment]::GetFolderPath("Desktop")
$shortcut = "$desktop\Yapes - Che plaS.lnk"
$shell    = New-Object -ComObject WScript.Shell
$lnk      = $shell.CreateShortcut($shortcut)
$lnk.TargetPath       = "wscript.exe"
$lnk.Arguments        = "`"$vbsPath`""
$lnk.WorkingDirectory = $scriptDir
$lnk.IconLocation     = "$iconPath,0"
$lnk.Description      = "Widget de Yapes - Che plaS"
$lnk.Save()

Write-Host "Acceso directo creado en el Escritorio" -ForegroundColor Green
Write-Host ""
Write-Host "La primera vez que uses el boton de la web," -ForegroundColor Yellow
Write-Host "Brave preguntara si permitir 'cheplas://'. Marca 'Siempre permitir'." -ForegroundColor Yellow
Write-Host ""
pause
