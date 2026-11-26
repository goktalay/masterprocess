using System.Diagnostics;
using System.Management;
using ProcessExplorer.Models;

namespace ProcessExplorer.Services;

public class ProcessService
{
    private readonly Dictionary<int, PerformanceCounter> _cpuCounters = new();
    private readonly Dictionary<int, ProcessInfo> _processCache = new();
    private DateTime _lastUpdateTime = DateTime.UtcNow;

    public List<ProcessInfo> GetAllProcesses()
    {
        var processes = new List<ProcessInfo>();
        var processes_System = Process.GetProcesses();

        foreach (var process in processes_System)
        {
            try
            {
                var processInfo = new ProcessInfo
                {
                    ProcessId = process.Id,
                    Name = process.ProcessName,
                    Path = process.MainModule?.FileName,
                    StartTime = process.StartTime,
                    WorkingSetMemory = process.WorkingSet64,
                    VirtualMemory = process.VirtualMemorySize64,
                    PagedMemory = process.PagedMemorySize64,
                    ThreadCount = process.Threads.Count,
                    MainWindowHandle = process.MainWindowHandle,
                    CpuUsagePercent = GetCpuUsage(process.Id),
                    LastUpdated = DateTime.Now,
                    WindowTitle = GetWindowTitle(process),
                };

                processes.Add(processInfo);
                _processCache[process.Id] = processInfo;
            }
            catch
            {
                // Skip processes we don't have permission to access
            }
        }

        return processes.OrderBy(p => p.Name).ToList();
    }

    public ProcessInfo? GetProcessInfo(int processId)
    {
        if (_processCache.TryGetValue(processId, out var cached))
        {
            return cached;
        }

        try
        {
            var process = Process.GetProcessById(processId);
            return new ProcessInfo
            {
                ProcessId = process.Id,
                Name = process.ProcessName,
                Path = process.MainModule?.FileName,
                StartTime = process.StartTime,
                WorkingSetMemory = process.WorkingSet64,
                VirtualMemory = process.VirtualMemorySize64,
                PagedMemory = process.PagedMemorySize64,
                ThreadCount = process.Threads.Count,
                MainWindowHandle = process.MainWindowHandle,
                CpuUsagePercent = GetCpuUsage(processId),
                LastUpdated = DateTime.Now,
                WindowTitle = GetWindowTitle(process),
            };
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

    private double GetCpuUsage(int processId)
    {
        try
        {
            if (!_cpuCounters.TryGetValue(processId, out var counter))
            {
                counter = new PerformanceCounter("Process", "% Processor Time",
                    Process.GetProcessById(processId).ProcessName, true);
                _cpuCounters[processId] = counter;
            }

            var value = counter.NextValue() / Environment.ProcessorCount;
            return Math.Min(value, 100.0);
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
