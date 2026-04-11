$widgetPath  = "file:///C:/Users/Che%20plas/PROGRAMA-CAJA/yapes-widget.html"
$profileDir  = "C:\Users\Che plas\PROGRAMA-CAJA\.widget-data"
$W = 200; $H = 90   # tamano completo de la ventana OS (incluye barra de titulo)

$bravePaths = @(
    "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    "C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
)
$brave = $null
foreach ($p in $bravePaths) { if (Test-Path $p) { $brave = $p; break } }
if (-not $brave) { exit 1 }

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr ins, int x, int y, int cx, int cy, uint f);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
    public static IntPtr FindByTitle(string text) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, lp) => {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            if (sb.ToString().Contains(text)) { found = hWnd; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$x = $screen.Left + 10
$y = $screen.Bottom - $H - 10

# Si ya esta abierto, traerlo al frente
$existing = [Win32]::FindByTitle("Yapes")
if ($existing -ne [IntPtr]::Zero) {
    [Win32]::ShowWindow($existing, 9)
    [Win32]::SetWindowPos($existing, [IntPtr](-1), $x, $y, $W, $H, 0)
    [Win32]::SetForegroundWindow($existing)
    exit
}

# Perfil dedicado: Brave no mezcla estado con el navegador principal.
# --window-size se respeta en perfiles sin historial de tamano guardado.
Start-Process $brave -ArgumentList "--app=`"$widgetPath`" --user-data-dir=`"$profileDir`" --window-size=$W,$H --no-first-run --no-default-browser-check"

# Esperar ventana
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 300
    $hwnd = [Win32]::FindByTitle("Yapes")
    if ($hwnd -ne [IntPtr]::Zero) { break }
}
if ($hwnd -eq [IntPtr]::Zero) { exit }

# Forzar tamano + posicion + siempre visible durante 3s
# (por si el perfil tenia estado previo maximizado)
$deadline = (Get-Date).AddSeconds(3)
while ((Get-Date) -lt $deadline) {
    [Win32]::SetWindowPos($hwnd, [IntPtr](-1), $x, $y, $W, $H, 0)
    Start-Sleep -Milliseconds 80
}
[Win32]::SetForegroundWindow($hwnd)
