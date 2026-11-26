using System.Globalization;
using System.Text.Json;

namespace MpAgent;

/// <summary>Protokol hata kodu taşıyan istisna; dağıtıcı bunu hata yanıtına çevirir.</summary>
internal sealed class AgentException : Exception
{
    public string Code { get; }
    public AgentException(string code, string message) : base(message) { Code = code; }

    public static AgentException BadRequest(string msg) => new("bad_request", msg);
    public static AgentException Gone(string msg) => new("gone", msg);
    public static AgentException Access(string msg) => new("access", msg);
    public static AgentException Unsupported(string msg) => new("unsupported", msg);
    public static AgentException Failed(string msg) => new("failed", msg);
    public static AgentException Win32(string what, int err) => new("failed", $"{what} failed (win32 {err})");
    public static AgentException Nt(string what, uint status) => new("failed", $"{what} failed (ntstatus 0x{status:x8})");
}

internal static unsafe class Proto
{
    public const string AgentVersion = "1.0.0";
    public const int ProtocolVersion = 1;

    /// <summary>Onaltılık dizge: 0x öneki yok, küçük harf, baştaki sıfırlar atılır.</summary>
    public static string Hex(ulong v) => v.ToString("x", CultureInfo.InvariantCulture);
    public static string Hex(nuint v) => ((ulong)v).ToString("x", CultureInfo.InvariantCulture);
    public static string Hex(IntPtr v) => ((ulong)(nuint)(nint)v).ToString("x", CultureInfo.InvariantCulture);

    /// <summary>LUID: 16 hane (yüksek 8 + düşük 8).</summary>
    public static string Luid(uint high, uint low) =>
        high.ToString("x8", CultureInfo.InvariantCulture) + low.ToString("x8", CultureInfo.InvariantCulture);

    /// <summary>FILETIME (100 ns, 1601) → Unix epoch ms; 0 ya da geçersizse 0.</summary>
    public static long FileTimeToMs(long ft)
    {
        const long EpochDiff = 116444736000000000L;
        if (ft <= EpochDiff) return 0;
        return (ft - EpochDiff) / 10000;
    }

    public static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public static double Round1(double v)
    {
        if (double.IsNaN(v) || double.IsInfinity(v) || v < 0) return 0;
        return Math.Round(v, 1);
    }

    public static double Pct(double v)
    {
        if (double.IsNaN(v) || double.IsInfinity(v) || v < 0) return 0;
        if (v > 100) v = 100;
        return Math.Round(v, 1);
    }

    /// <summary>Tek kalmış vekil (surrogate) kod birimlerini U+FFFD yapar; JSON yazıcısı bunlarda istisna atar.</summary>
    public static string Clean(string? s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        int i = 0;
        for (; i < s.Length; i++)
        {
            char c = s[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1])) { i++; continue; }
                break;
            }
            if (char.IsLowSurrogate(c)) break;
        }
        if (i == s.Length) return s;
        var a = s.ToCharArray();
        for (i = 0; i < a.Length; i++)
        {
            char c = a[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 < a.Length && char.IsLowSurrogate(a[i + 1])) { i++; continue; }
                a[i] = '�';
            }
            else if (char.IsLowSurrogate(c)) a[i] = '�';
        }
        return new string(a);
    }

    // ---- istek argümanları ----
    public static uint ReqPid(JsonElement req)
    {
        if (!req.TryGetProperty("pid", out var p) || p.ValueKind != JsonValueKind.Number || !p.TryGetInt64(out long v) || v < 0 || v > uint.MaxValue)
            throw AgentException.BadRequest("missing or invalid 'pid'");
        return (uint)v;
    }

    public static string ReqString(JsonElement req, string name)
    {
        if (!req.TryGetProperty(name, out var p) || p.ValueKind != JsonValueKind.String)
            throw AgentException.BadRequest($"missing or invalid '{name}'");
        string s = p.GetString() ?? "";
        if (s.Length == 0) throw AgentException.BadRequest($"empty '{name}'");
        return s;
    }

    public static ulong ReqHex(JsonElement req, string name)
    {
        string s = ReqString(req, name);
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s.Substring(2);
        if (s.Length == 0 || s.Length > 16 || !ulong.TryParse(s, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out ulong v))
            throw AgentException.BadRequest($"'{name}' is not a hex string");
        return v;
    }

    public static long ReqInt(JsonElement req, string name, long? def = null)
    {
        if (!req.TryGetProperty(name, out var p) || p.ValueKind == JsonValueKind.Null)
        {
            if (def.HasValue) return def.Value;
            throw AgentException.BadRequest($"missing '{name}'");
        }
        if (p.ValueKind != JsonValueKind.Number) throw AgentException.BadRequest($"'{name}' must be a number");
        if (p.TryGetInt64(out long v)) return v;
        if (p.TryGetDouble(out double d) && d >= long.MinValue && d <= long.MaxValue && Math.Floor(d) == d) return (long)d;
        throw AgentException.BadRequest($"'{name}' must be an integer");
    }

    // ---- süreç açma ----
    /// <summary>Süreci açar; açılamazsa protokol hatası atar (yok → gone, yetki → access).</summary>
    public static IntPtr OpenProcessOrThrow(uint pid, uint access)
    {
        IntPtr h = Native.OpenProcess(access, 0, pid);
        if (h != IntPtr.Zero) return h;
        int err = System.Runtime.InteropServices.Marshal.GetLastPInvokeError();
        throw OpenError(pid, err);
    }

    public static AgentException OpenError(uint pid, int err)
    {
        if (err == Native.ERROR_INVALID_PARAMETER) return AgentException.Gone($"process {pid} does not exist");
        if (err == Native.ERROR_ACCESS_DENIED) return AgentException.Access($"access denied to process {pid} (win32 5)");
        return AgentException.Win32("OpenProcess", err);
    }

    /// <summary>Süreç sonlanmış mı (tanıtıcısı başka biri tarafından açık tutulan "zombi" dahil). Bilinemiyorsa false.</summary>
    public static bool HasExited(uint pid)
    {
        IntPtr h = Native.OpenProcess(Native.SYNCHRONIZE, 0, pid);
        if (h != IntPtr.Zero)
        {
            bool exited = Native.WaitForSingleObject(h, 0) == 0;
            Native.CloseHandle(h);
            return exited;
        }
        h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (h != IntPtr.Zero)
        {
            uint code = 0;
            bool exited = Native.GetExitCodeProcess(h, &code) != 0 && code != 259;
            Native.CloseHandle(h);
            return exited;
        }
        return false;
    }

    /// <summary>Tanıtıcı açık ama süreç sonlanmışsa gone atar.</summary>
    public static void ThrowIfExited(IntPtr h, uint pid)
    {
        uint code = 0;
        if (Native.GetExitCodeProcess(h, &code) != 0 && code != 259)
            throw AgentException.Gone($"process {pid} has exited");
    }

    public static int LastError() => System.Runtime.InteropServices.Marshal.GetLastPInvokeError();
}
