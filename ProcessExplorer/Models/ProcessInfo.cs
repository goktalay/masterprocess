namespace ProcessExplorer.Models;

public class ProcessInfo
{
    public int ProcessId { get; set; }
    public int? ParentProcessId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? Path { get; set; }
    public DateTime StartTime { get; set; }
    public long WorkingSetMemory { get; set; }
    public long VirtualMemory { get; set; }
    public long PagedMemory { get; set; }
    public double CpuUsagePercent { get; set; }
    public double GpuUsagePercent { get; set; }
    public long GpuMemoryBytes { get; set; }
    public long DiskReadBytes { get; set; }
    public long DiskWriteBytes { get; set; }
    public int ThreadCount { get; set; }
    public string? WindowTitle { get; set; }
    public IntPtr MainWindowHandle { get; set; }
    public DateTime LastUpdated { get; set; }

    public string MemoryFormatted => FormatBytes(WorkingSetMemory);
    public string GpuMemoryFormatted => FormatBytes(GpuMemoryBytes);
    public string CpuUsageFormatted => $"{CpuUsagePercent:F2}%";
    public string GpuUsageFormatted => $"{GpuUsagePercent:F2}%";

    private static string FormatBytes(long bytes)
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
