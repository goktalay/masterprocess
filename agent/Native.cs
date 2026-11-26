using System.Runtime.InteropServices;

namespace MpAgent;

/// <summary>Win32 / NT P/Invoke bildirimleri. Tüm imzalar blittable (işaretçi + tamsayı) tutulur.</summary>
internal static unsafe class Native
{
    private const string K32 = "kernel32.dll";
    private const string Ntdll = "ntdll.dll";
    private const string Adv = "advapi32.dll";
    private const string U32 = "user32.dll";
    private const string Gdi = "gdi32.dll";
    private const string Pdh = "pdh.dll";

    // ---- sabitler ----
    public const uint PROCESS_TERMINATE = 0x0001;
    public const uint PROCESS_VM_READ = 0x0010;
    public const uint PROCESS_DUP_HANDLE = 0x0040;
    public const uint PROCESS_SET_INFORMATION = 0x0200;
    public const uint PROCESS_QUERY_INFORMATION = 0x0400;
    public const uint PROCESS_SUSPEND_RESUME = 0x0800;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const uint SYNCHRONIZE = 0x00100000;

    public const int ERROR_FILE_NOT_FOUND = 2;
    public const int ERROR_PATH_NOT_FOUND = 3;
    public const int ERROR_ACCESS_DENIED = 5;
    public const int ERROR_BAD_LENGTH = 24;
    public const int ERROR_SHARING_VIOLATION = 32;
    public const int ERROR_HANDLE_EOF = 38;
    public const int ERROR_NOT_SUPPORTED = 50;
    public const int ERROR_INVALID_PARAMETER = 87;
    public const int ERROR_INSUFFICIENT_BUFFER = 122;
    public const int ERROR_MORE_DATA = 234;
    public const int ERROR_PARTIAL_COPY = 299;
    public const int ERROR_INVALID_WINDOW_HANDLE = 1400;

    public const uint STATUS_INFO_LENGTH_MISMATCH = 0xC0000004;
    public const uint STATUS_BUFFER_OVERFLOW = 0x80000005;
    public const uint STATUS_BUFFER_TOO_SMALL = 0xC0000023;

    public const uint TOKEN_QUERY = 0x0008;
    public const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;

    public static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

    // ---- kernel32 ----
    [DllImport(K32, SetLastError = true)] public static extern IntPtr OpenProcess(uint access, int inherit, uint pid);
    [DllImport(K32, SetLastError = true)] public static extern int CloseHandle(IntPtr h);
    [DllImport(K32)] public static extern IntPtr GetCurrentProcess();
    [DllImport(K32)] public static extern uint GetCurrentProcessId();
    [DllImport(K32, SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport(K32, SetLastError = true)] public static extern int GetExitCodeProcess(IntPtr h, uint* code);
    [DllImport(K32, SetLastError = true)] public static extern int TerminateProcess(IntPtr h, uint code);
    [DllImport(K32, SetLastError = true)] public static extern uint GetPriorityClass(IntPtr h);
    [DllImport(K32, SetLastError = true)] public static extern int SetPriorityClass(IntPtr h, uint cls);
    [DllImport(K32, SetLastError = true)] public static extern int GetProcessHandleCount(IntPtr h, uint* count);
    [DllImport(K32, SetLastError = true)] public static extern int QueryFullProcessImageNameW(IntPtr h, uint flags, char* buf, uint* size);
    [DllImport(K32, SetLastError = true)] public static extern int IsWow64Process(IntPtr h, int* wow64);
    [DllImport(K32, SetLastError = true)] public static extern int IsWow64Process2(IntPtr h, ushort* processMachine, ushort* nativeMachine);
    [DllImport(K32, SetLastError = true)] public static extern int GetSystemTimes(long* idle, long* kernel, long* user);
    [DllImport(K32, SetLastError = true)] public static extern int GlobalMemoryStatusEx(MEMORYSTATUSEX* st);
    [DllImport(K32)] public static extern void GetSystemInfo(SYSTEM_INFO* si);
    [DllImport(K32)] public static extern uint GetActiveProcessorCount(ushort group);
    [DllImport(K32, SetLastError = true)] public static extern int K32GetPerformanceInfo(PERFORMANCE_INFORMATION* pi, uint cb);
    [DllImport(K32, SetLastError = true)] public static extern int K32GetProcessMemoryInfo(IntPtr h, PROCESS_MEMORY_COUNTERS_EX* pmc, uint cb);
    [DllImport(K32, SetLastError = true)] public static extern int K32EnumProcessModulesEx(IntPtr h, IntPtr* mods, uint cb, uint* needed, uint filter);
    [DllImport(K32, SetLastError = true)] public static extern uint K32GetModuleFileNameExW(IntPtr h, IntPtr mod, char* buf, uint size);
    [DllImport(K32, SetLastError = true)] public static extern int K32GetModuleInformation(IntPtr h, IntPtr mod, MODULEINFO* mi, uint cb);
    [DllImport(K32, SetLastError = true)] public static extern uint K32GetMappedFileNameW(IntPtr h, void* addr, char* buf, uint size);
    [DllImport(K32, SetLastError = true)] public static extern int K32QueryWorkingSet(IntPtr h, void* buf, uint cb);
    [DllImport(K32, SetLastError = true)] public static extern nuint VirtualQueryEx(IntPtr h, void* addr, MEMORY_BASIC_INFORMATION* mbi, nuint cb);
    [DllImport(K32, SetLastError = true)] public static extern int ReadProcessMemory(IntPtr h, void* addr, void* buf, nuint size, nuint* read);
    [DllImport(K32, SetLastError = true)] public static extern uint QueryDosDeviceW(char* device, char* target, uint max);
    [DllImport(K32, SetLastError = true)] public static extern uint GetLogicalDrives();
    [DllImport(K32, SetLastError = true)] public static extern int DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, IntPtr* dst, uint access, int inherit, uint options);
    [DllImport(K32, SetLastError = true)] public static extern uint GetFileType(IntPtr h);
    [DllImport(K32, SetLastError = true)] public static extern uint GetFinalPathNameByHandleW(IntPtr h, char* buf, uint size, uint flags);
    [DllImport(K32, SetLastError = true)] public static extern int GetFileSizeEx(IntPtr h, long* size);
    [DllImport(K32, SetLastError = true)] public static extern int GetFileInformationByHandle(IntPtr h, BY_HANDLE_FILE_INFORMATION* info);
    [DllImport(K32, SetLastError = true)] public static extern int GetFileInformationByHandleEx(IntPtr h, int cls, void* buf, uint size);
    [DllImport(K32, SetLastError = true)] public static extern IntPtr CreateFileW(char* path, uint access, uint share, void* sa, uint disposition, uint flags, IntPtr template);
    [DllImport(K32, SetLastError = true)] public static extern int DeviceIoControl(IntPtr h, uint code, void* inBuf, uint inSize, void* outBuf, uint outSize, uint* returned, void* overlapped);
    [DllImport(K32, SetLastError = true)] public static extern int GetVolumePathNameW(char* path, char* volume, uint size);
    [DllImport(K32, SetLastError = true)] public static extern int GetDiskFreeSpaceW(char* root, uint* sectorsPerCluster, uint* bytesPerSector, uint* freeClusters, uint* totalClusters);
    [DllImport(K32, SetLastError = true)] public static extern uint GetDriveTypeW(char* root);
    [DllImport(K32, SetLastError = true)] public static extern int SetFilePointerEx(IntPtr h, long distance, long* newPos, uint method);
    [DllImport(K32, SetLastError = true)] public static extern int ReadFile(IntPtr h, void* buf, uint len, uint* read, void* overlapped);
    [DllImport(K32, SetLastError = true)] public static extern IntPtr GetModuleHandleW(char* name);

    // ---- ntdll ----
    [DllImport(Ntdll)] public static extern uint NtQuerySystemInformation(int cls, void* buf, uint len, uint* retLen);
    [DllImport(Ntdll)] public static extern uint NtQueryInformationProcess(IntPtr h, int cls, void* buf, uint len, uint* retLen);
    [DllImport(Ntdll)] public static extern uint NtQueryObject(IntPtr h, int cls, void* buf, uint len, uint* retLen);
    [DllImport(Ntdll)] public static extern uint NtSuspendProcess(IntPtr h);
    [DllImport(Ntdll)] public static extern uint NtResumeProcess(IntPtr h);
    [DllImport(Ntdll)] public static extern uint RtlGetVersion(RTL_OSVERSIONINFOW* info);

    // ---- advapi32 ----
    [DllImport(Adv, SetLastError = true)] public static extern int OpenProcessToken(IntPtr proc, uint access, IntPtr* token);
    [DllImport(Adv, SetLastError = true)] public static extern int GetTokenInformation(IntPtr token, int cls, void* buf, uint len, uint* retLen);
    [DllImport(Adv, SetLastError = true)] public static extern int LookupAccountSidW(char* system, void* sid, char* name, uint* nameLen, char* domain, uint* domainLen, int* use);
    [DllImport(Adv, SetLastError = true)] public static extern int LookupPrivilegeValueW(char* system, char* name, long* luid);
    [DllImport(Adv, SetLastError = true)] public static extern int AdjustTokenPrivileges(IntPtr token, int disableAll, void* newState, uint len, void* prev, uint* retLen);

    // ---- user32 ----
    [DllImport(U32)] public static extern int EnumWindows(delegate* unmanaged[Stdcall]<IntPtr, IntPtr, int> cb, IntPtr lParam);
    [DllImport(U32)] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, uint* pid);
    [DllImport(U32)] public static extern int GetWindowTextW(IntPtr hwnd, char* buf, int max);
    [DllImport(U32)] public static extern int GetClassNameW(IntPtr hwnd, char* buf, int max);
    [DllImport(U32)] public static extern int IsWindowVisible(IntPtr hwnd);
    [DllImport(U32)] public static extern int IsIconic(IntPtr hwnd);
    [DllImport(U32)] public static extern int IsWindow(IntPtr hwnd);
    [DllImport(U32, SetLastError = true)] public static extern int GetWindowRect(IntPtr hwnd, RECT* rc);
    [DllImport(U32, SetLastError = true)] public static extern int GetWindowPlacement(IntPtr hwnd, WINDOWPLACEMENT* wp);
    [DllImport(U32, SetLastError = true)] public static extern int PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport(U32)] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport(U32)] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport(U32, SetLastError = true)] public static extern uint GetGuiResources(IntPtr proc, uint flags);
    [DllImport(U32)] public static extern int SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport(U32, SetLastError = true)] public static extern IntPtr CreateWindowExW(uint exStyle, char* cls, char* title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, void* param);
    [DllImport(U32)] public static extern int DestroyWindow(IntPtr hwnd);

    // ---- gdi32 ----
    [DllImport(Gdi)] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport(Gdi)] public static extern int DeleteDC(IntPtr hdc);
    [DllImport(Gdi)] public static extern IntPtr CreateDIBSection(IntPtr hdc, BITMAPINFOHEADER* bmi, uint usage, void** bits, IntPtr section, uint offset);
    [DllImport(Gdi)] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport(Gdi)] public static extern int DeleteObject(IntPtr obj);
    [DllImport(Gdi)] public static extern int SetStretchBltMode(IntPtr hdc, int mode);
    [DllImport(Gdi)] public static extern int SetBrushOrgEx(IntPtr hdc, int x, int y, void* prev);
    [DllImport(Gdi)] public static extern int StretchBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int sw, int sh, uint rop);
    [DllImport(Gdi)] public static extern int GdiFlush();

    // ---- pdh ----
    [DllImport(Pdh)] public static extern uint PdhOpenQueryW(char* source, nuint userData, IntPtr* query);
    [DllImport(Pdh)] public static extern uint PdhAddEnglishCounterW(IntPtr query, char* path, nuint userData, IntPtr* counter);
    [DllImport(Pdh)] public static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport(Pdh)] public static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, uint* bufSize, uint* itemCount, void* buf);
    [DllImport(Pdh)] public static extern uint PdhCloseQuery(IntPtr query);

    // ---- dxgi ----
    [DllImport("dxgi.dll")] public static extern int CreateDXGIFactory1(Guid* riid, void** factory);

    // ---- yapılar ----
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORYSTATUSEX
    {
        public uint dwLength, dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SYSTEM_INFO
    {
        public ushort wProcessorArchitecture, wReserved;
        public uint dwPageSize;
        public nuint lpMinimumApplicationAddress, lpMaximumApplicationAddress, dwActiveProcessorMask;
        public uint dwNumberOfProcessors, dwProcessorType, dwAllocationGranularity;
        public ushort wProcessorLevel, wProcessorRevision;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PERFORMANCE_INFORMATION
    {
        public uint cb;
        public nuint CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable, SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize;
        public uint HandleCount, ProcessCount, ThreadCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_MEMORY_COUNTERS_EX
    {
        public uint cb, PageFaultCount;
        public nuint PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MODULEINFO
    {
        public nuint lpBaseOfDll;
        public uint SizeOfImage;
        public nuint EntryPoint;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION
    {
        public nuint BaseAddress, AllocationBase;
        public uint AllocationProtect;
        public ushort PartitionId, Pad;
        public nuint RegionSize;
        public uint State, Protect, Type, Pad2;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BY_HANDLE_FILE_INFORMATION
    {
        public uint dwFileAttributes;
        public uint ftCreationLow, ftCreationHigh, ftAccessLow, ftAccessHigh, ftWriteLow, ftWriteHigh; // FILETIME üçlüsü (4 bayt hizalı)
        public uint dwVolumeSerialNumber, nFileSizeHigh, nFileSizeLow, nNumberOfLinks, nFileIndexHigh, nFileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT
    {
        public uint length, flags, showCmd;
        public int minX, minY, maxX, maxY;
        public RECT rcNormalPosition;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth, biHeight;
        public ushort biPlanes, biBitCount;
        public uint biCompression, biSizeImage;
        public int biXPelsPerMeter, biYPelsPerMeter;
        public uint biClrUsed, biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RTL_OSVERSIONINFOW
    {
        public uint dwOSVersionInfoSize, dwMajorVersion, dwMinorVersion, dwBuildNumber, dwPlatformId;
        public fixed char szCSDVersion[128];
    }
}
