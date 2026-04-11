# Crea un acceso directo en el Escritorio que abre el widget de Yapes
# siempre visible (por encima de todas las ventanas), tamaño compacto

$scriptDir    = "C:\Users\Che plas\PROGRAMA-CAJA"
$launcherPath = "$scriptDir\lanzar-yapes.ps1"

$desktop  = [System.Environment]::GetFolderPath("Desktop")
$shortcut = "$desktop\Yapes - Che plaS.lnk"

$shell = New-Object -ComObject WScript.Shell
$lnk   = $shell.CreateShortcut($shortcut)

$lnk.TargetPath       = "powershell.exe"
$lnk.Arguments        = "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""
$lnk.WorkingDirectory = $scriptDir
$lnk.Description      = "Widget de Yapes - Che plaS (siempre visible)"
$lnk.WindowStyle      = 7   # 7 = minimized/hidden (no flash de consola)
$lnk.Save()

Write-Host ""
Write-Host "Acceso directo creado:" -ForegroundColor Green
Write-Host "  '$shortcut'" -ForegroundColor Cyan
Write-Host ""
Write-Host "El widget se abrira siempre en la esquina inferior derecha" -ForegroundColor White
Write-Host "y se mantendra sobre todas las demas ventanas." -ForegroundColor White
Write-Host ""
pause
