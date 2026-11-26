namespace ProcessExplorer.Models;

public class PerformanceMetrics
{
    public int ProcessId { get; set; }
    public DateTime Timestamp { get; set; }
    public double CpuUsagePercent { get; set; }
    public long MemoryBytes { get; set; }
    public double GpuUsagePercent { get; set; }
    public long GpuMemoryBytes { get; set; }
    public long DiskReadBytesPerSec { get; set; }
    public long DiskWriteBytesPerSec { get; set; }
    public long NetworkBytesReceivedPerSec { get; set; }
    public long NetworkBytesSentPerSec { get; set; }

    public int Id { get; set; }
}
