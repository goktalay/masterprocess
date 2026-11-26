using System.Diagnostics;
using System.Management;
using ProcessExplorer.Models;

namespace ProcessExplorer.Services;

public class ProcessService
{
    private readonly Dictionary<int, (TimeSpan Cpu, DateTime At)> _cpuSamples = new();
    private readonly Dictionary<int, ProcessInfo> _processCache = new();

    public List<ProcessInfo> GetAllProcesses()
    {
        var processes = new List<ProcessInfo>();
        var processes_System = Process.GetProcesses();

        foreach (var process in processes_System)
        {
            try
            {
                processes.Add(ReadProcess(process));
            }
            catch
            {
                // Process exited while it was being read
            }
            finally
            {
                process.Dispose();
            }
        }

        // Forget processes that are gone
        var alive = processes.Select(p => p.ProcessId).ToHashSet();
        foreach (var id in _processCache.Keys.Where(id => !alive.Contains(id)).ToList())
        {
            _processCache.Remove(id);
            _cpuSamples.Remove(id);
        }

        return processes.OrderBy(p => p.Name).ToList();
    }

    private ProcessInfo ReadProcess(Process process)
    {
        var name = process.ProcessName;
        _processCache.TryGetValue(process.Id, out var cached);
        if (cached != null && cached.Name != name)
        {
            // The process id was reused by another program
            cached = null;
            _cpuSamples.Remove(process.Id);
        }

        var processInfo = new ProcessInfo
        {
            ProcessId = process.Id,
            Name = name,
            // Path and start time need more rights than the rest: protected processes stay listed without them
            Path = cached != null ? cached.Path : TryGet(() => process.MainModule?.FileName),
            StartTime = cached != null ? cached.StartTime : TryGet(() => (DateTime?)process.StartTime),
            WorkingSetMemory = process.WorkingSet64,
            VirtualMemory = process.VirtualMemorySize64,
            PagedMemory = process.PagedMemorySize64,
            ThreadCount = process.Threads.Count,
            MainWindowHandle = process.MainWindowHandle,
            CpuUsagePercent = GetCpuUsage(process),
            LastUpdated = DateTime.Now,
            WindowTitle = GetWindowTitle(process),
        };

        _processCache[process.Id] = processInfo;
        return processInfo;
    }

    private static T? TryGet<T>(Func<T?> read)
    {
        try
        {
            return read();
        }
        catch
        {
            return default;
        }
    }

    public ProcessInfo? GetProcessInfo(int processId)
    {
        if (_processCache.TryGetValue(processId, out var cached))
        {
            return cached;
        }

        try
        {
            using var process = Process.GetProcessById(processId);
            return ReadProcess(process);
        }
        catch
        {
            return null;
        }
    }

    public List<ProcessInfo> GetProcessTree()
    {
        var allProcesses = GetAllProcesses();
        var processById = allProcesses.ToDictionary(p => p.ProcessId);

        // Build parent relationships
        foreach (var process in allProcesses)
        {
            try
            {
                var currentProcess = Process.GetProcessById(process.ProcessId);
                if (currentProcess.Parent() is { } parent)
                {
                    process.ParentProcessId = parent.Id;
                }
            }
            catch
            {
                // If we can't get parent, leave it null
            }
        }

        // Return root processes (those without parents or whose parents don't exist)
        return allProcesses.Where(p => p.ParentProcessId == null ||
                                       !processById.ContainsKey(p.ParentProcessId.Value))
                          .ToList();
    }

    // CPU share since the previous sample: processor time used / wall time elapsed / logical processors
    private double GetCpuUsage(Process process)
    {
        try
        {
            var now = DateTime.UtcNow;
            var cpu = process.TotalProcessorTime;
            double usage = 0;

            if (_cpuSamples.TryGetValue(process.Id, out var previous))
            {
                var elapsed = (now - previous.At).TotalMilliseconds;
                if (elapsed > 0)
                {
                    usage = (cpu - previous.Cpu).TotalMilliseconds / elapsed / Environment.ProcessorCount * 100.0;
                }
            }

            _cpuSamples[process.Id] = (cpu, now);
            return Math.Clamp(usage, 0.0, 100.0);
        }
        catch
        {
            return 0;
        }
    }

    private static string GetWindowTitle(Process process)
    {
        try
        {
            return process.MainWindowTitle ?? string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    public void SaveProcessMetrics(ProcessInfo processInfo)
    {
        DatabaseHelper.SaveProcessMetrics(
            processInfo.ProcessId,
            processInfo.Name,
            processInfo.CpuUsagePercent,
            processInfo.WorkingSetMemory,
            processInfo.GpuUsagePercent,
            processInfo.GpuMemoryBytes);
    }

    public List<(DateTime, double)> GetProcessCpuHistory(int processId)
    {
        return DatabaseHelper.GetProcessCpuHistory(processId);
    }
}

// Extension method to get parent process
public static class ProcessExtensions
{
    public static Process? Parent(this Process process)
    {
        try
        {
            var parentPid = new System.Management.ManagementObject(
                $"win32_process.handle='{process.Id}'").Properties["ParentProcessId"];

            if (parentPid != null && int.TryParse(parentPid.Value.ToString(), out int pid))
            {
                return Process.GetProcessById(pid);
            }
        }
        catch
        {
            // Parent process not found
        }

        return null;
    }
}
