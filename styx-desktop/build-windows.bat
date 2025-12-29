@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   Styx Desktop - Windows Build
echo ========================================
echo.

REM Copy shared client files (keep local config.js)
echo [INFO] Copying shared client files...
cd /d "%~dp0"
copy /Y "..\shared\client\app.js" "client\" >nul
copy /Y "..\shared\client\index.html" "client\" >nul
copy /Y "..\shared\client\style.css" "client\" >nul
copy /Y "..\shared\client\styx-modules.js" "client\" >nul
copy /Y "..\shared\client\noise-gate-processor.js" "client\" >nul
copy /Y "..\shared\client\logo.png" "client\" >nul
copy /Y "..\shared\client\favicon.ico" "client\" >nul
copy /Y "..\shared\client\favicon-16.png" "client\" >nul
copy /Y "..\shared\client\favicon-32.png" "client\" >nul
copy /Y "..\shared\client\apple-touch-icon.png" "client\" >nul
copy /Y "..\shared\client\icon-192.png" "client\" 2>nul
echo [OK] Shared files copied

REM Check Rust
where rustc >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Rust not found.
    echo Please install from https://rustup.rs
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('rustc --version') do echo Rust: %%i

REM Check CMake (required for Opus)
where cmake >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] CMake not found.
    echo Please install from https://cmake.org/download/
    echo Or: winget install Kitware.CMake
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('cmake --version ^| findstr /n "." ^| findstr "^1:"') do (
    set "ver=%%i"
    echo CMake: !ver:~2!
)

REM Check Visual Studio Build Tools
where cl >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] MSVC compiler not in PATH.
    echo Make sure to run from "Developer Command Prompt for VS"
    echo Or install Visual Studio Build Tools.
    echo.
)

REM Check Tauri CLI
cargo tauri --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [INFO] Installing Tauri CLI...
    cargo install tauri-cli
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install Tauri CLI
        pause
        exit /b 1
    )
)
for /f "tokens=*" %%i in ('cargo tauri --version') do echo Tauri CLI: %%i

echo.
echo [INFO] Building Styx Desktop (Production + Dev)...
echo This may take 10-15 minutes on first build.
echo.

cd /d "%~dp0src-tauri"

REM Build production version (devtools disabled)
echo.
echo [1/2] Building PRODUCTION version...
powershell -Command "(Get-Content tauri.conf.json) -replace '\"devtools\": true', '\"devtools\": false' | Set-Content tauri.conf.json"
cargo tauri build

if %errorlevel% neq 0 (
    echo [ERROR] Production build failed!
    pause
    exit /b 1
)

REM Rename production artifacts
for %%f in (target\release\bundle\msi\*.msi) do (
    echo %%~nf | findstr /C:"-prod" >nul || echo %%~nf | findstr /C:"-dev" >nul || ren "%%f" "%%~nf-prod.msi"
)
for %%f in (target\release\bundle\nsis\*.exe) do (
    echo %%~nf | findstr /C:"-prod" >nul || echo %%~nf | findstr /C:"-dev" >nul || ren "%%f" "%%~nf-prod.exe"
)

REM Build dev version (devtools enabled)
echo.
echo [2/2] Building DEV version (with devtools)...
powershell -Command "(Get-Content tauri.conf.json) -replace '\"devtools\": false', '\"devtools\": true' | Set-Content tauri.conf.json"
cargo tauri build

if %errorlevel% neq 0 (
    echo [ERROR] Dev build failed!
    pause
    exit /b 1
)

REM Rename dev artifacts
for %%f in (target\release\bundle\msi\*.msi) do (
    echo %%~nf | findstr /C:"-prod" >nul || echo %%~nf | findstr /C:"-dev" >nul || ren "%%f" "%%~nf-dev.msi"
)
for %%f in (target\release\bundle\nsis\*.exe) do (
    echo %%~nf | findstr /C:"-prod" >nul || echo %%~nf | findstr /C:"-dev" >nul || ren "%%f" "%%~nf-dev.exe"
)

cd /d "%~dp0"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build failed!
    echo.
    echo Common issues:
    echo - Missing CMake: winget install Kitware.CMake
    echo - Missing MSVC: Install Visual Studio Build Tools
    echo - Missing WebView2: Will be bundled automatically
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Build Complete!
echo ========================================
echo.
echo PRODUCTION (for peers - no devtools):
dir /b src-tauri\target\release\bundle\msi\*-prod.msi 2>nul
dir /b src-tauri\target\release\bundle\nsis\*-prod.exe 2>nul
echo.
echo DEV (for you - with devtools, press F12):
dir /b src-tauri\target\release\bundle\msi\*-dev.msi 2>nul
dir /b src-tauri\target\release\bundle\nsis\*-dev.exe 2>nul
echo.
echo Location: src-tauri\target\release\bundle\
echo.

pause
