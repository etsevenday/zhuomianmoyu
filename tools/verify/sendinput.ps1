# 验收脚本用的系统层面输入发送器（B5）：从标准输入一行读一条命令，往标准输出回一行 JSON。
# 文件存成带 BOM 的 UTF-8：Windows PowerShell 5.1 读不带 BOM 的脚本按系统编码（GBK），中文会乱。
# 用 Windows SendInput / SetCursorPos 发真实的系统输入，和用户自己按键、点鼠标走同一条路（Raw Input 收得到、前台程序收得到）。
# 安全：发键前逐个确认前台是调用方指定的窗口，点击、拖动前确认那一点上是调用方指定的窗口，不是就停下报错，
# 不会往别的软件里打字或点击。
#
# 命令：
#   notepad                 开一个记事本，回 { hwnd, pid }
#   kill <pid>              结束进程
#   fg                      当前前台窗口（顶层）
#   focus <hwnd>            让它到前台
#   move <hwnd> x y w h     摆窗口（物理像素）
#   text <hwnd>             记事本里的字数
#   keys <hwnd> <n>         前台是 hwnd 时按 n 次 1（按下、松开）
#   hold <hwnd> <n>         按住 1：连续 n 次按下（和键盘自动连发一样），再松开
#   combo <hwnd>            Shift 按住、按 1、松开 Shift
#   point x y                       只把指针挪到 (x, y)，不点。用 SendInput 发真实的移动（SetCursorPos 不算输入，
#                                   小窗收不到转发的移动、不会按指针位置切穿透）
#   click <hwnd> x y [left|middle]  (x, y) 上是 hwnd 时，指针移过去点一次
#   drag <hwnd> x y dx dy           (x, y) 上是 hwnd 时，按下左键，挪 (dx, dy) 后松开
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Si {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l, t, r, b; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool on);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint type);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr p, IntPtr after, string cls, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  public static void MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    var i = new INPUT { type = 0 };
    i.u.mi = new MOUSEINPUT { dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1)), dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1)), dwFlags = 0x0001 | 0x8000 | 0x4000 };
    SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
    SetCursorPos(x, y);
  }
  public static IntPtr At(int x, int y) { return GetAncestor(WindowFromPoint(new POINT { x = x, y = y }), 2); }
  public static IntPtr Fg() { return GetAncestor(GetForegroundWindow(), 2); }
  public static void Key(ushort vk, bool up) {
    var i = new INPUT { type = 1 };
    i.u.ki = new KEYBDINPUT { wVk = vk, wScan = (ushort)MapVirtualKeyW(vk, 0), dwFlags = up ? 2u : 0u };
    SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Button(uint flags) {
    var i = new INPUT { type = 0 };
    i.u.mi = new MOUSEINPUT { dwFlags = flags };
    SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static bool Focus(IntPtr h) {
    uint mine = GetCurrentThreadId(), theirs = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    AttachThreadInput(mine, theirs, true);
    ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h);
    AttachThreadInput(mine, theirs, false);
    return Fg() == h;
  }
  public static int TextLength(IntPtr h) {
    var edit = FindWindowExW(h, IntPtr.Zero, "Edit", null);
    if (edit == IntPtr.Zero) edit = FindWindowExW(h, IntPtr.Zero, "RichEditD2DPT", null);
    return edit == IntPtr.Zero ? -1 : (int)SendMessageW(edit, 0x000E, IntPtr.Zero, IntPtr.Zero); // WM_GETTEXTLENGTH
  }
}
'@
[Si]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Reply($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function Guard([IntPtr]$h) { if ([Si]::Fg() -ne $h) { throw "前台不是指定窗口（前台 $([Si]::Fg())，要求 $h），停止发键" } }
function GuardAt([IntPtr]$h, $x, $y) { if ([Si]::At($x, $y) -ne $h) { throw "($x, $y) 上不是指定窗口（是 $([Si]::At($x, $y))，要求 $h），停止点击" } }
$VK_1 = 0x31; $VK_SHIFT = 0x10  # 数字 1：中文输入法不拦（不在组字时直接上屏），字母会进拼音组字
$down = @{ left = 0x2; middle = 0x20 }; $up = @{ left = 0x4; middle = 0x40 }

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $a = $line.Trim() -split '\s+'
  try {
    switch ($a[0]) {
      'notepad' {
        $p = Start-Process (Join-Path $env:windir 'system32\notepad.exe') -PassThru
        for ($i = 0; $i -lt 100 -and $p.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 100; $p.Refresh() }
        Reply @{ ok = $true; hwnd = [long]$p.MainWindowHandle; pid = $p.Id }
      }
      'kill' { Stop-Process -Id ([int]$a[1]) -Force -ErrorAction SilentlyContinue; Reply @{ ok = $true } }
      'fg' { Reply @{ ok = $true; hwnd = [long][Si]::Fg() } }
      'focus' { $ok = [Si]::Focus([IntPtr][long]$a[1]); Start-Sleep -Milliseconds 150; Reply @{ ok = ([Si]::Fg() -eq [IntPtr][long]$a[1]) } }
      'move' { [Si]::MoveWindow([IntPtr][long]$a[1], [int]$a[2], [int]$a[3], [int]$a[4], [int]$a[5], $true) | Out-Null; Reply @{ ok = $true } }
      'text' { Reply @{ ok = $true; length = [Si]::TextLength([IntPtr][long]$a[1]) } }
      'keys' {
        $h = [IntPtr][long]$a[1]
        for ($i = 0; $i -lt [int]$a[2]; $i++) { Guard $h; [Si]::Key($VK_1, $false); [Si]::Key($VK_1, $true); Start-Sleep -Milliseconds 10 }
        Reply @{ ok = $true }
      }
      'hold' {
        $h = [IntPtr][long]$a[1]
        for ($i = 0; $i -lt [int]$a[2]; $i++) { Guard $h; [Si]::Key($VK_1, $false); Start-Sleep -Milliseconds 30 }
        [Si]::Key($VK_1, $true)
        Reply @{ ok = $true }
      }
      'combo' {
        $h = [IntPtr][long]$a[1]; Guard $h
        [Si]::Key($VK_SHIFT, $false); [Si]::Key($VK_1, $false); [Si]::Key($VK_1, $true); [Si]::Key($VK_SHIFT, $true)
        Reply @{ ok = $true }
      }
      'point' { [Si]::MoveTo([int]$a[1], [int]$a[2]); Reply @{ ok = $true } }
      'click' {
        $x = [int]$a[2]; $y = [int]$a[3]; GuardAt ([IntPtr][long]$a[1]) $x $y
        $b = if ($a.Length -gt 4) { $a[4] } else { 'left' }
        [Si]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 60
        [Si]::Button($down[$b]); Start-Sleep -Milliseconds 40; [Si]::Button($up[$b]); Start-Sleep -Milliseconds 60
        Reply @{ ok = $true }
      }
      'drag' {
        $x = [int]$a[2]; $y = [int]$a[3]; $dx = [int]$a[4]; $dy = [int]$a[5]; GuardAt ([IntPtr][long]$a[1]) $x $y
        [Si]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 60
        [Si]::Button(0x2)
        for ($i = 1; $i -le 8; $i++) { Start-Sleep -Milliseconds 20; [Si]::SetCursorPos($x + [int]($dx * $i / 8), $y + [int]($dy * $i / 8)) | Out-Null }
        Start-Sleep -Milliseconds 40; [Si]::Button(0x4); Start-Sleep -Milliseconds 60
        Reply @{ ok = $true }
      }
      default { Reply @{ ok = $false; error = "不认识的命令 $($a[0])" } }
    }
  } catch { Reply @{ ok = $false; error = "$_" } }
}
