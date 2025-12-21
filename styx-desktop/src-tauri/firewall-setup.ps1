# Styx Firewall Setup Script
# Called by MSI installer

param(
    [string]$InstallDir = $env:ProgramFiles + "\Styx"
)

try {
    Write-Host "Configuring Windows Firewall for Styx..."
    
    # Remove existing rules
    netsh advfirewall firewall delete rule name="Styx UDP In" 2>$null
    netsh advfirewall firewall delete rule name="Styx UDP Out" 2>$null
    
    # Add new rules with program path
    $exePath = Join-Path $InstallDir "styx-desktop.exe"
    
    netsh advfirewall firewall add rule name="Styx UDP In" dir=in action=allow protocol=UDP localport=10000-65535 program="$exePath"
    netsh advfirewall firewall add rule name="Styx UDP Out" dir=out action=allow protocol=UDP localport=10000-65535 program="$exePath"
    
    Write-Host "✅ Firewall rules configured successfully"
    exit 0
} catch {
    Write-Host "⚠️ Could not configure firewall: $_"
    Write-Host "You may need to allow Styx manually when prompted"
    exit 1
}
