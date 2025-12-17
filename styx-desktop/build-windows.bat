@echo off
echo Styx Desktop - Windows Build
echo ============================
echo.

REM Check Rust
where rustc >nul 2>&1
if %errorlevel% neq 0 (
    echo Rust not found. Please install from https://rustup.rs
    pause
    exit /b 1
)

REM Check Tauri CLI
cargo tauri --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Installing Tauri CLI...
    cargo install tauri-cli
)

echo Building Styx Desktop...
cd /d "%~dp0"
cargo tauri build

echo.
echo Build complete! Check src-tauri/target/release/bundle/
pause
