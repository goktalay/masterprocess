using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace MpAgent;

internal struct WinRow
{
    public IntPtr Hwnd;
    public string Title, Cls;
    public bool Visible, Minimized;
    public int X, Y, W, H;
}

/// <summary>detail ve modules komutları.</summary>
internal static unsafe class Detail
{
    // ---- pencere sayımı ----
    [ThreadStatic] private static List<WinRow>? _winList;
    [ThreadStatic] private static uint _winPid;

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvStdcall) })]
    private static int EnumProc(IntPtr hwnd, IntPtr lParam)
    {
        try
        {
            uint pid = 0;
            Native.GetWindowThreadProcessId(hwnd, &pid);
            if (pid != _winPid || _winList == null) return 1;
            bool visible = Native.IsWindowVisible(hwnd) != 0;
            string title = WindowText(hwnd);
            if (!visible && title.Length == 0) return 1; // görünmeyen + başlıksız yardımcı pencereler
            Native.RECT rc = default;
            Native.GetWindowRect(hwnd, &rc);
            _winList.Add(new WinRow
            {
                Hwnd = hwnd,
                Title = title,
                Cls = ClassName(hwnd),
                Visible = visible,
                Minimized = Native.IsIconic(hwnd) != 0,
                X = rc.left, Y = rc.top, W = rc.right - rc.left, H = rc.bottom - rc.top,
            });
        }
        catch { /* geri çağrıdan istisna sızdırma */ }
        return 1;
    }

    public static string WindowText(IntPtr hwnd)
    {
        char* buf = stackalloc char[512];
        int n = Native.GetWindowTextW(hwnd, buf, 512);
        return n > 0 ? Proto.Clean(new string(buf, 0, n)) : "";
    }

    public static string ClassName(IntPtr hwnd)
    {
        char* buf = stackalloc char[260];
        int n = Native.GetClassNameW(hwnd, buf, 260);
        return n > 0 ? Proto.Clean(new string(buf, 0, n)) : "";
    }

    public static List<WinRow> WindowsOf(uint pid)
    {
        var list = new List<WinRow>();
        _winList = list;
        _winPid = pid;
        try { Native.EnumWindows(&EnumProc, IntPtr.Zero); }
        finally { _winList = null; }
        return list;
    }

    // ---- alan okuyucular ----
    public static string? ImagePath(IntPtr h)
    {
        char* buf = stackalloc char[1024];
        uint size = 1024;
        if (Native.QueryFullProcessImageNameW(h, 0, buf, &size) != 0 && size > 0) return Proto.Clean(new string(buf, 0, (int)size));
        // çok uzun yol
        int cap = 33000;
        char* big = (char*)NativeMemory.Alloc((nuint)cap * 2);
        try
        {
            size = (uint)cap;
            if (Native.QueryFullProcessImageNameW(h, 0, big, &size) != 0 && size > 0) return Proto.Clean(new string(big, 0, (int)size));
        }
        finally { NativeMemory.Free(big); }
        return null;
    }

    private static string? CommandLine(IntPtr h)
    {
        uint need = 0;
        Native.NtQueryInformationProcess(h, 60, null, 0, &need); // ProcessCommandLineInformation
        if (need == 0 || need > (1 << 20)) need = 4096;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            byte* buf = (byte*)NativeMemory.Alloc(need);
            try
            {
                uint ret = 0;
                uint st = Native.NtQueryInformationProcess(h, 60, buf, need, &ret);
                if (st == 0)
                {
                    ushort len = *(ushort*)buf;
                    char* p = *(char**)(buf + 8);
                    if (p == null || len == 0) return "";
                    if ((byte*)p < buf || (byte*)p + len > buf + need) return null;
                    return Proto.Clean(new string(p, 0, len / 2));
                }
                if ((st == Native.STATUS_INFO_LENGTH_MISMATCH || st == Native.STATUS_BUFFER_TOO_SMALL || st == Native.STATUS_BUFFER_OVERFLOW) && ret > need)
                {
                    need = ret + 64;
                    continue;
                }
                return null;
            }
            finally { NativeMemory.Free(buf); }
        }
        return null;
    }

    private static void TokenInfo(IntPtr h, out string? user, out bool? elevated)
    {
        user = null; elevated = null;
        IntPtr tok;
        if (Native.OpenProcessToken(h, Native.TOKEN_QUERY, &tok) == 0) return;
        try
        {
            uint ret = 0;
            int elev = 0;
            if (Native.GetTokenInformation(tok, 20, &elev, 4, &ret) != 0) elevated = elev != 0; // TokenElevation

            byte* buf = stackalloc byte[512];
            if (Native.GetTokenInformation(tok, 1, buf, 512, &ret) != 0) // TokenUser
            {
                void* sid = *(void**)buf;
                char* name = stackalloc char[260];
                char* dom = stackalloc char[260];
                uint nl = 260, dl = 260;
                int use = 0;
                if (Native.LookupAccountSidW(null, sid, name, &nl, dom, &dl, &use) != 0)
                {
                    string n = new(name, 0, (int)nl), d = new(dom, 0, (int)dl);
                    user = Proto.Clean(d.Length > 0 ? d + "\\" + n : n);
                }
            }
        }
        finally { Native.CloseHandle(tok); }
    }

    public static bool SelfElevated()
    {
        TokenInfo(Native.GetCurrentProcess(), out _, out bool? e);
        return e == true;
    }

    private static string? Arch(IntPtr h)
    {
        try
        {
            ushort pm = 0, nm = 0;
            if (Native.IsWow64Process2(h, &pm, &nm) != 0)
            {
                ushort m = pm == 0 ? nm : pm; // IMAGE_FILE_MACHINE_UNKNOWN → yerel
                return m switch
                {
                    0x014c => "x86",
                    0x8664 => "x64",
                    0xAA64 => "arm64",
                    0x01c4 => "x86", // ARM32 (protokolde karşılığı yok)
                    _ => null,
                };
            }
        }
        catch (EntryPointNotFoundException) { }
        int wow = 0;
        if (Native.IsWow64Process(h, &wow) != 0) return wow != 0 ? "x86" : "x64";
        return null;
    }

    private static string? PriorityName(IntPtr h)
    {
        return Native.GetPriorityClass(h) switch
        {
            0x40 => "idle",
            0x4000 => "below",
            0x20 => "normal",
            0x8000 => "above",
            0x80 => "high",
            0x100 => "realtime",
            _ => null,
        };
    }

    private static string ThreadState(uint s) => s switch
    {
        2 => "run",
        1 or 3 or 7 => "ready",
        5 => "wait",
        _ => "other",
    };

    private static void WriteStr(Utf8JsonWriter w, string name, string? v)
    {
        if (v == null) w.WriteNull(name); else w.WriteString(name, v);
    }

    public static void Handle(JsonElement req, Utf8JsonWriter w)
    {
        uint pid = Proto.ReqPid(req);
        var list = ProcTable.Query(pid);
        ProcRow? row = null;
        var createByPid = new Dictionary<uint, long>(list.Count);
        foreach (var r in list) { createByPid[r.Pid] = r.CreateTime; if (r.Pid == pid) row = r; }
        if (row == null || pid == 0) throw AgentException.Gone($"process {pid} does not exist");
        if (Proto.HasExited(pid)) throw AgentException.Gone($"process {pid} has exited");

        string? path = null, cmdline = null, user = null, priority = null, arch = null;
        bool? elevated = null;
        uint handleCount = row.Handles, gdi = 0, usr = 0;

        IntPtr h = Native.OpenProcess(Native.PROCESS_QUERY_INFORMATION | Native.PROCESS_VM_READ, 0, pid);
        if (h == IntPtr.Zero) h = Native.OpenProcess(Native.PROCESS_QUERY_INFORMATION, 0, pid);
        if (h == IntPtr.Zero) h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (h != IntPtr.Zero)
        {
            try
            {
                path = ImagePath(h);
                cmdline = CommandLine(h);
                TokenInfo(h, out user, out elevated);
                priority = PriorityName(h);
                arch = Arch(h);
                uint hc = 0;
                if (Native.GetProcessHandleCount(h, &hc) != 0) handleCount = hc;
                gdi = Native.GetGuiResources(h, 0);
                usr = Native.GetGuiResources(h, 1);
            }
            finally { Native.CloseHandle(h); }
        }

        uint ppid = row.Ppid;
        if (ppid != 0 && createByPid.TryGetValue(ppid, out long pc) && pc > row.CreateTime && row.CreateTime != 0) ppid = 0;
        if (ppid == pid) ppid = 0;

        w.WriteStartObject();
        w.WriteNumber("pid", pid);
        w.WriteString("name", row.Name);
        WriteStr(w, "path", path);
        WriteStr(w, "cmdline", cmdline);
        WriteStr(w, "user", user);
        w.WriteNumber("start", Proto.FileTimeToMs(row.CreateTime));
        WriteStr(w, "priority", priority);
        WriteStr(w, "arch", arch);
        w.WriteBoolean("elevated", elevated ?? false);
        w.WriteBoolean("suspended", row.Threads > 0 && row.AllSuspended);
        w.WriteNumber("ppid", ppid);

        w.WriteStartObject("counters");
        w.WriteNumber("handles", handleCount);
        w.WriteNumber("gdi", gdi);
        w.WriteNumber("user", usr);
        w.WriteNumber("pageFaults", row.PageFaults);
        w.WriteNumber("peakWs", row.PeakWs);
        w.WriteNumber("ws", row.Ws);
        w.WriteNumber("priv", row.Priv);
        w.WriteNumber("virt", row.Virt);
        w.WriteNumber("ioReadOps", row.ReadOps);
        w.WriteNumber("ioWriteOps", row.WriteOps);
        w.WriteNumber("ioOtherOps", row.OtherOps);
        w.WriteNumber("ioReadBytes", row.ReadBytes);
        w.WriteNumber("ioWriteBytes", row.WriteBytes);
        w.WriteNumber("ioOtherBytes", row.OtherBytes);
        w.WriteNumber("kernelMs", row.KernelTime / 10000);
        w.WriteNumber("userMs", row.UserTime / 10000);
        w.WriteEndObject();

        WriteFile(w, path);

        w.WriteStartArray("threads");
        if (row.ThreadList != null)
        {
            foreach (var t in row.ThreadList)
            {
                w.WriteStartObject();
                w.WriteNumber("tid", t.Tid);
                w.WriteNumber("cpuMs", (t.KernelTime + t.UserTime) / 10000);
                w.WriteNumber("priority", t.Priority);
                w.WriteString("state", ThreadState(t.State));
                w.WriteNumber("start", Proto.FileTimeToMs(t.CreateTime));
                w.WriteEndObject();
            }
        }
        w.WriteEndArray();

        w.WriteStartArray("windows");
        foreach (var win in WindowsOf(pid))
        {
            w.WriteStartObject();
            w.WriteString("hwnd", Proto.Hex(win.Hwnd));
            w.WriteString("title", win.Title);
            w.WriteString("cls", win.Cls);
            w.WriteBoolean("visible", win.Visible);
            w.WriteBoolean("minimized", win.Minimized);
            w.WriteStartArray("rect");
            w.WriteNumberValue(win.X); w.WriteNumberValue(win.Y); w.WriteNumberValue(win.W); w.WriteNumberValue(win.H);
            w.WriteEndArray();
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteEndObject();
    }

    private static void WriteFile(Utf8JsonWriter w, string? path)
    {
        string? company = null, description = null, version = null;
        long size = -1, modified = 0;
        if (path != null)
        {
            try
            {
                var fi = new FileInfo(path);
                if (fi.Exists) { size = fi.Length; modified = new DateTimeOffset(fi.LastWriteTimeUtc).ToUnixTimeMilliseconds(); }
            }
            catch { }
            try
            {
                var vi = FileVersionInfo.GetVersionInfo(path);
                company = NullIfEmpty(vi.CompanyName);
                description = NullIfEmpty(vi.FileDescription);
                version = NullIfEmpty(vi.FileVersion) ?? NullIfEmpty(vi.ProductVersion);
            }
            catch { }
        }
        if (path == null || (size < 0 && company == null && description == null && version == null))
        {
            w.WriteNull("file");
            return;
        }
        w.WriteStartObject("file");
        WriteStr(w, "company", company);
        WriteStr(w, "description", description);
        WriteStr(w, "version", version);
        w.WriteNumber("size", size < 0 ? 0 : size);
        w.WriteNumber("modified", modified);
        w.WriteEndObject();
    }

    private static string? NullIfEmpty(string? s) => string.IsNullOrWhiteSpace(s) ? null : Proto.Clean(s.Trim());

    // ---- modules ----
    public static void HandleModules(JsonElement req, Utf8JsonWriter w)
    {
        uint pid = Proto.ReqPid(req);
        if (pid == 0) throw AgentException.Gone("process 0 does not exist");
        IntPtr h = Proto.OpenProcessOrThrow(pid, Native.PROCESS_QUERY_INFORMATION | Native.PROCESS_VM_READ);
        try
        {
            Proto.ThrowIfExited(h, pid);
            uint cap = 1024;
            IntPtr* mods = null;
            uint count = 0;
            try
            {
                int lastErr = 0;
                bool ok = false;
                for (int attempt = 0; attempt < 6; attempt++)
                {
                    if (mods != null) NativeMemory.Free(mods);
                    mods = (IntPtr*)NativeMemory.Alloc(cap, (nuint)sizeof(IntPtr));
                    uint needed = 0;
                    if (Native.K32EnumProcessModulesEx(h, mods, cap * (uint)sizeof(IntPtr), &needed, 3) != 0)
                    {
                        uint n = needed / (uint)sizeof(IntPtr);
                        if (n > cap) { cap = n + 64; continue; }
                        count = n; ok = true; break;
                    }
                    lastErr = Proto.LastError();
                    if (lastErr == Native.ERROR_PARTIAL_COPY) { Thread.Sleep(30); continue; } // yükleyici henüz hazır değil
                    break;
                }
                if (!ok)
                {
                    Proto.ThrowIfExited(h, pid);
                    if (lastErr == Native.ERROR_ACCESS_DENIED) throw AgentException.Access($"cannot enumerate modules of process {pid} (win32 5)");
                    throw AgentException.Win32("EnumProcessModulesEx", lastErr);
                }

                char* buf = stackalloc char[1024];
                w.WriteStartObject();
                w.WriteStartArray("modules");
                for (uint i = 0; i < count; i++)
                {
                    Native.MODULEINFO mi = default;
                    if (Native.K32GetModuleInformation(h, mods[i], &mi, (uint)sizeof(Native.MODULEINFO)) == 0)
                    {
                        mi.lpBaseOfDll = (nuint)(nint)mods[i];
                        mi.SizeOfImage = 0;
                    }
                    uint n = Native.K32GetModuleFileNameExW(h, mods[i], buf, 1024);
                    w.WriteStartObject();
                    w.WriteString("base", Proto.Hex(mi.lpBaseOfDll));
                    w.WriteNumber("size", mi.SizeOfImage);
                    w.WriteString("path", n > 0 ? Proto.Clean(new string(buf, 0, (int)n)) : "");
                    w.WriteEndObject();
                }
                w.WriteEndArray();
                w.WriteEndObject();
            }
            finally { if (mods != null) NativeMemory.Free(mods); }
        }
        finally { Native.CloseHandle(h); }
    }
}
