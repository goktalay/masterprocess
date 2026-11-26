using System.Windows;

namespace ProcessExplorer;

public partial class App : Application
{
    public App()
    {
        InitializeComponent();
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Initialize database on startup
        DatabaseHelper.Initialize();
    }
}
