using CommunityToolkit.Mvvm.ComponentModel;

namespace ProcessExplorer.Models;

public class ProcessInfo : ObservableObject
{
    private long _workingSetMemory;
    private double _cpuUsagePercent;
    private long _gpuMemoryBytes;
    private int _threadCount;
    private string? _windowTitle;

    public int ProcessId { get; set; }
    public int? ParentProcessId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Path { get; set; }
    public DateTime? StartTime { get; set; }
    public long VirtualMemory { get; set; }
    public long PagedMemory { get; set; }
    public double GpuUsagePercent { get; set; }
    public long DiskReadBytes { get; set; }
    public long DiskWriteBytes { get; set; }
    public IntPtr MainWindowHandle { get; set; }
    public DateTime LastUpdated { get; set; }

    public long WorkingSetMemory
    {
        get => _workingSetMemory;
        set { if (SetProperty(ref _workingSetMemory, value)) OnPropertyChanged(nameof(MemoryFormatted)); }
    }

    public double CpuUsagePercent
    {
        get => _cpuUsagePercent;
        set { if (SetProperty(ref _cpuUsagePercent, value)) OnPropertyChanged(nameof(CpuUsageFormatted)); }
    }

    public long GpuMemoryBytes
    {
        get => _gpuMemoryBytes;
        set { if (SetProperty(ref _gpuMemoryBytes, value)) OnPropertyChanged(nameof(GpuMemoryFormatted)); }
    }

    public int ThreadCount
    {
        get => _threadCount;
        set => SetProperty(ref _threadCount, value);
    }

    public string? WindowTitle
    {
        get => _windowTitle;
        set => SetProperty(ref _windowTitle, value);
    }

    public string MemoryFormatted => FormatBytes(WorkingSetMemory);
    public string GpuMemoryFormatted => FormatBytes(GpuMemoryBytes);
    public string CpuUsageFormatted => $"{CpuUsagePercent:F2}%";
    public string GpuUsageFormatted => $"{GpuUsagePercent:F2}%";

    public static string FormatBytes(long bytes)
    {
        string[] sizes = { "B", "KB", "MB", "GB", "TB" };
        double len = bytes;
        int order = 0;
        while (len >= 1024 && order < sizes.Length - 1)
        {
            order++;
            len = len / 1024;
        }
        return $"{len:F2} {sizes[order]}";
    }
}
