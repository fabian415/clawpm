# Build custom OpenClaw image with pre-installed Python packages
# Usage: run from clawpm root  .\docker\build.ps1

$IMAGE_TAG = "clawpm-openclaw:2026.6.8-py"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Building $IMAGE_TAG ..." -ForegroundColor Cyan
docker build -t $IMAGE_TAG "$SCRIPT_DIR"

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Build succeeded." -ForegroundColor Green
    Write-Host "Add or update the following line in your .env:" -ForegroundColor Green
    Write-Host "  OPENCLAW_IMAGE=$IMAGE_TAG" -ForegroundColor Yellow
} else {
    Write-Host "Build failed. Make sure Docker is running and ghcr.io is reachable." -ForegroundColor Red
    exit 1
}
