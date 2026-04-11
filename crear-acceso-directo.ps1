# Crea el acceso directo del widget de Yapes en el Escritorio.
# Usa lanzar-yapes.vbs para abrir sin ninguna ventana de consola.

$scriptDir = "C:\Users\Che plas\PROGRAMA-CAJA"
$vbsPath   = "$scriptDir\lanzar-yapes.vbs"
$desktop   = [System.Environment]::GetFolderPath("Desktop")
$shortcut  = "$desktop\Yapes - Che plaS.lnk"

$shell = New-Object -ComObject WScript.Shell
$lnk   = $shell.CreateShortcut($shortcut)

$lnk.TargetPath       = "wscript.exe"
$lnk.Arguments        = "`"$vbsPath`""
$lnk.WorkingDirectory = $scriptDir
$lnk.Description      = "Widget de Yapes - Che plaS"
$lnk.Save()

Write-Host "Acceso directo creado: $shortcut" -ForegroundColor Green
pause
