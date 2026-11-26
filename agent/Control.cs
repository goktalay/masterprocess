using System.Text.Json;

namespace MpAgent;

/// <summary>kill / suspend / resume / priority komutları.</summary>
internal static unsafe class Control
{
    private static uint TargetPid(JsonElement req)
    {
        uint pid = Proto.ReqPid(req);
        if (pid == 0 || pid == 4 || pid == Native.GetCurrentProcessId())
            throw AgentException.BadRequest($"process {pid} is protected from this command");
        return pid;
    }

    private static void Done(Utf8JsonWriter w)
    {
        w.WriteStartObject();
        w.WriteBoolean("done", true);
        w.WriteEndObject();
    }

    private static AgentException NtError(string what, uint status, uint pid) => status switch
    {
        0xC0000022 => AgentException.Access($"{what}: access denied to process {pid} (ntstatus 0xc0000022)"),
        0xC000010A => AgentException.Gone($"process {pid} is terminating"),
        _ => AgentException.Nt(what, status),
    };

    public static void Kill(JsonElement req, Utf8JsonWriter w)
    {
        uint pid = TargetPid(req);
        IntPtr h = Proto.OpenProcessOrThrow(pid, Native.PROCESS_TERMINATE | Native.SYNCHRONIZE | Native.PROCESS_QUERY_LIMITED_INFORMATION);
        try
        {
            Proto.ThrowIfExited(h, pid);
            if (Native.TerminateProcess(h, 1) == 0)
            {
                int err = Proto.LastError();
                if (Native.WaitForSingleObject(h, 0) == 0) throw AgentException.Gone($"process {pid} has exited");
                if (err == Native.ERROR_ACCESS_DENIED) throw AgentException.Access($"cannot terminate process {pid} (win32 5)");
                throw AgentException.Win32("TerminateProcess", err);
            }
            Native.WaitForSingleObject(h, 3000); // sonlanma tamamlansın; sonraki sorgular 'gone' görsün
            Done(w);
        }
        finally { Native.CloseHandle(h); }
    }

    public static void Suspend(JsonElement req, Utf8JsonWriter w) => SuspendResume(req, w, true);
    public static void Resume(JsonElement req, Utf8JsonWriter w) => SuspendResume(req, w, false);

    private static void SuspendResume(JsonElement req, Utf8JsonWriter w, bool suspend)
    {
        uint pid = TargetPid(req);
        IntPtr h = Proto.OpenProcessOrThrow(pid, Native.PROCESS_SUSPEND_RESUME | Native.PROCESS_QUERY_LIMITED_INFORMATION);
        try
        {
            Proto.ThrowIfExited(h, pid);
            uint st = suspend ? Native.NtSuspendProcess(h) : Native.NtResumeProcess(h);
            if (st != 0) throw NtError(suspend ? "NtSuspendProcess" : "NtResumeProcess", st, pid);
            Done(w);
        }
        finally { Native.CloseHandle(h); }
    }

    public static void Priority(JsonElement req, Utf8JsonWriter w)
    {
        uint pid = TargetPid(req);
        string value = Proto.ReqString(req, "value");
        uint cls = value switch
        {
            "idle" => 0x40,
            "below" => 0x4000,
            "normal" => 0x20,
            "above" => 0x8000,
            "high" => 0x80,
            "realtime" => throw AgentException.BadRequest("'realtime' priority is not allowed"),
            _ => throw AgentException.BadRequest("'value' must be one of idle|below|normal|above|high"),
        };
        IntPtr h = Proto.OpenProcessOrThrow(pid, Native.PROCESS_SET_INFORMATION | Native.PROCESS_QUERY_LIMITED_INFORMATION);
        try
        {
            Proto.ThrowIfExited(h, pid);
            if (Native.SetPriorityClass(h, cls) == 0)
            {
                int err = Proto.LastError();
                if (err == Native.ERROR_ACCESS_DENIED) throw AgentException.Access($"cannot set priority of process {pid} (win32 5)");
                throw AgentException.Win32("SetPriorityClass", err);
            }
            Done(w);
        }
        finally { Native.CloseHandle(h); }
    }
}
