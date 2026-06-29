# Fleet dev setup (Windows).
#
# Installs anything missing (Node, Rust) AFTER asking, runs `npm install`, then launches.
#   .\scripts\windows\setup.ps1            # install deps, then `npm run tauri dev` (default)
#   .\scripts\windows\setup.ps1 dev        # same as above
#   .\scripts\windows\setup.ps1 build      # install deps, then `npm run tauri build` (.msi/.exe)
#   .\scripts\windows\setup.ps1 install    # install deps only, don't run
#   .\scripts\windows\setup.ps1 -Yes       # skip confirmation prompts (assume yes)
#
# If blocked by execution policy, run:
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1
param(
  [ValidateSet('dev', 'build', 'install')]
  [string]$Mode = 'dev',
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'
# Run from the project root (two levels up from scripts\windows\).
Set-Location (Resolve-Path "$PSScriptRoot\..\..")

function Say($msg) { Write-Host "[setup] $msg" -ForegroundColor Cyan }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Update-PathEnv {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$env:USERPROFILE\.cargo\bin"
}
# Ask before changing the user's system. Enter = yes. Returns $true to proceed.
function Confirm-Install($what) {
  if ($Yes) { return $true }
  $ans = Read-Host "$what is not installed. Install it now? [Y/n]"
  return ($ans -eq '' -or $ans -match '^(y|yes)$')
}

if (-not (Have 'winget')) {
  Write-Host "winget is required to auto-install dependencies. Get it from the Microsoft Store ('App Installer'), or install Node + Rust manually." -ForegroundColor Yellow
  if (-not (Have 'node') -or -not (Have 'cargo')) { exit 1 }
}

# --- Node --------------------------------------------------------------------
if (-not (Have 'node')) {
  if (-not (Confirm-Install 'Node.js LTS (via winget)')) {
    Write-Host "Aborted. Node.js is required to build Fleet." -ForegroundColor Yellow; exit 1
  }
  Say "Installing Node.js LTS via winget..."
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  Update-PathEnv
}
if (-not (Have 'node')) { Write-Host "Node still not on PATH. Open a new terminal and re-run." -ForegroundColor Yellow; exit 1 }
Say "Node $(node --version)"

# --- Rust --------------------------------------------------------------------
Update-PathEnv
if (-not (Have 'cargo')) {
  if (-not (Confirm-Install 'Rust (via winget rustup)')) {
    Write-Host "Aborted. Rust is required to build Fleet's backend." -ForegroundColor Yellow; exit 1
  }
  Say "Installing Rust via winget..."
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
  Update-PathEnv
  # Ensure a default toolchain is set up (rustup may install without one).
  if (Have 'rustup') { rustup default stable | Out-Null }
}
if (-not (Have 'cargo')) {
  Write-Host "Rust installed but cargo isn't on PATH yet. Close this terminal, open a NEW one, and re-run the script." -ForegroundColor Yellow
  exit 1
}
Say "Rust $(rustc --version)"

# --- MSVC build tools (the linker Rust needs on Windows) ---------------------
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMsvc = $false
if (Test-Path $vswhere) {
  $found = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName 2>$null
  if ($found) { $hasMsvc = $true }
}
if (-not $hasMsvc) {
  Write-Host "MSVC C++ build tools not found - Rust needs them to link on Windows." -ForegroundColor Yellow
  Write-Host "Install with:" -ForegroundColor Yellow
  Write-Host '  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' -ForegroundColor Yellow
  Write-Host "Then re-run the script." -ForegroundColor Yellow
  exit 1
}
Say "MSVC C++ build tools present"

# --- project deps ------------------------------------------------------------
if (-not (Test-Path 'node_modules')) {
  Say "Installing npm dependencies..."
  npm install
} else {
  Say "node_modules present - skipping npm install"
}

# --- run ---------------------------------------------------------------------
switch ($Mode) {
  'install' { Say "Setup complete. Run: npm run tauri dev" }
  'dev'     { Say "Launching dev app..."; npm run tauri dev }
  'build'   {
    Say "Building release bundle..."
    npm run tauri build
    Say "Done. Bundles in: src-tauri\target\release\bundle\"
  }
}
