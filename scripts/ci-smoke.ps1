# Smoke test for the built app on a Windows runner (Windows PowerShell 5.1).
# Starts the exe, waits for the main window, checks its title, starts monitoring through UI Automation,
# verifies that the process list is filled and (optionally) saves a real screenshot of the window.
# Usage: ci-smoke.ps1 -Exe <path> [-Shot <png path>] [-ExpectDb]
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string]$Shot = '',
    [switch]$ExpectDb
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type -Namespace Smoke -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

$started = Get-Date
$db = Join-Path $env:APPDATA 'Master Process\history.db'
if ($ExpectDb -and (Test-Path $db)) { Remove-Item $db -Force }

function Show-Crash {
    Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $started } -ErrorAction SilentlyContinue |
        Where-Object { $_.ProviderName -in '.NET Runtime', 'Application Error' } |
        Select-Object -First 4 | ForEach-Object { Write-Host "--- $($_.ProviderName)`n$($_.Message)" }
}

Write-Host "Starting: $Exe"
$p = Start-Process -FilePath $Exe -PassThru
try {
    $hwnd = [IntPtr]::Zero
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1
        if ($p.HasExited) { Show-Crash; throw "The app exited during startup (exit code $($p.ExitCode))." }
        $p.Refresh()
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $p.MainWindowHandle; break }
    }
    if ($hwnd -eq [IntPtr]::Zero) { throw 'No main window after 90 s.' }
    if ($p.MainWindowTitle -ne 'Master Process') { throw "Unexpected window title: '$($p.MainWindowTitle)'" }
    Write-Host "Window is up: '$($p.MainWindowTitle)'"

    [void][Smoke.Win]::ShowWindow($hwnd, 3)          # SW_MAXIMIZE
    [void][Smoke.Win]::SetForegroundWindow($hwnd)

    $ae = [System.Windows.Automation.AutomationElement]
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    $root = $ae::FromHandle($hwnd)
    $byName = New-Object System.Windows.Automation.PropertyCondition($ae::NameProperty, 'Start Monitoring')
    $button = $root.FindFirst($scope, $byName)
    if ($null -eq $button) { throw 'Start Monitoring button not found.' }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()

    # Two timer ticks (2 s each) so that CPU values come from real samples
    Start-Sleep -Seconds 7
    if ($p.HasExited) { Show-Crash; throw "The app exited while monitoring (exit code $($p.ExitCode))." }

    $isRow = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataItem)
    $rows = $root.FindAll($scope, $isRow)
    Write-Host "Visible process rows: $($rows.Count)"
    if ($rows.Count -lt 5) { throw 'The process list is empty.' }

    # Select a row that has details to show (the app itself when it is visible)
    $pick = $rows[0]
    $own = New-Object System.Windows.Automation.PropertyCondition($ae::NameProperty, $p.ProcessName)
    foreach ($r in $rows) { if ($null -ne $r.FindFirst($scope, $own)) { $pick = $r; break } }
    try { $pick.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { Write-Host "Row selection skipped: $_" }
    Start-Sleep -Seconds 5
    if ($p.HasExited) { Show-Crash; throw "The app exited after selecting a row (exit code $($p.ExitCode))." }

    $texts = $root.FindAll($scope, (New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))
    $names = @($texts | ForEach-Object { $_.Current.Name })
    $status = $names | Where-Object { $_ -like 'Monitoring: *' -or $_ -like 'Processes: *' -or $_ -like 'Error: *' }
    Write-Host "Status texts: $($status -join ' | ')"
    if ($names -notcontains 'Monitoring: True') { throw 'Monitoring did not start.' }
    if ($status | Where-Object { $_ -like 'Error: *' }) { throw "The app reports an error: $status" }

    if ($ExpectDb) {
        if (-not (Test-Path $db)) { throw "History database was not created: $db" }
        Write-Host "History database: $((Get-Item $db).Length) bytes"
    }

    if ($Shot) {
        try {
            $rect = New-Object Smoke.Win+RECT
            [void][Smoke.Win]::GetWindowRect($hwnd, [ref]$rect)
            $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $x = [Math]::Max($rect.Left, 0); $y = [Math]::Max($rect.Top, 0)
            $w = [Math]::Min($rect.Right, $screen.Width) - $x; $h = [Math]::Min($rect.Bottom, $screen.Height) - $y
            $bmp = New-Object System.Drawing.Bitmap($w, $h)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Shot) | Out-Null
            $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
            $g.Dispose(); $bmp.Dispose()
            Write-Host "Screenshot: $Shot (${w}x${h})"
        } catch { Write-Host "::warning::Screenshot failed: $_" }
    }
    Write-Host 'Smoke test passed.'
}
finally {
    if (-not $p.HasExited) {
        [void]$p.CloseMainWindow()
        if (-not $p.WaitForExit(5000)) { $p.Kill() }
    }
}
