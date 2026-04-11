# Crea un acceso directo en el Escritorio que abre el widget de Yapes
# como app independiente (sin barra de navegador)

$widgetPath = "file:///C:/Users/Che%20plas/PROGRAMA-CAJA/yapes-widget.html"

# Buscar Brave en ubicaciones comunes
$bravePaths = @(
    "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    "C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
)

$brave = $null
foreach ($p in $bravePaths) {
    if (Test-Path $p) { $brave = $p; break }
}

if (-not $brave) {
    Write-Host "No se encontro Brave. Buscando..." -ForegroundColor Yellow
    $brave = Get-Command brave -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
}

if (-not $brave) {
    Write-Host "ERROR: No se encontro Brave instalado." -ForegroundColor Red
    Write-Host "Instala Brave o edita la ruta en este script." -ForegroundColor Red
    pause
    exit 1
}

Write-Host "Brave encontrado en: $brave" -ForegroundColor Green

# Crear acceso directo en el Escritorio
$desktop    = [System.Environment]::GetFolderPath("Desktop")
$shortcut   = "$desktop\Yapes - Che plaS.lnk"
$shell      = New-Object -ComObject WScript.Shell
$lnk        = $shell.CreateShortcut($shortcut)

$lnk.TargetPath       = $brave
$lnk.Arguments        = "--app=`"$widgetPath`" --window-size=280,400"
$lnk.WorkingDirectory = Split-Path $brave
$lnk.Description      = "Widget de Yapes - Che plaS"
$lnk.Save()

Write-Host ""
Write-Host "Acceso directo creado en el Escritorio:" -ForegroundColor Green
Write-Host "  'Yapes - Che plaS.lnk'" -ForegroundColor Cyan
Write-Host ""
Write-Host "Abrelo desde el Escritorio. Puedes anclarlo a la barra de tareas." -ForegroundColor White
pause
