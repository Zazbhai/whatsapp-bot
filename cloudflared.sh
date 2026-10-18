#!/usr/bin/env bash
# ==============================================================================
# Cloudflared Automation Script for WhatsApp Bot & Auto-Redirect Gateway
# Exposes port 3001 (WhatsApp Auto-Redirect) or port 3000 (Dashboard) to the web
# ==============================================================================

set -e

PORT="${1:-${REDIRECT_PORT:-3001}}"
CLOUDFLARED_BIN="$(command -v cloudflared 2>/dev/null || echo "")"

install_or_update_cloudflared() {
  echo "[CLOUDFLARED] Checking for cloudflared binary..."
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  ARCH_URL="cloudflared-linux-amd64" ;;
    aarch64|arm64) ARCH_URL="cloudflared-linux-arm64" ;;
    armv7l)  ARCH_URL="cloudflared-linux-arm" ;;
    *) echo "[ERROR] Unsupported system architecture: $ARCH"; exit 1 ;;
  esac

  TARGET_DIR="/usr/local/bin"
  if [ ! -w "$TARGET_DIR" ]; then
    TARGET_DIR="$HOME/.local/bin"
    mkdir -p "$TARGET_DIR"
    export PATH="$TARGET_DIR:$PATH"
  fi

  echo "[CLOUDFLARED] Downloading latest cloudflared release for $ARCH..."
  DOWNLOAD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/$ARCH_URL"
  
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$TARGET_DIR/cloudflared" "$DOWNLOAD_URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TARGET_DIR/cloudflared" "$DOWNLOAD_URL"
  else
    echo "[ERROR] Neither curl nor wget found. Please install curl or wget first."
    exit 1
  fi

  chmod +x "$TARGET_DIR/cloudflared"
  CLOUDFLARED_BIN="$TARGET_DIR/cloudflared"
  echo "[CLOUDFLARED] Installed successfully at $CLOUDFLARED_BIN ($($CLOUDFLARED_BIN --version))"
}

# Install if not present
if [ -z "$CLOUDFLARED_BIN" ] || [ ! -x "$CLOUDFLARED_BIN" ]; then
  install_or_update_cloudflared
fi

# Optional update flag check
if [ "$2" == "--update" ] || [ "$1" == "--update" ]; then
  install_or_update_cloudflared
  if [ "$1" == "--update" ]; then exit 0; fi
fi

echo "=============================================================================="
echo "🚀 STARTING CLOUDFLARE TUNNEL FOR PORT: $PORT"
if [ "$PORT" == "3001" ]; then
  echo "👉 Target: WhatsApp Auto-Redirect Gateway (wa.me click-to-chat)"
elif [ "$PORT" == "3000" ]; then
  echo "👉 Target: Admin Dashboard & Web Store"
elif [ "$PORT" == "3005" ]; then
  echo "👉 Target: APK Download Server"
fi
echo "=============================================================================="

# If Cloudflare Tunnel Token is provided in environment, run authenticated named tunnel
if [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
  echo "[CLOUDFLARED] Running authenticated Cloudflare Tunnel with token..."
  exec "$CLOUDFLARED_BIN" tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN"
fi

# Otherwise, create an instant zero-config Quick Tunnel (trycloudflare.com)
LOG_FILE="/tmp/cloudflared_${PORT}.log"
URL_FILE=".tunnel_url_${PORT}"
rm -f "$LOG_FILE"

echo "[CLOUDFLARED] Establishing zero-config Quick Tunnel..."
echo "[CLOUDFLARED] Forwarding to: http://127.0.0.1:$PORT"

# Run tunnel and monitor output for public trycloudflare URL
"$CLOUDFLARED_BIN" tunnel --url "http://127.0.0.1:$PORT" 2>&1 | tee "$LOG_FILE" &
TUNNEL_PID=$!

cleanup() {
  echo -e "\n[CLOUDFLARED] Shutting down tunnel (PID: $TUNNEL_PID)..."
  kill "$TUNNEL_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM EXIT

# Poll log file for generated URL
echo "[CLOUDFLARED] Waiting for public HTTPS URL..."
FOUND_URL=""
for i in {1..30}; do
  if [ -f "$LOG_FILE" ]; then
    FOUND_URL=$(grep -o 'https://[-a-zA-Z0-9]*\.trycloudflare\.com' "$LOG_FILE" | head -n 1 || true)
    if [ -n "$FOUND_URL" ]; then
      break
    fi
  fi
  sleep 1
done

if [ -n "$FOUND_URL" ]; then
  echo ""
  echo "=============================================================================="
  echo "🎉 YOUR PUBLIC HTTPS CLOUDFLARE TUNNEL IS LIVE!"
  echo "🌐 Public URL: $FOUND_URL"
  echo "🔗 Forwarding -> http://localhost:$PORT"
  echo "=============================================================================="
  echo "$FOUND_URL" > "$URL_FILE"
  echo "Saved URL to $URL_FILE"
else
  echo "[WARN] Could not parse tunnel URL automatically. Check log output above."
fi

# Wait for tunnel process
wait "$TUNNEL_PID"
