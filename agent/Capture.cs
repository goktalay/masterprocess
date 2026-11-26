using System.Text.Json;

namespace MpAgent;

/// <summary>capture komutu: PrintWindow ile pencere görüntüsü (BGRA, yukarıdan aşağıya).</summary>
internal static unsafe class Capture
{
    private const uint PW_RENDERFULLCONTENT = 2;
    private const uint SRCCOPY = 0x00CC0020;
    private const int HALFTONE = 4;
    private const long MaxSourcePixels = 64L * 1024 * 1024; // ~256 MB DIB üst sınırı

    private static IntPtr MakeDib(IntPtr screenDc, int w, int h, out void* bits)
    {
        Native.BITMAPINFOHEADER bi = default;
        bi.biSize = (uint)sizeof(Native.BITMAPINFOHEADER);
        bi.biWidth = w;
        bi.biHeight = -h; // yukarıdan aşağıya
        bi.biPlanes = 1;
        bi.biBitCount = 32;
        bi.biCompression = 0; // BI_RGB
        void* p = null;
        IntPtr bmp = Native.CreateDIBSection(screenDc, &bi, 0, &p, IntPtr.Zero, 0);
        bits = p;
        return bmp;
    }

    public static void Handle(JsonElement req, Utf8JsonWriter w)
    {
        ulong hv = Proto.ReqHex(req, "hwnd");
        long maxW = Proto.ReqInt(req, "maxW", 1280);
        if (maxW < 64) maxW = 64;
        if (maxW > 3840) maxW = 3840;
        IntPtr hwnd = (IntPtr)(nint)hv;
        if (hv == 0 || Native.IsWindow(hwnd) == 0) throw AgentException.Gone("window does not exist");

        string title = Detail.WindowText(hwnd);
        string hwndHex = Proto.Hex(hv);

        if (Native.IsIconic(hwnd) != 0)
        {
            int nw = 0, nh = 0;
            Native.WINDOWPLACEMENT wp = default;
            wp.length = (uint)sizeof(Native.WINDOWPLACEMENT);
            if (Native.GetWindowPlacement(hwnd, &wp) != 0)
            {
                nw = Math.Max(0, wp.rcNormalPosition.right - wp.rcNormalPosition.left);
                nh = Math.Max(0, wp.rcNormalPosition.bottom - wp.rcNormalPosition.top);
            }
            WriteResult(w, hwndHex, title, nw, nh, 0, 0, true, ReadOnlySpan<byte>.Empty);
            return;
        }

        Native.RECT rc;
        if (Native.GetWindowRect(hwnd, &rc) == 0)
        {
            int err = Proto.LastError();
            if (err == Native.ERROR_INVALID_WINDOW_HANDLE || Native.IsWindow(hwnd) == 0) throw AgentException.Gone("window does not exist");
            throw AgentException.Win32("GetWindowRect", err);
        }
        int srcW = rc.right - rc.left, srcH = rc.bottom - rc.top;
        if (srcW <= 0 || srcH <= 0) throw AgentException.Failed("window has an empty rectangle");
        if ((long)srcW * srcH > MaxSourcePixels) throw AgentException.Failed("window is too large to capture");

        int outW = srcW, outH = srcH;
        if (srcW > maxW)
        {
            outW = (int)maxW;
            outH = Math.Max(1, (int)Math.Round((double)srcH * outW / srcW));
        }

        IntPtr screenDc = IntPtr.Zero, srcDc = IntPtr.Zero, dstDc = IntPtr.Zero;
        IntPtr srcBmp = IntPtr.Zero, dstBmp = IntPtr.Zero, oldSrc = IntPtr.Zero, oldDst = IntPtr.Zero;
        try
        {
            screenDc = Native.GetDC(IntPtr.Zero);
            srcDc = Native.CreateCompatibleDC(screenDc);
            if (srcDc == IntPtr.Zero) throw AgentException.Failed("CreateCompatibleDC failed");
            srcBmp = MakeDib(screenDc, srcW, srcH, out void* srcBits);
            if (srcBmp == IntPtr.Zero || srcBits == null) throw AgentException.Failed("CreateDIBSection failed");
            oldSrc = Native.SelectObject(srcDc, srcBmp);

            if (Native.PrintWindow(hwnd, srcDc, PW_RENDERFULLCONTENT) == 0 && Native.PrintWindow(hwnd, srcDc, 0) == 0)
            {
                if (Native.IsWindow(hwnd) == 0) throw AgentException.Gone("window does not exist");
                throw AgentException.Win32("PrintWindow", Proto.LastError());
            }
            Native.GdiFlush();

            byte* outBits = (byte*)srcBits;
            if (outW != srcW || outH != srcH)
            {
                dstDc = Native.CreateCompatibleDC(screenDc);
                if (dstDc == IntPtr.Zero) throw AgentException.Failed("CreateCompatibleDC failed");
                dstBmp = MakeDib(screenDc, outW, outH, out void* dstBits);
                if (dstBmp == IntPtr.Zero || dstBits == null) throw AgentException.Failed("CreateDIBSection failed");
                oldDst = Native.SelectObject(dstDc, dstBmp);
                Native.SetStretchBltMode(dstDc, HALFTONE);
                Native.SetBrushOrgEx(dstDc, 0, 0, null);
                if (Native.StretchBlt(dstDc, 0, 0, outW, outH, srcDc, 0, 0, srcW, srcH, SRCCOPY) == 0)
                    throw AgentException.Failed("StretchBlt failed");
                Native.GdiFlush();
                outBits = (byte*)dstBits;
            }

            int total = checked(outW * outH * 4);
            for (int i = 3; i < total; i += 4) outBits[i] = 255; // alfa
            WriteResult(w, hwndHex, title, srcW, srcH, outW, outH, false, new ReadOnlySpan<byte>(outBits, total));
        }
        finally
        {
            if (oldDst != IntPtr.Zero) Native.SelectObject(dstDc, oldDst);
            if (dstBmp != IntPtr.Zero) Native.DeleteObject(dstBmp);
            if (dstDc != IntPtr.Zero) Native.DeleteDC(dstDc);
            if (oldSrc != IntPtr.Zero) Native.SelectObject(srcDc, oldSrc);
            if (srcBmp != IntPtr.Zero) Native.DeleteObject(srcBmp);
            if (srcDc != IntPtr.Zero) Native.DeleteDC(srcDc);
            if (screenDc != IntPtr.Zero) Native.ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    private static void WriteResult(Utf8JsonWriter w, string hwnd, string title, int srcW, int srcH, int outW, int outH, bool minimized, ReadOnlySpan<byte> pixels)
    {
        w.WriteStartObject();
        w.WriteString("hwnd", hwnd);
        w.WriteString("title", title);
        w.WriteNumber("srcW", srcW);
        w.WriteNumber("srcH", srcH);
        w.WriteNumber("w", outW);
        w.WriteNumber("h", outH);
        w.WriteBoolean("minimized", minimized);
        w.WriteString("format", "bgra");
        if (pixels.IsEmpty) w.WriteString("b64", ""); else w.WriteBase64String("b64", pixels);
        w.WriteEndObject();
    }
}
