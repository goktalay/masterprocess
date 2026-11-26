using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace MpAgent;

/// <summary>SYSTEM_PROCESS_INFORMATION'dan okunan bir süreç kaydı (x64 düzeni, elle ofsetlerle).</summary>
internal sealed class ProcRow
{
    public uint Pid, Ppid, Threads, Handles, Session, PageFaults;
    public string Name = "";
    public long CreateTime, UserTime, KernelTime;          // 100 ns
    public ulong Ws, PeakWs, Priv, Virt;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public bool AllSuspended;
    public ThreadRow[]? ThreadList;                          // yalnız istenirse doldurulur
}

internal struct ThreadRow
{
    public uint Tid;
    public long KernelTime, UserTime, CreateTime;
    public int Priority;
    public uint State, WaitReason;
}

/// <summary>NtQuerySystemInformation(SystemProcessInformation) sarmalayıcısı.</summary>
internal static unsafe class ProcTable
{
    private static byte* _buf;
    private static uint _cap;

    // SYSTEM_PROCESS_INFORMATION (x64)
    private const int O_Next = 0x00, O_NumThreads = 0x04, O_Create = 0x20, O_User = 0x28, O_Kernel = 0x30,
        O_NameLen = 0x38, O_NameBuf = 0x40, O_Pid = 0x50, O_Ppid = 0x58, O_Handles = 0x60, O_Session = 0x64,
        O_Virt = 0x78, O_PageFaults = 0x80, O_PeakWs = 0x88, O_Ws = 0x90, O_Priv = 0xC8,
        O_ReadOps = 0xD0, O_WriteOps = 0xD8, O_OtherOps = 0xE0, O_ReadBytes = 0xE8, O_WriteBytes = 0xF0, O_OtherBytes = 0xF8,
        O_Threads = 0x100;
    // SYSTEM_THREAD_INFORMATION (x64, 0x50 bayt)
    private const int T_Size = 0x50, T_Kernel = 0x00, T_User = 0x08, T_Create = 0x10, T_Tid = 0x30, T_Priority = 0x38,
        T_State = 0x44, T_WaitReason = 0x48;

    /// <summary>Tüm süreçleri okur. <paramref name="threadsFor"/> verilirse yalnız o PID için iş parçacığı listesi doldurulur.</summary>
    public static List<ProcRow> Query(uint? threadsFor = null)
    {
        if (_buf == null) { _cap = 1 << 20; _buf = (byte*)NativeMemory.Alloc(_cap); }
        for (int attempt = 0; ; attempt++)
        {
            uint ret = 0;
            uint st = Native.NtQuerySystemInformation(5, _buf, _cap, &ret);
            if (st == 0) break;
            if ((st == Native.STATUS_INFO_LENGTH_MISMATCH || st == Native.STATUS_BUFFER_TOO_SMALL) && attempt < 8)
            {
                uint want = Math.Max(ret + (ret >> 2) + 65536, _cap * 2);
                NativeMemory.Free(_buf);
                _cap = want;
                _buf = (byte*)NativeMemory.Alloc(_cap);
                continue;
            }
            throw AgentException.Nt("NtQuerySystemInformation(SystemProcessInformation)", st);
        }

        var list = new List<ProcRow>(256);
        byte* p = _buf;
        byte* end = _buf + _cap;
        while (true)
        {
            if (p + O_Threads > end) break;
            uint nThreads = *(uint*)(p + O_NumThreads);
            var r = new ProcRow
            {
                Threads = nThreads,
                CreateTime = *(long*)(p + O_Create),
                UserTime = *(long*)(p + O_User),
                KernelTime = *(long*)(p + O_Kernel),
                Pid = (uint)*(ulong*)(p + O_Pid),
                Ppid = (uint)*(ulong*)(p + O_Ppid),
                Handles = *(uint*)(p + O_Handles),
                Session = *(uint*)(p + O_Session),
                Virt = *(ulong*)(p + O_Virt),
                PageFaults = *(uint*)(p + O_PageFaults),
                PeakWs = *(ulong*)(p + O_PeakWs),
                Ws = *(ulong*)(p + O_Ws),
                Priv = *(ulong*)(p + O_Priv),
                ReadOps = *(ulong*)(p + O_ReadOps),
                WriteOps = *(ulong*)(p + O_WriteOps),
                OtherOps = *(ulong*)(p + O_OtherOps),
                ReadBytes = *(ulong*)(p + O_ReadBytes),
                WriteBytes = *(ulong*)(p + O_WriteBytes),
                OtherBytes = *(ulong*)(p + O_OtherBytes),
            };
            ushort nameLen = *(ushort*)(p + O_NameLen);
            char* nameBuf = *(char**)(p + O_NameBuf);
            if (nameLen > 0 && nameBuf != null) r.Name = Proto.Clean(new string(nameBuf, 0, nameLen / 2));
            else r.Name = r.Pid == 0 ? "System Idle Process" : (r.Pid == 4 ? "System" : "");

            byte* t = p + O_Threads;
            if (nThreads > 0 && t + (long)nThreads * T_Size <= end)
            {
                bool allSusp = true;
                bool want = threadsFor.HasValue && threadsFor.Value == r.Pid;
                if (want) r.ThreadList = new ThreadRow[nThreads];
                for (uint i = 0; i < nThreads; i++, t += T_Size)
                {
                    uint state = *(uint*)(t + T_State);
                    uint reason = *(uint*)(t + T_WaitReason);
                    if (!(state == 5 && reason == 5)) allSusp = false;
                    if (want)
                    {
                        r.ThreadList![i] = new ThreadRow
                        {
                            Tid = (uint)*(ulong*)(t + T_Tid),
                            KernelTime = *(long*)(t + T_Kernel),
                            UserTime = *(long*)(t + T_User),
                            CreateTime = *(long*)(t + T_Create),
                            Priority = *(int*)(t + T_Priority),
                            State = state,
                            WaitReason = reason,
                        };
                    }
                }
                r.AllSuspended = allSusp;
            }
            else if (threadsFor.HasValue && threadsFor.Value == r.Pid) r.ThreadList = Array.Empty<ThreadRow>();

            list.Add(r);
            uint next = *(uint*)(p + O_Next);
            if (next == 0) break;
            p += next;
        }
        return list;
    }

    public static ProcRow? Find(uint pid, bool withThreads)
    {
        var list = Query(withThreads ? pid : null);
        foreach (var r in list) if (r.Pid == pid) return r;
        return null;
    }
}

/// <summary>snapshot komutu: oranlar bir önceki snapshot çağrısına göre hesaplanır.</summary>
internal static unsafe class Snapshot
{
    private struct Prev { public long Create, Cpu; public ulong Read, Write; }

    private static Dictionary<uint, Prev> _prev = new();
    private static long _prevStamp;
    private static long _prevIdle, _prevKernel, _prevUser;
    private static bool _hasPrev;
    private static int _cpuCount;

    public static int CpuCount
    {
        get
        {
            if (_cpuCount == 0)
            {
                uint n = Native.GetActiveProcessorCount(0xFFFF);
                _cpuCount = n > 0 ? (int)n : Math.Max(1, Environment.ProcessorCount);
            }
            return _cpuCount;
        }
    }

    public static readonly string[] Cols =
    {
        "pid", "ppid", "name", "cpu", "ws", "priv", "ioRead", "ioWrite", "gpu", "gpuDed", "gpuShr", "threads", "handles", "start", "session",
    };

    public static void Handle(JsonElement req, Utf8JsonWriter w)
    {
        var rows = ProcTable.Query();
        long stamp = Stopwatch.GetTimestamp();
        long idle = 0, kernel = 0, user = 0;
        bool sysOk = Native.GetSystemTimes(&idle, &kernel, &user) != 0;
        long nowMs = Proto.NowMs();

        double elapsedSec = _hasPrev ? (stamp - _prevStamp) / (double)Stopwatch.Frequency : 0;
        bool rates = _hasPrev && elapsedSec > 0.01;
        double elapsed100ns = elapsedSec * 1e7;
        int ncpu = CpuCount;

        double sysCpu = 0;
        if (rates && sysOk)
        {
            double dIdle = idle - _prevIdle, dTotal = (kernel - _prevKernel) + (user - _prevUser);
            if (dTotal > 0) sysCpu = (dTotal - dIdle) / dTotal * 100.0;
        }

        var gpu = Gpu.Collect();

        var createByPid = new Dictionary<uint, long>(rows.Count);
        foreach (var r in rows) createByPid[r.Pid] = r.CreateTime;

        var next = new Dictionary<uint, Prev>(rows.Count);
        var cpuArr = new double[rows.Count];
        var rdArr = new double[rows.Count];
        var wrArr = new double[rows.Count];
        var skip = new bool[rows.Count];
        double sysRead = 0, sysWrite = 0;

        for (int i = 0; i < rows.Count; i++)
        {
            var r = rows[i];
            if (r.Pid == 0) { skip[i] = true; continue; }
            // İş parçacığı kalmamış kayıt: tanıtıcısı açık tutulan sonlanmış süreç olabilir.
            if (r.Threads == 0 && Proto.HasExited(r.Pid)) { skip[i] = true; continue; }

            long cpu = r.KernelTime + r.UserTime;
            next[r.Pid] = new Prev { Create = r.CreateTime, Cpu = cpu, Read = r.ReadBytes, Write = r.WriteBytes };
            if (rates && _prev.TryGetValue(r.Pid, out var pv) && pv.Create == r.CreateTime)
            {
                if (cpu >= pv.Cpu) cpuArr[i] = (cpu - pv.Cpu) / (elapsed100ns * ncpu) * 100.0;
                if (r.ReadBytes >= pv.Read) rdArr[i] = (r.ReadBytes - pv.Read) / elapsedSec;
                if (r.WriteBytes >= pv.Write) wrArr[i] = (r.WriteBytes - pv.Write) / elapsedSec;
                sysRead += rdArr[i];
                sysWrite += wrArr[i];
            }
        }

        Native.MEMORYSTATUSEX ms = default;
        ms.dwLength = (uint)sizeof(Native.MEMORYSTATUSEX);
        Native.GlobalMemoryStatusEx(&ms);
        Native.PERFORMANCE_INFORMATION pi = default;
        pi.cb = (uint)sizeof(Native.PERFORMANCE_INFORMATION);
        ulong commitTotal = 0, commitLimit = 0;
        if (Native.K32GetPerformanceInfo(&pi, pi.cb) != 0)
        {
            commitTotal = (ulong)pi.CommitTotal * pi.PageSize;
            commitLimit = (ulong)pi.CommitLimit * pi.PageSize;
        }

        w.WriteStartObject();
        w.WriteNumber("t", nowMs);
        w.WriteStartObject("sys");
        w.WriteNumber("cpu", Proto.Pct(sysCpu));
        w.WriteNumber("memTotal", ms.ullTotalPhys);
        w.WriteNumber("memAvail", ms.ullAvailPhys);
        w.WriteNumber("commitTotal", commitTotal);
        w.WriteNumber("commitLimit", commitLimit);
        w.WriteNumber("ioRead", (long)Math.Round(sysRead));
        w.WriteNumber("ioWrite", (long)Math.Round(sysWrite));
        w.WriteNumber("gpu", Proto.Pct(gpu.SysUtil));
        w.WriteNumber("gpuDedicated", gpu.SysDedicated);
        w.WriteNumber("gpuShared", gpu.SysShared);
        w.WriteEndObject();

        w.WriteStartArray("cols");
        foreach (var c in Cols) w.WriteStringValue(c);
        w.WriteEndArray();

        w.WriteStartArray("procs");
        for (int i = 0; i < rows.Count; i++)
        {
            if (skip[i]) continue;
            var r = rows[i];
            uint ppid = r.Ppid;
            // Ebeveyn PID'i yeniden kullanılmışsa (ebeveyn çocuktan sonra başlamış) 0.
            if (ppid != 0 && createByPid.TryGetValue(ppid, out long pc) && pc > r.CreateTime && r.CreateTime != 0) ppid = 0;
            if (ppid == r.Pid) ppid = 0;
            gpu.ByPid.TryGetValue(r.Pid, out var g);

            w.WriteStartArray();
            w.WriteNumberValue(r.Pid);
            w.WriteNumberValue(ppid);
            w.WriteStringValue(r.Name);
            w.WriteNumberValue(Proto.Pct(cpuArr[i]));
            w.WriteNumberValue(r.Ws);
            w.WriteNumberValue(r.Priv);
            w.WriteNumberValue((long)Math.Round(rdArr[i]));
            w.WriteNumberValue((long)Math.Round(wrArr[i]));
            w.WriteNumberValue(Proto.Pct(g.Util));
            w.WriteNumberValue(g.Dedicated);
            w.WriteNumberValue(g.Shared);
            w.WriteNumberValue(r.Threads);
            w.WriteNumberValue(r.Handles);
            w.WriteNumberValue(Proto.FileTimeToMs(r.CreateTime));
            w.WriteNumberValue(r.Session);
            w.WriteEndArray();
        }
        w.WriteEndArray();
        w.WriteEndObject();

        _prev = next;
        _prevStamp = stamp;
        if (sysOk) { _prevIdle = idle; _prevKernel = kernel; _prevUser = user; }
        _hasPrev = true;
    }
}
