using System.Text.Json;

namespace MpAgent;

/// <summary>filemap (dosyanın birimdeki fiziksel yerleşimi), volmap (birimin doluluk haritası) ve readfile komutları.</summary>
internal static unsafe class FileMap
{
    private const uint FILE_READ_ATTRIBUTES = 0x80, GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_ALL = 7, OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FSCTL_GET_RETRIEVAL_POINTERS = 0x00090073, FSCTL_GET_VOLUME_BITMAP = 0x0009006F;
    private const int MaxExtents = 20000;

    private static AgentException OpenError(string what, int err) => err switch
    {
        Native.ERROR_ACCESS_DENIED or Native.ERROR_SHARING_VIOLATION => AgentException.Access($"{what}: access denied (win32 {err})"),
        Native.ERROR_FILE_NOT_FOUND or Native.ERROR_PATH_NOT_FOUND => AgentException.Failed($"{what}: file not found (win32 {err})"),
        _ => AgentException.Win32(what, err),
    };

    public static void Handle(JsonElement req, Utf8JsonWriter w)
    {
        string path = Proto.ReqString(req, "path");
        if (path.IndexOf('\0') >= 0) throw AgentException.BadRequest("invalid 'path'");

        // Birim kökü + küme bilgisi
        string volume;
        uint spc = 0, bps = 0, freeClusters = 0, totalClusters = 0;
        char* vol = stackalloc char[520];
        fixed (char* pp = path)
        {
            if (Native.GetVolumePathNameW(pp, vol, 520) == 0)
            {
                int err = Proto.LastError();
                if (path.StartsWith("\\\\", StringComparison.Ordinal) && !path.StartsWith("\\\\?\\", StringComparison.Ordinal))
                    throw AgentException.Unsupported("network paths are not supported");
                throw OpenError("GetVolumePathName", err);
            }
        }
        int vlen = 0;
        while (vlen < 520 && vol[vlen] != 0) vlen++;
        volume = new string(vol, 0, vlen);
        uint driveType = Native.GetDriveTypeW(vol);
        if (driveType == 4 /* DRIVE_REMOTE */ || volume.StartsWith("\\\\", StringComparison.Ordinal) && !volume.StartsWith("\\\\?\\", StringComparison.Ordinal))
            throw AgentException.Unsupported("network paths are not supported");
        if (Native.GetDiskFreeSpaceW(vol, &spc, &bps, &freeClusters, &totalClusters) == 0)
            throw AgentException.Unsupported($"cannot query volume geometry (win32 {Proto.LastError()})");
        ulong clusterSize = (ulong)spc * bps;

        IntPtr h;
        fixed (char* pp = path)
            h = Native.CreateFileW(pp, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (h == Native.INVALID_HANDLE_VALUE) throw OpenError("CreateFile", Proto.LastError());
        try
        {
            long size = 0;
            Native.GetFileSizeEx(h, &size);

            var extents = new List<(long Lcn, long Count)>();
            bool resident = false, truncated = false;
            int fragments = 0;
            long lastEnd = -2;
            const int OutSize = 64 * 1024;
            byte* outBuf = (byte*)System.Runtime.InteropServices.NativeMemory.Alloc(OutSize);
            try
            {
                long startVcn = 0;
                while (true)
                {
                    uint returned = 0;
                    int ok = Native.DeviceIoControl(h, FSCTL_GET_RETRIEVAL_POINTERS, &startVcn, 8, outBuf, OutSize, &returned, null);
                    int err = ok != 0 ? 0 : Proto.LastError();
                    if (ok == 0 && err != Native.ERROR_MORE_DATA)
                    {
                        if (err == Native.ERROR_HANDLE_EOF)
                        {
                            if (extents.Count == 0) resident = true; // veri MFT kaydının içinde (ya da boş dosya)
                            break;
                        }
                        if (err == 1 /* ERROR_INVALID_FUNCTION */ || err == Native.ERROR_NOT_SUPPORTED || err == Native.ERROR_INVALID_PARAMETER)
                            throw AgentException.Unsupported($"file system does not report extents (win32 {err})");
                        if (err == Native.ERROR_ACCESS_DENIED) throw AgentException.Access("FSCTL_GET_RETRIEVAL_POINTERS: access denied (win32 5)");
                        throw AgentException.Win32("FSCTL_GET_RETRIEVAL_POINTERS", err);
                    }
                    if (returned < 16) break;
                    uint count = *(uint*)outBuf;
                    long prevVcn = *(long*)(outBuf + 8);
                    uint maxFit = (returned - 16) / 16;
                    if (count > maxFit) count = maxFit;
                    if (count == 0) break;
                    byte* e = outBuf + 16;
                    for (uint i = 0; i < count; i++, e += 16)
                    {
                        long nextVcn = *(long*)e, lcn = *(long*)(e + 8);
                        long n = nextVcn - prevVcn;
                        prevVcn = nextVcn;
                        if (lcn == -1 || n <= 0) continue; // seyrek / sıkıştırılmış boşluk
                        if (extents.Count >= MaxExtents) { truncated = true; break; }
                        if (lcn != lastEnd) fragments++;
                        lastEnd = lcn + n;
                        extents.Add((lcn, n));
                    }
                    if (truncated || ok != 0) break;
                    startVcn = prevVcn; // ERROR_MORE_DATA: kaldığı yerden
                }
            }
            finally { System.Runtime.InteropServices.NativeMemory.Free(outBuf); }

            w.WriteStartObject();
            w.WriteString("path", Proto.Clean(path));
            w.WriteString("volume", Proto.Clean(volume));
            w.WriteNumber("clusterSize", clusterSize);
            w.WriteNumber("sectorSize", bps);
            w.WriteNumber("totalClusters", totalClusters);
            w.WriteNumber("freeClusters", freeClusters);
            w.WriteNumber("size", size);
            w.WriteStartArray("extents");
            foreach (var x in extents)
            {
                w.WriteStartArray();
                w.WriteNumberValue(x.Lcn);
                w.WriteNumberValue(x.Count);
                w.WriteEndArray();
            }
            w.WriteEndArray();
            w.WriteNumber("fragments", fragments);
            w.WriteBoolean("resident", resident);
            if (truncated) w.WriteBoolean("truncated", true);
            w.WriteEndObject();
        }
        finally { Native.CloseHandle(h); }
    }

    /// <summary>
    /// volmap: birimin küme bit eşlemi (FSCTL_GET_VOLUME_BITMAP), "cells" hücreye indirgenmiş doluluk yoğunluğu olarak.
    /// Her hücre birimin ardışık bir küme aralığıdır; değer o aralıktaki dolu küme oranıdır (0 = boş, 255 = tam dolu).
    /// </summary>
    public static void HandleVolMap(JsonElement req, Utf8JsonWriter w)
    {
        string path = Proto.ReqString(req, "path");
        if (path.IndexOf('\0') >= 0) throw AgentException.BadRequest("invalid 'path'");
        long want = Proto.ReqInt(req, "cells", 4096);
        if (want < 64 || want > 16384) throw AgentException.BadRequest("'cells' must be between 64 and 16384");

        uint spc = 0, bps = 0, freeClusters = 0, totalClusters = 0;
        char* vol = stackalloc char[520];
        fixed (char* pp = path)
        {
            if (Native.GetVolumePathNameW(pp, vol, 520) == 0)
            {
                int err = Proto.LastError();
                if (path.StartsWith("\\\\", StringComparison.Ordinal) && !path.StartsWith("\\\\?\\", StringComparison.Ordinal))
                    throw AgentException.Unsupported("network paths are not supported");
                throw OpenError("GetVolumePathName", err);
            }
        }
        int vlen = 0;
        while (vlen < 520 && vol[vlen] != 0) vlen++;
        string volume = new string(vol, 0, vlen);
        if (Native.GetDriveTypeW(vol) == 4 /* DRIVE_REMOTE */) throw AgentException.Unsupported("network paths are not supported");
        // Yalnız sürücü harfli birimler: "C:\" → aygıt yolu "\\.\C:"
        if (vlen != 3 || volume[1] != ':' || volume[2] != '\\' || !char.IsAsciiLetter(volume[0]))
            throw AgentException.Unsupported("only drive-letter volumes are supported");
        if (Native.GetDiskFreeSpaceW(vol, &spc, &bps, &freeClusters, &totalClusters) == 0)
            throw AgentException.Unsupported($"cannot query volume geometry (win32 {Proto.LastError()})");
        string device = "\\\\.\\" + volume.Substring(0, 2);

        // Öznitelik erişimi çoğu sürümde yeter; yetmezse okuma erişimiyle (yönetici ister) bir kez daha denenir
        long total = 0, used = 0;
        byte[] density = Array.Empty<byte>();
        int e = 0;
        if (!ReadBitmap(device, FILE_READ_ATTRIBUTES, (int)want, out total, out used, out density, out e)
            && !ReadBitmap(device, GENERIC_READ, (int)want, out total, out used, out density, out e))
        {
            if (e == Native.ERROR_ACCESS_DENIED || e == Native.ERROR_SHARING_VIOLATION)
                throw AgentException.Access($"volume bitmap: access denied (win32 {e})");
            if (e == 1 /* ERROR_INVALID_FUNCTION */ || e == Native.ERROR_NOT_SUPPORTED || e == Native.ERROR_INVALID_PARAMETER)
                throw AgentException.Unsupported($"file system does not report a volume bitmap (win32 {e})");
            throw AgentException.Win32("FSCTL_GET_VOLUME_BITMAP", e);
        }

        w.WriteStartObject();
        w.WriteString("volume", Proto.Clean(volume));
        w.WriteNumber("clusterSize", (ulong)spc * bps);
        w.WriteNumber("sectorSize", bps);
        w.WriteNumber("totalClusters", total);
        w.WriteNumber("usedClusters", used);
        w.WriteNumber("cells", density.Length);
        w.WriteBase64String("b64", density);
        w.WriteEndObject();
    }

    private static bool ReadBitmap(string device, uint access, int cells, out long total, out long used, out byte[] density, out int err)
    {
        total = 0; used = 0; density = Array.Empty<byte>(); err = 0;
        IntPtr h;
        fixed (char* dp = device)
            h = Native.CreateFileW(dp, access, FILE_SHARE_ALL, null, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == Native.INVALID_HANDLE_VALUE) { err = Proto.LastError(); return false; }
        const int OutSize = 1 << 20;
        byte* buf = (byte*)System.Runtime.InteropServices.NativeMemory.Alloc(OutSize);
        try
        {
            long[]? usedIn = null;
            int cell = 0;
            long cellEnd = 0, lcn = 0;
            while (true)
            {
                uint returned = 0;
                int ok = Native.DeviceIoControl(h, FSCTL_GET_VOLUME_BITMAP, &lcn, 8, buf, OutSize, &returned, null);
                int e = ok != 0 ? 0 : Proto.LastError();
                if (ok == 0 && e != Native.ERROR_MORE_DATA) { err = e; return false; }
                if (returned <= 16) break;
                long start = *(long*)buf, size = *(long*)(buf + 8); // StartingLcn (8'in katına yuvarlanmış olabilir), kalan küme sayısı
                if (start < 0 || size <= 0) break;
                if (usedIn == null)
                {
                    total = start + size;
                    if (cells > total) cells = (int)total;
                    usedIn = new long[cells];
                    cell = 0;
                    cellEnd = CellEnd(0, total, cells);
                }
                long bits = Math.Min(Math.Min(size, total - start), (long)(returned - 16) * 8);
                if (bits <= 0) break;
                byte* p = buf + 16;
                for (long k = 0; k < bits;)
                {
                    long at = start + k;
                    while (at >= cellEnd && cell < cells - 1) { cell++; cellEnd = CellEnd(cell, total, cells); }
                    if ((k & 7) == 0 && k + 8 <= bits && at + 8 <= cellEnd)
                    {
                        usedIn[cell] += System.Numerics.BitOperations.PopCount((uint)p[k >> 3]); // bayt bütünüyle aynı hücrede
                        k += 8;
                        continue;
                    }
                    if ((p[k >> 3] & (1 << (int)(k & 7))) != 0) usedIn[cell]++;
                    k++;
                }
                lcn = start + bits;
                if (ok != 0 || lcn >= total) break;
            }
            if (usedIn == null) { err = Native.ERROR_NOT_SUPPORTED; return false; }
            density = new byte[cells];
            long prevEnd = 0;
            for (int c = 0; c < cells; c++)
            {
                long end = CellEnd(c, total, cells), n = end - prevEnd;
                prevEnd = end;
                used += usedIn[c];
                if (n <= 0 || usedIn[c] <= 0) continue;
                density[c] = (byte)Math.Clamp((usedIn[c] * 255 + n / 2) / n, 1, 255); // dolu kümesi olan hücre en az 1
            }
            return true;
        }
        finally
        {
            System.Runtime.InteropServices.NativeMemory.Free(buf);
            Native.CloseHandle(h);
        }
    }

    /// <summary>c numaralı hücrenin bittiği küme (dışlayan): floor(lcn * cells / total) == c ⇔ lcn &lt; CellEnd(c).</summary>
    private static long CellEnd(int c, long total, int cells) => c >= cells - 1 ? total : ((long)(c + 1) * total + cells - 1) / cells;

    public static void HandleReadFile(JsonElement req, Utf8JsonWriter w)
    {
        string path = Proto.ReqString(req, "path");
        if (path.IndexOf('\0') >= 0) throw AgentException.BadRequest("invalid 'path'");
        long offset = Proto.ReqInt(req, "offset", 0);
        long len = Proto.ReqInt(req, "len");
        if (offset < 0) throw AgentException.BadRequest("'offset' must be >= 0");
        if (len < 0 || len > 65536) throw AgentException.BadRequest("'len' must be between 0 and 65536");

        IntPtr h;
        fixed (char* pp = path)
            h = Native.CreateFileW(pp, GENERIC_READ, FILE_SHARE_ALL, null, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == Native.INVALID_HANDLE_VALUE)
            throw AgentException.Access($"cannot open file (win32 {Proto.LastError()})");
        try
        {
            long size = 0;
            if (Native.GetFileSizeEx(h, &size) == 0) throw AgentException.Win32("GetFileSizeEx", Proto.LastError());
            byte[] data = new byte[len];
            int got = 0;
            if (len > 0 && offset < size)
            {
                if (Native.SetFilePointerEx(h, offset, null, 0) == 0) throw AgentException.Win32("SetFilePointerEx", Proto.LastError());
                fixed (byte* p = data)
                {
                    while (got < len)
                    {
                        uint r = 0;
                        if (Native.ReadFile(h, p + got, (uint)(len - got), &r, null) == 0)
                        {
                            if (got > 0) break;
                            throw AgentException.Win32("ReadFile", Proto.LastError());
                        }
                        if (r == 0) break;
                        got += (int)r;
                    }
                }
            }
            w.WriteStartObject();
            w.WriteNumber("offset", offset);
            w.WriteNumber("len", got);
            w.WriteNumber("size", size);
            w.WriteBase64String("b64", new ReadOnlySpan<byte>(data, 0, got));
            w.WriteEndObject();
        }
        finally { Native.CloseHandle(h); }
    }
}
