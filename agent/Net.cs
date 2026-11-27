using System.Text;
using System.Text.Json;

namespace MpAgent;

/// <summary>Ağ komutları (netcap, netconns, netwatch, netstream), soketlerin açılıp kapatılması ve anlık görüntüye giden sayaçlar.</summary>
internal static unsafe partial class Net
{
    private static bool _want, _capture, _wsa;
    private static string _reason = "off", _addrSig = "";
    private static int _error;
    private static readonly List<string> _errors = new();
    private static long _maintAt;
    private static Thread? _tick;
    private static readonly AutoResetEvent _tickWake = new(false);
    private static Dictionary<ulong, (ulong In, ulong Out)> _ifPrev = new();

    // ---- soketler (Gate altında) ----

    private static string Sig(List<LocalAddr> addrs)
    {
        var sb = new StringBuilder();
        foreach (var a in addrs) sb.Append(a.V).Append(':').Append(a.A0).Append(':').Append(a.A1).Append('@').Append(a.IfIndex).Append(',');
        return sb.ToString();
    }

    private static uint[] Modes()
    {
        string? m = Environment.GetEnvironmentVariable("MP_NET_RCVALL");
        if (m == "on") return new uint[] { 1 };
        if (m == "iplevel") return new uint[] { 3 };
        return new uint[] { 3, 1 }; // RCVALL_IPLEVEL: kart karışık kipe alınmaz; olmazsa RCVALL_ON
    }

    private static Sock? Open(in LocalAddr a, out int err, out string step)
    {
        err = 0;
        step = "socket";
        nuint s = Native.socket(a.V == 4 ? Native.AF_INET : Native.AF_INET6, Native.SOCK_RAW, a.V == 4 ? Native.IPPROTO_IP : Native.IPPROTO_IPV6);
        if (s == Native.INVALID_SOCKET) { err = Proto.LastError(); return null; }
        byte* sa = stackalloc byte[28];
        new Span<byte>(sa, 28).Clear();
        int len;
        if (a.V == 4) { *(ushort*)sa = 2; *(uint*)(sa + 4) = (uint)a.A0; len = 16; }
        else { *(ushort*)sa = 23; *(ulong*)(sa + 8) = a.A0; *(ulong*)(sa + 16) = a.A1; *(uint*)(sa + 24) = a.Scope; len = 28; }
        step = "bind";
        if (Native.bind(s, sa, len) != 0) { err = Proto.LastError(); Native.closesocket(s); return null; }
        int rcvbuf = 8 << 20;
        Native.setsockopt(s, Native.SOL_SOCKET, Native.SO_RCVBUF, (byte*)&rcvbuf, 4);
        step = "rcvall";
        string mode = "";
        foreach (uint opt in Modes())
        {
            uint v = opt, ret = 0;
            if (Native.WSAIoctl(s, Native.SIO_RCVALL, &v, 4, null, 0, &ret, null, null) == 0) { mode = opt == 3 ? "iplevel" : "on"; break; }
            err = Proto.LastError();
        }
        if (mode.Length == 0) { Native.closesocket(s); return null; }
        err = 0;
        return new Sock { S = s, V = a.V, IfIndex = a.IfIndex, Addr = NetTables.Addr(a.V, a.A0, a.A1), Mode = mode };
    }

    private static void StartSockets()
    {
        _errors.Clear();
        _error = 0;
        _capture = false;
        if (!_wsa)
        {
            byte* data = stackalloc byte[512];
            int rc = Native.WSAStartup(0x0202, data);
            if (rc != 0) { _reason = "failed"; _error = rc; _errors.Add("WSAStartup err=" + rc); return; }
            _wsa = true;
        }
        var addrs = NetTables.LocalAddrs();
        var l4 = new HashSet<uint>();
        var l6 = new HashSet<(ulong, ulong)>();
        foreach (var a in addrs) { if (a.V == 4) l4.Add((uint)a.A0); else l6.Add((a.A0, a.A1)); }
        _local4 = l4;
        _local6 = l6;
        _addrSig = Sig(addrs);
        var names = new Dictionary<uint, string>();
        foreach (var r in NetTables.Interfaces()) names[r.Index] = r.Alias;

        var seen = new HashSet<(uint, byte)>();
        bool denied = false;
        int candidates = 0;
        // İkinci geçiş: yönlendirilebilir IPv6 adresi olmayan arayüzlerde bağlantı-yerel (fe80::/10) adres kullanılır.
        for (int pass = 0; pass < 2; pass++)
        foreach (var a in addrs)
        {
            if (a.V == 4 && (a.A0 & 0xFFFF) == 0xFEA9) continue; // 169.254.x.x
            bool linkLocal = a.V == 6 && (a.A0 & 0xC0FF) == 0x80FE; // fe80::/10
            if (linkLocal != (pass == 1) || (linkLocal && a.Scope == 0)) continue;
            candidates++;
            if (!seen.Add((a.IfIndex, a.V))) continue; // arayüz ve adres ailesi başına tek soket
            var sk = Open(a, out int err, out string step);
            if (sk == null)
            {
                seen.Remove((a.IfIndex, a.V));
                if (err == Native.WSAEACCES) denied = true;
                if (_error == 0) _error = err;
                if (_errors.Count < 16) _errors.Add($"v{a.V} if={a.IfIndex} {step} err={err}");
                continue;
            }
            Sock live = sk;
            live.Name = names.TryGetValue(a.IfIndex, out var nm) ? nm : "";
            _socks.Add(live);
            live.T = new Thread(() => ThreadMain(live)) { IsBackground = true, Name = "net-" + a.IfIndex };
            live.T.Start();
        }
        // geri döngü (127.0.0.1, ::1): aynı bilgisayardaki süreçler arası trafik. Açılamazsa yalnız not düşülür.
        uint loIndex = 1;
        foreach (var r in NetTables.Interfaces()) if (r.Type == 24) { loIndex = r.Index; break; }
        if (Environment.GetEnvironmentVariable("MP_NET_LOOPBACK") != "off")
        {
            foreach (var a in new[]
            {
                new LocalAddr { V = 4, A0 = 0x0100007FUL, IfIndex = loIndex },
                new LocalAddr { V = 6, A0 = 0, A1 = 0x0100000000000000UL, IfIndex = loIndex },
            })
            {
                var sk = Open(a, out int err, out string step);
                if (sk == null)
                {
                    if (err == Native.WSAEACCES) denied = true;
                    if (_errors.Count < 16) _errors.Add($"v{a.V} loopback {step} err={err}");
                    continue;
                }
                Sock live = sk;
                live.Name = names.TryGetValue(a.IfIndex, out var nm) ? nm : "loopback";
                live.Loopback = true;
                _socks.Add(live);
                live.T = new Thread(() => ThreadMain(live)) { IsBackground = true, Name = "net-lo" };
                live.T.Start();
            }
        }
        if (_socks.Count > 0)
        {
            _capture = true; _reason = "ok";
            if (_tick == null)
            {
                _tick = new Thread(TickMain) { IsBackground = true, Name = "net-tick" };
                _tick.Start();
            }
        }
        else _reason = denied ? "elevation" : candidates == 0 ? "nonet" : "failed";
    }

    /// <summary>
    /// Yakalama açıkken çalışır: paket gelmese de sahibi bekleyen akışları yeniden dener, eksik parça bekleyen
    /// akışları ilerletir, eskileri atar. Kısa bağlantılarda son paketten sonra başka paket gelmez; bu yüzden
    /// eşleme yalnız paket varışına bırakılamaz.
    /// </summary>
    private static void TickMain()
    {
        while (true)
        {
            int wait = 500;
            lock (Gate)
            {
                if (!_capture) { _tick = null; return; }
                try
                {
                    long now = Clock();
                    long next = ResolvePending(now);
                    FlushStale(now);
                    if (now - _sweepAt >= 5000) Sweep(now, false);
                    if (next >= 0) wait = (int)Math.Clamp(next, 4, 500);
                    if (_pendFlows.Count > 0) wait = Math.Min(wait, 250);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("mp-agent: net tick error: " + ex.Message);
                }
            }
            _tickWake.WaitOne(wait);
        }
    }

    private static List<Thread>? StopSockets()
    {
        if (_socks.Count == 0) return null;
        var list = new List<Thread>();
        foreach (var sk in _socks)
        {
            sk.Stop = true;
            Native.closesocket(sk.S); // bekleyen recv hata ile döner
            if (sk.T != null) list.Add(sk.T);
        }
        _socks.Clear();
        _capture = false;
        _tickWake.Set();
        return list;
    }

    /// <summary>Gate dışında çağrılır: iş parçacıkları paket işlerken Gate'i alır.</summary>
    private static void Join(List<Thread>? threads)
    {
        if (threads == null) return;
        foreach (var t in threads) t.Join(500);
    }

    // ---- komutlar ----

    private static bool ReadPids(JsonElement req, HashSet<uint> set)
    {
        if (req.TryGetProperty("pids", out var arr))
        {
            if (arr.ValueKind != JsonValueKind.Array || arr.GetArrayLength() > 256)
                throw AgentException.BadRequest("'pids' must be an array of at most 256 process ids");
            foreach (var el in arr.EnumerateArray())
            {
                if (el.ValueKind != JsonValueKind.Number || !el.TryGetUInt32(out uint p)) throw AgentException.BadRequest("invalid process id in 'pids'");
                if (p != 0) set.Add(p);
            }
            return true;
        }
        if (req.TryGetProperty("pid", out var pe))
        {
            if (pe.ValueKind != JsonValueKind.Number || !pe.TryGetUInt32(out uint p)) throw AgentException.BadRequest("missing or invalid 'pid'");
            if (p != 0) set.Add(p);
            return true;
        }
        return false;
    }

    private static void WriteWatch(Utf8JsonWriter w)
    {
        var list = new List<uint>(_watch);
        list.Sort();
        w.WriteStartArray("watch");
        foreach (uint p in list) w.WriteNumberValue(p);
        w.WriteEndArray();
        w.WriteBoolean("capture", _capture);
    }

    public static void HandleCap(JsonElement req, Utf8JsonWriter w)
    {
        if (req.TryGetProperty("on", out var on))
        {
            if (on.ValueKind != JsonValueKind.True && on.ValueKind != JsonValueKind.False) throw AgentException.BadRequest("'on' must be a boolean");
            List<Thread>? join = null;
            lock (Gate)
            {
                if (on.ValueKind == JsonValueKind.True)
                {
                    _want = true;
                    if (!_capture) StartSockets();
                }
                else
                {
                    _want = false;
                    join = StopSockets();
                    _reason = "off";
                    _error = 0;
                    _errors.Clear();
                    _flows.Clear();
                    _pendFlows.Clear();
                    _unres.Clear();
                    _counters.Clear();
                    _heldBytes = 0;
                }
            }
            Join(join);
        }
        lock (Gate)
        {
            w.WriteStartObject();
            w.WriteBoolean("capture", _capture);
            w.WriteString("reason", _reason);
            w.WriteBoolean("elevated", Detail.SelfElevated());
            if (_error != 0) w.WriteNumber("error", _error);
            w.WriteStartArray("ifaces");
            foreach (var sk in _socks)
            {
                w.WriteStartObject();
                w.WriteString("name", Proto.Clean(sk.Name));
                w.WriteString("addr", sk.Addr);
                w.WriteNumber("v", sk.V);
                w.WriteString("mode", sk.Mode);
                w.WriteNumber("packets", sk.Packets);
                if (sk.Loopback) w.WriteBoolean("loopback", true);
                if (sk.Head != null) w.WriteString("head", sk.Head);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteStartArray("errors");
            foreach (string e in _errors) w.WriteStringValue(e);
            w.WriteEndArray();
            w.WriteEndObject();
        }
    }

    private static void WriteEnds(Utf8JsonWriter w, byte proto, byte v, string local, ushort lport, string remote, ushort rport)
    {
        w.WriteString("proto", proto == 6 ? "tcp" : "udp");
        w.WriteNumber("v", v);
        w.WriteString("local", local);
        w.WriteNumber("lport", lport);
        w.WriteString("remote", remote);
        w.WriteNumber("rport", rport);
    }

    private static void FlowTexts(Flow f)
    {
        f.LocalText ??= NetTables.Addr(f.Key.V, f.Key.L0, f.Key.L1);
        f.RemoteText ??= NetTables.Addr(f.Key.V, f.Key.R0, f.Key.R1);
    }

    public static void HandleConns(JsonElement req, Utf8JsonWriter w)
    {
        var filter = new HashSet<uint>();
        bool all = req.TryGetProperty("all", out var allEl) && allEl.ValueKind == JsonValueKind.True;
        if (!all && !ReadPids(req, filter)) throw AgentException.BadRequest("missing 'pid', 'pids' or 'all'");
        lock (Gate)
        {
            long now = Clock();
            RefreshTables(now);
            var used = new HashSet<Flow>();
            var udpSum = new Dictionary<(uint, ushort), (long Rx, long Tx)>();
            foreach (var f in _flows.Values)
            {
                if (f.Key.Proto != 17 || f.Pid == 0) continue;
                udpSum.TryGetValue((f.Pid, f.Key.LPort), out var s);
                udpSum[(f.Pid, f.Key.LPort)] = (s.Rx + f.Rx, s.Tx + f.Tx);
            }
            int n = 0;
            bool truncated = false;
            w.WriteStartObject();
            w.WriteBoolean("capture", _capture);
            w.WriteStartArray("conns");
            foreach (var r in _rows)
            {
                if (!all && !filter.Contains(r.Pid)) continue;
                if (n >= 2000) { truncated = true; break; }
                Flow? f = null;
                long rx = 0, tx = 0;
                string state;
                if (r.Proto == 6)
                {
                    state = NetTables.TcpState(r.State);
                    if (r.State != NetTables.TcpListen)
                    {
                        if (!_flows.TryGetValue(new FlowKey(r.V, 6, r.L0, r.L1, r.R0, r.R1, r.LPort, r.RPort), out f)
                            && r.V == 6 && NetTables.IsMapped(r.L0, r.L1) && NetTables.IsMapped(r.R0, r.R1))
                            _flows.TryGetValue(new FlowKey(4, 6, r.L1 >> 32, 0, r.R1 >> 32, 0, r.LPort, r.RPort), out f);
                        if (f != null) { rx = f.Rx; tx = f.Tx; used.Add(f); }
                    }
                }
                else
                {
                    state = "bound";
                    if (udpSum.TryGetValue((r.Pid, r.LPort), out var s)) { rx = s.Rx; tx = s.Tx; }
                }
                bool remote = r.Proto == 6 && r.State != NetTables.TcpListen;
                w.WriteStartObject();
                w.WriteNumber("pid", r.Pid);
                WriteEnds(w, r.Proto, r.V, NetTables.Addr(r.V, r.L0, r.L1), r.LPort, remote ? NetTables.Addr(r.V, r.R0, r.R1) : "", r.RPort);
                w.WriteString("state", state);
                w.WriteNumber("rx", rx);
                w.WriteNumber("tx", tx);
                if (f != null) w.WriteNumber("flow", f.Id);
                w.WriteEndObject();
                n++;
            }
            if (!truncated)
            {
                // tabloda satırı olmayanlar: uzak ucu yakalamadan bilinen UDP akışları ve yeni kapanmış TCP bağlantıları
                foreach (var f in _flows.Values)
                {
                    if (f.Pid == 0 || used.Contains(f) || now - f.Last > 60000) continue;
                    if (!all && !filter.Contains(f.Pid)) continue;
                    if (n >= 2000) { truncated = true; break; }
                    FlowTexts(f);
                    w.WriteStartObject();
                    w.WriteNumber("pid", f.Pid);
                    WriteEnds(w, f.Key.Proto, f.Key.V, f.LocalText!, f.Key.LPort, f.RemoteText!, f.Key.RPort);
                    w.WriteString("state", f.Key.Proto == 6 && f.Closed ? "closed" : "active");
                    w.WriteNumber("rx", f.Rx);
                    w.WriteNumber("tx", f.Tx);
                    w.WriteNumber("flow", f.Id);
                    w.WriteEndObject();
                    n++;
                }
            }
            w.WriteEndArray();
            w.WriteBoolean("truncated", truncated);
            w.WriteEndObject();
        }
    }

    public static void HandleWatch(JsonElement req, Utf8JsonWriter w)
    {
        var set = new HashSet<uint>();
        if (!ReadPids(req, set)) throw AgentException.BadRequest("missing 'pid' or 'pids'");
        bool reset = req.TryGetProperty("reset", out var re) && re.ValueKind == JsonValueKind.True;
        lock (Gate)
        {
            if (!set.SetEquals(_watch))
            {
                _watch = set;
                ResetStreams(); // yarım kalan sıralama durumu yeni izleme kümesinde yanlış boşluk üretmesin
            }
            if (reset || set.Count == 0) ClearRing();
            w.WriteStartObject();
            WriteWatch(w);
            w.WriteNumber("next", _nextSeq - 1);
            w.WriteEndObject();
        }
    }

    public static void HandleStream(JsonElement req, Utf8JsonWriter w)
    {
        long since = Proto.ReqInt(req, "since", 0);
        long max = Proto.ReqInt(req, "max", 262144);
        if (since < 0) throw AgentException.BadRequest("invalid 'since'");
        max = Math.Clamp(max, 4096, 1 << 20);
        lock (Gate)
        {
            long clock = Clock();
            ResolvePending(clock);
            FlushStale(clock);
            long last = _nextSeq - 1;
            long first = _ringCount > 0 ? _ring[_ringHead]!.Seq : _nextSeq;
            long next = Math.Min(Math.Max(since, first - 1), last);
            bool more = false;
            long bytes = 0;
            int count = 0;
            w.WriteStartObject();
            WriteWatch(w);
            w.WriteNumber("now", clock); // parçaların "t" alanıyla aynı saat: arayüz duvar saatine çevirir
            w.WriteNumber("first", first);
            w.WriteNumber("dropped", _dropped);
            w.WriteStartArray("chunks");
            for (long seq = next + 1; seq <= last; seq++)
            {
                var c = _ring[(_ringHead + (int)(seq - first)) & (RingCap - 1)]!;
                if (count > 0 && (bytes + c.Data.Length > max || count >= 2000)) { more = true; break; }
                var f = c.Fl;
                FlowTexts(f);
                w.WriteStartObject();
                w.WriteNumber("seq", c.Seq);
                w.WriteNumber("t", c.T);
                w.WriteNumber("pid", c.Pid);
                w.WriteNumber("flow", f.Id);
                w.WriteString("dir", c.In ? "in" : "out");
                WriteEnds(w, f.Key.Proto, f.Key.V, f.LocalText!, f.Key.LPort, f.RemoteText!, f.Key.RPort);
                w.WriteNumber("f", c.F);
                w.WriteBase64String("b64", c.Data);
                w.WriteEndObject();
                bytes += c.Data.Length;
                count++;
                next = seq;
            }
            w.WriteEndArray();
            w.WriteNumber("next", next);
            w.WriteBoolean("more", more);
            w.WriteEndObject();
        }
    }

    // ---- anlık görüntü ----

    public static bool Capturing { get { lock (Gate) return _capture; } }

    /// <summary>Her anlık görüntüde: eski akışları atar; adresler değişmişse ya da bir soket ölmüşse soketleri yeniden açar.</summary>
    public static void Maintain()
    {
        long now = Clock();
        List<Thread>? join = null;
        lock (Gate)
        {
            if (now - _sweepAt >= 5000) Sweep(now, false);
            if (!_want || now - _maintAt < 3000) return;
            _maintAt = now;
            if (_reason == "elevation") return; // yetki yeniden başlatmadan değişmez
            bool dead = false;
            foreach (var sk in _socks) if (sk.Dead) dead = true;
            if (!dead && Sig(NetTables.LocalAddrs()) == _addrSig) return;
            join = StopSockets();
        }
        Join(join);
        lock (Gate) { if (_want && !_capture) StartSockets(); }
    }

    /// <summary>Süreç başına kümülatif bayt sayaçlarının kopyası; yaşamayan süreçlerin sayaçları silinir.</summary>
    public static Dictionary<uint, (long Rx, long Tx)> Counters(Dictionary<uint, long> live)
    {
        var res = new Dictionary<uint, (long Rx, long Tx)>();
        lock (Gate)
        {
            ResolvePending(Clock());
            List<uint>? gone = null;
            foreach (var kv in _counters)
            {
                if (live.ContainsKey(kv.Key)) res[kv.Key] = (kv.Value.Rx, kv.Value.Tx);
                else (gone ??= new List<uint>()).Add(kv.Key);
            }
            if (gone != null) foreach (uint p in gone) _counters.Remove(p);
        }
        return res;
    }

    /// <summary>Sistem geneli ağ hızı (B/sn): arayüz sayaçlarının farkından; yakalama gerektirmez.</summary>
    public static void SysRate(double elapsedSec, bool rates, out double rx, out double tx)
    {
        rx = 0; tx = 0;
        var ifs = NetTables.Interfaces();
        bool any = false;
        foreach (var r in ifs) if (NetTables.Counted(r)) { any = true; break; }
        var cur = new Dictionary<ulong, (ulong In, ulong Out)>();
        ulong dIn = 0, dOut = 0;
        foreach (var r in ifs)
        {
            if (any ? !NetTables.Counted(r) : !NetTables.CountedFallback(r)) continue;
            cur[r.Luid] = (r.In, r.Out);
            if (!_ifPrev.TryGetValue(r.Luid, out var p)) continue;
            if (r.In >= p.In) dIn += r.In - p.In;
            if (r.Out >= p.Out) dOut += r.Out - p.Out;
        }
        _ifPrev = cur;
        if (!rates || elapsedSec <= 0) return;
        rx = dIn / elapsedSec;
        tx = dOut / elapsedSec;
    }

    /// <summary>--netdiag: tabloların ham dökümü (yapı ofsetlerini ve arayüz seçimini doğrulamak için). Yakalama açmaz.</summary>
    public static int Diag()
    {
        var o = Console.Out;
        var ifs = NetTables.Interfaces();
        o.WriteLine($"interfaces: {ifs.Count}");
        foreach (var r in ifs)
        {
            if (r.Oper != 1 && r.In == 0 && r.Out == 0) continue;
            o.WriteLine($"  if index={r.Index} type={r.Type} oper={r.Oper} flags=0x{r.Flags:x2} hw={r.Hardware} filter={r.Filter} connector={r.Connector} counted={NetTables.Counted(r)} in={r.In} out={r.Out} alias=\"{r.Alias}\"");
        }
        var addrs = NetTables.LocalAddrs();
        o.WriteLine($"addresses: {addrs.Count}");
        foreach (var a in addrs) o.WriteLine($"  addr v{a.V} {NetTables.Addr(a.V, a.A0, a.A1)} if={a.IfIndex} scope={a.Scope}");
        var rows = NetTables.Query();
        int tcp4 = 0, tcp6 = 0, udp4 = 0, udp6 = 0, listen = 0;
        foreach (var r in rows)
        {
            if (r.Proto == 6) { if (r.V == 4) tcp4++; else tcp6++; if (r.State == NetTables.TcpListen) listen++; }
            else if (r.V == 4) udp4++;
            else udp6++;
        }
        o.WriteLine($"sockets: tcp4={tcp4} tcp6={tcp6} udp4={udp4} udp6={udp6} listening={listen}");
        int shown = 0;
        foreach (var r in rows)
        {
            if (r.Proto != 6 || shown >= 12) continue;
            o.WriteLine($"  tcp v{r.V} pid={r.Pid} {NetTables.Addr(r.V, r.L0, r.L1)}:{r.LPort} -> {NetTables.Addr(r.V, r.R0, r.R1)}:{r.RPort} {NetTables.TcpState(r.State)}");
            shown++;
        }
        return ifs.Count > 0 && rows.Count > 0 ? 0 : 1;
    }
}
