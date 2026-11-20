# VSTY Camera Gateway Launcher for Windows PowerShell
param(
    [string]$CameraIP = "192.168.43.166",
    [string]$Token = $env:VSTY_AUTH_TOKEN
)

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       VSTY Submersible Robot - Camera Gateway            " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Inspect local network
$wifiSSID = (netsh wlan show interfaces | Select-String "^\s*SSID\s*:\s*(.+)" | ForEach-Object { $_.Matches.Groups[1].Value.Trim() } | Select-Object -First 1)
$localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | Select-Object -ExpandProperty IPAddress -First 1)

Write-Host "Laptop Wi-Fi SSID : " -NoNewline
Write-Host ($wifiSSID ? $wifiSSID : "Unknown") -ForegroundColor Green
Write-Host "Laptop IPv4       : " -NoNewline
Write-Host ($localIP ? $localIP : "Unknown") -ForegroundColor Green
Write-Host "Target Camera IP  : " -NoNewline
Write-Host $CameraIP -ForegroundColor Green
Write-Host ""

# 2. Check subnet alignment
if ($CameraIP -like "192.168.43.*" -and $localIP -notlike "192.168.43.*") {
    Write-Host "[!] NETWORK MISMATCH DETECTED!" -ForegroundColor Red
    Write-Host "    Your laptop is connected to: '$wifiSSID' ($localIP)" -ForegroundColor Yellow
    Write-Host "    The camera is on the hotspot: 'GalayxA14' ($CameraIP)" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    -> Please click the Wi-Fi icon on your taskbar and connect to 'GalayxA14'." -ForegroundColor Cyan
    Write-Host ""
}

# 3. Ensure Token is provided
if (-not $Token) {
    Write-Host "No VSTY_AUTH_TOKEN found in environment." -ForegroundColor Yellow
    $Token = Read-Host "Paste your Operator Gateway Token (from Render dashboard)"
}

if (-not $Token) {
    Write-Host "ERROR: An operator token is required to relay video to Render." -ForegroundColor Red
    Write-Host "Log into https://submersible-micro-robot.onrender.com/dashboard and click 'Copy Gateway Token'." -ForegroundColor Yellow
    exit 1
}

# 4. Run the Python Gateway
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "Starting gateway relay..." -ForegroundColor Cyan
py -u tools/camera_gateway.py --camera-url "http://$($CameraIP):81/stream" --token "$Token" --fps 30
