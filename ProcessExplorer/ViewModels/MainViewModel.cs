using System.Collections.ObjectModel;
using System.Runtime.InteropServices;
using System.Windows.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using ProcessExplorer.Models;
using ProcessExplorer.Services;

namespace ProcessExplorer.ViewModels;

public partial class MainViewModel : ObservableObject
{
    private readonly ProcessService _processService = new();
    private DispatcherTimer? _updateTimer;

    [ObservableProperty]
    private ObservableCollection<ProcessInfo> processes = new();

    [ObservableProperty]
    private ProcessInfo? selectedProcess;

    [ObservableProperty]
    private bool isMonitoring = false;

    [ObservableProperty]
    private string? statusMessage = "Ready";

    [ObservableProperty]
    private double systemCpuUsage = 0;

    [ObservableProperty]
    private long totalMemoryBytes = 0;

    [ObservableProperty]
    private long availableMemoryBytes = 0;

    public MainViewModel()
    {
        RefreshProcessList();
        UpdateSystemMetrics();
    }

    [RelayCommand]
    public void StartMonitoring()
    {
        if (IsMonitoring) return;

        IsMonitoring = true;
        StatusMessage = "Monitoring...";

        _updateTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _updateTimer.Tick += (s, e) =>
        {
            RefreshProcessList();
            UpdateSystemMetrics();

            // Save metrics for selected process
            if (SelectedProcess != null)
            {
                _processService.SaveProcessMetrics(SelectedProcess);
            }
        };

        _updateTimer.Start();
    }

    [RelayCommand]
    public void StopMonitoring()
    {
        if (!IsMonitoring) return;

        _updateTimer?.Stop();
        IsMonitoring = false;
        StatusMessage = "Monitoring stopped";
    }

    [RelayCommand]
    public void RefreshProcessList()
    {
        try
        {
            var processList = _processService.GetAllProcesses();

            // Update existing or add new
            var updated = new HashSet<int>();
            foreach (var process in processList)
            {
                updated.Add(process.ProcessId);

                var existing = Processes.FirstOrDefault(p => p.ProcessId == process.ProcessId);
                if (existing != null)
                {
                    // Update properties
                    existing.WorkingSetMemory = process.WorkingSetMemory;
                    existing.CpuUsagePercent = process.CpuUsagePercent;
                    existing.ThreadCount = process.ThreadCount;
                    existing.LastUpdated = DateTime.Now;
                }
                else
                {
                    Processes.Add(process);
                }
            }

            // Remove terminated processes
            var toRemove = Processes.Where(p => !updated.Contains(p.ProcessId)).ToList();
            foreach (var process in toRemove)
            {
                Processes.Remove(process);
            }

            StatusMessage = $"Processes: {Processes.Count}";
        }
        catch (Exception ex)
        {
            StatusMessage = $"Error: {ex.Message}";
        }
    }

    private void UpdateSystemMetrics()
    {
        try
        {
            // Get total and available memory
            var memoryStatus = new MEMORYSTATUSEX();
            if (GlobalMemoryStatusEx(ref memoryStatus))
            {
                TotalMemoryBytes = (long)memoryStatus.ullTotalPhys;
                AvailableMemoryBytes = (long)memoryStatus.ullAvailPhys;
            }

            // Get CPU usage
            SystemCpuUsage = GetSystemCpuUsage();
        }
        catch
        {
            // Silently fail
        }
    }

    private static double GetSystemCpuUsage()
    {
        try
        {
            var cpuCounter = new System.Diagnostics.PerformanceCounter(
                "Processor", "% Processor Time", "_Total", true);
            cpuCounter.NextValue(); // First call returns 0, so call it twice
            return cpuCounter.NextValue();
        }
        catch
        {
            return 0;
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;

        public MEMORYSTATUSEX()
        {
            this.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        }
    }
}
