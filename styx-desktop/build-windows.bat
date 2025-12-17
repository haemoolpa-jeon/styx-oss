@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   Styx Desktop - Windows Build
echo ========================================
echo.

REM Check Rust
where rustc >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Rust not found.
    echo Please install from https://rustup.rs
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('rustc --version') do echo Rust: %%i

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
echo This may take several minutes on first build.
echo.

cd /d "%~dp0"
cargo tauri build

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Build Complete!
echo ========================================
echo.
echo Installers are located in:
echo   src-tauri\target\release\bundle\
echo.
echo - MSI installer: msi\
echo - NSIS installer: nsis\
echo.

pause
