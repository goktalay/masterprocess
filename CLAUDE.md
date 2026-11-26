# CLAUDE.md - Masterprocess Development Guide

## Project Overview
**Process Explorer** - Gelişmiş Windows sistem izleme ve process yönetim aracı
- **Language**: C# .NET 8.0
- **UI Framework**: WPF (Windows Presentation Foundation)
- **Architecture**: MVVM + Services + Repository pattern
- **Database**: SQLite
- **Target**: Windows 10/11

## Project Structure Rules

### File Organization
```
ProcessExplorer/
├── Views/          # XAML UI + Code-behind
├── ViewModels/     # MVVM ViewModels (INotifyPropertyChanged)
├── Models/         # Data classes (ProcessInfo, PerformanceMetrics)
├── Services/       # Business logic (ProcessService, DatabaseHelper)
├── Utils/          # Utilities (NativeInterop, DatabaseHelper)
└── Resources/      # Styles, Colors, Icons
```

### Naming Conventions
- **ViewModels**: `{Feature}ViewModel.cs` (e.g., MainViewModel, ChartsViewModel)
- **Views**: `{Feature}View.xaml` / `{Feature}View.xaml.cs`
- **Services**: `{Feature}Service.cs` (e.g., ProcessService)
- **Models**: Singular noun (e.g., ProcessInfo, PerformanceMetrics)

## Code Standards

### C# Guidelines
- Use `file-scoped namespaces` (not nested)
- Enable `nullable reference types` (Nullable=enable)
- Use modern C# features (records, init properties where appropriate)
- MVVM: Use `CommunityToolkit.Mvvm` for `ObservableObject` and `IRelayCommand`
- Async operations: Use `async/await` with ConfigureAwait(false)

### XAML Guidelines
- Use data binding: `Binding="{Binding PropertyName}"`
- Commands: `Command="{Binding CommandName}"`
- Attached behaviors for complex interactions
- Styles in `Resources/Styles.xaml` (don't inline)
- Color palette defined in Styles.xaml

### Database
- SQLite only (System.Data.SQLite package)
- Use prepared statements with parameters (prevent SQL injection)
- Helper class: `DatabaseHelper.cs`
- Schema: Keep simple, indexed on frequently queried columns

## Development Workflow

### Adding a New Feature

1. **Create Model** (if needed)
   ```csharp
   // Models/FeatureName.cs
   public class FeatureName
   {
       public int Id { get; set; }
       public string Name { get; set; }
   }
   ```

2. **Create Service** (business logic)
   ```csharp
   // Services/FeatureService.cs
   public class FeatureService
   {
       public List<FeatureName> GetItems() { ... }
   }
   ```

3. **Create ViewModel** (UI logic + bindings)
   ```csharp
   // ViewModels/FeatureViewModel.cs
   public partial class FeatureViewModel : ObservableObject
   {
       [ObservableProperty]
       private ObservableCollection<FeatureName> items = new();
       
       [RelayCommand]
       public void LoadItems() { ... }
   }
   ```

4. **Create View** (UI)
   ```xaml
   <!-- Views/FeatureView.xaml -->
   <UserControl ...>
       <DataGrid ItemsSource="{Binding Items}" ... />
   </UserControl>
   ```

5. **Wire in MainWindow** if it's a main feature

### Git Workflow
```bash
# Create feature branch
git checkout -b feature/feature-name

# Make changes, commit regularly
git commit -m "Description of change"

# Push when ready
git push -u origin feature/feature-name

# Create PR on GitHub
```

## Testing Guidelines

- Unit tests: `ProcessExplorer.Tests` project
- Use Moq for mocking services
- Test ViewModels without UI
- Database tests: Use in-memory SQLite (`:memory:`)

## Common Tasks

### Adding Process Monitoring
1. Extend `ProcessService.cs` with new metrics
2. Add properties to `ProcessInfo.cs` model
3. Update `MainViewModel` binding
4. Add database schema to `DatabaseHelper.cs`

### Creating a New Chart
1. Use OxyPlot for graphs
2. Create series in `PerformanceViewModel`
3. Bind in XAML view
4. Update `MainViewModel` data collection

### Database Schema Change
1. Update `DatabaseHelper.CreateTablesIfNotExist()`
2. Add migration helper for existing DBs
3. Test with fresh + existing database

## Debugging Tips

### Performance Counters Issues
- Some processes require admin privileges
- Use try-catch around `PerformanceCounter` calls
- Performance Counters need "warm-up" (call twice)

### UI Freezing
- Keep long operations on background thread
- Use `DispatcherTimer` for UI updates (not Thread.Sleep)
- Use async/await for I/O operations

### Database Issues
- Check database path: `%APPDATA%\Masterprocess\ProcessExplorer.db`
- Use SQLite browser tools to inspect
- Ensure proper connection string in DatabaseHelper

## Dependencies
- OxyPlot.Wpf (2.1.2+) - Graphing
- System.Data.SQLite (1.0.118+) - Database
- CommunityToolkit.Mvvm (8.2.2+) - MVVM

## Future Phases

### Phase 2: Advanced Monitoring
- Real-time performance charts
- GPU monitoring (NVIDIA/AMD SDK)
- Memory and disk I/O visualization

### Phase 3: Deep Analysis
- Hex dump tools
- Process file handles
- Window capture and screenshot
- Memory layout visualization

### Phase 4: System Integration
- Scheduled tasks
- Process alerts and notifications
- Export reports (CSV, PDF)

## Important Notes

1. **Windows-Only**: This is a Windows-specific application (WPF, kernel APIs)
2. **Admin Privileges**: Some features require elevated privileges
3. **Performance**: Monitor memory usage with many processes
4. **Thread Safety**: Use Dispatcher for cross-thread UI updates
5. **Resource Cleanup**: Dispose PerformanceCounter instances properly

## Q&A

**Q: Why WPF and not UWP/WinUI?**
A: WPF provides better low-level Windows API access and mature databinding. WinUI 3 is alternative if needed.

**Q: How to access GPU data?**
A: Requires NVIDIA/AMD SDK integration via native DLLs (C++ wrapper)

**Q: Can this run on Linux?**
A: No, it's Windows-specific. Mono/Wine would work but not recommended.

**Q: Performance impact of monitoring?**
A: Minimal - process enumeration every 2 seconds is negligible on modern systems.
