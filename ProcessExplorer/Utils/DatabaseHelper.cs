using System.Data.SQLite;
using System.IO;

namespace ProcessExplorer;

public static class DatabaseHelper
{
    private static readonly string DbPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Masterprocess", "ProcessExplorer.db");

    public static void Initialize()
    {
        var directory = Path.GetDirectoryName(DbPath);
        if (!Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory!);
        }

        using var connection = new SQLiteConnection($"Data Source={DbPath};Version=3;");
        connection.Open();

        CreateTablesIfNotExist(connection);
    }

    private static void CreateTablesIfNotExist(SQLiteConnection connection)
    {
        const string createProcessHistoryTable = @"
            CREATE TABLE IF NOT EXISTS ProcessHistory (
                Id INTEGER PRIMARY KEY AUTOINCREMENT,
                ProcessId INTEGER NOT NULL,
                ProcessName TEXT NOT NULL,
                Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                CpuUsagePercent REAL,
                MemoryBytes INTEGER,
                GpuUsagePercent REAL,
                GpuMemoryBytes INTEGER,
                DiskReadBytesPerSec INTEGER,
                DiskWriteBytesPerSec INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_ProcessId ON ProcessHistory(ProcessId);
            CREATE INDEX IF NOT EXISTS idx_Timestamp ON ProcessHistory(Timestamp);
        ";

        using var command = connection.CreateCommand();
        command.CommandText = createProcessHistoryTable;
        command.ExecuteNonQuery();
    }

    public static string GetConnectionString()
    {
        return $"Data Source={DbPath};Version=3;";
    }

    public static void SaveProcessMetrics(int processId, string processName,
        double cpuUsage, long memory, double gpuUsage, long gpuMemory)
    {
        using var connection = new SQLiteConnection(GetConnectionString());
        connection.Open();

        const string query = @"
            INSERT INTO ProcessHistory
            (ProcessId, ProcessName, CpuUsagePercent, MemoryBytes, GpuUsagePercent, GpuMemoryBytes)
            VALUES (@ProcessId, @ProcessName, @CpuUsage, @Memory, @GpuUsage, @GpuMemory)
        ";

        using var command = connection.CreateCommand();
        command.CommandText = query;
        command.Parameters.AddWithValue("@ProcessId", processId);
        command.Parameters.AddWithValue("@ProcessName", processName);
        command.Parameters.AddWithValue("@CpuUsage", cpuUsage);
        command.Parameters.AddWithValue("@Memory", memory);
        command.Parameters.AddWithValue("@GpuUsage", gpuUsage);
        command.Parameters.AddWithValue("@GpuMemory", gpuMemory);

        command.ExecuteNonQuery();
    }

    public static List<(DateTime, double)> GetProcessCpuHistory(int processId, int lastMinutes = 60)
    {
        var history = new List<(DateTime, double)>();
        using var connection = new SQLiteConnection(GetConnectionString());
        connection.Open();

        const string query = @"
            SELECT Timestamp, CpuUsagePercent
            FROM ProcessHistory
            WHERE ProcessId = @ProcessId
            AND Timestamp > datetime('now', @Minutes)
            ORDER BY Timestamp
        ";

        using var command = connection.CreateCommand();
        command.CommandText = query;
        command.Parameters.AddWithValue("@ProcessId", processId);
        command.Parameters.AddWithValue("@Minutes", $"-{lastMinutes} minutes");

        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var timestamp = DateTime.Parse(reader["Timestamp"].ToString()!);
            var cpuUsage = Convert.ToDouble(reader["CpuUsagePercent"]);
            history.Add((timestamp, cpuUsage));
        }

        return history;
    }
}
