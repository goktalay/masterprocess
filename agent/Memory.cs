using System.Runtime.InteropServices;
using System.Text.Json;

namespace MpAgent;

/// <summary>Aygıt yolu (\Device\HarddiskVolume3\…) → sürücü harfli yol çevirisi.</summary>
internal static unsafe class DeviceMap
{
    private static List<(string Device, string Drive)>? _map;
    private static long _built;

    private static List<(string, string)> Build()
    {
        var list = new List<(string, string)>();
        uint mask = Native.GetLogicalDrives();
        char* dev = stackalloc char[3];
        char* target = stackalloc char[1024];
        for (int i = 0; i < 26; i++)
        {
            if ((mask & (1u << i)) == 0) continue;
            dev[0] = (char)('A' + i); dev[1] = ':'; dev[2] = '\0';
            uint n = Native.QueryDosDeviceW(dev, target, 1024);
            if (n == 0) continue;
            int len = 0;
            while (len < 1024 && target[len] != 0) len++;
            if (len > 0) list.Add((new string(target, 0, len), new string(dev, 0, 2)));
        }
        // uzun önek önce eşleşsin (HarddiskVolume1 / HarddiskVolume10)
        list.Sort((a, b) => b.Item1.Length.CompareTo(a.Item1.Length));
        return list;
    }

    public static string ToDosPath(string devicePath)
    {
        long now = Environment.TickCount64;
        if (_map == null || now - _built > 30000) { _map = Build(); _built = now; }
        foreach (var (device, drive) in _map)
        {
            if (devicePath.Length > device.Length && devicePath[device.Length] == '\\' &&
                devicePath.StartsWith(device, StringComparison.OrdinalIgnoreCase))
                return drive + devicePath.Substring(device.Length);
        }
        const string mup = "\\Device\\Mup\\";
        if (devicePath.StartsWith(mup, StringComparison.OrdinalIgnoreCase)) return "\\\\" + devicePath.Substring(mup.Length);
        return devicePath;
    }
}

/// <summary>memmap ve readmem komutları.</summary>
internal static unsafe class Memory
{
    private const uint MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, MEM_FREE = 0x10000;
    private const uint MEM_PRIVATE = 0x20000, MEM_MAPPED = 0x40000, MEM_IMAGE = 0x1000000;
    private const int MaxRegions = 200000;

    private struct Region
    {
        public ulong Base, Size, AllocBase;
        public byte State, Type;
        public uint Protect;
        public int WsPages;
        public int NameIdx;
    }

    public static readonly string[] Cols = { "base", "size", "state", "protect", "type", "wsPages", "name" };

    public static void HandleMemMap(JsonElement req, Utf8JsonWriter w)
    {
        uint pid = Proto.ReqPid(req);
        if (pid == 0) throw AgentException.Gone("process 0 does not exist");
        IntPtr h = Proto.OpenProcessOrThrow(pid, Native.PROCESS_QUERY_INFORMATION | Native.PROCESS_VM_READ);
        try
        {
            Proto.ThrowIfExited(h, pid);
            Native.SYSTEM_INFO si;
            Native.GetSystemInfo(&si);
            ulong min = si.lpMinimumApplicationAddress, max = si.lpMaximumApplicationAddress;
            uint pageSize = si.dwPageSize == 0 ? 4096 : si.dwPageSize;

            var regions = new List<Region>(2048);
            var names = new List<string> { "" };
            var nameByAlloc = new Dictionary<ulong, int>();
            bool truncated = false;
            char* nameBuf = stackalloc char[1024];

            ulong addr = min;
            Native.MEMORY_BASIC_INFORMATION mbi;
            bool any = false;
            int firstErr = 0;
            while (addr < max)
            {
                if (Native.VirtualQueryEx(h, (void*)addr, &mbi, (nuint)sizeof(Native.MEMORY_BASIC_INFORMATION)) == 0)
                {
                    if (!any) firstErr = Proto.LastError();
                    break;
                }
                any = true;
                ulong rbase = mbi.BaseAddress, rsize = mbi.RegionSize;
                if (rsize == 0) break;
                if (regions.Count >= MaxRegions) { truncated = true; break; }

                var r = new Region { Base = rbase, Size = rsize, AllocBase = mbi.AllocationBase, WsPages = 0 };
                r.State = mbi.State switch { MEM_COMMIT => (byte)1, MEM_RESERVE => (byte)2, _ => (byte)3 };
                if (r.State == 3) r.Type = 0;
                else r.Type = mbi.Type switch { MEM_PRIVATE => (byte)1, MEM_MAPPED => (byte)2, MEM_IMAGE => (byte)3, _ => (byte)0 };
                r.Protect = r.State == 1 ? mbi.Protect : 0;

                if (r.Type == 2 || r.Type == 3)
                {
                    if (!nameByAlloc.TryGetValue(r.AllocBase, out int idx))
                    {
                        idx = 0;
                        uint n = Native.K32GetMappedFileNameW(h, (void*)rbase, nameBuf, 1024);
                        if (n > 0)
                        {
                            names.Add(Proto.Clean(DeviceMap.ToDosPath(new string(nameBuf, 0, (int)n))));
                            idx = names.Count - 1;
                            nameByAlloc[r.AllocBase] = idx;
                        }
                        else if (r.State == 1) nameByAlloc[r.AllocBase] = 0; // commit'li bölgede ad yok: sayfa dosyası destekli eşleme
                    }
                    r.NameIdx = idx;
                }
                regions.Add(r);

                ulong next = rbase + rsize;
                if (next <= addr) break;
                addr = next;
            }
            if (!any)
            {
                Proto.ThrowIfExited(h, pid);
                if (firstErr == Native.ERROR_ACCESS_DENIED) throw AgentException.Access($"cannot query memory of process {pid} (win32 5)");
                throw AgentException.Win32("VirtualQueryEx", firstErr);
            }

            bool wsKnown = FillWorkingSet(h, regions, pageSize, out ulong wsPagesTotal);
            ulong wsBytes = wsPagesTotal * pageSize;
            if (!wsKnown)
            {
                Native.PROCESS_MEMORY_COUNTERS_EX pmc = default;
                pmc.cb = (uint)sizeof(Native.PROCESS_MEMORY_COUNTERS_EX);
                if (Native.K32GetProcessMemoryInfo(h, &pmc, pmc.cb) != 0) wsBytes = pmc.WorkingSetSize;
            }

            ulong tCommit = 0, tReserve = 0, tFree = 0, tImage = 0, tMapped = 0, tPrivate = 0;
            w.WriteStartObject();
            w.WriteNumber("pageSize", pageSize);
            w.WriteString("min", Proto.Hex(min));
            w.WriteString("max", Proto.Hex(max));
            w.WriteStartArray("cols");
            foreach (var c in Cols) w.WriteStringValue(c);
            w.WriteEndArray();
            w.WriteStartArray("regions");
            foreach (var r in regions)
            {
                switch (r.State) { case 1: tCommit += r.Size; break; case 2: tReserve += r.Size; break; default: tFree += r.Size; break; }
                switch (r.Type) { case 1: tPrivate += r.Size; break; case 2: tMapped += r.Size; break; case 3: tImage += r.Size; break; }
                w.WriteStartArray();
                w.WriteStringValue(Proto.Hex(r.Base));
                w.WriteNumberValue(r.Size);
                w.WriteNumberValue((int)r.State);
                w.WriteNumberValue(r.Protect);
                w.WriteNumberValue((int)r.Type);
                w.WriteNumberValue(wsKnown ? r.WsPages : -1);
                w.WriteStringValue(names[r.NameIdx]);
                w.WriteEndArray();
            }
            w.WriteEndArray();
            w.WriteStartObject("totals");
            w.WriteNumber("commit", tCommit);
            w.WriteNumber("reserve", tReserve);
            w.WriteNumber("free", tFree);
            w.WriteNumber("image", tImage);
            w.WriteNumber("mapped", tMapped);
            w.WriteNumber("private", tPrivate);
            w.WriteNumber("ws", wsBytes);
            w.WriteEndObject();
            if (truncated) w.WriteBoolean("truncated", true);
            w.WriteEndObject();
        }
        finally { Native.CloseHandle(h); }
    }

    /// <summary>Çalışma kümesi sayfalarını bölgelere dağıtır (bölgeler taban adrese göre sıralıdır).</summary>
    private static bool FillWorkingSet(IntPtr h, List<Region> regions, uint pageSize, out ulong total)
    {
        total = 0;
        nuint cap = 1 << 16; // girdi sayısı
        ulong* buf = null;
        try
        {
            bool ok = false;
            for (int attempt = 0; attempt < 8; attempt++)
            {
                if (buf != null) NativeMemory.Free(buf);
                nuint bytes = (cap + 1) * 8;
                if (bytes > uint.MaxValue) return false;
                buf = (ulong*)NativeMemory.Alloc(bytes);
                buf[0] = 0;
                if (Native.K32QueryWorkingSet(h, buf, (uint)bytes) != 0) { ok = true; break; }
                int err = Proto.LastError();
                if (err != Native.ERROR_BAD_LENGTH) return false;
                ulong need = buf[0];
                cap = (nuint)Math.Max(need + need / 8 + 1024, (ulong)cap * 2);
            }
            if (!ok) return false;

            ulong count = buf[0];
            if (count > cap) count = cap;
            var span = CollectionsMarshal.AsSpan(regions);
            ulong mask = ~((ulong)pageSize - 1);
            int hint = 0;
            for (ulong i = 0; i < count; i++)
            {
                ulong page = buf[1 + i] & mask;
                int idx;
                if (hint < span.Length && page >= span[hint].Base && page - span[hint].Base < span[hint].Size) idx = hint;
                else
                {
                    int lo = 0, hi = span.Length - 1;
                    idx = -1;
                    while (lo <= hi)
                    {
                        int mid = (lo + hi) >>> 1;
                        if (page < span[mid].Base) hi = mid - 1;
                        else if (page - span[mid].Base >= span[mid].Size) lo = mid + 1;
                        else { idx = mid; break; }
                    }
                    if (idx < 0) continue;
                    hint = idx;
                }
                span[idx].WsPages++;
                total++;
            }
            return true;
        }
        finally { if (buf != null) NativeMemory.Free(buf); }
    }

    public static void HandleReadMem(JsonElement req, Utf8JsonWriter w)
    {
        uint pid = Proto.ReqPid(req);
        ulong addr = Proto.ReqHex(req, "addr");
        long len = Proto.ReqInt(req, "len");
        if (len < 1 || len > 65536) throw AgentException.BadRequest("'len' must be between 1 and 65536");
        if (pid == 0) throw AgentException.Gone("process 0 does not exist");

        IntPtr h = Proto.OpenProcessOrThrow(pid, Native.PROCESS_VM_READ | Native.PROCESS_QUERY_LIMITED_INFORMATION);
        try
        {
            Proto.ThrowIfExited(h, pid);
            byte[] data = new byte[len];
            nuint got = 0;
            int err = 0;
            fixed (byte* p = data)
            {
                if (Native.ReadProcessMemory(h, (void*)addr, p, (nuint)len, &got) == 0)
                {
                    err = Proto.LastError();
                    // Kısmi okuma: sayfa sayfa, ilk okunamayan sayfaya dek.
                    got = 0;
                    ulong cur = addr, end = addr + (ulong)len;
                    while (cur < end)
                    {
                        ulong pageEnd = (cur & ~0xFFFUL) + 0x1000;
                        ulong chunk = Math.Min(pageEnd, end) - cur;
                        nuint r = 0;
                        if (Native.ReadProcessMemory(h, (void*)cur, p + (cur - addr), (nuint)chunk, &r) == 0 || r != chunk) break;
                        got += (nuint)chunk;
                        cur += chunk;
                    }
                }
            }
            if (got == 0) throw AgentException.Access($"cannot read memory at {Proto.Hex(addr)} (win32 {err})");
            w.WriteStartObject();
            w.WriteString("addr", Proto.Hex(addr));
            w.WriteNumber("len", (ulong)got);
            w.WriteBase64String("b64", new ReadOnlySpan<byte>(data, 0, (int)got));
            w.WriteEndObject();
        }
        finally { Native.CloseHandle(h); }
    }
}
