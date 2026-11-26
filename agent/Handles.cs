using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace MpAgent;

/// <summary>handles komutu: tür sayıları + disk dosyası/klasör tanıtıcılarının yolları.</summary>
internal static unsafe class Handles
{
    private const int PerHandleTimeoutMs = 150;
    private const int BudgetMs = 5000;
    private const uint DUPLICATE_SAME_ACCESS = 2;
    private const uint FILE_TYPE_DISK = 1;

    private static readonly Dictionary<int, string> _typeNames = new();
    private static bool _typeTableTried;
    private static Worker? _worker; // çağrılar arasında yeniden kullanılır; askıda kalırsa terk edilip yenisi açılır
    private static int _verifyLeft;

    /// <summary>Dosya tanıtıcısı sorgusu; işçi iş parçacığında çalışır, askıda kalırsa terk edilir.</summary>
    private sealed class Job
    {
        public IntPtr Handle;
        public int State;          // 0 çalışıyor, 1 bitti, 2 terk edildi
        public bool IsDisk, IsDir;
        public string? Path;
        public long Size;
    }

    private sealed class Worker
    {
        private readonly AutoResetEvent _go = new(false);
        private readonly AutoResetEvent _done = new(false);
        private Job? _job;
        private volatile bool _stop;

        public Worker()
        {
            var t = new Thread(Loop, 256 * 1024) { IsBackground = true, Name = "mp-agent-handle-query" };
            t.Start();
        }

        private void Loop()
        {
            while (true)
            {
                _go.WaitOne();
                if (_stop) { _go.Dispose(); _done.Dispose(); return; }
                Job job = _job!;
                try { Query(job); } catch { }
                if (Interlocked.CompareExchange(ref job.State, 1, 0) != 0)
                {
                    // Terk edildik: tanıtıcı bizde kaldı, kapatıp çıkıyoruz (yeni işçi çoktan başlatıldı).
                    Native.CloseHandle(job.Handle);
                    _go.Dispose(); _done.Dispose();
                    return;
                }
                _done.Set();
            }
        }

        /// <summary>true: sonuç hazır (tanıtıcıyı çağıran kapatır). false: zaman aşımı, işçi terk edildi.</summary>
        public bool Run(Job job, int timeoutMs)
        {
            _job = job;
            _go.Set();
            if (_done.WaitOne(timeoutMs)) return true;
            if (Interlocked.CompareExchange(ref job.State, 2, 0) == 0) return false;
            _done.WaitOne(); // tam sınırda bitti
            return true;
        }

        public void Stop() { _stop = true; _go.Set(); }
    }

    private static void Query(Job job)
    {
        IntPtr h = job.Handle;
        if (Native.GetFileType(h) != FILE_TYPE_DISK) return;
        job.IsDisk = true;
        char* buf = stackalloc char[1024];
        uint n = Native.GetFinalPathNameByHandleW(h, buf, 1024, 0);
        string? path = null;
        if (n > 0 && n < 1024) path = new string(buf, 0, (int)n);
        else if (n >= 1024 && n < 33000)
        {
            char* big = (char*)NativeMemory.Alloc((nuint)(n + 1) * 2);
            try
            {
                uint m = Native.GetFinalPathNameByHandleW(h, big, n + 1, 0);
                if (m > 0 && m <= n) path = new string(big, 0, (int)m);
            }
            finally { NativeMemory.Free(big); }
        }
        if (path == null) return;
        if (path.StartsWith("\\\\?\\UNC\\", StringComparison.Ordinal)) path = "\\\\" + path.Substring(8);
        else if (path.StartsWith("\\\\?\\", StringComparison.Ordinal)) path = path.Substring(4);

        // FILE_STANDARD_INFO: erişim hakkı gerektirmez (çalışma dizini gibi yalnız TRAVERSE ile açılmış tanıtıcılarda da çalışır).
        // { long AllocationSize; long EndOfFile; uint NumberOfLinks; byte DeletePending; byte Directory; }
        byte* std = stackalloc byte[24];
        new Span<byte>(std, 24).Clear();
        if (Native.GetFileInformationByHandleEx(h, 1 /* FileStandardInfo */, std, 24) != 0)
        {
            job.IsDir = std[21] != 0;
            job.Size = job.IsDir ? 0 : *(long*)(std + 8);
        }
        else
        {
            Native.BY_HANDLE_FILE_INFORMATION info;
            if (Native.GetFileInformationByHandle(h, &info) != 0)
            {
                job.IsDir = (info.dwFileAttributes & 0x10) != 0;
                job.Size = job.IsDir ? 0 : (long)(((ulong)info.nFileSizeHigh << 32) | info.nFileSizeLow);
            }
        }
        job.Path = Proto.Clean(path);
    }

    private static string? TypeNameOf(IntPtr h)
    {
        byte* buf = stackalloc byte[1024];
        uint ret = 0;
        if (Native.NtQueryObject(h, 2, buf, 1024, &ret) != 0) return null; // ObjectTypeInformation
        ushort len = *(ushort*)buf;
        char* p = *(char**)(buf + 8);
        if (p == null || len == 0) return null;
        return new string(p, 0, len / 2);
    }

    /// <summary>Tüm nesne türlerinin adlarını tür indeksiyle önbelleğe alır (çoğaltılamayan tanıtıcılar için).</summary>
    private static void LoadTypeTable()
    {
        if (_typeTableTried) return;
        _typeTableTried = true;
        uint cap = 1 << 16;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            byte* buf = (byte*)NativeMemory.Alloc(cap);
            try
            {
                uint ret = 0;
                uint st = Native.NtQueryObject(IntPtr.Zero, 3, buf, cap, &ret); // ObjectTypesInformation
                if (st == Native.STATUS_INFO_LENGTH_MISMATCH || st == Native.STATUS_BUFFER_TOO_SMALL || st == Native.STATUS_BUFFER_OVERFLOW)
                {
                    cap = Math.Max(ret + 4096, cap * 2);
                    continue;
                }
                if (st != 0) return;
                uint count = *(uint*)buf;
                byte* p = buf + 8;
                byte* end = buf + cap;
                for (uint i = 0; i < count && p + 0x68 <= end; i++)
                {
                    ushort len = *(ushort*)p, maxLen = *(ushort*)(p + 2);
                    char* name = *(char**)(p + 8);
                    int typeIndex = *(p + 0x5A);
                    if (typeIndex == 0) typeIndex = (int)i + 2;
                    if (name != null && len > 0 && (byte*)name >= buf && (byte*)name + len <= end)
                        _typeNames.TryAdd(typeIndex, new string(name, 0, len / 2));
                    p += 0x68 + ((maxLen + 7) & ~7);
                }
                _verifyLeft = 24;
                return;
            }
            finally { NativeMemory.Free(buf); }
        }
    }

    private static bool SkipNameQuery(uint access) =>
        access == 0x0012019f || access == 0x001a019f || access == 0x00120189 || access == 0x00100000;

    public static void Handle(JsonElement req, Utf8JsonWriter w)
    {
        uint pid = Proto.ReqPid(req);
        if (pid == 0) throw AgentException.Gone("process 0 does not exist");
        IntPtr hp = Proto.OpenProcessOrThrow(pid, Native.PROCESS_DUP_HANDLE | Native.PROCESS_QUERY_LIMITED_INFORMATION);
        byte* buf = null;
        try
        {
            Proto.ThrowIfExited(hp, pid);
            var sw = Stopwatch.StartNew();
            try { LoadTypeTable(); } catch { }

            // SystemExtendedHandleInformation
            uint cap = 8u << 20;
            for (int attempt = 0; ; attempt++)
            {
                buf = (byte*)NativeMemory.Alloc(cap);
                uint ret = 0;
                uint st = Native.NtQuerySystemInformation(64, buf, cap, &ret);
                if (st == 0) break;
                NativeMemory.Free(buf); buf = null;
                if ((st == Native.STATUS_INFO_LENGTH_MISMATCH || st == Native.STATUS_BUFFER_TOO_SMALL) && attempt < 8)
                {
                    cap = Math.Max(ret + (ret >> 2) + (1u << 20), cap * 2);
                    continue;
                }
                throw AgentException.Nt("NtQuerySystemInformation(SystemExtendedHandleInformation)", st);
            }

            ulong total = *(ulong*)buf;
            ulong maxEntries = (cap - 16) / 40;
            if (total > maxEntries) total = maxEntries;

            var countsByIndex = new Dictionary<int, int>();
            var files = new List<(ulong H, string Path, bool Dir, long Size)>();
            bool truncated = false;
            IntPtr self = Native.GetCurrentProcess();
            byte* e = buf + 16;
            for (ulong i = 0; i < total; i++, e += 40)
            {
                if (*(ulong*)(e + 8) != pid) continue;
                ulong hv = *(ulong*)(e + 0x10);
                uint access = *(uint*)(e + 0x18);
                int typeIndex = *(ushort*)(e + 0x1E);
                countsByIndex.TryGetValue(typeIndex, out int c);
                countsByIndex[typeIndex] = c + 1;

                bool typeKnown = _typeNames.TryGetValue(typeIndex, out string? tn);
                // Tür tablosu (indeks → ad) ilk birkaç tanıtıcıda gerçek adla karşılaştırılarak doğrulanır.
                bool verify = typeKnown && _verifyLeft > 0;
                bool maybeFile = !typeKnown || tn == "File";
                if (!maybeFile && !verify) continue;
                if (truncated) continue; // bütçe doldu: yalnız say
                if (sw.ElapsedMilliseconds > BudgetMs) { truncated = true; continue; }

                IntPtr dup;
                if (Native.DuplicateHandle(hp, (IntPtr)(nint)hv, self, &dup, 0, 0, DUPLICATE_SAME_ACCESS) == 0) continue;
                bool closeDup = true;
                try
                {
                    if (!typeKnown || verify)
                    {
                        string? real = TypeNameOf(dup);
                        if (real != null)
                        {
                            if (verify)
                            {
                                _verifyLeft--;
                                if (real != tn) { _typeNames.Clear(); _verifyLeft = 0; } // tablo güvenilmez: yalnız sorgulananlar kalır
                            }
                            _typeNames[typeIndex] = real;
                            tn = real;
                        }
                    }
                    if (tn != "File") continue;
                    if (SkipNameQuery(access)) continue;

                    _worker ??= new Worker();
                    var job = new Job { Handle = dup };
                    if (!_worker.Run(job, PerHandleTimeoutMs))
                    {
                        closeDup = false;  // tanıtıcıyı askıdaki işçi kapatacak
                        _worker = null;    // yenisi gerektiğinde başlatılır
                        continue;
                    }
                    if (job.IsDisk && job.Path != null) files.Add((hv, job.Path, job.IsDir, job.Size));
                }
                finally { if (closeDup) Native.CloseHandle(dup); }
            }

            w.WriteStartObject();
            w.WriteStartObject("counts");
            var byName = new SortedDictionary<string, int>(StringComparer.Ordinal);
            foreach (var kv in countsByIndex)
            {
                string name = _typeNames.TryGetValue(kv.Key, out string? n) && n.Length > 0 ? n : "Unknown";
                byName.TryGetValue(name, out int cur);
                byName[name] = cur + kv.Value;
            }
            foreach (var kv in byName) w.WriteNumber(Proto.Clean(kv.Key), kv.Value);
            w.WriteEndObject();
            w.WriteStartArray("files");
            foreach (var f in files)
            {
                w.WriteStartObject();
                w.WriteString("h", Proto.Hex(f.H));
                w.WriteString("path", f.Path);
                w.WriteString("kind", f.Dir ? "dir" : "file");
                w.WriteNumber("size", f.Size);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            if (truncated) w.WriteBoolean("truncated", true);
            w.WriteEndObject();
        }
        finally
        {
            if (buf != null) NativeMemory.Free(buf);
            Native.CloseHandle(hp);
        }
    }
}
