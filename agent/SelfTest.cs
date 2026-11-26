using System.Buffers;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace MpAgent;

/// <summary>--selftest: tüm komutları kendi süreci üzerinde, gerçek dağıtıcıdan geçirerek sınar.</summary>
internal static unsafe class SelfTest
{
    private static readonly ArrayBufferWriter<byte> Buffer = new(1 << 16);
    private static readonly Utf8JsonWriter Writer = new(Buffer, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    private static int _nextId = 100;
    private static int _failed;

    private sealed class Reply : IDisposable
    {
        public JsonDocument Doc = null!;
        public int ByteLength;
        public bool Ok => Doc.RootElement.GetProperty("ok").GetBoolean();
        public string Err => Doc.RootElement.TryGetProperty("err", out var e) ? e.GetString() ?? "" : "";
        public string Msg => Doc.RootElement.TryGetProperty("msg", out var e) ? e.GetString() ?? "" : "";
        public JsonElement Data => Doc.RootElement.GetProperty("data");
        public void Dispose() => Doc.Dispose();
    }

    /// <summary>İsteği dağıtıcıdan geçirir; yanıtın tek satır geçerli JSON olduğunu ve id eşleşmesini denetler.</summary>
    private static Reply Call(string body, int? expectId = null)
    {
        int id = _nextId++;
        string line = body.StartsWith('{') && expectId == null ? "{\"id\":" + id.ToString(CultureInfo.InvariantCulture) + "," + body.Substring(1) : body;
        Program.Dispatch(line, Buffer, Writer);
        var bytes = Buffer.WrittenSpan;
        if (bytes.IndexOf((byte)'\n') >= 0) throw new Exception("response contains a newline");
        var doc = JsonDocument.Parse(bytes.ToArray());
        long gotId = doc.RootElement.GetProperty("id").GetInt64();
        long want = expectId ?? id;
        if (gotId != want) throw new Exception($"id mismatch: got {gotId}, want {want}");
        return new Reply { Doc = doc, ByteLength = bytes.Length };
    }

    private static Reply CallOk(string body)
    {
        var r = Call(body);
        if (!r.Ok) { string m = $"{r.Err}: {r.Msg}"; r.Dispose(); throw new Exception("unexpected error " + m); }
        return r;
    }

    private static void ExpectErr(string body, string code, int? expectId = null)
    {
        using var r = Call(body, expectId);
        if (r.Ok) throw new Exception($"expected '{code}', got ok for {body}");
        if (r.Err != code) throw new Exception($"expected '{code}', got '{r.Err}' ({r.Msg}) for {body}");
        if (r.Msg.Length == 0) throw new Exception("error without msg");
    }

    private static void Check(bool cond, string what)
    {
        if (!cond) throw new Exception("check failed: " + what);
    }

    private static void Test(string name, Func<string> body)
    {
        try
        {
            string summary = body();
            Console.Out.WriteLine($"PASS {name} {summary}");
        }
        catch (Exception ex)
        {
            _failed++;
            Console.Out.WriteLine($"FAIL {name} {ex.GetType().Name}: {ex.Message}");
        }
        Console.Out.Flush();
    }

    private static bool Near(double a, double b, double relTol, double absTol) => Math.Abs(a - b) <= Math.Max(absTol, Math.Max(Math.Abs(a), Math.Abs(b)) * relTol);

    private static string J(string s) => JsonEncodedText.Encode(s, JavaScriptEncoder.UnsafeRelaxedJsonEscaping).ToString();

    public static int Run()
    {
        uint self = Native.GetCurrentProcessId();
        string exe = Environment.ProcessPath ?? throw new Exception("no process path");
        string exeName = Path.GetFileName(exe);
        long exeSize = new FileInfo(exe).Length;
        bool gpuCounters = false;
        string firstModuleBase = "";

        Test("hello", () =>
        {
            using var r = CallOk("{\"cmd\":\"hello\"}");
            var d = r.Data;
            Check(d.GetProperty("agent").GetString() == Proto.AgentVersion, "agent");
            Check(d.GetProperty("protocol").GetInt32() == 1, "protocol");
            Check(d.GetProperty("pid").GetUInt32() == self, "pid");
            Check(d.GetProperty("arch").GetString() == "x64", "arch");
            Check(d.GetProperty("cpuCount").GetInt32() == Environment.ProcessorCount || d.GetProperty("cpuCount").GetInt32() > 0, "cpuCount");
            Check(d.GetProperty("pageSize").GetInt32() == Environment.SystemPageSize, "pageSize");
            Check(d.GetProperty("totalPhys").GetInt64() > 0, "totalPhys");
            Check(d.GetProperty("os").GetString()!.Split('.').Length == 3, "os");
            Check(d.GetProperty("elevated").ValueKind is JsonValueKind.True or JsonValueKind.False, "elevated");
            Check(d.GetProperty("debugPrivilege").ValueKind is JsonValueKind.True or JsonValueKind.False, "debugPrivilege");
            gpuCounters = d.GetProperty("gpuCounters").GetBoolean();
            int gpus = d.GetProperty("gpus").GetArrayLength();
            foreach (var g in d.GetProperty("gpus").EnumerateArray())
            {
                Check(g.GetProperty("luid").GetString()!.Length == 16, "gpu luid");
                Check(g.GetProperty("name").GetString() != null, "gpu name");
            }
            return $"os={d.GetProperty("os").GetString()} cpus={d.GetProperty("cpuCount").GetInt32()} elevated={d.GetProperty("elevated").GetBoolean()} debug={d.GetProperty("debugPrivilege").GetBoolean()} gpuCounters={gpuCounters} gpus={gpus}";
        });

        Test("snapshot", () =>
        {
            using (var r1 = CallOk("{\"cmd\":\"snapshot\"}"))
            {
                foreach (var row in r1.Data.GetProperty("procs").EnumerateArray())
                    Check(row[3].GetDouble() == 0, "first snapshot has zero cpu rates");
            }
            // ölçülebilir CPU kullanımı üret
            var sw = Stopwatch.StartNew();
            double x = 0;
            while (sw.ElapsedMilliseconds < 700) { for (int i = 1; i < 20000; i++) x += Math.Sqrt(i); }
            GC.KeepAlive(x);

            using var r = CallOk("{\"cmd\":\"snapshot\"}");
            var d = r.Data;
            var cols = d.GetProperty("cols");
            Check(cols.GetArrayLength() == Snapshot.Cols.Length, "cols length");
            for (int i = 0; i < Snapshot.Cols.Length; i++) Check(cols[i].GetString() == Snapshot.Cols[i], "cols order");
            Check(Math.Abs(d.GetProperty("t").GetInt64() - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) < 5000, "t is epoch ms");
            var sys = d.GetProperty("sys");
            Check(sys.GetProperty("memTotal").GetInt64() > 0 && sys.GetProperty("memAvail").GetInt64() > 0, "sys mem");
            Check(sys.GetProperty("commitLimit").GetInt64() >= sys.GetProperty("commitTotal").GetInt64() && sys.GetProperty("commitTotal").GetInt64() > 0, "sys commit");
            double sysCpu = sys.GetProperty("cpu").GetDouble();
            Check(sysCpu >= 0 && sysCpu <= 100, "sys.cpu range");

            using var me = Process.GetCurrentProcess();
            me.Refresh();
            Native.PROCESS_MEMORY_COUNTERS_EX pmc = default;
            pmc.cb = (uint)sizeof(Native.PROCESS_MEMORY_COUNTERS_EX);
            Native.K32GetProcessMemoryInfo(Native.GetCurrentProcess(), &pmc, pmc.cb);
            uint hc = 0;
            Native.GetProcessHandleCount(Native.GetCurrentProcess(), &hc);

            int n = 0;
            bool found = false;
            double myCpu = 0;
            string info = "";
            foreach (var row in d.GetProperty("procs").EnumerateArray())
            {
                n++;
                Check(row.GetArrayLength() == Snapshot.Cols.Length, "row length");
                uint pid = row[0].GetUInt32();
                Check(pid != 0, "pid 0 must not be listed");
                double cpu = row[3].GetDouble();
                Check(cpu >= 0 && cpu <= 100, "cpu range");
                if (pid != self) continue;
                found = true;
                myCpu = cpu;
                // SYSTEM_PROCESS_INFORMATION ofsetlerinin bağımsız kaynaklarla doğrulanması
                Check(string.Equals(row[2].GetString(), exeName, StringComparison.OrdinalIgnoreCase), $"name '{row[2].GetString()}' vs '{exeName}'");
                Check(Near(row[4].GetDouble(), (double)pmc.WorkingSetSize, 0.25, 4 << 20), $"ws {row[4].GetInt64()} vs {pmc.WorkingSetSize}");
                Check(Near(row[5].GetDouble(), (double)pmc.PrivateUsage, 0.25, 4 << 20), $"priv {row[5].GetInt64()} vs {pmc.PrivateUsage}");
                Check(Math.Abs(row[11].GetInt32() - me.Threads.Count) <= 4, $"threads {row[11].GetInt32()} vs {me.Threads.Count}");
                Check(Near(row[12].GetDouble(), hc, 0.25, 24), $"handles {row[12].GetInt32()} vs {hc}");
                long startMs = new DateTimeOffset(me.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
                Check(Math.Abs(row[13].GetInt64() - startMs) < 2000, $"start {row[13].GetInt64()} vs {startMs}");
                Check(row[14].GetInt32() == me.SessionId, $"session {row[14].GetInt32()} vs {me.SessionId}");
                Check(row[1].GetUInt32() != self, "ppid");
                info = $"self: ws={row[4].GetInt64()} priv={row[5].GetInt64()} threads={row[11].GetInt32()} handles={row[12].GetInt32()}";
            }
            Check(found, "own pid listed");
            Check(n > 5, "process count");
            Check(myCpu > 0 || sysCpu > 0, "cpu rate > 0 on second snapshot");
            return $"procs={n} sys.cpu={sysCpu.ToString(CultureInfo.InvariantCulture)} self.cpu={myCpu.ToString(CultureInfo.InvariantCulture)} {info}";
        });

        Test("detail", () =>
        {
            using var r = CallOk($"{{\"cmd\":\"detail\",\"pid\":{self}}}");
            var d = r.Data;
            Check(d.GetProperty("pid").GetUInt32() == self, "pid");
            Check(string.Equals(d.GetProperty("path").GetString(), exe, StringComparison.OrdinalIgnoreCase), $"path '{d.GetProperty("path").GetString()}'");
            Check(d.GetProperty("cmdline").GetString()!.Contains("--selftest"), "cmdline");
            Check(d.GetProperty("user").GetString()!.Length > 0, "user");
            Check(d.GetProperty("arch").GetString() == "x64", "arch");
            Check(d.GetProperty("priority").GetString() is "idle" or "below" or "normal" or "above" or "high" or "realtime", "priority");
            Check(!d.GetProperty("suspended").GetBoolean(), "suspended");
            Check(d.GetProperty("start").GetInt64() > 1500000000000, "start");
            var c = d.GetProperty("counters");
            foreach (string k in new[] { "handles", "gdi", "user", "pageFaults", "peakWs", "ws", "priv", "virt", "ioReadOps", "ioWriteOps", "ioOtherOps", "ioReadBytes", "ioWriteBytes", "ioOtherBytes", "kernelMs", "userMs" })
                Check(c.GetProperty(k).ValueKind == JsonValueKind.Number, "counters." + k);
            Check(c.GetProperty("ws").GetInt64() > 0 && c.GetProperty("peakWs").GetInt64() >= c.GetProperty("ws").GetInt64(), "ws/peakWs");
            Check(c.GetProperty("virt").GetInt64() > c.GetProperty("priv").GetInt64(), "virt > priv");
            Check(c.GetProperty("userMs").GetInt64() >= 300, $"userMs {c.GetProperty("userMs").GetInt64()} (burned ~700 ms)");
            Check(c.GetProperty("handles").GetInt32() > 0 && c.GetProperty("pageFaults").GetInt64() > 0, "handles/pageFaults");
            var f = d.GetProperty("file");
            Check(f.ValueKind == JsonValueKind.Object && f.GetProperty("size").GetInt64() == exeSize, "file.size");
            Check(f.GetProperty("modified").GetInt64() > 1500000000000, "file.modified");
            var th = d.GetProperty("threads");
            Check(th.GetArrayLength() > 0, "threads");
            bool hasRun = false;
            foreach (var t in th.EnumerateArray())
            {
                Check(t.GetProperty("tid").GetUInt32() != 0, "tid");
                Check(t.GetProperty("state").GetString() is "run" or "ready" or "wait" or "other", "thread state");
                if (t.GetProperty("state").GetString() == "run") hasRun = true;
            }
            Check(hasRun, "calling thread is in 'run' state");
            Check(d.GetProperty("windows").ValueKind == JsonValueKind.Array, "windows");
            return $"user={d.GetProperty("user").GetString()} priority={d.GetProperty("priority").GetString()} elevated={d.GetProperty("elevated").GetBoolean()} threads={th.GetArrayLength()} version={(f.GetProperty("version").ValueKind == JsonValueKind.String ? f.GetProperty("version").GetString() : "null")}";
        });

        Test("modules", () =>
        {
            using var r = CallOk($"{{\"cmd\":\"modules\",\"pid\":{self}}}");
            var m = r.Data.GetProperty("modules");
            Check(m.GetArrayLength() > 2, "module count");
            Check(string.Equals(m[0].GetProperty("path").GetString(), exe, StringComparison.OrdinalIgnoreCase), "first module is the exe");
            Check(m[0].GetProperty("size").GetInt64() > 0, "module size");
            firstModuleBase = m[0].GetProperty("base").GetString()!;
            Check(firstModuleBase.Length > 0 && firstModuleBase == firstModuleBase.ToLowerInvariant() && !firstModuleBase.StartsWith("0x"), "hex format");
            Check(ulong.Parse(firstModuleBase, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture) == (ulong)(nint)Native.GetModuleHandleW(null), "base == GetModuleHandle(null)");
            return $"count={m.GetArrayLength()} base={firstModuleBase}";
        });

        Test("memmap", () =>
        {
            using var r = CallOk($"{{\"cmd\":\"memmap\",\"pid\":{self}}}");
            var d = r.Data;
            Check(d.GetProperty("pageSize").GetInt32() == Environment.SystemPageSize, "pageSize");
            var cols = d.GetProperty("cols");
            for (int i = 0; i < Memory.Cols.Length; i++) Check(cols[i].GetString() == Memory.Cols[i], "cols order");
            ulong prevEnd = 0;
            int n = 0, named = 0, wsRegions = 0;
            bool exeSeen = false;
            long wsSum = 0;
            foreach (var row in d.GetProperty("regions").EnumerateArray())
            {
                n++;
                ulong b = ulong.Parse(row[0].GetString()!, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
                ulong size = row[1].GetUInt64();
                Check(b >= prevEnd, "regions ascending / non-overlapping");
                prevEnd = b + size;
                int state = row[2].GetInt32(), type = row[4].GetInt32();
                Check(state is 1 or 2 or 3, "state");
                Check(type is 0 or 1 or 2 or 3, "type");
                if (state == 3) Check(type == 0, "free has type 0");
                if (state != 1) Check(row[3].GetInt32() == 0, "protect 0 unless commit");
                int ws = row[5].GetInt32();
                if (ws > 0) { wsRegions++; wsSum += ws; }
                string name = row[6].GetString()!;
                if (type == 3 && name.Length > 0) named++;
                if (type == 3 && string.Equals(name, exe, StringComparison.OrdinalIgnoreCase)) exeSeen = true;
            }
            var t = d.GetProperty("totals");
            Check(t.GetProperty("commit").GetInt64() > 0 && t.GetProperty("reserve").GetInt64() > 0 && t.GetProperty("free").GetInt64() > 0, "totals");
            Check(t.GetProperty("image").GetInt64() > 0 && t.GetProperty("private").GetInt64() > 0, "totals by type");
            Check(t.GetProperty("ws").GetInt64() > 0, "totals.ws");
            Check(wsSum * Environment.SystemPageSize == t.GetProperty("ws").GetInt64(), "totals.ws == sum(wsPages) * pageSize");
            Check(named > 0, "image regions have names");
            Check(exeSeen, "own exe image region has a drive-letter path");
            return $"regions={n} namedImage={named} wsRegions={wsRegions} commit={t.GetProperty("commit").GetInt64()} ws={t.GetProperty("ws").GetInt64()} bytes={r.ByteLength}";
        });

        Test("readmem", () =>
        {
            Check(firstModuleBase.Length > 0, "needs module base");
            using var r = CallOk($"{{\"cmd\":\"readmem\",\"pid\":{self},\"addr\":\"{firstModuleBase}\",\"len\":4096}}");
            byte[] b = r.Data.GetProperty("b64").GetBytesFromBase64();
            Check(r.Data.GetProperty("len").GetInt32() == 4096 && b.Length == 4096, "len");
            Check(b[0] == (byte)'M' && b[1] == (byte)'Z', "MZ header");
            Check(r.Data.GetProperty("addr").GetString() == firstModuleBase, "addr echo");
            ExpectErr($"{{\"cmd\":\"readmem\",\"pid\":{self},\"addr\":\"8\",\"len\":16}}", "access");
            ExpectErr($"{{\"cmd\":\"readmem\",\"pid\":{self},\"addr\":\"{firstModuleBase}\",\"len\":65537}}", "bad_request");
            ExpectErr($"{{\"cmd\":\"readmem\",\"pid\":{self},\"addr\":\"zz\",\"len\":16}}", "bad_request");
            return "MZ ok, unreadable address = access";
        });

        Test("handles", () =>
        {
            using var fs = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var sw = Stopwatch.StartNew();
            using var r = CallOk($"{{\"cmd\":\"handles\",\"pid\":{self}}}");
            long ms = sw.ElapsedMilliseconds;
            var counts = r.Data.GetProperty("counts");
            int types = 0, total = 0;
            foreach (var p in counts.EnumerateObject()) { types++; total += p.Value.GetInt32(); }
            Check(types >= 3, "several handle types");
            Check(counts.TryGetProperty("File", out var fc) && fc.GetInt32() > 0, "counts.File");
            Check(counts.TryGetProperty("Event", out _) || counts.TryGetProperty("Thread", out _) || counts.TryGetProperty("Key", out _), "well-known type names");
            bool found = false;
            int nf = 0;
            foreach (var f in r.Data.GetProperty("files").EnumerateArray())
            {
                nf++;
                Check(f.GetProperty("kind").GetString() is "file" or "dir", "kind");
                if (string.Equals(f.GetProperty("path").GetString(), exe, StringComparison.OrdinalIgnoreCase))
                {
                    found = true;
                    Check(f.GetProperty("kind").GetString() == "file" && f.GetProperty("size").GetInt64() == exeSize, "file size");
                }
            }
            Check(found, "own open file listed in files");
            Check(ms < 7000, "time budget");
            return $"types={types} total={total} files={nf} ms={ms} unknown={(counts.TryGetProperty("Unknown", out var u) ? u.GetInt32() : 0)}";
        });

        Test("filemap", () =>
        {
            using var r = CallOk($"{{\"cmd\":\"filemap\",\"path\":{J(exe)}}}");
            var d = r.Data;
            Check(d.GetProperty("clusterSize").GetInt64() > 0, "clusterSize");
            Check(d.GetProperty("totalClusters").GetInt64() > 0, "totalClusters");
            Check(d.GetProperty("size").GetInt64() == exeSize, "size");
            Check(d.GetProperty("volume").GetString()!.EndsWith('\\'), "volume");
            int n = d.GetProperty("extents").GetArrayLength();
            bool resident = d.GetProperty("resident").GetBoolean();
            Check(n > 0 && !resident, "extents");
            long clusters = 0;
            foreach (var e in d.GetProperty("extents").EnumerateArray()) { Check(e[0].GetInt64() >= 0 && e[1].GetInt64() > 0, "extent"); clusters += e[1].GetInt64(); }
            long cs = d.GetProperty("clusterSize").GetInt64();
            Check(clusters * cs >= exeSize && (clusters - 1) * cs < exeSize + cs * 16, $"clusters {clusters} cover size {exeSize}");
            int frag = d.GetProperty("fragments").GetInt32();
            Check(frag >= 1 && frag <= n, "fragments");
            ExpectErr("{\"cmd\":\"filemap\"}", "bad_request");
            using (var miss = Call($"{{\"cmd\":\"filemap\",\"path\":{J(exe + ".does-not-exist")}}}")) Check(!miss.Ok && miss.Err == "failed", "missing file = failed");
            return $"volume={d.GetProperty("volume").GetString()} clusterSize={cs} extents={n} fragments={frag} clusters={clusters}";
        });

        Test("readfile", () =>
        {
            using var r = CallOk($"{{\"cmd\":\"readfile\",\"path\":{J(exe)},\"offset\":0,\"len\":64}}");
            byte[] b = r.Data.GetProperty("b64").GetBytesFromBase64();
            Check(b.Length == 64 && r.Data.GetProperty("len").GetInt32() == 64, "len");
            Check(b[0] == (byte)'M' && b[1] == (byte)'Z', "MZ");
            Check(r.Data.GetProperty("size").GetInt64() == exeSize, "size");
            using (var tail = CallOk($"{{\"cmd\":\"readfile\",\"path\":{J(exe)},\"offset\":{exeSize - 10},\"len\":4096}}"))
                Check(tail.Data.GetProperty("len").GetInt32() == 10 && tail.Data.GetProperty("b64").GetBytesFromBase64().Length == 10, "short read at end of file");
            ExpectErr($"{{\"cmd\":\"readfile\",\"path\":{J(exe + ".does-not-exist")},\"offset\":0,\"len\":16}}", "access");
            ExpectErr($"{{\"cmd\":\"readfile\",\"path\":{J(exe)},\"offset\":0,\"len\":65537}}", "bad_request");
            return "MZ ok, tail read ok";
        });

        Test("capture", () =>
        {
            ExpectErr("{\"cmd\":\"capture\",\"hwnd\":\"7ffffff0\"}", "gone");
            ExpectErr("{\"cmd\":\"capture\"}", "bad_request");
            IntPtr hwnd;
            fixed (char* cls = "STATIC")
            fixed (char* title = "mp-agent selftest")
                hwnd = Native.CreateWindowExW(0x00000080 | 0x08000000 /* TOOLWINDOW | NOACTIVATE */, cls, title, 0x80000000 | 0x10000000 /* POPUP | VISIBLE */, 0, 0, 320, 200, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, null);
            if (hwnd == IntPtr.Zero) throw new Exception($"CreateWindowEx failed (win32 {Proto.LastError()}); no interactive window station?");
            try
            {
                string hx = Proto.Hex(hwnd);
                using (var r = CallOk($"{{\"cmd\":\"capture\",\"hwnd\":\"{hx}\"}}"))
                {
                    var d = r.Data;
                    Check(d.GetProperty("srcW").GetInt32() == 320 && d.GetProperty("srcH").GetInt32() == 200, "src size");
                    Check(d.GetProperty("w").GetInt32() == 320 && d.GetProperty("h").GetInt32() == 200, "out size");
                    Check(d.GetProperty("format").GetString() == "bgra" && !d.GetProperty("minimized").GetBoolean(), "format");
                    Check(d.GetProperty("title").GetString() == "mp-agent selftest", "title");
                    byte[] px = d.GetProperty("b64").GetBytesFromBase64();
                    Check(px.Length == 320 * 200 * 4, "pixel bytes");
                    for (int i = 3; i < px.Length; i += 4) if (px[i] != 255) throw new Exception("alpha != 255");
                }
                using (var r = CallOk($"{{\"cmd\":\"capture\",\"hwnd\":\"{hx}\",\"maxW\":64}}"))
                {
                    var d = r.Data;
                    Check(d.GetProperty("w").GetInt32() == 64 && d.GetProperty("h").GetInt32() == 40, "scaled size");
                    Check(d.GetProperty("b64").GetBytesFromBase64().Length == 64 * 40 * 4, "scaled bytes");
                }
                // kendi penceremiz detail.windows içinde görünmeli
                using (var r = CallOk($"{{\"cmd\":\"detail\",\"pid\":{self}}}"))
                {
                    bool seen = false;
                    foreach (var w in r.Data.GetProperty("windows").EnumerateArray())
                    {
                        if (w.GetProperty("hwnd").GetString() != hx) continue;
                        seen = true;
                        Check(w.GetProperty("cls").GetString() == "Static" || string.Equals(w.GetProperty("cls").GetString(), "STATIC", StringComparison.OrdinalIgnoreCase), "window class");
                        Check(w.GetProperty("visible").GetBoolean(), "visible");
                        var rc = w.GetProperty("rect");
                        Check(rc[2].GetInt32() == 320 && rc[3].GetInt32() == 200, "rect w/h");
                    }
                    Check(seen, "own window listed in detail.windows");
                }
            }
            finally { Native.DestroyWindow(hwnd); }
            return "320x200 ok, scaled 64x40 ok, listed in detail.windows";
        });

        Test("gpudetail", () =>
        {
            using var r = Call($"{{\"cmd\":\"gpudetail\",\"pid\":{self}}}");
            if (!gpuCounters)
            {
                Check(!r.Ok && r.Err == "unsupported", "unsupported when counters are missing");
                return "unsupported (no GPU counters on this system)";
            }
            Check(r.Ok, $"ok expected, got {r.Err}: {r.Msg}");
            return $"engines={r.Data.GetProperty("engines").GetArrayLength()} mem={r.Data.GetProperty("mem").GetArrayLength()}";
        });

        Test("control", () =>
        {
            foreach (string cmd in new[] { "kill", "suspend", "resume" })
                foreach (uint pid in new[] { self, 0u, 4u })
                    ExpectErr($"{{\"cmd\":\"{cmd}\",\"pid\":{pid}}}", "bad_request");
            foreach (uint pid in new[] { self, 0u, 4u })
                ExpectErr($"{{\"cmd\":\"priority\",\"pid\":{pid},\"value\":\"below\"}}", "bad_request");
            ExpectErr("{\"cmd\":\"priority\",\"pid\":4294967280,\"value\":\"realtime\"}", "bad_request");
            ExpectErr("{\"cmd\":\"priority\",\"pid\":4294967280,\"value\":\"below\"}", "gone");
            ExpectErr("{\"cmd\":\"kill\",\"pid\":4294967280}", "gone");
            ExpectErr("{\"cmd\":\"suspend\",\"pid\":4294967280}", "gone");
            ExpectErr("{\"cmd\":\"kill\"}", "bad_request");
            return "self / pid 0 / pid 4 refused, missing pid = gone";
        });

        Test("errors", () =>
        {
            ExpectErr("{\"cmd\":\"nope\"}", "bad_request");
            ExpectErr("{\"cmd\":\"detail\",\"pid\":4294967280}", "gone");
            ExpectErr("{\"cmd\":\"modules\",\"pid\":4294967280}", "gone");
            ExpectErr("{\"cmd\":\"memmap\",\"pid\":4294967280}", "gone");
            ExpectErr("{\"cmd\":\"handles\",\"pid\":4294967280}", "gone");
            ExpectErr("{\"cmd\":\"detail\"}", "bad_request");
            ExpectErr("{\"cmd\":\"detail\",\"pid\":\"12\"}", "bad_request");
            ExpectErr("{not json", "bad_request", 0);
            ExpectErr("[1,2]", "bad_request", 0);
            ExpectErr("{\"cmd\":\"hello\"}", "bad_request", 0);
            using (var sys = Call("{\"cmd\":\"detail\",\"pid\":4}"))
            {
                Check(sys.Ok, "detail of pid 4 still answers");
                Check(sys.Data.GetProperty("name").GetString() == "System", "pid 4 name");
            }
            return "bad_request / gone paths ok, pid 4 detail ok";
        });

        Test("leaks", () =>
        {
            uint Count() { uint c = 0; Native.GetProcessHandleCount(Native.GetCurrentProcess(), &c); return c; }
            void Round()
            {
                CallOk("{\"cmd\":\"snapshot\"}").Dispose();
                CallOk($"{{\"cmd\":\"detail\",\"pid\":{self}}}").Dispose();
                CallOk($"{{\"cmd\":\"modules\",\"pid\":{self}}}").Dispose();
                CallOk($"{{\"cmd\":\"memmap\",\"pid\":{self}}}").Dispose();
                CallOk($"{{\"cmd\":\"handles\",\"pid\":{self}}}").Dispose();
                CallOk($"{{\"cmd\":\"filemap\",\"path\":{J(exe)}}}").Dispose();
                CallOk($"{{\"cmd\":\"readfile\",\"path\":{J(exe)},\"offset\":0,\"len\":16}}").Dispose();
                Call("{\"cmd\":\"capture\",\"hwnd\":\"7ffffff0\"}").Dispose();
            }
            Round(); Round();
            GC.Collect(); GC.WaitForPendingFinalizers();
            uint before = Count();
            for (int i = 0; i < 10; i++) Round();
            GC.Collect(); GC.WaitForPendingFinalizers();
            uint after = Count();
            Check((long)after - before <= 8, $"handle count grew from {before} to {after} over 10 rounds");
            return $"handles before={before} after={after}";
        });

        Console.Out.WriteLine(_failed == 0 ? "SELFTEST OK" : $"SELFTEST FAILED ({_failed})");
        Console.Out.Flush();
        return _failed == 0 ? 0 : 1;
    }
}
