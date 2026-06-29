#!/usr/bin/env bash
# Fleet dev setup (macOS / Linux).
#
# Installs anything missing (Node, Rust) AFTER asking, runs `npm install`, then launches.
#   ./scripts/macos/setup.sh          # install deps, then `npm run tauri dev` (default)
#   ./scripts/macos/setup.sh dev      # same as above
#   ./scripts/macos/setup.sh build    # install deps, then `npm run tauri build` (.dmg/.app)
#   ./scripts/macos/setup.sh install  # install deps only, don't run
#   ./scripts/macos/setup.sh -y       # skip confirmation prompts; combine: ... build -y
set -euo pipefail

MODE="dev"
ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    dev|build|install) MODE="$a" ;;
    -y|--yes) ASSUME_YES=1 ;;
    *) echo "usage: $0 [dev|build|install] [-y]" >&2; exit 1 ;;
  esac
done

# Run from the project root (two levels up from scripts/macos/).
cd "$(dirname "$0")/../.."
OS="$(uname -s)"
say() { printf '\033[1;36m[setup]\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
# Ask before changing the user's system. Enter = yes. Returns 0 to proceed.
confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf '%s is not installed. Install it now? [Y/n] ' "$1"
  local ans=""
  read -r ans </dev/tty || return 1
  case "$ans" in ""|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# --- platform deps -----------------------------------------------------------
if [ "$OS" = "Darwin" ]; then
  # Xcode Command Line Tools (provides cc/clang the Rust linker needs).
  if ! xcode-select -p >/dev/null 2>&1; then
    if ! confirm "Xcode Command Line Tools"; then
      echo "Aborted. The Command Line Tools are required to build Fleet." >&2; exit 1
    fi
    say "Installing Xcode Command Line Tools (a dialog may pop up - finish it, then re-run this script)..."
    xcode-select --install || true
    echo "Re-run this script once the Command Line Tools finish installing." >&2
    exit 1
  fi
  # Homebrew - used to install Node if it's missing.
  if ! have brew && ! have node; then
    if ! confirm "Homebrew (to install Node)"; then
      echo "Aborted. Install Node.js from https://nodejs.org and re-run." >&2; exit 1
    fi
    say "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Make brew available for the rest of this run.
    if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
    if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
  fi
fi

# --- Node --------------------------------------------------------------------
if ! have node; then
  if [ "$OS" = "Darwin" ] && have brew; then
    if ! confirm "Node.js (via Homebrew)"; then
      echo "Aborted. Node.js is required to build Fleet." >&2; exit 1
    fi
    say "Installing Node via Homebrew..."; brew install node
  else
    echo "Node.js is required but not installed. Install it from https://nodejs.org and re-run." >&2
    exit 1
  fi
fi
say "Node $(node --version)"

# --- Rust --------------------------------------------------------------------
if ! have cargo; then
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
fi
if ! have cargo; then
  if ! confirm "Rust (via rustup)"; then
    echo "Aborted. Rust is required to build Fleet's backend." >&2; exit 1
  fi
  say "Installing Rust via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
say "Rust $(rustc --version)"

# --- project deps ------------------------------------------------------------
if [ ! -d node_modules ]; then
  say "Installing npm dependencies..."; npm install
else
  say "node_modules present - skipping npm install"
fi

# --- run ---------------------------------------------------------------------
case "$MODE" in
  install) say "Setup complete. Run: npm run tauri dev" ;;
  dev)     say "Launching dev app...";   npm run tauri dev ;;
  build)   say "Building release bundle..."; npm run tauri build
           say "Done. Bundles in: src-tauri/target/release/bundle/" ;;
esac
