#!/usr/bin/env bash
# =============================================================================
# enable-auto-update.sh — one-time setup: GitHub pushes go live by themselves
#
#   cd ~/claude-office && sudo bash deploy/enable-auto-update.sh office.irvinhub.com
#
# 1. makes a read-only deploy key for this repository (no personal token needed
#    afterwards) and waits until it is added on GitHub
# 2. points this checkout at GitHub through that key
# 3. installs claude-office-update.timer: every 2 minutes it checks GitHub and,
#    when there is a new commit, deploys it (deploy/auto-update.sh)
# 4. runs install-vps.sh once now (asks the login password if none is set yet)
#
# Stop it:   sudo systemctl disable --now claude-office-update.timer
# Its log:   journalctl -u claude-office-update -n 50
# =============================================================================
set -euo pipefail

DOMAIN="${1:-}"
REPO="${OFFICE_REPO:-ItsMiracless/Claude-Office}"
BRANCH="${OFFICE_BRANCH:-main}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY=/root/.ssh/claude_office_deploy
HOST_ALIAS=github-claude-office

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Jalankan dengan sudo"
[ -n "$DOMAIN" ] || die "Pakai: sudo bash deploy/enable-auto-update.sh office.irvinhub.com"
git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 || die "$SRC bukan checkout git (clone dulu dari GitHub)"
command -v ssh-keygen >/dev/null || { apt-get update -q && apt-get install -y -q openssh-client >/dev/null; }

# --- 1. deploy key ---------------------------------------------------------------
say "Deploy key (hanya-baca) untuk $REPO"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "claude-office-deploy@$(hostname)" -f "$KEY"
touch /root/.ssh/config && chmod 600 /root/.ssh/config
if ! grep -q "^Host $HOST_ALIAS\$" /root/.ssh/config; then
  cat >> /root/.ssh/config <<EOF

Host $HOST_ALIAS
    HostName github.com
    User git
    IdentityFile $KEY
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
EOF
fi

if ! git ls-remote "git@$HOST_ALIAS:$REPO.git" HEAD >/dev/null 2>&1; then
  cat <<EOF

Tambahkan PUBLIC key ini ke GitHub (aman dibagikan, ini bukan rahasia):

$(cat "$KEY.pub")

Pilih salah satu:
  a) Kirim baris di atas ke Claude, ia yang menambahkannya, atau
  b) GitHub -> $REPO -> Settings -> Deploy keys -> Add deploy key
     (Title: vps-office, JANGAN centang "Allow write access")

EOF
  while ! git ls-remote "git@$HOST_ALIAS:$REPO.git" HEAD >/dev/null 2>&1; do
    read -r -p "Tekan Enter setelah key ditambahkan (Ctrl+C untuk batal)... " _
  done
fi
echo "OK: VPS bisa membaca $REPO lewat deploy key"

# --- 2. checkout -> deploy key -------------------------------------------------
say "Arahkan $SRC ke GitHub lewat deploy key"
git -C "$SRC" remote set-url origin "git@$HOST_ALIAS:$REPO.git"
git -C "$SRC" fetch -q origin "$BRANCH"
git -C "$SRC" checkout -q "$BRANCH" 2>/dev/null || true
git -C "$SRC" merge -q --ff-only "origin/$BRANCH" || die "Checkout $SRC punya perubahan lokal; bereskan dulu (git status)"

# --- 3. timer ------------------------------------------------------------------
say "Pasang timer auto-update (cek GitHub tiap 2 menit)"
mkdir -p /etc/claude-office
cat > /etc/claude-office/autoupdate.env <<EOF
OFFICE_SRC=$SRC
OFFICE_DOMAIN=$DOMAIN
OFFICE_BRANCH=$BRANCH
EOF
cat > /etc/systemd/system/claude-office-update.service <<EOF
[Unit]
Description=Claude Office: deploy new commits from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $SRC/deploy/auto-update.sh
TimeoutStartSec=30min
EOF
cat > /etc/systemd/system/claude-office-update.timer <<EOF
[Unit]
Description=Claude Office: check GitHub for updates every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
RandomizedDelaySec=15s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now claude-office-update.timer >/dev/null 2>&1
echo "OK: claude-office-update.timer aktif"

# --- 4. deploy now ----------------------------------------------------------------
say "Deploy versi terbaru sekarang"
bash "$SRC/deploy/install-vps.sh" "$DOMAIN"

cat <<EOF

Auto-deploy aktif. Setiap commit baru di $REPO ($BRANCH) live dalam ~2 menit.
Token GitHub pribadi (ghp_...) tidak dipakai lagi; boleh dihapus.
   journalctl -u claude-office-update -n 50          # log auto-update
   sudo systemctl disable --now claude-office-update.timer   # matikan
EOF
