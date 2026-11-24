#!/usr/bin/env bash
# =============================================================================
# install-vps.sh — put Claude Office on a VPS at https://<domain>
#
#   sudo bash deploy/install-vps.sh office.irvinhub.com
#
# Run it from this checkout on the VPS (Ubuntu/Debian). It:
#   1. installs Node 22, git, python3 and build tools when missing
#   2. copies the app to /opt/claude-office and builds the office page
#   3. runs the office as a systemd service (claude-office) on 127.0.0.1:3334
#   4. puts it behind HTTPS on <domain> with a login (nginx + certbot when nginx
#      is already serving your sites, else Caddy)
#   5. connects Claude Code on this VPS to it (hooks), and prints the link to
#      open once in your browser and the token for your laptop / cloud sessions
#
# Safe to re-run (updates the app, keeps the token and the login).
#
# Who runs the office: the user who ran sudo (OFFICE_RUN_AS overrides). Use the
# same user that runs Claude Code on this VPS, so both share ~/.agent-office.
# =============================================================================
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="${OFFICE_APP_DIR:-/opt/claude-office}"
PORT="${AGENT_OFFICE_PORT:-3334}"
RUN_AS="${OFFICE_RUN_AS:-${SUDO_USER:-root}}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Jalankan dengan sudo:  sudo bash deploy/install-vps.sh office.irvinhub.com"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || die "Berikan nama domain, contoh: sudo bash deploy/install-vps.sh office.irvinhub.com"
id "$RUN_AS" >/dev/null 2>&1 || die "User $RUN_AS tidak ada"
RUN_HOME="$(getent passwd "$RUN_AS" | cut -d: -f6)"
command -v apt-get >/dev/null || die "Skrip ini untuk Ubuntu/Debian (apt-get tidak ditemukan)"

# --- 0. DNS check (warn only) -------------------------------------------------
say "Cek DNS $DOMAIN"
MY_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}')"
if [ -z "$DNS_IP" ]; then
  warn "$DOMAIN belum mengarah ke server mana pun. Tambahkan A record: office -> ${MY_IP:-IP VPS ini}"
  warn "Sertifikat HTTPS baru bisa dibuat setelah DNS aktif (skrip tetap lanjut)."
elif [ -n "$MY_IP" ] && [ "$DNS_IP" != "$MY_IP" ]; then
  warn "$DOMAIN mengarah ke $DNS_IP, tetapi IP VPS ini $MY_IP. Pastikan A record benar (Cloudflare proxy boleh)."
else
  echo "OK: $DOMAIN -> $DNS_IP"
fi

# --- 1. packages ---------------------------------------------------------------
say "Pasang paket dasar"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates git python3 build-essential rsync >/dev/null
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  say "Pasang Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -q nodejs >/dev/null
fi
echo "Node $(node -v)"

# --- 2. app --------------------------------------------------------------------
say "Salin aplikasi ke $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude node_modules --exclude dist --exclude .git "$SRC_DIR"/ "$APP_DIR"/
chown -R "$RUN_AS":"$(id -gn "$RUN_AS")" "$APP_DIR"

say "Install dependency & build halaman kantor (beberapa menit)"
sudo -u "$RUN_AS" -H bash -c "cd '$APP_DIR' && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error && npx vite build --logLevel error"

# --- 3. service ----------------------------------------------------------------
say "Pasang service systemd: claude-office"
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/claude-office.service <<EOF
[Unit]
Description=Claude Office (pixel office for Claude Code sessions)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=AGENT_OFFICE_PORT=$PORT
Environment=AGENT_OFFICE_ALLOWED_HOSTS=$DOMAIN
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable claude-office >/dev/null 2>&1
systemctl restart claude-office

TOKEN_FILE="$RUN_HOME/.agent-office/auth-token"
for _ in $(seq 1 30); do [ -s "$TOKEN_FILE" ] && break; sleep 1; done
[ -s "$TOKEN_FILE" ] || die "Server tidak membuat token. Lihat log: journalctl -u claude-office -n 50"
TOKEN="$(cat "$TOKEN_FILE")"
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null || die "Server tidak menjawab. Lihat: journalctl -u claude-office -n 50"
echo "OK: kantor jalan di 127.0.0.1:$PORT"

# --- 4. login + HTTPS ------------------------------------------------------------
# The login covers the page itself (/, /assets, /sprites, /rooms). The data
# routes and the WebSocket are not behind it: the office demands its own token
# on every one of them when reached through a proxy (docs/reference.md), and
# the hooks sign their posts with that token.
LOGIN_USER="${OFFICE_LOGIN_USER:-}"
LOGIN_PASS="${OFFICE_LOGIN_PASS:-}"
need_login() {
  if [ -z "$LOGIN_USER" ]; then read -r -p "Username login kantor [irvin]: " LOGIN_USER; LOGIN_USER="${LOGIN_USER:-irvin}"; fi
  if [ -z "$LOGIN_PASS" ]; then
    read -r -s -p "Password login kantor (min. 10 karakter): " LOGIN_PASS; echo
    [ "${#LOGIN_PASS}" -ge 10 ] || die "Password terlalu pendek"
  fi
}

UI_PATHS_NGINX='location = / { auth_basic "Claude Office"; auth_basic_user_file /etc/nginx/claude-office.htpasswd; include /etc/nginx/snippets/claude-office-proxy.conf; }
    location = /index.html { auth_basic "Claude Office"; auth_basic_user_file /etc/nginx/claude-office.htpasswd; include /etc/nginx/snippets/claude-office-proxy.conf; }
    location ^~ /assets/  { auth_basic "Claude Office"; auth_basic_user_file /etc/nginx/claude-office.htpasswd; include /etc/nginx/snippets/claude-office-proxy.conf; }
    location ^~ /sprites/ { auth_basic "Claude Office"; auth_basic_user_file /etc/nginx/claude-office.htpasswd; include /etc/nginx/snippets/claude-office-proxy.conf; }
    location ^~ /rooms/   { auth_basic "Claude Office"; auth_basic_user_file /etc/nginx/claude-office.htpasswd; include /etc/nginx/snippets/claude-office-proxy.conf; }'

if command -v nginx >/dev/null 2>&1; then
  say "nginx terdeteksi: pasang situs $DOMAIN + HTTPS (certbot)"
  apt-get install -y -q apache2-utils certbot python3-certbot-nginx >/dev/null
  if [ ! -s /etc/nginx/claude-office.htpasswd ] || [ -n "${OFFICE_LOGIN_PASS:-}" ]; then
    need_login
    printf '%s' "$LOGIN_PASS" | htpasswd -i -c -B /etc/nginx/claude-office.htpasswd "$LOGIN_USER" 2>/dev/null
  fi
  chmod 640 /etc/nginx/claude-office.htpasswd; chgrp www-data /etc/nginx/claude-office.htpasswd 2>/dev/null || true
  mkdir -p /etc/nginx/snippets
  cat > /etc/nginx/snippets/claude-office-proxy.conf <<EOF
proxy_pass http://127.0.0.1:$PORT;
proxy_http_version 1.1;
proxy_set_header Host \$host;
proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto \$scheme;
proxy_set_header X-Forwarded-Host \$host;
proxy_set_header Upgrade \$http_upgrade;
proxy_set_header Connection \$claude_office_connection;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
EOF
  SITE=/etc/nginx/sites-available/claude-office
  [ -d /etc/nginx/sites-available ] || SITE=/etc/nginx/conf.d/claude-office.conf
  cat > "$SITE" <<EOF
map \$http_upgrade \$claude_office_connection { default upgrade; '' close; }

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 5m;

    $UI_PATHS_NGINX

    # data routes + WebSocket: protected by the office token, not the login
    location / { include /etc/nginx/snippets/claude-office-proxy.conf; }
}
EOF
  [ -d /etc/nginx/sites-enabled ] && [ "$SITE" = /etc/nginx/sites-available/claude-office ] && ln -sf "$SITE" /etc/nginx/sites-enabled/claude-office
  nginx -t && systemctl reload nginx
  if [ -n "$DNS_IP" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
      || warn "certbot gagal. Setelah DNS benar, jalankan: sudo certbot --nginx -d $DOMAIN"
  else
    warn "Lewati HTTPS (DNS belum ada). Setelah DNS aktif: sudo certbot --nginx -d $DOMAIN"
  fi
else
  if ! command -v caddy >/dev/null 2>&1; then
    if ss -ltn '( sport = :80 or sport = :443 )' | grep -q LISTEN; then
      die "Port 80/443 sudah dipakai program lain (bukan nginx/caddy). Arahkan proxy Anda ke 127.0.0.1:$PORT dengan header Host asli dan X-Forwarded-*; lihat deploy/README.md."
    fi
    say "Pasang Caddy (HTTPS otomatis)"
    apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q && apt-get install -y -q caddy >/dev/null
  fi
  say "Caddy: situs $DOMAIN + HTTPS"
  CADDY_SITE=/etc/caddy/claude-office.caddy
  if [ ! -s "$CADDY_SITE" ] || [ -n "${OFFICE_LOGIN_PASS:-}" ]; then
    need_login
    HASH="$(caddy hash-password --plaintext "$LOGIN_PASS")"
    cat > "$CADDY_SITE" <<EOF
$DOMAIN {
	encode gzip
	@ui path / /index.html /assets/* /sprites/* /rooms/*
	basicauth @ui {
		$LOGIN_USER $HASH
	}
	# data routes + WebSocket: protected by the office token, not the login
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
  fi
  grep -q 'import /etc/caddy/claude-office.caddy' /etc/caddy/Caddyfile 2>/dev/null \
    || printf '\nimport /etc/caddy/claude-office.caddy\n' >> /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl reload caddy || systemctl restart caddy
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

# --- 5. Claude Code on this VPS --------------------------------------------------
say "Sambungkan Claude Code di VPS ini (hooks untuk user $RUN_AS)"
sudo -u "$RUN_AS" -H bash -c "cd '$APP_DIR' && bash hooks/install-hooks.sh </dev/null" >/dev/null 2>&1 \
  && echo "OK: hooks terpasang di $RUN_HOME/.claude/settings.json" \
  || warn "Gagal memasang hooks; jalankan manual: cd $APP_DIR && bash hooks/install-hooks.sh"

cat <<EOF

$(printf '\033[1;32m')Selesai!$(printf '\033[0m')

1) Buka SEKALI link ini di browser (laptop & HP), lalu login:
     https://$DOMAIN/#token=$TOKEN
   Setelah itu cukup buka https://$DOMAIN (token tersimpan di browser).

2) Token kantor (RAHASIA — dipakai laptop dan sesi cloud):
     $TOKEN

3) Laptop: dari folder project ini jalankan
     bash deploy/connect-laptop.sh https://$DOMAIN

Perintah berguna:
   systemctl status claude-office        # status
   journalctl -u claude-office -f        # log
   sudo bash deploy/install-vps.sh $DOMAIN   # update setelah ada perubahan
EOF
