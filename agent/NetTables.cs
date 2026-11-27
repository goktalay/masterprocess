using System.Net;

namespace MpAgent;

/// <summary>Bir bağlantının yerel/uzak uçları. IPv4'te adres L0/R0'ın düşük 32 bitinde (bellek sırasıyla), L1/R1 = 0.</summary>
internal readonly record struct FlowKey(byte V, byte Proto, ulong L0, ulong L1, ulong R0, ulong R1, ushort LPort, ushort RPort);

/// <summary>Yerel uç (dinleyen TCP soketi ya da UDP soketi).</summary>
internal readonly record struct EpKey(byte V, byte Proto, ulong A0, ulong A1, ushort Port);

internal struct ConnRow
{
    public byte V, Proto;
    public ulong L0, L1, R0, R1;
    public ushort LPort, RPort;
    public int State;
    public uint Pid;
}

internal struct LocalAddr
{
    public byte V;
    public ulong A0, A1;
    public uint IfIndex, Scope;
}

internal struct IfRow
{
    public ulong Luid;
    public uint Index, Type, Oper;
    public byte Flags;
    public string Alias;
    public ulong In, Out;

    public readonly bool Hardware => (Flags & 1) != 0;
    public readonly bool Filter => (Flags & 2) != 0;
    public readonly bool Connector => (Flags & 4) != 0;
}

/// <summary>IP yardımcı tabloları: soket sahipliği (PID), yerel adresler, arayüz sayaçları. Yalnız okur.</summary>
internal static unsafe class NetTables
{
    private static byte[] _buf = new byte[1 << 16];

    public const int TcpListen = 2;

    private static readonly string[] TcpStates =
    {
        "unknown", "closed", "listen", "syn_sent", "syn_rcvd", "established", "fin_wait1", "fin_wait2",
        "close_wait", "closing", "last_ack", "time_wait", "delete_tcb",
    };

    public static string TcpState(int s) => s >= 0 && s < TcpStates.Length ? TcpStates[s] : "unknown";

    /// <summary>Tablolardaki port alanı: ağ bayt sırasında, DWORD'ün düşük 16 bitinde.</summary>
    public static ushort Port(uint raw) => (ushort)(((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF));

    public static ulong Map4(ulong a4) => (a4 << 32) | 0xFFFF0000UL;
    public static bool IsMapped(ulong a0, ulong a1) => a0 == 0 && (a1 & 0xFFFFFFFFUL) == 0xFFFF0000UL;

    public static string Addr(byte v, ulong a0, ulong a1)
    {
        if (v == 4)
        {
            uint x = (uint)a0;
            return $"{x & 0xFF}.{(x >> 8) & 0xFF}.{(x >> 16) & 0xFF}.{x >> 24}";
        }
        byte[] b = new byte[16];
        BitConverter.TryWriteBytes(new Span<byte>(b, 0, 8), a0);
        BitConverter.TryWriteBytes(new Span<byte>(b, 8, 8), a1);
        return new IPAddress(b).ToString();
    }

    private static bool Fetch(bool tcp, uint af, out int count)
    {
        count = 0;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            uint size = (uint)_buf.Length;
            uint rc;
            fixed (byte* p = _buf)
            {
                rc = tcp
                    ? Native.GetExtendedTcpTable(p, &size, 0, af, 5, 0)   // TCP_TABLE_OWNER_PID_ALL
                    : Native.GetExtendedUdpTable(p, &size, 0, af, 1, 0);  // UDP_TABLE_OWNER_PID
            }
            if (rc == 0)
            {
                count = (int)BitConverter.ToUInt32(_buf, 0);
                return true;
            }
            if (rc != 122) return false; // ERROR_INSUFFICIENT_BUFFER dışı: bu aile yok / tablo okunamadı
            _buf = new byte[Math.Max(size, (uint)_buf.Length) + 16384];
        }
        return false;
    }

    /// <summary>TCP ve UDP soketlerinin (IPv4 + IPv6) sahipleriyle listesi.</summary>
    public static List<ConnRow> Query()
    {
        var list = new List<ConnRow>(256);
        int n;
        if (Fetch(true, 2, out n))
        {
            n = Math.Min(n, (_buf.Length - 4) / 24);
            fixed (byte* b = _buf)
            {
                for (int i = 0; i < n; i++)
                {
                    uint* r = (uint*)(b + 4 + i * 24); // MIB_TCPROW_OWNER_PID
                    var row = new ConnRow { V = 4, Proto = 6, State = (int)r[0], L0 = r[1], LPort = Port(r[2]), Pid = r[5] };
                    if (row.State != TcpListen) { row.R0 = r[3]; row.RPort = Port(r[4]); }
                    list.Add(row);
                }
            }
        }
        if (Fetch(true, 23, out n))
        {
            n = Math.Min(n, (_buf.Length - 4) / 56);
            fixed (byte* b = _buf)
            {
                for (int i = 0; i < n; i++)
                {
                    byte* r = b + 4 + i * 56; // MIB_TCP6ROW_OWNER_PID
                    var row = new ConnRow
                    {
                        V = 6, Proto = 6,
                        L0 = *(ulong*)r, L1 = *(ulong*)(r + 8), LPort = Port(*(uint*)(r + 20)),
                        State = *(int*)(r + 48), Pid = *(uint*)(r + 52),
                    };
                    if (row.State != TcpListen) { row.R0 = *(ulong*)(r + 24); row.R1 = *(ulong*)(r + 32); row.RPort = Port(*(uint*)(r + 44)); }
                    list.Add(row);
                }
            }
        }
        if (Fetch(false, 2, out n))
        {
            n = Math.Min(n, (_buf.Length - 4) / 12);
            fixed (byte* b = _buf)
            {
                for (int i = 0; i < n; i++)
                {
                    uint* r = (uint*)(b + 4 + i * 12); // MIB_UDPROW_OWNER_PID
                    list.Add(new ConnRow { V = 4, Proto = 17, L0 = r[0], LPort = Port(r[1]), Pid = r[2] });
                }
            }
        }
        if (Fetch(false, 23, out n))
        {
            n = Math.Min(n, (_buf.Length - 4) / 28);
            fixed (byte* b = _buf)
            {
                for (int i = 0; i < n; i++)
                {
                    byte* r = b + 4 + i * 28; // MIB_UDP6ROW_OWNER_PID
                    list.Add(new ConnRow { V = 6, Proto = 17, L0 = *(ulong*)r, L1 = *(ulong*)(r + 8), LPort = Port(*(uint*)(r + 20)), Pid = *(uint*)(r + 24) });
                }
            }
        }
        return list;
    }

    /// <summary>Bu bilgisayarın kullanımdaki tek noktaya (unicast) adresleri; geri döngü hariç.</summary>
    public static List<LocalAddr> LocalAddrs()
    {
        var list = new List<LocalAddr>();
        void* table = null;
        if (Native.GetUnicastIpAddressTable(0, &table) != 0 || table == null) return list;
        try
        {
            int n = (int)*(uint*)table;
            byte* rows = (byte*)table + 8;
            for (int i = 0; i < n; i++)
            {
                byte* r = rows + (long)i * 80; // MIB_UNICASTIPADDRESS_ROW
                if (*(int*)(r + 64) != 4) continue; // DadState: yalnız Preferred
                ushort family = *(ushort*)r;
                uint ifIndex = *(uint*)(r + 40);
                if (family == 2)
                {
                    uint a = *(uint*)(r + 4);
                    if (a == 0 || (a & 0xFF) == 127) continue;
                    list.Add(new LocalAddr { V = 4, A0 = a, IfIndex = ifIndex });
                }
                else if (family == 23)
                {
                    ulong a0 = *(ulong*)(r + 8), a1 = *(ulong*)(r + 16);
                    if (a0 == 0 && a1 == 0x0100000000000000UL) continue; // ::1
                    list.Add(new LocalAddr { V = 6, A0 = a0, A1 = a1, IfIndex = ifIndex, Scope = *(uint*)(r + 24) });
                }
            }
        }
        finally { Native.FreeMibTable(table); }
        return list;
    }

    /// <summary>Ağ arayüzleri ve bayt sayaçları (MIB_IF_ROW2, 1352 bayt).</summary>
    public static List<IfRow> Interfaces()
    {
        var list = new List<IfRow>();
        void* table = null;
        if (Native.GetIfTable2(&table) != 0 || table == null) return list;
        try
        {
            int n = (int)*(uint*)table;
            byte* rows = (byte*)table + 8;
            for (int i = 0; i < n; i++)
            {
                byte* r = rows + (long)i * 1352;
                char* alias = (char*)(r + 28);
                int len = 0;
                while (len < 256 && alias[len] != '\0') len++;
                list.Add(new IfRow
                {
                    Luid = *(ulong*)r,
                    Index = *(uint*)(r + 8),
                    Alias = new string(alias, 0, len),
                    Type = *(uint*)(r + 1128),
                    Flags = r[1152],
                    Oper = *(uint*)(r + 1156),
                    In = *(ulong*)(r + 1208),
                    Out = *(ulong*)(r + 1280),
                });
            }
        }
        finally { Native.FreeMibTable(table); }
        return list;
    }

    /// <summary>Sistem ağ hızına katılan arayüz: fiziksel bağlantısı olan, süzgeç olmayan, çalışır durumdaki.</summary>
    public static bool Counted(in IfRow r) => r.Connector && !r.Filter && r.Oper == 1;

    /// <summary>Hiçbir arayüz <see cref="Counted"/> koşulunu sağlamıyorsa: süzgeç ve geri döngü dışındakiler.</summary>
    public static bool CountedFallback(in IfRow r) => !r.Filter && r.Type != 24 && r.Oper == 1;
}
