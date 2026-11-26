using System.Windows;
using ProcessExplorer.ViewModels;

namespace ProcessExplorer.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Loaded += (s, e) => UpdateMemoryDisplay();
    }

    private void UpdateMemoryDisplay()
    {
        if (DataContext is MainViewModel viewModel)
        {
            TotalMemoryDisplay.Text = FormatBytes(viewModel.TotalMemoryBytes);
            AvailableMemoryDisplay.Text = FormatBytes(viewModel.AvailableMemoryBytes);
        }
    }

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
