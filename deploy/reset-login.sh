#!/usr/bin/env bash
# =============================================================================
# reset-login.sh — set a new User ID / password for the office login page
#
#   sudo bash deploy/reset-login.sh
#
# Asks for both on the terminal (nothing lands in the shell history), saves
# them in /etc/claude-office/login.json and clears the failed-attempt lock by
# restarting the login service. Every device is signed out and signs in again
# with the new password.
# =============================================================================
set -euo pipefail

LOGIN_FILE="${OFFICE_LOGIN_FILE:-/etc/claude-office/login.json}"
APP_DIR="${OFFICE_APP_DIR:-/opt/claude-office}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY="$APP_DIR/deploy/login-gateway.mjs"
[ -f "$GATEWAY" ] || GATEWAY="$SRC_DIR/deploy/login-gateway.mjs"

[ "$(id -u)" -eq 0 ] || { echo "Jalankan dengan sudo: sudo bash deploy/reset-login.sh" >&2; exit 1; }

CURRENT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["user"])' "$LOGIN_FILE" 2>/dev/null || true)"
[ -n "$CURRENT" ] && echo "User ID sekarang: $CURRENT"

read -r -p "User ID baru [${CURRENT:-irvin}]: " NEW_USER
NEW_USER="${NEW_USER:-${CURRENT:-irvin}}"
while :; do
  read -r -s -p "Password baru (min. 10 karakter): " P1; echo
  read -r -s -p "Ulangi password baru: " P2; echo
  if [ "${#P1}" -lt 10 ]; then echo "Terlalu pendek, coba lagi."; continue; fi
  if [ "$P1" != "$P2" ]; then echo "Tidak sama, coba lagi."; continue; fi
  break
done

GROUP="$(stat -c %G "$(dirname "$LOGIN_FILE")" 2>/dev/null || echo root)"
OFFICE_LOGIN_USER="$NEW_USER" OFFICE_LOGIN_PASS="$P1" OFFICE_LOGIN_FILE="$LOGIN_FILE" node "$GATEWAY" --set-password
unset P1 P2
chown root:"$GROUP" "$LOGIN_FILE"; chmod 640 "$LOGIN_FILE"

systemctl restart claude-office-login 2>/dev/null || true
echo
echo "Selesai. Login di https://<domain-kantor>/login dengan User ID \"$NEW_USER\" (huruf besar/kecil bebas) dan password baru."
