#!/usr/bin/env node
// =============================================================================
// login-gateway.mjs — the login page in front of an online Claude Office
//
// A small server on 127.0.0.1:3340 (OFFICE_LOGIN_PORT) that nginx / Caddy ask
// before serving the office page:
//
//   GET  /login         the sign-in page (IrvinHub style)
//   POST /login         check user + password, set a signed session cookie,
//                       then send the browser to the office with its token
//                       (/#token=…), so nobody needs the token link by hand
//   GET  /logout        clear the cookie
//   GET  /auth/check    204 with a valid session cookie, else 401
//                       (?mode=redirect: a 302 to /login instead, for Caddy)
//
// The office's data routes and WebSocket are not behind this: they demand the
// office token themselves. This only keeps the page away from strangers.
//
// Password setup (reads OFFICE_LOGIN_USER / OFFICE_LOGIN_PASS from the
// environment, never argv):
//   OFFICE_LOGIN_USER=irvin OFFICE_LOGIN_PASS=… node deploy/login-gateway.mjs --set-password
//
// No dependencies: node:http and node:crypto only.
// =============================================================================
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto'

const PORT = Number(process.env.OFFICE_LOGIN_PORT || 3340)
const LOGIN_FILE = process.env.OFFICE_LOGIN_FILE || '/etc/claude-office/login.json'
const TOKEN_FILE = process.env.OFFICE_TOKEN_FILE || path.join(process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), '.agent-office'), 'auth-token')
const COOKIE = 'co_session'
const SESSION_DAYS = Number(process.env.OFFICE_SESSION_DAYS || 30)
const SCRYPT = { N: 16384, r: 8, p: 1 }

// ---------------------------------------------------------------------------
// password file
// ---------------------------------------------------------------------------
function hashPassword(pass, salt) {
  return scryptSync(pass, salt, 64, SCRYPT)
}

function setPassword() {
  const user = (process.env.OFFICE_LOGIN_USER || '').trim()
  const pass = process.env.OFFICE_LOGIN_PASS || ''
  if (!user || pass.length < 10) {
    console.error('OFFICE_LOGIN_USER and OFFICE_LOGIN_PASS (min. 10 characters) are required')
    process.exit(1)
  }
  let secret
  try { secret = JSON.parse(fs.readFileSync(LOGIN_FILE, 'utf8')).secret } catch { /* new file */ }
  const salt = randomBytes(16)
  const data = {
    user,
    salt: salt.toString('hex'),
    hash: hashPassword(pass, salt).toString('hex'),
    // Keep the cookie secret across password changes only if asked; a new
    // password signs everyone out by default.
    secret: process.env.OFFICE_KEEP_SESSIONS === '1' && secret ? secret : randomBytes(32).toString('hex'),
  }
  fs.mkdirSync(path.dirname(LOGIN_FILE), { recursive: true })
  fs.writeFileSync(LOGIN_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o640 })
  console.log(`Login saved for "${user}" in ${LOGIN_FILE}`)
}

function loadLogin() {
  try {
    const d = JSON.parse(fs.readFileSync(LOGIN_FILE, 'utf8'))
    if (d.user && d.salt && d.hash && d.secret) return d
  } catch { /* fall through */ }
  return null
}

// ---------------------------------------------------------------------------
// session cookie: base64url(JSON{u, exp}).hmac
// ---------------------------------------------------------------------------
const b64 = (s) => Buffer.from(s).toString('base64url')
const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url')

function makeSession(login) {
  const payload = b64(JSON.stringify({ u: login.user, exp: Date.now() + SESSION_DAYS * 864e5 }))
  return `${payload}.${sign(login.secret, payload)}`
}

function validSession(login, value) {
  if (!login || typeof value !== 'string') return false
  const [payload, mac] = value.split('.')
  if (!payload || !mac) return false
  const want = Buffer.from(sign(login.secret, payload))
  const got = Buffer.from(mac)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return u === login.user && typeof exp === 'number' && exp > Date.now()
  } catch {
    return false
  }
}

function cookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

// ---------------------------------------------------------------------------
// brute-force brake: 5 wrong tries per IP -> 10 minutes locked
// ---------------------------------------------------------------------------
const failures = new Map() // ip -> { n, until }
const clientIp = (req) => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
function locked(ip) {
  const f = failures.get(ip)
  return f && f.until > Date.now()
}
function noteFailure(ip) {
  const f = failures.get(ip) || { n: 0, until: 0 }
  f.n += 1
  if (f.n >= 5) { f.until = Date.now() + 10 * 60e3; f.n = 0 }
  failures.set(ip, f)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function safeNext(raw) {
  const s = typeof raw === 'string' ? raw : '/'
  // same-site paths only: no scheme, no //host, no backslashes
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || s.startsWith('/login') || s.startsWith('/logout')) return '/'
  return s
}

function officeToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch { return '' }
}

function landing(next) {
  // The office page reads its token from #token= and keeps it; hand it over
  // on the way in so the token link is never needed.
  const isPage = next === '/' || next.startsWith('/?') || next === '/index.html'
  const token = isPage ? officeToken() : ''
  return token && /^[0-9a-f]+$/.test(token) ? `${next}#token=${token}` : next
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https'
}

function setCookie(req, value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; form-action 'self'; img-src data:",
    ...headers,
  })
  res.end(body)
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------
function page({ host = '', next = '/', error = '', user = '' } = {}) {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Office — IrvinHub</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f5f6f6; --dot: #d9dbe0; --card: #ffffff; --border: #e4e6ea; --text: #111216;
    --muted: #6b6f7b; --accent: #5e6ad2; --accent-hover: #4f5bc4; --accent-soft: rgba(94,106,210,.12);
    --input: #ffffff; --error-bg: #fdecec; --error: #b42318; --clay: #d97757;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0e0f12; --dot: #23252c; --card: #16171b; --border: #2a2c33; --text: #eceef2;
      --muted: #9a9eab; --accent: #7480e6; --accent-hover: #8790ee; --accent-soft: rgba(116,128,230,.16);
      --input: #1c1d22; --error-bg: #3a1616; --error: #f3a59d;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0e0f12; --dot: #23252c; --card: #16171b; --border: #2a2c33; --text: #eceef2;
    --muted: #9a9eab; --accent: #7480e6; --accent-hover: #8790ee; --accent-soft: rgba(116,128,230,.16);
    --input: #1c1d22; --error-bg: #3a1616; --error: #f3a59d;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; font-family: Inter, "Segoe UI", system-ui, sans-serif; color: var(--text);
    background: var(--bg) radial-gradient(var(--dot) 1px, transparent 1px) 0 0 / 22px 22px;
    display: grid; place-items: center; padding: 24px 16px;
  }
  .theme {
    position: fixed; top: 16px; right: 16px; border: 1px solid var(--accent-soft); background: var(--accent-soft);
    color: var(--accent); font: 600 12px Inter, sans-serif; padding: 7px 12px; border-radius: 999px; cursor: pointer;
  }
  .card {
    width: 100%; max-width: 448px; background: var(--card); border: 1px solid var(--border);
    border-radius: 16px; padding: 32px; box-shadow: 0 1px 2px rgba(16,18,22,.04), 0 8px 24px rgba(16,18,22,.04);
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .logo {
    width: 32px; height: 32px; border-radius: 8px; background: var(--accent); color: #fff;
    display: grid; place-items: center; font-weight: 700; font-size: 13px; letter-spacing: .02em;
  }
  .brand b { display: block; font-size: 15px; font-weight: 600; }
  .brand span { display: block; font-size: 12.5px; color: var(--muted); margin-top: 1px; }
  h1 { font-size: 24px; font-weight: 700; margin: 34px 0 8px; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: 14.5px; margin: 0 0 26px; }
  .office { display: flex; align-items: center; gap: 8px; }
  .clawd { width: 22px; height: 18px; flex: none; image-rendering: pixelated; }
  label { display: block; font-size: 14px; font-weight: 500; margin: 0 0 8px; }
  .field { position: relative; margin-bottom: 18px; }
  input {
    width: 100%; height: 40px; border: 1px solid var(--border); border-radius: 10px; background: var(--input);
    color: var(--text); font: 400 15px Inter, sans-serif; padding: 0 12px; outline: none;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .pw input { padding-right: 42px; }
  .eye {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%); border: 0; background: none;
    color: var(--muted); width: 32px; height: 32px; border-radius: 8px; cursor: pointer; display: grid; place-items: center;
  }
  .eye:hover { color: var(--text); }
  button.submit {
    width: 100%; height: 36px; border: 0; border-radius: 999px; background: var(--accent); color: #fff;
    font: 600 14px Inter, sans-serif; cursor: pointer; margin-top: 2px;
  }
  button.submit:hover { background: var(--accent-hover); }
  button.submit:disabled { opacity: .7; cursor: wait; }
  .error { background: var(--error-bg); color: var(--error); font-size: 13.5px; border-radius: 10px; padding: 10px 12px; margin: -8px 0 18px; }
  .foot { text-align: center; font-size: 12.5px; color: var(--muted); margin-top: 22px; }
  @media (max-width: 420px) { .card { padding: 24px 20px; } h1 { margin-top: 26px; } }
</style>
<script>
  try { var t = localStorage.getItem('co-theme'); if (t) document.documentElement.dataset.theme = t } catch (e) {}
</script>
</head>
<body>
<button class="theme" type="button" id="theme">Dark</button>
<main class="card">
  <div class="brand">
    <div class="logo">IH</div>
    <div><b>IrvinHub</b><span>Claude Office</span></div>
  </div>
  <h1>Welcome back</h1>
  <p class="sub office">
    <svg class="clawd" viewBox="0 0 11 9" aria-hidden="true"><path fill="var(--clay)" d="M1 0h9v6H1zM0 3h1v2H0zM10 3h1v2h-1zM2 6h1v3H2zM4 6h1v3H4zM6 6h1v3H6zM8 6h1v3H8z"/><path fill="#1f1410" d="M3 2h1v2H3zM7 2h1v2H7z"/></svg>
    Login untuk melihat tim Claude Anda bekerja.
  </p>
  ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
  <form method="post" action="/login" id="form">
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="user">User ID</label>
    <div class="field"><input id="user" name="user" autocomplete="username" value="${esc(user)}" required autofocus></div>
    <label for="password">Password</label>
    <div class="field pw">
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button class="eye" type="button" id="eye" aria-label="Tampilkan password">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
    </div>
    <button class="submit" type="submit" id="go">Sign in</button>
  </form>
  ${host ? `<p class="foot">${esc(host)}</p>` : ''}
</main>
<script>
  var root = document.documentElement, btn = document.getElementById('theme');
  function dark() { return root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches }
  function label() { btn.textContent = dark() ? 'Light' : 'Dark' }
  label();
  btn.onclick = function () { root.dataset.theme = dark() ? 'light' : 'dark'; try { localStorage.setItem('co-theme', root.dataset.theme) } catch (e) {} label() };
  var pw = document.getElementById('password');
  document.getElementById('eye').onclick = function () { pw.type = pw.type === 'password' ? 'text' : 'password' };
  document.getElementById('form').onsubmit = function () { var g = document.getElementById('go'); g.disabled = true; g.textContent = 'Signing in…' };
  if (document.getElementById('user').value) pw.focus();
</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const login = loadLogin()
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()

  if (url.pathname === '/auth/check') {
    if (validSession(login, cookies(req)[COOKIE])) { res.writeHead(204); return res.end() }
    if (url.searchParams.get('mode') === 'redirect') {
      const next = safeNext(req.headers['x-forwarded-uri'] || '/')
      res.writeHead(302, { Location: `/login?next=${encodeURIComponent(next)}`, 'Cache-Control': 'no-store' })
      return res.end()
    }
    res.writeHead(401); return res.end()
  }

  if (url.pathname === '/logout') {
    res.writeHead(302, { Location: '/login', 'Set-Cookie': setCookie(req, '', 0), 'Cache-Control': 'no-store' })
    return res.end()
  }

  if (url.pathname !== '/login') { res.writeHead(404); return res.end() }

  if (!login) return send(res, 503, page({ host, error: 'Login belum disiapkan di server. Jalankan ulang deploy/install-vps.sh.' }))

  if (req.method === 'GET' || req.method === 'HEAD') {
    const next = safeNext(url.searchParams.get('next'))
    if (validSession(login, cookies(req)[COOKIE])) {
      res.writeHead(302, { Location: landing(next), 'Cache-Control': 'no-store' })
      return res.end()
    }
    return send(res, 200, page({ host, next }))
  }

  if (req.method !== 'POST') { res.writeHead(405); return res.end() }
  if (!sameOrigin(req)) return send(res, 403, page({ host, error: 'Permintaan ditolak.' }))

  const ip = clientIp(req)
  let form
  try { form = new URLSearchParams(await readBody(req)) } catch { res.writeHead(413); return res.end() }
  const user = (form.get('user') || '').trim()
  const pass = form.get('password') || ''
  const next = safeNext(form.get('next'))

  if (locked(ip)) return send(res, 429, page({ host, next, user, error: 'Terlalu banyak percobaan. Coba lagi dalam 10 menit.' }))

  const userOk = Buffer.from(user).length === Buffer.from(login.user).length && timingSafeEqual(Buffer.from(user), Buffer.from(login.user))
  const hash = hashPassword(pass, Buffer.from(login.salt, 'hex')) // always hash: same time for a wrong user
  const passOk = timingSafeEqual(hash, Buffer.from(login.hash, 'hex'))
  if (!userOk || !passOk) {
    noteFailure(ip)
    console.warn(`[login] failed sign-in from ${ip}`)
    return send(res, 401, page({ host, next, user, error: 'User ID atau password salah.' }))
  }

  failures.delete(ip)
  console.log(`[login] ${login.user} signed in from ${ip}`)
  res.writeHead(303, {
    Location: landing(next),
    'Set-Cookie': setCookie(req, makeSession(login), SESSION_DAYS * 86400),
    'Cache-Control': 'no-store',
  })
  res.end()
}

if (process.argv.includes('--set-password')) {
  setPassword()
} else {
  http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[login] error', e)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  }).listen(PORT, '127.0.0.1', () => console.log(`[login] gateway on 127.0.0.1:${PORT} (${LOGIN_FILE})`))
}
