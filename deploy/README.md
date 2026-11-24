# Claude Office online — office.irvinhub.com

Kantor pixel untuk semua sesi Claude Anda (laptop, VPS, dan cloud) di satu alamat
yang bisa dibuka kapan saja dari browser atau HP.

```
Laptop (Claude Code) ──hook + token──┐
Claude Code di VPS ──hook (lokal)────┼──▶ office.irvinhub.com ──▶ browser / HP Anda
Sesi cloud claude.ai/code ──token────┘        (login + token)
```

## Keamanan singkat

- Halaman kantor dikunci dengan **login** (username + password).
- Semua data (sesi, prompt, balasan) dan koneksi live juga butuh **token kantor**.
  Tanpa token, server menjawab `401`, walaupun lolos login.
- Hook mengirim token lewat header dari file berizin `600`, jadi token tidak pernah
  muncul di command line.
- Token = kunci rumah. Jangan dibagikan atau di-commit ke git.

## 1. DNS

Di pengelola DNS irvinhub.com, tambahkan record:

| Tipe | Nama | Nilai |
|---|---|---|
| A | `office` | IP VPS Anda |

## 2. Pasang di VPS

Login SSH ke VPS sebagai user yang biasa menjalankan Claude Code, lalu:

```bash
git clone <URL repo ini> claude-office && cd claude-office
```
```bash
sudo bash deploy/install-vps.sh office.irvinhub.com
```

Skrip ini akan:
- memasang Node 22,
- membangun kantor ke `/opt/claude-office`,
- menjalankannya sebagai service `claude-office`,
- memasang HTTPS + login. Kalau nginx sudah dipakai untuk irvinhub.com, skrip memakai
  nginx + certbot. Kalau belum ada, skrip memasang Caddy.
- memasang hook untuk Claude Code di VPS itu.

Di akhir, skrip mencetak:
1. **Link sekali buka**: `https://office.irvinhub.com/#token=...`. Buka sekali di
   laptop dan sekali di HP. Setelah itu cukup buka `https://office.irvinhub.com`.
2. **Token kantor**, untuk langkah 3 dan 4.

Update di kemudian hari: `git pull`, lalu jalankan lagi perintah `install-vps.sh` yang
sama. Token dan login tidak berubah.

## 3. Sambungkan laptop

Di laptop (macOS/Linux, atau Windows lewat WSL/Git Bash), dari folder project ini:

```bash
bash deploy/connect-laptop.sh https://office.irvinhub.com
```

Masukkan token saat diminta. Setelah itu, setiap sesi Claude Code baru di laptop
muncul di kantor online.

Untuk kembali ke kantor lokal: `rm ~/.agent-office/server-url`.

## 4. Sesi cloud (claude.ai/code)

Sesi cloud berjalan di container Anthropic, jadi butuh dua hal di environment cloud Anda:
1. **Network secret** untuk host `office.irvinhub.com` berisi token kantor (Bearer).
   Proxy cloud menyisipkannya otomatis, jadi token tidak ditulis di mana pun.
2. **Setup script** yang memasang hook dan menulis alamat kantor:
   ```bash
   git clone --depth 1 <URL repo ini> /opt/claude-office
   mkdir -p ~/.agent-office && echo https://office.irvinhub.com > ~/.agent-office/server-url
   bash /opt/claude-office/hooks/install-hooks.sh </dev/null
   ```

Minta Claude di sesi cloud untuk menyiapkan keduanya. Network secret diisi lewat
formulir aman, tidak lewat chat.

## Perintah berguna di VPS

```bash
systemctl status claude-office
```
```bash
journalctl -u claude-office -f
```
```bash
sudo systemctl restart claude-office
```

## Ganti password login

```bash
sudo OFFICE_LOGIN_USER=irvin OFFICE_LOGIN_PASS='password-baru-panjang' bash deploy/install-vps.sh office.irvinhub.com
```
