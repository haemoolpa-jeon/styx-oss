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
echo [INFO] Building Styx Desktop...
echo This may take 5-10 minutes on first build.
echo.

cd /d "%~dp0"

REM CMake 4.x compatibility fix for audiopus_sys
set CMAKE_POLICY_VERSION_MINIMUM=3.5

cargo tauri build

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
echo Installers:
echo   src-tauri\target\release\bundle\msi\
echo   src-tauri\target\release\bundle\nsis\
echo.
echo Portable EXE:
echo   src-tauri\target\release\styx-desktop.exe
echo.

pause
