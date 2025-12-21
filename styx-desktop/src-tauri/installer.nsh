; Styx Desktop Installer Script
; Adds Windows Firewall rules for UDP audio

!include "MUI2.nsh"

; Custom install function - runs after files are installed
Function .onInstSuccess
    ; Add firewall rules for Styx UDP audio
    DetailPrint "Adding Windows Firewall rules..."
    
    ; Delete existing rules (if any)
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Styx UDP In" 2>nul'
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Styx UDP Out" 2>nul'
    
    ; Add new firewall rules
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Styx UDP In" dir=in action=allow protocol=UDP localport=10000-65535 program="$INSTDIR\styx-desktop.exe"'
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Styx UDP Out" dir=out action=allow protocol=UDP localport=10000-65535 program="$INSTDIR\styx-desktop.exe"'
    
    ; Check if rules were added successfully
    ${If} ${Errors}
        DetailPrint "Warning: Could not add firewall rules. You may need to allow Styx manually."
        MessageBox MB_ICONINFORMATION "Styx has been installed successfully.$\n$\nNote: Windows may ask for firewall permission when you first run the app. Please click 'Allow' to enable audio features."
    ${Else}
        DetailPrint "Firewall rules added successfully."
        MessageBox MB_ICONINFORMATION "Styx has been installed successfully with firewall rules configured automatically."
    ${EndIf}
FunctionEnd

; Custom uninstall function - removes firewall rules
Function un.onUninstSuccess
    DetailPrint "Removing Windows Firewall rules..."
    
    ; Remove firewall rules
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Styx UDP In"'
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Styx UDP Out"'
    
    DetailPrint "Firewall rules removed."
FunctionEnd

; Show firewall info on installer page
Function .onGUIInit
    ; Add custom text to installer
    !insertmacro MUI_INSTALLOPTIONS_WRITE "ioSpecial.ini" "Settings" "Title" "Styx Audio Collaboration"
    !insertmacro MUI_INSTALLOPTIONS_WRITE "ioSpecial.ini" "Settings" "Text" "This installer will automatically configure Windows Firewall for optimal audio performance.$\n$\nStyx requires UDP network access for low-latency audio streaming."
FunctionEnd
