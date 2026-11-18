// 桌面摸鱼 PC 后台输入采集程序（B5）：外壳在"后台输入"开着时启动它，它只数"按下了一次键 / 点了一次鼠标"，一行一条告诉外壳。
//
// 用 Windows Raw Input（RIDEV_INPUTSINK：不在前台也收得到），不装钩子：不拦截、不改写任何输入，原输入照常给用户正在用的程序。
// 不取字符和键名，不记按了哪个键、点在哪、在哪个程序里，不写文件、不联网。标准输出只有三种行：
//   ready   开始接收了
//   k 0|1   键盘按下一次（自动连发不算，松开不算）；1 = 当时前台是小窗自己
//   c 0|1   鼠标点击一次（任一键按下到松开，移动不超过 5 个逻辑像素；超过算拖，不输出）；1 = 按下处是小窗自己
// 口径和网页版 play.js 一致（01 §1、评估请求 §4）。键是否按着只在内存里记到松开为止，只用来去掉自动连发。
//
// 用法：MoyuInput <小窗窗口句柄（十进制）>。外壳关掉标准输入（包括外壳退出）时本程序随之退出。
using System.Runtime.InteropServices;

namespace Moyu.PcInput;

internal static unsafe class Program
{
    const uint WM_INPUT = 0x00FF;
    const uint RID_INPUT = 0x10000003;
    const uint RIM_TYPEMOUSE = 0, RIM_TYPEKEYBOARD = 1;
    const uint RIDEV_INPUTSINK = 0x00000100;
    const ushort RI_KEY_BREAK = 1, RI_KEY_E0 = 2, RI_KEY_E1 = 4;
    const uint GA_ROOT = 2;
    const uint MONITOR_DEFAULTTONEAREST = 2;
    const double DRAG_THRESHOLD = 5; // 逻辑像素，和网页一致

    // 左、右、中、侧键 1、侧键 2 的按下 / 松开标志
    static readonly ushort[] Down = { 0x0001, 0x0004, 0x0010, 0x0040, 0x0100 };
    static readonly ushort[] Up = { 0x0002, 0x0008, 0x0020, 0x0080, 0x0200 };

    sealed class Press
    {
        public int X, Y;
        public bool Own, Moved;
        public double Limit; // 按下处这块屏的 5 个逻辑像素换成物理像素
    }

    static IntPtr own;
    static readonly HashSet<long> held = new();          // 正按着的键，松开就删
    static readonly Press?[] presses = new Press?[5];    // 每个鼠标键当前这次按下
    static readonly StreamWriter output = new(Console.OpenStandardOutput()) { AutoFlush = true, NewLine = "\n" };

    static int Main(string[] args)
    {
        if (args.Length < 1 || !long.TryParse(args[0], out var handle))
        {
            Console.Error.WriteLine("用法：MoyuInput <小窗窗口句柄>");
            return 2;
        }
        own = (IntPtr)handle;
        SetProcessDpiAwarenessContext(-4); // 每屏 DPI 感知：坐标、命中都按物理像素
        new Thread(WatchStdin) { IsBackground = true }.Start();

        var inst = GetModuleHandleW(null);
        var name = Marshal.StringToHGlobalUni("MoyuInputSink");
        var wc = new WNDCLASSEXW
        {
            cbSize = (uint)sizeof(WNDCLASSEXW),
            lpfnWndProc = (IntPtr)(delegate* unmanaged<IntPtr, uint, IntPtr, IntPtr, IntPtr>)&WndProc,
            hInstance = inst,
            lpszClassName = name,
        };
        if (RegisterClassExW(&wc) == 0) return Fail("RegisterClassEx");
        var hwnd = CreateWindowExW(0, name, IntPtr.Zero, 0, 0, 0, 0, 0, new IntPtr(-3) /* HWND_MESSAGE */, IntPtr.Zero, inst, IntPtr.Zero);
        if (hwnd == IntPtr.Zero) return Fail("CreateWindowEx");

        var devices = stackalloc RAWINPUTDEVICE[2];
        devices[0] = new RAWINPUTDEVICE { usUsagePage = 1, usUsage = 6, dwFlags = RIDEV_INPUTSINK, hwndTarget = hwnd }; // 键盘
        devices[1] = new RAWINPUTDEVICE { usUsagePage = 1, usUsage = 2, dwFlags = RIDEV_INPUTSINK, hwndTarget = hwnd }; // 鼠标
        if (!RegisterRawInputDevices(devices, 2, (uint)sizeof(RAWINPUTDEVICE))) return Fail("RegisterRawInputDevices");

        output.WriteLine("ready");
        MSG msg;
        while (GetMessageW(&msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        return 0;
    }

    static int Fail(string what)
    {
        Console.Error.WriteLine($"{what} 失败：{Marshal.GetLastWin32Error()}");
        return 1;
    }

    static void WatchStdin()
    {
        try
        {
            using var stdin = Console.OpenStandardInput();
            var buf = new byte[64];
            while (stdin.Read(buf, 0, buf.Length) > 0) { }
        }
        catch { }
        Environment.Exit(0);
    }

    [UnmanagedCallersOnly]
    static IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_INPUT)
        {
            try { OnInput(lParam); }
            catch { /* 一条读坏了不影响后面的 */ }
        }
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    static void OnInput(IntPtr raw)
    {
        const int Cap = 64;
        var buf = stackalloc byte[Cap];
        uint size = Cap;
        uint header = (uint)sizeof(RAWINPUTHEADER);
        var got = GetRawInputData(raw, RID_INPUT, buf, &size, header);
        if (got == uint.MaxValue || got < header) return;
        var h = (RAWINPUTHEADER*)buf;
        var data = buf + header;
        if (h->dwType == RIM_TYPEKEYBOARD) OnKey(*(RAWKEYBOARD*)data);
        else if (h->dwType == RIM_TYPEMOUSE) OnMouse(*(RAWMOUSE*)data);
    }

    static void OnKey(RAWKEYBOARD k)
    {
        if (k.VKey == 0xFF) return; // 键盘驱动补发的假键（Pause 等的前缀）
        bool e0 = (k.Flags & RI_KEY_E0) != 0;
        if (e0 && (k.MakeCode == 0x2A || k.MakeCode == 0x36)) return; // NumLock 下按方向键等时补发的假 Shift
        long id = ((long)k.VKey << 16) | k.MakeCode | (e0 ? 0x1000L : 0) | ((k.Flags & RI_KEY_E1) != 0 ? 0x2000L : 0);
        if ((k.Flags & RI_KEY_BREAK) != 0)
        {
            held.Remove(id);
            return;
        }
        if (!held.Add(id)) return; // 还按着：自动连发
        Emit('k', GetAncestor(GetForegroundWindow(), GA_ROOT) == own);
    }

    static void OnMouse(RAWMOUSE m)
    {
        var pos = MessagePos();
        foreach (var p in presses)
            if (p != null && !p.Moved && Far(p, pos)) p.Moved = true;
        for (int i = 0; i < Down.Length; i++)
        {
            if ((m.usButtonFlags & Down[i]) != 0)
                presses[i] = new Press { X = pos.x, Y = pos.y, Own = IsOwnAt(pos), Limit = Limit(pos) };
            if ((m.usButtonFlags & Up[i]) != 0 && presses[i] is { } p)
            {
                presses[i] = null;
                if (!p.Moved && !Far(p, pos)) Emit('c', p.Own);
            }
        }
    }

    // 这条输入发生时的指针位置（不是处理时的），快速连续操作也不会错位
    static POINT MessagePos()
    {
        uint v = GetMessagePos();
        return new POINT { x = (short)(v & 0xFFFF), y = (short)(v >> 16) };
    }

    static bool IsOwnAt(POINT pt) => GetAncestor(WindowFromPoint(pt), GA_ROOT) == own;

    static bool Far(Press p, POINT pt)
    {
        double dx = pt.x - p.X, dy = pt.y - p.Y;
        return Math.Sqrt(dx * dx + dy * dy) > p.Limit;
    }

    static double Limit(POINT pt)
    {
        var mon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        return GetDpiForMonitor(mon, 0, out var dpi, out _) == 0 && dpi > 0 ? DRAG_THRESHOLD * dpi / 96.0 : DRAG_THRESHOLD;
    }

    static void Emit(char kind, bool isOwn) => output.WriteLine(isOwn ? $"{kind} 1" : $"{kind} 0");

    // ───── Win32 ─────

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int x, y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; public uint lPrivate; }

    [StructLayout(LayoutKind.Sequential)]
    struct WNDCLASSEXW
    {
        public uint cbSize, style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public IntPtr hInstance, hIcon, hCursor, hbrBackground, lpszMenuName, lpszClassName, hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort usUsagePage, usUsage; public uint dwFlags; public IntPtr hwndTarget; }

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTHEADER { public uint dwType, dwSize; public IntPtr hDevice, wParam; }

    [StructLayout(LayoutKind.Sequential)]
    struct RAWKEYBOARD { public ushort MakeCode, Flags, Reserved, VKey; public uint Message, ExtraInformation; }

    [StructLayout(LayoutKind.Explicit)]
    struct RAWMOUSE
    {
        [FieldOffset(0)] public ushort usFlags;
        [FieldOffset(4)] public ushort usButtonFlags;
        [FieldOffset(6)] public ushort usButtonData;
        [FieldOffset(8)] public uint ulRawButtons;
        [FieldOffset(12)] public int lLastX;
        [FieldOffset(16)] public int lLastY;
        [FieldOffset(20)] public uint ulExtraInformation;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string? name);
    [DllImport("user32.dll", SetLastError = true)] static extern ushort RegisterClassExW(WNDCLASSEXW* wc);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr CreateWindowExW(uint exStyle, IntPtr cls, IntPtr title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetMessageW(MSG* msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern int TranslateMessage(MSG* msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(MSG* msg);
    [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterRawInputDevices(RAWINPUTDEVICE* devices, uint count, uint size);
    [DllImport("user32.dll")] static extern uint GetRawInputData(IntPtr raw, uint command, void* data, uint* size, uint header);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")] static extern uint GetMessagePos();
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(nint value);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
}
