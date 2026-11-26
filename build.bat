@echo off
REM Process Explorer - Build Script (Batch)
REM Windows batch build script

setlocal enabledelayedexpansion

set "CONFIGURATION=Release"
set "CLEAN=0"
set "PACKAGE=0"

REM Parse arguments
if "%1"=="clean" set "CLEAN=1"
if "%2"=="clean" set "CLEAN=1"
if "%1"=="package" set "PACKAGE=1"
if "%2"=="package" set "PACKAGE=1"

echo.
echo ================================
echo Process Explorer - Build Script
echo ================================
echo.

REM Check .NET SDK
echo Checking .NET SDK...
dotnet --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: .NET SDK not found. Please install .NET 8.0 SDK first.
    echo Download from: https://dotnet.microsoft.com/download/dotnet/8.0
    exit /b 1
)
for /f "tokens=*" %%i in ('dotnet --version') do set "DOTNET_VERSION=%%i"
echo [OK] .NET SDK version: %DOTNET_VERSION%
echo.

REM Clean
if "%CLEAN%"=="1" (
    echo Cleaning solution...
    call dotnet clean --configuration %CONFIGURATION%
    if %errorlevel% neq 0 (
        echo ERROR: Clean failed
        exit /b 1
    )
    echo [OK] Clean completed
    echo.
)

REM Restore
echo Restoring NuGet packages...
call dotnet restore
if %errorlevel% neq 0 (
    echo ERROR: Restore failed
    exit /b 1
)
echo [OK] Restore completed
echo.

REM Build
echo Building solution (%CONFIGURATION%)...
call dotnet build --configuration %CONFIGURATION% --no-restore
if %errorlevel% neq 0 (
    echo ERROR: Build failed
    exit /b 1
)
echo [OK] Build completed successfully
echo.

REM Output info
echo Output files:
set "OUTPUT_PATH=bin\%CONFIGURATION%\net8.0-windows"
if exist "%OUTPUT_PATH%\ProcessExplorer.exe" (
    for %%F in ("%OUTPUT_PATH%\ProcessExplorer.exe") do set "FILE_SIZE=%%~zF"
    set /a FILE_SIZE_MB=!FILE_SIZE! / 1048576
    echo   Executable: ProcessExplorer.exe (!FILE_SIZE_MB! MB^)
    echo   Location: %cd%\%OUTPUT_PATH%
    echo [OK] Build completed successfully!
) else (
    echo ERROR: Output executable not found
    exit /b 1
)
echo.

REM Package
if "%PACKAGE%"=="1" (
    echo Creating deployment package...
    if not exist "dist" mkdir dist

    REM PowerShell komutunu çalıştır (ZIP oluşturma için)
    powershell -Command "Compress-Archive -Path '%OUTPUT_PATH%' -DestinationPath 'dist\ProcessExplorer-Release.zip' -Force"

    if exist "dist\ProcessExplorer-Release.zip" (
        for %%F in ("dist\ProcessExplorer-Release.zip") do set "ZIP_SIZE=%%~zF"
        set /a ZIP_SIZE_MB=!ZIP_SIZE! / 1048576
        echo [OK] Package created: ProcessExplorer-Release.zip
        echo   Size: !ZIP_SIZE_MB! MB
        echo   Location: %cd%\dist
    ) else (
        echo ERROR: Failed to create package
        exit /b 1
    )
    echo.
)

echo Next steps:
echo   1. Run: bin\%CONFIGURATION%\net8.0-windows\ProcessExplorer.exe
echo   2. Or: dotnet run --project ProcessExplorer/ProcessExplorer.csproj
if "%PACKAGE%"=="0" (
    echo   3. Create package: build.bat package
)
echo.

exit /b 0
