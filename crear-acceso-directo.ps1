# Crea icono + acceso directo del widget de Yapes en el Escritorio.

$scriptDir = "C:\Users\Che plas\PROGRAMA-CAJA"
$vbsPath   = "$scriptDir\lanzar-yapes.vbs"
$iconPath  = "$scriptDir\yapes.ico"

# ── Generar icono: circulo verde con Y blanca ──────────────────────────────
Add-Type -AssemblyName System.Drawing

$size = 64
$bmp  = New-Object System.Drawing.Bitmap($size, $size)
$g    = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint  = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Fondo transparente (ya viene en blanco por defecto, lo limpiar)
$g.Clear([System.Drawing.Color]::Transparent)

# Circulo verde
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle(0, 0, $size, $size)),
    [System.Drawing.Color]::FromArgb(22, 163, 74),
    [System.Drawing.Color]::FromArgb(20, 83, 45),
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal
)
$g.FillEllipse($grad, 2, 2, $size-4, $size-4)

# Borde sutil
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(80, 255, 255, 255), 1.5)
$g.DrawEllipse($pen, 3, 3, $size-6, $size-6)

# Letra Y blanca centrada
$font = New-Object System.Drawing.Font("Arial", 30, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf   = New-Object System.Drawing.StringFormat
$sf.Alignment     = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("Y", $font, [System.Drawing.Brushes]::White,
    [System.Drawing.RectangleF]::new(0, 2, $size, $size), $sf)

$g.Dispose()

# Guardar como .ico
$hIcon = $bmp.GetHicon()
$icon  = [System.Drawing.Icon]::FromHandle($hIcon)
$fs    = New-Object System.IO.FileStream($iconPath, [System.IO.FileMode]::Create)
$icon.Save($fs)
$fs.Close(); $icon.Dispose(); $bmp.Dispose()

Write-Host "Icono creado: $iconPath" -ForegroundColor Green

# ── Crear acceso directo ───────────────────────────────────────────────────
$desktop  = [System.Environment]::GetFolderPath("Desktop")
$shortcut = "$desktop\Yapes - Che plaS.lnk"

$shell = New-Object -ComObject WScript.Shell
$lnk   = $shell.CreateShortcut($shortcut)

$lnk.TargetPath       = "wscript.exe"
$lnk.Arguments        = "`"$vbsPath`""
$lnk.WorkingDirectory = $scriptDir
$lnk.IconLocation     = "$iconPath,0"
$lnk.Description      = "Widget de Yapes - Che plaS"
$lnk.Save()

Write-Host "Acceso directo creado: $shortcut" -ForegroundColor Green
Write-Host ""
pause
