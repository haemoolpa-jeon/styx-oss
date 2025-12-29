@echo off
REM Build script for Styx - generates both production and dev versions

cd /d "%~dp0src-tauri"

echo 🔨 Building Styx...

REM Build production version (devtools disabled)
echo 📦 Building production version...
powershell -Command "(Get-Content tauri.conf.json) -replace '\"devtools\": true', '\"devtools\": false' | Set-Content tauri.conf.json"
cargo tauri build --bundles msi,nsis

REM Rename production artifacts
if exist "target\release\bundle\msi\*.msi" (
  for %%f in (target\release\bundle\msi\*.msi) do (
    if not "%%~nf"==*"-prod" if not "%%~nf"==*"-dev" (
      ren "%%f" "%%~nf-prod.msi"
    )
  )
)
if exist "target\release\bundle\nsis\*.exe" (
  for %%f in (target\release\bundle\nsis\*.exe) do (
    if not "%%~nf"==*"-prod" if not "%%~nf"==*"-dev" (
      ren "%%f" "%%~nf-prod.exe"
    )
  )
)

REM Build dev version (devtools enabled)
echo 🔧 Building dev version...
powershell -Command "(Get-Content tauri.conf.json) -replace '\"devtools\": false', '\"devtools\": true' | Set-Content tauri.conf.json"
cargo tauri build --bundles msi,nsis

REM Rename dev artifacts
if exist "target\release\bundle\msi\*.msi" (
  for %%f in (target\release\bundle\msi\*.msi) do (
    echo %%~nf | findstr /C:"-prod" >nul || (
      echo %%~nf | findstr /C:"-dev" >nul || ren "%%f" "%%~nf-dev.msi"
    )
  )
)
if exist "target\release\bundle\nsis\*.exe" (
  for %%f in (target\release\bundle\nsis\*.exe) do (
    echo %%~nf | findstr /C:"-prod" >nul || (
      echo %%~nf | findstr /C:"-dev" >nul || ren "%%f" "%%~nf-dev.exe"
    )
  )
)

REM Reset to production config
powershell -Command "(Get-Content tauri.conf.json) -replace '\"devtools\": true', '\"devtools\": false' | Set-Content tauri.conf.json"

echo ✅ Build complete!
echo 📁 Artifacts in: src-tauri\target\release\bundle\
dir target\release\bundle\msi\ 2>nul
dir target\release\bundle\nsis\ 2>nul
