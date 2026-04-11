# Busca la ventana "Yapes" abierta y le aplica HWND_TOPMOST.
# Llamado desde cheplas://topmost via el boton de la webapp.
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

# Esperar hasta 3s a que la ventana aparezca (puede estar cargando)
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 10; $i++) {
    $hwnd = [Win32]::FindByTitle("Yapes")
    if ($hwnd -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 300
}

if ($hwnd -ne [IntPtr]::Zero) {
    [Win32]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 3)  # TOPMOST + NOMOVE + NOSIZE
    [Win32]::SetForegroundWindow($hwnd)
}
