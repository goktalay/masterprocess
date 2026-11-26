using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace MpAgent;

internal struct GpuProc { public double Util; public ulong Dedicated, Shared; }

internal sealed class GpuSample
{
    public static readonly GpuSample Empty = new();
    public Dictionary<uint, GpuProc> ByPid = new();
    public double SysUtil;
    public ulong SysDedicated, SysShared;
    public List<GpuEngineItem> Engines = new();
    public List<GpuMemItem> Mem = new();
    public long Stamp;
}

internal struct GpuEngineItem { public uint Pid; public uint LuidHigh, LuidLow; public int Eng; public string Type; public double Util; }
internal struct GpuMemItem { public uint Pid; public uint LuidHigh, LuidLow; public ulong Dedicated, Shared; }

/// <summary>Süreç başına GPU sayaçları (PDH) ve DXGI bağdaştırıcı listesi. Hiçbir hata yardımcıyı düşürmez.</summary>
internal static unsafe class Gpu
{
    private const uint PDH_MORE_DATA = 0x800007D2;
    private const uint PDH_FMT_DOUBLE = 0x00000200;
    private const uint PDH_FMT_LARGE = 0x00000400;
    private const uint PDH_FMT_NOCAP100 = 0x00008000;

    private static bool _init;
    private static bool _ok;
    private static IntPtr _query, _cEngine, _cDed, _cShr;
    private static GpuSample _last = GpuSample.Empty;
    private static byte* _buf;
    private static uint _bufCap;

    public static bool CountersAvailable { get { Init(); return _ok; } }

    private static void Init()
    {
        if (_init) return;
        _init = true;
        try
        {
            IntPtr q;
            if (Native.PdhOpenQueryW(null, 0, &q) != 0) return;
            IntPtr c1 = IntPtr.Zero, c2 = IntPtr.Zero, c3 = IntPtr.Zero;
            uint s1, s2, s3;
            fixed (char* p1 = "\\GPU Engine(*)\\Utilization Percentage")
            fixed (char* p2 = "\\GPU Process Memory(*)\\Dedicated Usage")
            fixed (char* p3 = "\\GPU Process Memory(*)\\Shared Usage")
            {
                s1 = Native.PdhAddEnglishCounterW(q, p1, 0, &c1);
                s2 = Native.PdhAddEnglishCounterW(q, p2, 0, &c2);
                s3 = Native.PdhAddEnglishCounterW(q, p3, 0, &c3);
            }
            if (s1 != 0 || s2 != 0 || s3 != 0)
            {
                Console.Error.WriteLine($"mp-agent: GPU counters unavailable (pdh 0x{s1:x8} 0x{s2:x8} 0x{s3:x8})");
                Native.PdhCloseQuery(q);
                return;
            }
            _query = q; _cEngine = c1; _cDed = c2; _cShr = c3;
            Native.PdhCollectQueryData(q); // oran sayacı için ilk örnek
            _ok = true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("mp-agent: GPU counter init failed: " + ex.Message);
            _ok = false;
        }
    }

    /// <summary>Sayaçları toplar; sayaç yoksa boş örnek döner.</summary>
    public static GpuSample Collect()
    {
        Init();
        if (!_ok) return GpuSample.Empty;
        var s = new GpuSample { Stamp = Stopwatch.GetTimestamp() };
        try
        {
            Native.PdhCollectQueryData(_query);
            // pid → (motor türü → toplam)
            var perType = new Dictionary<uint, Dictionary<string, double>>();
            var sysType = new Dictionary<string, double>();
            ReadArray(_cEngine, (name, val) =>
            {
                if (!ParseInstance(name, out uint pid, out uint lh, out uint ll, out int eng, out string type)) return;
                if (val < 0) val = 0;
                s.Engines.Add(new GpuEngineItem { Pid = pid, LuidHigh = lh, LuidLow = ll, Eng = eng, Type = type, Util = val });
                if (!perType.TryGetValue(pid, out var d)) perType[pid] = d = new Dictionary<string, double>(4);
                d.TryGetValue(type, out double cur); d[type] = cur + val;
                sysType.TryGetValue(type, out double sc); sysType[type] = sc + val;
            });
            foreach (var kv in perType)
            {
                double max = 0;
                foreach (var v in kv.Value.Values) if (v > max) max = v;
                s.ByPid[kv.Key] = new GpuProc { Util = Math.Min(100, max) };
            }
            foreach (var v in sysType.Values) if (v > s.SysUtil) s.SysUtil = v;
            if (s.SysUtil > 100) s.SysUtil = 100;

            var memIdx = new Dictionary<(uint, uint, uint), int>();
            void AddMem(string name, double val, bool dedicated)
            {
                if (!ParseInstance(name, out uint pid, out uint lh, out uint ll, out _, out _)) return;
                ulong v = val > 0 ? (ulong)val : 0;
                var key = (pid, lh, ll);
                if (!memIdx.TryGetValue(key, out int idx))
                {
                    idx = s.Mem.Count;
                    memIdx[key] = idx;
                    s.Mem.Add(new GpuMemItem { Pid = pid, LuidHigh = lh, LuidLow = ll });
                }
                var m = s.Mem[idx];
                if (dedicated) m.Dedicated += v; else m.Shared += v;
                s.Mem[idx] = m;
                s.ByPid.TryGetValue(pid, out var g);
                if (dedicated) { g.Dedicated += v; s.SysDedicated += v; } else { g.Shared += v; s.SysShared += v; }
                s.ByPid[pid] = g;
            }
            ReadArray(_cDed, (n, v) => AddMem(n, v, true));
            ReadArray(_cShr, (n, v) => AddMem(n, v, false));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("mp-agent: GPU collect failed: " + ex.Message);
        }
        _last = s;
        return s;
    }

    private static void ReadArray(IntPtr counter, Action<string, double> onItem)
    {
        for (int attempt = 0; attempt < 4; attempt++)
        {
            uint size = _bufCap, count = 0;
            uint st = Native.PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &size, &count, _bufCap == 0 ? null : _buf);
            if (st == PDH_MORE_DATA)
            {
                if (_buf != null) NativeMemory.Free(_buf);
                _bufCap = size + 16384;
                _buf = (byte*)NativeMemory.Alloc(_bufCap);
                continue;
            }
            if (st != 0) return; // örnek yok / geçersiz veri: sessizce boş
            // PDH_FMT_COUNTERVALUE_ITEM_W (x64): szName ptr @0, CStatus u32 @8, double @16; 24 bayt
            byte* p = _buf;
            for (uint i = 0; i < count; i++, p += 24)
            {
                char* name = *(char**)p;
                uint cstatus = *(uint*)(p + 8);
                double val = *(double*)(p + 16);
                if (name == null) continue;
                if (cstatus != 0 && cstatus != 1) continue; // PDH_CSTATUS_VALID_DATA / NEW_DATA
                if (double.IsNaN(val) || double.IsInfinity(val)) continue;
                onItem(new string(name), val);
            }
            return;
        }
    }

    /// <summary>Örnek adı: pid_1234_luid_0x00000000_0x00012A4F_phys_0[_eng_0_engtype_3D]</summary>
    internal static bool ParseInstance(string name, out uint pid, out uint luidHigh, out uint luidLow, out int eng, out string type)
    {
        pid = 0; luidHigh = 0; luidLow = 0; eng = -1; type = "";
        var parts = name.Split('_');
        bool gotPid = false;
        for (int i = 0; i < parts.Length; i++)
        {
            string k = parts[i];
            if (k == "pid" && i + 1 < parts.Length)
            {
                gotPid = uint.TryParse(parts[++i], NumberStyles.None, CultureInfo.InvariantCulture, out pid);
            }
            else if (k == "luid" && i + 2 < parts.Length)
            {
                TryHex(parts[i + 1], out luidHigh);
                TryHex(parts[i + 2], out luidLow);
                i += 2;
            }
            else if (k == "eng" && i + 1 < parts.Length)
            {
                int.TryParse(parts[++i], NumberStyles.None, CultureInfo.InvariantCulture, out eng);
            }
            else if (k == "engtype")
            {
                type = string.Join("_", parts, i + 1, parts.Length - i - 1); // tür adında alt çizgi olabilir
                break;
            }
        }
        return gotPid;
    }

    private static bool TryHex(string s, out uint v)
    {
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s.Substring(2);
        return uint.TryParse(s, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out v);
    }

    // ---- gpudetail ----
    public static void HandleDetail(JsonElement req, Utf8JsonWriter w)
    {
        uint pid = Proto.ReqPid(req);
        if (!CountersAvailable) throw AgentException.Unsupported("GPU performance counters are not available on this system");
        if (ProcTable.Find(pid, false) == null || Proto.HasExited(pid)) throw AgentException.Gone($"process {pid} does not exist");

        var s = _last;
        double ageSec = s.Stamp == 0 ? double.MaxValue : (Stopwatch.GetTimestamp() - s.Stamp) / (double)Stopwatch.Frequency;
        if (ageSec > 2.5) s = Collect();

        w.WriteStartObject();
        w.WriteStartArray("engines");
        foreach (var e in s.Engines)
        {
            if (e.Pid != pid) continue;
            w.WriteStartObject();
            w.WriteString("luid", Proto.Luid(e.LuidHigh, e.LuidLow));
            w.WriteNumber("eng", e.Eng);
            w.WriteString("type", e.Type);
            w.WriteNumber("util", Proto.Pct(e.Util));
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteStartArray("mem");
        foreach (var m in s.Mem)
        {
            if (m.Pid != pid) continue;
            w.WriteStartObject();
            w.WriteString("luid", Proto.Luid(m.LuidHigh, m.LuidLow));
            w.WriteNumber("dedicated", m.Dedicated);
            w.WriteNumber("shared", m.Shared);
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteEndObject();
    }

    // ---- DXGI bağdaştırıcıları (ham vtable çağrıları) ----
    public static void WriteAdapters(Utf8JsonWriter w)
    {
        w.WriteStartArray("gpus");
        void** factory = null;
        try
        {
            Guid iid = new(0x770aae78, 0xf26f, 0x4dba, 0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87); // IID_IDXGIFactory1
            void* pf = null;
            int hr = Native.CreateDXGIFactory1(&iid, &pf);
            if (hr >= 0 && pf != null)
            {
                factory = (void**)pf;
                void** vt = *(void***)factory;
                var enumAdapters1 = (delegate* unmanaged[Stdcall]<void*, uint, void**, int>)vt[12];
                byte* desc = stackalloc byte[312];
                for (uint i = 0; i < 64; i++)
                {
                    void* pa = null;
                    if (enumAdapters1(factory, i, &pa) < 0 || pa == null) break;
                    void** avt = *(void***)pa;
                    var getDesc1 = (delegate* unmanaged[Stdcall]<void*, void*, int>)avt[10];
                    var release = (delegate* unmanaged[Stdcall]<void*, uint>)avt[2];
                    new Span<byte>(desc, 312).Clear();
                    if (getDesc1(pa, desc) >= 0)
                    {
                        // DXGI_ADAPTER_DESC1: Description[128] @0, DedicatedVideoMemory @272, SharedSystemMemory @288,
                        // AdapterLuid {Low @296, High @300}, Flags @304
                        int len = 0;
                        char* d = (char*)desc;
                        while (len < 128 && d[len] != 0) len++;
                        w.WriteStartObject();
                        w.WriteString("luid", Proto.Luid(*(uint*)(desc + 300), *(uint*)(desc + 296)));
                        w.WriteString("name", Proto.Clean(new string(d, 0, len)));
                        w.WriteNumber("dedicated", *(ulong*)(desc + 272));
                        w.WriteNumber("shared", *(ulong*)(desc + 288));
                        w.WriteBoolean("software", (*(uint*)(desc + 304) & 2) != 0);
                        w.WriteEndObject();
                    }
                    release(pa);
                }
            }
        }
        catch (DllNotFoundException) { }
        catch (EntryPointNotFoundException) { }
        finally
        {
            if (factory != null)
            {
                var release = (delegate* unmanaged[Stdcall]<void*, uint>)(*(void***)factory)[2];
                release(factory);
            }
        }
        w.WriteEndArray();
    }
}
