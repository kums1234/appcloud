#!/usr/bin/env bash
# setup-local-access.sh
# Sets up permanent browser access to AppCloud at http://appcloud.local
# without needing to run minikube tunnel manually in a terminal.
#
# What this does:
#   1. Installs the minikube tunnel as a macOS launchd daemon (auto-start)
#   2. Sets up dnsmasq to resolve *.appcloud.local → 127.0.0.1
#   3. Configures macOS to use dnsmasq for .local resolution
#   4. Adds /etc/hosts entry as a fallback
#
# Usage: chmod +x setup-local-access.sh && ./setup-local-access.sh
# Undo:  ./setup-local-access.sh --uninstall

set -euo pipefail

PROFILE="appcloud"
HOSTNAME="appcloud.local"
PLIST_NAME="com.appcloud.tunnel"
PLIST_DST="/Library/LaunchDaemons/${PLIST_NAME}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTROY="${1:-}"

# ── Detect minikube binary location ──────────────────────────────────────────
MINIKUBE_BIN=$(which minikube 2>/dev/null || echo "/opt/homebrew/bin/minikube")

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  AppCloud Local Access Setup                         ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Uninstall ─────────────────────────────────────────────────────────────────
if [ "$DESTROY" = "--uninstall" ]; then
  echo "► Removing launchd tunnel daemon..."
  sudo launchctl unload "$PLIST_DST" 2>/dev/null || true
  sudo rm -f "$PLIST_DST"

  echo "► Removing dnsmasq config..."
  sudo rm -f /etc/resolver/local
  sudo rm -f /usr/local/etc/dnsmasq.d/appcloud.conf
  brew services stop dnsmasq 2>/dev/null || true

  echo "► Removing /etc/hosts entry..."
  sudo sed -i '' '/appcloud.local/d' /etc/hosts

  echo "✓ Uninstall complete"
  exit 0
fi

# ── Step 1: launchd daemon for minikube tunnel ───────────────────────────────
echo "► Installing minikube tunnel as a background service..."
echo "  (minikube tunnel keeps the ingress accessible at 127.0.0.1)"

# Write the plist
sudo tee "$PLIST_DST" > /dev/null << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${MINIKUBE_BIN}</string>
    <string>tunnel</string>
    <string>--profile=${PROFILE}</string>
    <string>--cleanup</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/appcloud-tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/appcloud-tunnel-error.log</string>
</dict>
</plist>
PLIST

sudo launchctl unload "$PLIST_DST" 2>/dev/null || true
sudo launchctl load "$PLIST_DST"
echo "  ✓ Tunnel daemon installed and started"
echo "  ✓ Logs: /tmp/appcloud-tunnel.log"

# ── Step 2: /etc/hosts entry (immediate fallback) ────────────────────────────
echo ""
echo "► Configuring /etc/hosts..."
if grep -q "$HOSTNAME" /etc/hosts; then
  echo "  ✓ $HOSTNAME already in /etc/hosts"
else
  echo "127.0.0.1  $HOSTNAME" | sudo tee -a /etc/hosts > /dev/null
  echo "  ✓ Added 127.0.0.1  $HOSTNAME"
fi

# ── Step 3: dnsmasq for *.appcloud.local wildcard (optional but nicer) ────────
echo ""
echo "► Setting up dnsmasq for *.appcloud.local wildcard DNS..."
if command -v brew &>/dev/null; then
  # Install dnsmasq if not present
  if ! brew list dnsmasq &>/dev/null; then
    echo "  Installing dnsmasq..."
    brew install dnsmasq
  fi

  # Configure dnsmasq to resolve *.appcloud.local → 127.0.0.1
  DNSMASQ_CONF_DIR="$(brew --prefix)/etc/dnsmasq.d"
  mkdir -p "$DNSMASQ_CONF_DIR"
  echo "address=/.appcloud.local/127.0.0.1" > "$DNSMASQ_CONF_DIR/appcloud.conf"

  # Configure macOS resolver to use dnsmasq for .local queries
  sudo mkdir -p /etc/resolver
  sudo tee /etc/resolver/appcloud.local > /dev/null << RESOLVER
nameserver 127.0.0.1
port 53
RESOLVER

  # Start dnsmasq
  sudo brew services restart dnsmasq
  echo "  ✓ dnsmasq configured — *.appcloud.local resolves to 127.0.0.1"
  echo "  ✓ Resolver configured at /etc/resolver/appcloud.local"
else
  echo "  ⚠ Homebrew not found — skipping dnsmasq (using /etc/hosts only)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Setup complete!                                     ║"
echo "║                                                      ║"
echo "║  Open in your browser (no tunnel terminal needed):  ║"
echo "║                                                      ║"
echo "║   UI:        http://appcloud.local                   ║"
echo "║   API:       http://appcloud.local/health            ║"
echo "║   Neo4j:     http://appcloud.local:7474              ║"
echo "║                                                      ║"
echo "║  The tunnel runs automatically in the background.   ║"
echo "║  Check status: sudo launchctl list | grep appcloud  ║"
echo "║  View logs:    tail -f /tmp/appcloud-tunnel.log      ║"
echo "║                                                      ║"
echo "║  Uninstall: ./setup-local-access.sh --uninstall     ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Note: minikube must be running for the tunnel to work."
echo "  Start minikube: minikube start --profile=appcloud"
echo "  The tunnel will reconnect automatically when minikube restarts."
echo ""