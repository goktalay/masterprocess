namespace MpAgent;

/// <summary>
/// Ağ yakalama: arayüz başına bir ham soket (SIO_RCVALL) yalnız dinler; yardımcı bağlantı kurmaz, paket göndermez.
/// Başlıklardan süreç başına bayt sayılır; izlenen süreçlerin yükleri bellekteki halka tamponda tutulur.
/// </summary>
internal static unsafe partial class Net
{
    internal static readonly object Gate = new();

    private const int F_SYN = 1, F_FIN = 2, F_RST = 4, F_GAP = 8;
    private const int MaxFlows = 20000;
    private const int RingCap = 1 << 15;
    private const long RingMaxBytes = 16L << 20;
    private const int HeldPerFlow = 64 << 10;
    private const long HeldMaxBytes = 8L << 20;
    private const int PendingMaxCount = 32;
    private const int PendingMaxBytes = 256 << 10;

    private sealed class Sock
    {
        public nuint S;
        public byte V;
        public uint IfIndex;
        public string Addr = "", Mode = "", Name = "";
        public string? Head; // ilk paketin ilk 8 baytı (IP başlığının başı): tanılama için
        public long Packets;
        public volatile bool Stop;
        public volatile bool Dead;
        public Thread? T;
    }

    private sealed class Dir
    {
        public bool Has, HasFin;
        public uint Next, FinSeq;
        public List<(uint Seq, byte[] Data)>? Pending;
        public int PendingBytes;
        public long PendingSince;

        public void Reset()
        {
            Has = false; HasFin = false; Next = 0; FinSeq = 0;
            Pending = null; PendingBytes = 0; PendingSince = 0;
        }
    }

    private sealed class Flow
    {
        public int Id;
        public FlowKey Key;
        public uint Pid;
        public long Rx, Tx, PendRx, PendTx;
        public long Last, NextTry, Resolved;
        public int Tries;
        public bool Closed, FinIn, FinOut;
        public readonly Dir In = new(), Out = new();
        public List<Chunk>? Held;
        public int HeldBytes;
        public long HeldSince;
        public string? LocalText, RemoteText;
    }

    private sealed class Chunk
    {
        public long Seq, T;
        public uint Pid;
        public Flow Fl = null!;
        public bool In;
        public int F;
        public byte[] Data = Array.Empty<byte>();
    }

    private sealed class Counter { public long Rx, Tx; }

    private static readonly List<Sock> _socks = new();
    private static readonly Dictionary<FlowKey, Flow> _flows = new();
    private static readonly HashSet<Flow> _pendFlows = new();
    private static readonly Dictionary<uint, Counter> _counters = new();
    private static HashSet<uint> _local4 = new();
    private static HashSet<(ulong, ulong)> _local6 = new();
    private static HashSet<uint> _watch = new();

    private static readonly Dictionary<FlowKey, uint> _tcp = new();
    private static readonly Dictionary<EpKey, uint> _listen = new();
    private static readonly Dictionary<EpKey, uint> _udp = new();
    private static List<ConnRow> _rows = new();
    private static long _tablesAt = -100000;

    private static readonly Chunk?[] _ring = new Chunk?[RingCap];
    private static int _ringHead, _ringCount, _flowId;
    private static long _ringBytes, _nextSeq = 1, _dropped, _heldBytes, _sweepAt;

    // ---- soket sahipliği ----

    private static void RefreshTables(long now)
    {
        _rows = NetTables.Query();
        _tcp.Clear(); _listen.Clear(); _udp.Clear();
        foreach (var r in _rows)
        {
            if (r.Pid == 0) continue;
            if (r.Proto == 17) _udp[new EpKey(r.V, 17, r.L0, r.L1, r.LPort)] = r.Pid;
            else if (r.State == NetTables.TcpListen) _listen[new EpKey(r.V, 6, r.L0, r.L1, r.LPort)] = r.Pid;
            else _tcp[new FlowKey(r.V, 6, r.L0, r.L1, r.R0, r.R1, r.LPort, r.RPort)] = r.Pid;
        }
        _tablesAt = now;
    }

    private static uint Lookup(in FlowKey k)
    {
        uint pid;
        if (k.Proto == 6)
        {
            if (_tcp.TryGetValue(k, out pid)) return pid;
            // çift yığınlı (IPv6) soket üzerindeki IPv4 bağlantısı tabloda ::ffff:a.b.c.d olarak durur
            if (k.V == 4 && _tcp.TryGetValue(new FlowKey(6, 6, 0, NetTables.Map4(k.L0), 0, NetTables.Map4(k.R0), k.LPort, k.RPort), out pid)) return pid;
            if (_listen.TryGetValue(new EpKey(k.V, 6, k.L0, k.L1, k.LPort), out pid)) return pid;
            if (k.V == 4 && _listen.TryGetValue(new EpKey(4, 6, 0, 0, k.LPort), out pid)) return pid;
            if (_listen.TryGetValue(new EpKey(6, 6, 0, 0, k.LPort), out pid)) return pid;
            return 0;
        }
        if (_udp.TryGetValue(new EpKey(k.V, 17, k.L0, k.L1, k.LPort), out pid)) return pid;
        if (k.V == 4 && _udp.TryGetValue(new EpKey(4, 17, 0, 0, k.LPort), out pid)) return pid;
        if (_udp.TryGetValue(new EpKey(6, 17, 0, 0, k.LPort), out pid)) return pid;
        return 0;
    }

    private static Counter CounterFor(uint pid)
    {
        if (!_counters.TryGetValue(pid, out var c)) { c = new Counter(); _counters[pid] = c; }
        return c;
    }

    private static void DropHeld(Flow f)
    {
        if (f.Held == null) return;
        _heldBytes -= f.HeldBytes;
        f.Held = null; f.HeldBytes = 0;
    }

    private static void TryResolve(Flow f, long now)
    {
        uint pid = Lookup(f.Key);
        if (pid == 0 && now - _tablesAt >= 20) { RefreshTables(now); pid = Lookup(f.Key); }
        if (pid == 0)
        {
            f.Tries = Math.Min(f.Tries + 1, 8);
            f.NextTry = now + (10L << f.Tries); // 20 ms … 2,5 sn
            return;
        }
        f.Pid = pid;
        f.Resolved = now;
        if (f.PendRx != 0 || f.PendTx != 0)
        {
            var c = CounterFor(pid);
            c.Rx += f.PendRx; c.Tx += f.PendTx;
            f.PendRx = 0; f.PendTx = 0;
        }
        if (f.Held != null)
        {
            var held = f.Held;
            DropHeld(f);
            if (_watch.Contains(pid)) foreach (var ch in held) { ch.Pid = pid; Push(ch); }
        }
    }

    // ---- halka tampon ----

    private static void Push(Chunk c)
    {
        c.Seq = _nextSeq++;
        while (_ringCount > 0 && (_ringCount >= RingCap || _ringBytes + c.Data.Length > RingMaxBytes))
        {
            var old = _ring[_ringHead]!;
            _ring[_ringHead] = null;
            _ringHead = (_ringHead + 1) & (RingCap - 1);
            _ringCount--;
            _ringBytes -= old.Data.Length;
            _dropped++;
        }
        _ring[(_ringHead + _ringCount) & (RingCap - 1)] = c;
        _ringCount++;
        _ringBytes += c.Data.Length;
    }

    private static void ClearRing()
    {
        Array.Clear(_ring);
        _ringHead = 0; _ringCount = 0; _ringBytes = 0;
    }

    private static void Emit(Flow f, bool inbound, ReadOnlySpan<byte> data, int flags)
    {
        long t = Proto.NowMs();
        int off = 0;
        do
        {
            int n = Math.Min(data.Length - off, 65536);
            var ch = new Chunk { T = t, Pid = f.Pid, Fl = f, In = inbound, F = flags, Data = n > 0 ? data.Slice(off, n).ToArray() : Array.Empty<byte>() };
            flags &= ~F_GAP;
            off += n;
            if (f.Pid != 0) Push(ch);
            else if (f.HeldBytes + n <= HeldPerFlow && _heldBytes + n <= HeldMaxBytes)
            {
                if (f.Held == null) { f.Held = new List<Chunk>(); f.HeldSince = Environment.TickCount64; }
                f.Held.Add(ch);
                f.HeldBytes += n; _heldBytes += n;
            }
        } while (off < data.Length);
    }

    // ---- TCP sıralama ----

    private static void Drain(Flow f, bool inbound, Dir d)
    {
        var pend = d.Pending;
        while (pend != null && pend.Count > 0)
        {
            int best = -1;
            for (int i = 0; i < pend.Count; i++)
                if ((int)(pend[i].Seq - d.Next) <= 0) { best = i; break; }
            if (best < 0) break;
            var (seq, data) = pend[best];
            pend.RemoveAt(best);
            d.PendingBytes -= data.Length;
            int skip = (int)(d.Next - seq);
            if (skip < data.Length)
            {
                Emit(f, inbound, new ReadOnlySpan<byte>(data, skip, data.Length - skip), 0);
                d.Next += (uint)(data.Length - skip);
            }
        }
        if (pend == null || pend.Count == 0) { d.Pending = null; d.PendingBytes = 0; _pendFlows.Remove(f); if (HasPending(f)) _pendFlows.Add(f); }
        if (d.HasFin && d.FinSeq == d.Next)
        {
            d.HasFin = false;
            d.Next++;
            Emit(f, inbound, default, F_FIN);
        }
    }

    private static bool HasPending(Flow f) => f.In.Pending != null || f.Out.Pending != null;

    /// <summary>Eksik parça gelmedi: bekleyen en küçük sıra numarasına atlanır, boşluk işaretlenir.</summary>
    private static void SkipGap(Flow f, bool inbound, Dir d)
    {
        var pend = d.Pending;
        if (pend == null || pend.Count == 0) { d.Pending = null; d.PendingBytes = 0; return; }
        int best = 0;
        for (int i = 1; i < pend.Count; i++)
            if ((int)(pend[i].Seq - pend[best].Seq) < 0) best = i;
        var (seq, data) = pend[best];
        pend.RemoveAt(best);
        d.PendingBytes -= data.Length;
        d.Next = seq + (uint)data.Length;
        Emit(f, inbound, data, F_GAP);
        d.PendingSince = Environment.TickCount64;
        Drain(f, inbound, d);
    }

    private static void Reassemble(Flow f, bool inbound, uint seq, int tcpFlags, ReadOnlySpan<byte> data, long now)
    {
        Dir d = inbound ? f.In : f.Out;
        if ((tcpFlags & 0x02) != 0)
        {
            d.Reset();
            d.Has = true;
            d.Next = seq + 1;
            Emit(f, inbound, default, F_SYN);
            return;
        }
        if ((tcpFlags & 0x04) != 0)
        {
            d.Reset();
            Emit(f, inbound, default, F_RST);
            return;
        }
        if (!d.Has) { d.Has = true; d.Next = seq; }
        if (data.Length > 0)
        {
            int diff = (int)(seq - d.Next);
            if (diff == 0)
            {
                Emit(f, inbound, data, 0);
                d.Next += (uint)data.Length;
                if (d.Pending != null) Drain(f, inbound, d);
            }
            else if (diff < 0)
            {
                int skip = -diff; // yeniden iletim: yalnız yeni kuyruk alınır
                if (skip > 0 && skip < data.Length)
                {
                    Emit(f, inbound, data.Slice(skip), 0);
                    d.Next += (uint)(data.Length - skip);
                    if (d.Pending != null) Drain(f, inbound, d);
                }
            }
            else if (diff > (4 << 20))
            {
                d.Pending = null; d.PendingBytes = 0;
                d.Next = seq + (uint)data.Length;
                Emit(f, inbound, data, F_GAP);
            }
            else
            {
                if (d.Pending == null) { d.Pending = new List<(uint, byte[])>(); d.PendingSince = now; _pendFlows.Add(f); }
                d.Pending.Add((seq, data.ToArray()));
                d.PendingBytes += data.Length;
                while (d.Pending != null && (d.Pending.Count > PendingMaxCount || d.PendingBytes > PendingMaxBytes)) SkipGap(f, inbound, d);
            }
        }
        if ((tcpFlags & 0x01) != 0)
        {
            uint finSeq = seq + (uint)data.Length;
            if (finSeq == d.Next) { d.Next++; Emit(f, inbound, default, F_FIN); }
            else if ((int)(finSeq - d.Next) > 0) { d.HasFin = true; d.FinSeq = finSeq; }
        }
    }

    /// <summary>Bir saniyeden uzun süredir eksik parça bekleyen akışlar boşluk işaretiyle ilerletilir.</summary>
    private static void FlushStale(long now)
    {
        if (_pendFlows.Count == 0) return;
        var list = new List<Flow>(_pendFlows);
        foreach (var f in list)
        {
            if (f.In.Pending != null && now - f.In.PendingSince > 1000) { while (f.In.Pending != null) SkipGap(f, true, f.In); }
            if (f.Out.Pending != null && now - f.Out.PendingSince > 1000) { while (f.Out.Pending != null) SkipGap(f, false, f.Out); }
            if (!HasPending(f)) _pendFlows.Remove(f);
        }
    }

    private static void ResetStreams()
    {
        foreach (var f in _flows.Values) { f.In.Reset(); f.Out.Reset(); DropHeld(f); }
        _pendFlows.Clear();
        _heldBytes = 0;
    }

    private static void RemoveFlow(Flow f)
    {
        DropHeld(f);
        _pendFlows.Remove(f);
        _flows.Remove(f.Key);
    }

    private static void Sweep(long now, bool hard)
    {
        _sweepAt = now;
        List<Flow>? dead = null;
        foreach (var f in _flows.Values)
        {
            long idle = now - f.Last;
            if (idle > 120000 || (f.Closed && idle > 60000) || (hard && idle > 10000)) (dead ??= new List<Flow>()).Add(f);
            else if (f.Held != null && now - f.HeldSince > 3000) DropHeld(f);
        }
        if (dead != null) foreach (var f in dead) RemoveFlow(f);
        if (hard && _flows.Count >= MaxFlows) { _flows.Clear(); _pendFlows.Clear(); _heldBytes = 0; }
    }

    // ---- paket ayrıştırma (Gate altında) ----

    private static void Packet4(byte* p, int n)
    {
        if (n < 20 || (p[0] >> 4) != 4) return;
        int ihl = (p[0] & 0x0F) * 4;
        if (ihl < 20 || ihl > n) return;
        int total = (p[2] << 8) | p[3];
        if (total < ihl || total > n) total = n; // büyük gönderim birleştirmesinde (LSO) uzunluk alanı 0 gelir
        byte proto = p[9];
        if (proto != 6 && proto != 17) return;
        if ((((p[6] & 0x1F) << 8) | p[7]) != 0) return; // parçanın devamı: port başlığı yok
        Transport(4, *(uint*)(p + 12), 0, *(uint*)(p + 16), 0, proto, p + ihl, total - ihl, total);
    }

    private static void Packet6(byte* p, int n)
    {
        if (n < 40 || (p[0] >> 4) != 6) return;
        int payload = (p[4] << 8) | p[5];
        int total = 40 + payload;
        if (payload == 0 || total > n) total = n;
        byte nh = p[6];
        int off = 40;
        for (int i = 0; i < 8; i++)
        {
            if (nh == 0 || nh == 43 || nh == 60)
            {
                if (off + 8 > total) return;
                byte next = p[off];
                off += (p[off + 1] + 1) * 8;
                nh = next;
            }
            else if (nh == 44)
            {
                if (off + 8 > total) return;
                if ((((p[off + 2] << 8) | p[off + 3]) & 0xFFF8) != 0) return;
                nh = p[off];
                off += 8;
            }
            else break;
        }
        if ((nh != 6 && nh != 17) || off > total) return;
        Transport(6, *(ulong*)(p + 8), *(ulong*)(p + 16), *(ulong*)(p + 24), *(ulong*)(p + 32), nh, p + off, total - off, total);
    }

    private static void Transport(byte v, ulong s0, ulong s1, ulong d0, ulong d1, byte proto, byte* th, int rem, int total)
    {
        bool sLocal = v == 4 ? _local4.Contains((uint)s0) : _local6.Contains((s0, s1));
        bool dLocal = v == 4 ? _local4.Contains((uint)d0) : _local6.Contains((d0, d1));
        bool inbound;
        if (sLocal && dLocal) return;
        if (sLocal) inbound = false;
        else if (dLocal) inbound = true;
        else if (proto == 17 && (v == 4 ? ((d0 & 0xF0) == 0xE0 || (uint)d0 == 0xFFFFFFFF) : (d0 & 0xFF) == 0xFF)) inbound = true; // çok noktaya / yayın
        else return;

        ushort sport, dport;
        uint seq = 0;
        int flags = 0;
        byte* data;
        int len;
        if (proto == 6)
        {
            if (rem < 20) return;
            int doff = (th[12] >> 4) * 4;
            if (doff < 20 || doff > rem) return;
            seq = ((uint)th[4] << 24) | ((uint)th[5] << 16) | ((uint)th[6] << 8) | th[7];
            flags = th[13];
            data = th + doff;
            len = rem - doff;
        }
        else
        {
            if (rem < 8) return;
            int ulen = (th[4] << 8) | th[5];
            len = ulen >= 8 && ulen <= rem ? ulen - 8 : rem - 8;
            data = th + 8;
        }
        sport = (ushort)((th[0] << 8) | th[1]);
        dport = (ushort)((th[2] << 8) | th[3]);

        var key = inbound ? new FlowKey(v, proto, d0, d1, s0, s1, dport, sport) : new FlowKey(v, proto, s0, s1, d0, d1, sport, dport);
        long now = Environment.TickCount64;
        bool newConn = proto == 6 && (flags & 0x12) == 0x02; // SYN, ACK'siz: aynı uçlarla yeni bağlantı
        if (!_flows.TryGetValue(key, out var f) || newConn)
        {
            if (f != null) RemoveFlow(f);
            if (_flows.Count >= MaxFlows) Sweep(now, true);
            f = new Flow { Id = ++_flowId, Key = key };
            _flows[key] = f;
        }
        f.Last = now;

        if (f.Pid == 0) { if (now >= f.NextTry) TryResolve(f, now); }
        else if (proto == 17 && now - f.Resolved > 3000)
        {
            // UDP'de bağlantı kurulumu yok: yerel port el değiştirmiş olabilir
            if (now - _tablesAt > 1000) RefreshTables(now);
            uint again = Lookup(key);
            if (again != 0) f.Pid = again;
            f.Resolved = now;
        }

        if (inbound) f.Rx += total; else f.Tx += total;
        if (f.Pid != 0)
        {
            var c = CounterFor(f.Pid);
            if (inbound) c.Rx += total; else c.Tx += total;
        }
        else if (inbound) f.PendRx += total;
        else f.PendTx += total;

        if (proto == 6)
        {
            if ((flags & 0x04) != 0) f.Closed = true;
            if ((flags & 0x01) != 0)
            {
                if (inbound) f.FinIn = true; else f.FinOut = true;
                if (f.FinIn && f.FinOut) f.Closed = true;
            }
        }

        bool want = f.Pid != 0 ? _watch.Contains(f.Pid) : _watch.Count > 0;
        if (!want) return;
        var span = new ReadOnlySpan<byte>(data, len);
        if (proto == 17) { if (len > 0) Emit(f, inbound, span, 0); }
        else Reassemble(f, inbound, seq, flags, span, now);
    }

    private static void ThreadMain(Sock sk)
    {
        byte[] buf = new byte[262144];
        fixed (byte* p = buf)
        {
            while (!sk.Stop)
            {
                int n = Native.recv(sk.S, p, buf.Length, 0);
                if (sk.Stop) break;
                if (n <= 0)
                {
                    if (n < 0 && Proto.LastError() == 10040) continue; // WSAEMSGSIZE: paket tampondan büyük, atlanır
                    break;
                }
                lock (Gate)
                {
                    if (sk.Stop) break;
                    sk.Packets++;
                    sk.Head ??= Convert.ToHexString(new ReadOnlySpan<byte>(p, Math.Min(n, 8))).ToLowerInvariant();
                    try
                    {
                        if (sk.V == 4) Packet4(p, n); else Packet6(p, n);
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine("mp-agent: net packet error: " + ex.Message);
                    }
                }
            }
        }
        sk.Dead = true;
    }
}
