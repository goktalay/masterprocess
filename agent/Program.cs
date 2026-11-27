using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace MpAgent;

internal static unsafe class Program
{
    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Indented = false,
        SkipValidation = false,
    };

    private static bool _debugPrivilege;

    private static int Main(string[] args)
    {
        if (args.Length > 0)
        {
            switch (args[0])
            {
                case "--version":
                case "-v":
                    Console.Out.WriteLine($"mp-agent {Proto.AgentVersion} (protocol {Proto.ProtocolVersion}, win-x64)");
                    return 0;
                case "--selftest":
                    Startup();
                    return SelfTest.Run();
                case "--netdiag":
                    Startup();
                    return Net.Diag();
                default:
                    Console.Error.WriteLine("usage: mp-agent [--version | --selftest | --netdiag]   (no arguments: NDJSON protocol server on stdin/stdout)");
                    return 2;
            }
        }
        Startup();
        return Serve();
    }

    private static void Startup()
    {
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // per-monitor v2: gerçek piksel boyutları
        try { _debugPrivilege = EnableDebugPrivilege(); } catch { _debugPrivilege = false; }
    }

    private static bool EnableDebugPrivilege()
    {
        IntPtr tok;
        if (Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ADJUST_PRIVILEGES | Native.TOKEN_QUERY, &tok) == 0) return false;
        try
        {
            long luid = 0;
            fixed (char* name = "SeDebugPrivilege")
                if (Native.LookupPrivilegeValueW(null, name, &luid) == 0) return false;
            // TOKEN_PRIVILEGES { DWORD count; LUID luid; DWORD attrs; } = 16 bayt
            byte* tp = stackalloc byte[16];
            *(uint*)tp = 1;
            *(long*)(tp + 4) = luid;
            *(uint*)(tp + 12) = 2; // SE_PRIVILEGE_ENABLED
            if (Native.AdjustTokenPrivileges(tok, 0, tp, 16, null, null) == 0) return false;
            return Proto.LastError() == 0; // ERROR_NOT_ALL_ASSIGNED (1300) → ayrıcalık yok
        }
        finally { Native.CloseHandle(tok); }
    }

    private static int Serve()
    {
        using var stdin = Console.OpenStandardInput();
        using var stdout = Console.OpenStandardOutput();
        using var reader = new StreamReader(stdin, new UTF8Encoding(false), detectEncodingFromByteOrderMarks: true, bufferSize: 65536);
        var buffer = new ArrayBufferWriter<byte>(1 << 16);
        using var writer = new Utf8JsonWriter(buffer, WriterOptions);

        while (true)
        {
            string? line;
            try { line = reader.ReadLine(); }
            catch (IOException) { break; }
            if (line == null) break;
            line = line.Trim().TrimStart('﻿');
            if (line.Length == 0) continue;

            Dispatch(line, buffer, writer);
            try
            {
                stdout.Write(buffer.WrittenSpan);
                stdout.WriteByte((byte)'\n');
                stdout.Flush();
            }
            catch (IOException) { break; } // arayüz kapandı
            buffer.Clear();
            if (buffer.Capacity > (64 << 20)) { buffer = new ArrayBufferWriter<byte>(1 << 16); writer.Reset(buffer); }
        }
        return 0;
    }

    /// <summary>Bir istek satırını işler; yanıt (tek JSON nesnesi, satır sonu yok) <paramref name="buffer"/>'a yazılır.</summary>
    internal static void Dispatch(string line, ArrayBufferWriter<byte> buffer, Utf8JsonWriter writer)
    {
        buffer.Clear();
        writer.Reset(buffer);
        long id = 0;
        JsonDocument? doc = null;
        try
        {
            try { doc = JsonDocument.Parse(line); }
            catch (JsonException) { throw AgentException.BadRequest("invalid JSON"); }
            JsonElement root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw AgentException.BadRequest("request must be a JSON object");
            if (!root.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt64(out id))
            {
                id = 0;
                throw AgentException.BadRequest("missing or invalid 'id'");
            }
            if (!root.TryGetProperty("cmd", out var cmdEl) || cmdEl.ValueKind != JsonValueKind.String)
                throw AgentException.BadRequest("missing or invalid 'cmd'");
            string cmd = cmdEl.GetString() ?? "";

            writer.WriteStartObject();
            writer.WriteNumber("id", id);
            writer.WriteBoolean("ok", true);
            writer.WritePropertyName("data");
            Run(cmd, root, writer);
            writer.WriteEndObject();
            writer.Flush();
        }
        catch (Exception ex)
        {
            string code, msg;
            if (ex is AgentException ae) { code = ae.Code; msg = ae.Message; }
            else
            {
                code = "failed";
                msg = ex.GetType().Name + ": " + ex.Message;
                Console.Error.WriteLine("mp-agent: unexpected error: " + ex);
            }
            buffer.Clear();
            writer.Reset(buffer);
            writer.WriteStartObject();
            writer.WriteNumber("id", id);
            writer.WriteBoolean("ok", false);
            writer.WriteString("err", code);
            writer.WriteString("msg", Proto.Clean(msg));
            writer.WriteEndObject();
            writer.Flush();
        }
        finally { doc?.Dispose(); }
    }

    private static void Run(string cmd, JsonElement req, Utf8JsonWriter w)
    {
        switch (cmd)
        {
            case "hello": Hello(w); break;
            case "snapshot": Snapshot.Handle(req, w); break;
            case "detail": Detail.Handle(req, w); break;
            case "modules": Detail.HandleModules(req, w); break;
            case "memmap": Memory.HandleMemMap(req, w); break;
            case "readmem": Memory.HandleReadMem(req, w); break;
            case "handles": Handles.Handle(req, w); break;
            case "filemap": FileMap.Handle(req, w); break;
            case "readfile": FileMap.HandleReadFile(req, w); break;
            case "capture": Capture.Handle(req, w); break;
            case "gpudetail": Gpu.HandleDetail(req, w); break;
            case "netcap": Net.HandleCap(req, w); break;
            case "netconns": Net.HandleConns(req, w); break;
            case "netwatch": Net.HandleWatch(req, w); break;
            case "netstream": Net.HandleStream(req, w); break;
            case "kill": Control.Kill(req, w); break;
            case "suspend": Control.Suspend(req, w); break;
            case "resume": Control.Resume(req, w); break;
            case "priority": Control.Priority(req, w); break;
            default: throw AgentException.BadRequest($"unknown command '{(cmd.Length > 40 ? cmd.Substring(0, 40) : cmd)}'");
        }
    }

    private static void Hello(Utf8JsonWriter w)
    {
        Native.SYSTEM_INFO si;
        Native.GetSystemInfo(&si);
        Native.MEMORYSTATUSEX ms = default;
        ms.dwLength = (uint)sizeof(Native.MEMORYSTATUSEX);
        Native.GlobalMemoryStatusEx(&ms);
        Native.RTL_OSVERSIONINFOW ver = default;
        ver.dwOSVersionInfoSize = (uint)sizeof(Native.RTL_OSVERSIONINFOW);
        string os = Native.RtlGetVersion(&ver) == 0
            ? $"{ver.dwMajorVersion}.{ver.dwMinorVersion}.{ver.dwBuildNumber}"
            : Environment.OSVersion.Version.ToString(3);

        w.WriteStartObject();
        w.WriteString("agent", Proto.AgentVersion);
        w.WriteNumber("protocol", Proto.ProtocolVersion);
        w.WriteNumber("pid", Native.GetCurrentProcessId());
        w.WriteBoolean("elevated", Detail.SelfElevated());
        w.WriteBoolean("debugPrivilege", _debugPrivilege);
        w.WriteString("arch", "x64");
        w.WriteString("os", os);
        w.WriteNumber("cpuCount", Snapshot.CpuCount);
        w.WriteNumber("pageSize", si.dwPageSize);
        w.WriteNumber("totalPhys", ms.ullTotalPhys);
        w.WriteBoolean("gpuCounters", Gpu.CountersAvailable);
        w.WriteBoolean("net", true);
        Gpu.WriteAdapters(w);
        w.WriteEndObject();
    }
}
