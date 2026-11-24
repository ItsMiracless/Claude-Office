#!/usr/bin/env bash
# =============================================================================
# connect-laptop.sh — send this computer's Claude Code sessions to a remote office
#
#   bash deploy/connect-laptop.sh https://office.irvinhub.com
#
# Run from this checkout on your laptop (macOS, Linux, or Windows via WSL /
# Git Bash). It asks for the office token (printed by deploy/install-vps.sh),
# stores it in ~/.agent-office/auth-token (only you can read it), writes the
# office address to ~/.agent-office/server-url and installs the Claude Code
# hooks. The hooks sign every post with the token; the token never goes on a
# command line.
#
# Undo: rm ~/.agent-office/server-url   (back to a local office)
#       npm run uninstall-hooks          (remove the hooks)
# =============================================================================
set -euo pipefail

URL="${1:-}"
URL="${URL%/}"
case "$URL" in
  https://*) ;;
  *) echo "Pakai: bash deploy/connect-laptop.sh https://office.irvinhub.com" >&2; exit 1 ;;
esac
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v python3 >/dev/null || { echo "python3 dibutuhkan" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl dibutuhkan" >&2; exit 1; }

HOME_DIR="${AGENT_OFFICE_HOME:-$HOME/.agent-office}"
mkdir -p "$HOME_DIR"; chmod 700 "$HOME_DIR"

TOKEN="${OFFICE_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  read -r -s -p "Token kantor (dari output install-vps.sh): " TOKEN; echo
fi
[[ "$TOKEN" =~ ^[0-9a-f]{32,128}$ ]] || { echo "Token tidak valid (harus heksadesimal)" >&2; exit 1; }

# Check the token against the office before saving anything (header via stdin, not argv)
CODE="$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -s -o /dev/null -w '%{http_code}' --max-time 10 -K - "$URL/health" || true)"
case "$CODE" in
  200) echo "OK: kantor $URL menerima token ini" ;;
  401) echo "Token ditolak oleh $URL" >&2; exit 1 ;;
  *)   echo "Tidak bisa menghubungi $URL/health (HTTP $CODE). Cek DNS/HTTPS di VPS." >&2; exit 1 ;;
esac

umask 077
printf '%s\n' "$TOKEN" > "$HOME_DIR/auth-token"
printf 'Authorization: Bearer %s\n' "$TOKEN" > "$HOME_DIR/auth-header"
printf '%s\n' "$URL" > "$HOME_DIR/server-url"
echo "OK: token & alamat disimpan di $HOME_DIR"

bash hooks/install-hooks.sh

cat <<EOF

Selesai. Buka sesi Claude Code baru (atau restart yang lama), lalu lihat
$URL — setiap sesi muncul sebagai Claude berwarna di kantor.
EOF
