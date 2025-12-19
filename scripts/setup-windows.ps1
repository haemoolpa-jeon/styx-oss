# Styx 저지연 오디오 설정 스크립트
# 관리자 권한으로 실행 필요

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Styx 저지연 오디오 설정 스크립트" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 관리자 권한 확인
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "❌ 관리자 권한이 필요합니다!" -ForegroundColor Red
    Write-Host "PowerShell을 관리자 권한으로 다시 실행해주세요." -ForegroundColor Yellow
    pause
    exit 1
}

Write-Host "✅ 관리자 권한 확인됨" -ForegroundColor Green
Write-Host ""

# 1. 방화벽 설정
Write-Host "[1/4] 방화벽 규칙 추가 중..." -ForegroundColor Yellow

try {
    # 기존 규칙 삭제 (있으면)
    netsh advfirewall firewall delete rule name="Styx UDP In" 2>$null
    netsh advfirewall firewall delete rule name="Styx UDP Out" 2>$null
    
    # 새 규칙 추가
    netsh advfirewall firewall add rule name="Styx UDP In" dir=in action=allow protocol=UDP localport=10000-65535 | Out-Null
    netsh advfirewall firewall add rule name="Styx UDP Out" dir=out action=allow protocol=UDP localport=10000-65535 | Out-Null
    
    Write-Host "✅ 방화벽 규칙 추가 완료" -ForegroundColor Green
} catch {
    Write-Host "⚠️ 방화벽 설정 실패: $_" -ForegroundColor Red
}
Write-Host ""

# 2. 네트워크 확인
Write-Host "[2/4] 네트워크 상태 확인 중..." -ForegroundColor Yellow

try {
    $publicIP = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 5)
    Write-Host "  공인 IP: $publicIP" -ForegroundColor White
    
    # 게이트웨이 확인
    $gateway = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Select-Object -First 1).NextHop
    Write-Host "  게이트웨이: $gateway" -ForegroundColor White
    
    # CGNAT 경고
    if ($publicIP -match "^100\.64\." -or $publicIP -match "^10\." -or $publicIP -match "^172\.(1[6-9]|2[0-9]|3[01])\.") {
        Write-Host "⚠️ CGNAT 감지됨 - ISP에 공인 IP 요청 권장" -ForegroundColor Yellow
    } else {
        Write-Host "✅ 공인 IP 사용 중 (P2P UDP 가능)" -ForegroundColor Green
    }
} catch {
    Write-Host "⚠️ 네트워크 확인 실패" -ForegroundColor Red
}
Write-Host ""

# 3. 오디오 장치 확인
Write-Host "[3/4] 오디오 장치 확인 중..." -ForegroundColor Yellow

$audioDevices = Get-PnpDevice -Class AudioEndpoint -Status OK | Select-Object -ExpandProperty FriendlyName
Write-Host "  감지된 오디오 장치:" -ForegroundColor White
foreach ($device in $audioDevices) {
    if ($device -match "ASIO|Focusrite|Scarlett|Behringer|Steinberg|MOTU|PreSonus|Universal Audio") {
        Write-Host "    ✅ $device (ASIO 가능)" -ForegroundColor Green
    } else {
        Write-Host "    - $device" -ForegroundColor Gray
    }
}
Write-Host ""

# 4. 연결 테스트
Write-Host "[4/4] 서울 서버 연결 테스트 중..." -ForegroundColor Yellow

try {
    $ping = Test-Connection -ComputerName "stun.l.google.com" -Count 3 -ErrorAction Stop
    $avgLatency = ($ping | Measure-Object -Property ResponseTime -Average).Average
    
    if ($avgLatency -lt 20) {
        Write-Host "✅ 평균 지연: $([math]::Round($avgLatency, 1))ms (우수)" -ForegroundColor Green
    } elseif ($avgLatency -lt 50) {
        Write-Host "✅ 평균 지연: $([math]::Round($avgLatency, 1))ms (양호)" -ForegroundColor Yellow
    } else {
        Write-Host "⚠️ 평균 지연: $([math]::Round($avgLatency, 1))ms (높음)" -ForegroundColor Red
    }
} catch {
    Write-Host "⚠️ 연결 테스트 실패" -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  설정 완료!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "다음 단계:" -ForegroundColor White
Write-Host "  1. Styx 데스크톱 앱 실행" -ForegroundColor White
Write-Host "  2. '⚡ 저지연 모드' 체크" -ForegroundColor White
Write-Host "  3. 'UDP (저지연)' 모드 선택" -ForegroundColor White
Write-Host "  4. 방 입장 후 테스트" -ForegroundColor White
Write-Host ""

pause
