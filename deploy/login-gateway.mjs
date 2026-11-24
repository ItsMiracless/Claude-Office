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
import { fileURLToPath } from 'node:url'
import { FONTS_HREF, UI, SESSION_CLAUDES, mascotSvg } from './pixel-tokens.mjs'

const PORT = Number(process.env.OFFICE_LOGIN_PORT || 3340)
const LOGIN_FILE = process.env.OFFICE_LOGIN_FILE || '/etc/claude-office/login.json'
const TOKEN_FILE = process.env.OFFICE_TOKEN_FILE || path.join(process.env.AGENT_OFFICE_HOME || path.join(os.homedir(), '.agent-office'), 'auth-token')
const COOKIE = 'co_session'
const SESSION_DAYS = Number(process.env.OFFICE_SESSION_DAYS || 30)
const SCRYPT = { N: 16384, r: 8, p: 1 }
// The deployed commit (install-vps.sh writes APP_DIR/VERSION), shown as a header on /login
const VERSION = (() => {
  try { return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'VERSION'), 'utf8').trim().slice(0, 40) } catch { return 'dev' }
})()

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
    'X-Claude-Office-Version': VERSION,
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; form-action 'self'; img-src data:",
    ...headers,
  })
  res.end(body)
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------
// The page: a night over the office, the eight session Claudes hopping on a
// ledge and the boss on the sign-in panel (deploy/pixel-tokens.mjs).
const STARS = Array.from({ length: 46 }, (_, i) => {
  // fixed pseudo-random layout so the sky is the same on every load
  const r = (n) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1
  return { x: (r(1) * 100).toFixed(2), y: (r(2) * 62).toFixed(2), s: r(3) > 0.82 ? 3 : 2, d: (r(4) * 4).toFixed(2) }
})

function page({ host = '', next = '/', error = '', user = '' } = {}) {
  const crew = SESSION_CLAUDES.map((name, i) =>
    `<li class="mate" style="--i:${i}">${mascotSvg(name, { size: 56, title: `Claude ${i + 1}` })}</li>`).join('')
  const stars = STARS.map((s) =>
    `<i style="left:${s.x}%;top:${s.y}%;width:${s.s}px;height:${s.s}px;animation-delay:${s.d}s"></i>`).join('')
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Claude Office</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="${FONTS_HREF}" rel="stylesheet">
<style>
  :root {
    --night: ${UI.night}; --night2: ${UI.night2}; --surface: ${UI.surface}; --surface2: ${UI.surface2};
    --line: ${UI.line}; --text: ${UI.text}; --muted: ${UI.muted}; --gold: ${UI.gold}; --gold-dark: ${UI.goldDark};
    --clay: ${UI.clay}; --success: ${UI.success}; --danger: ${UI.danger}; --outline: ${UI.outline};
    --px: 4px;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0; color: var(--text); font-family: ${UI.fontMono};
    background: linear-gradient(180deg, var(--night) 0%, #171a2e 55%, var(--night2) 100%);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100vh; padding: 32px 16px 40px; overflow-x: hidden;
  }
  .sky { position: fixed; inset: 0; pointer-events: none; z-index: 0; }
  .sky i { position: absolute; background: #fff7d6; opacity: .25; animation: twinkle 3.2s steps(2) infinite; }
  .moon { position: fixed; top: 7vh; right: 9vw; width: 40px; height: 40px; background: #fff3c4; z-index: 0;
    box-shadow: 0 0 0 4px rgba(255,243,196,.12), 0 0 0 10px rgba(255,243,196,.05);
    clip-path: polygon(20% 0,80% 0,80% 10%,90% 10%,90% 20%,100% 20%,100% 80%,90% 80%,90% 90%,80% 90%,80% 100%,20% 100%,20% 90%,10% 90%,10% 80%,0 80%,0 20%,10% 20%,10% 10%,20% 10%); }
  @keyframes twinkle { 50% { opacity: .95; } }
  main { position: relative; z-index: 1; width: 100%; max-width: 460px; }
  h1 {
    font-family: ${UI.fontPixel}; font-weight: 400; text-align: center; margin: 0 0 6px;
    font-size: 22px; letter-spacing: 2px; color: var(--gold); line-height: 1.4;
    text-shadow: 3px 3px 0 var(--outline), -1px -1px 0 var(--outline);
  }
  .tag { text-align: center; color: var(--muted); font-size: 12.5px; margin: 0 0 22px; }
  .crew { list-style: none; margin: 0 auto; padding: 0 4px; display: flex; justify-content: center; gap: 4px; }
  .mate { width: 52px; display: flex; justify-content: center; align-items: flex-end; height: 64px; }
  .mate svg { width: 46px; height: auto; display: block; animation: hop 1.6s steps(1) infinite; animation-delay: calc(var(--i) * .2s); }
  @keyframes hop { 0%, 60%, 100% { transform: translateY(0); } 70% { transform: translateY(-8px); } 80% { transform: translateY(-12px); } 90% { transform: translateY(-6px); } }
  .ledge { height: 8px; margin: 0 6px 58px; background: repeating-linear-gradient(90deg, #6b4f3a 0 16px, #5a4a38 16px 32px); box-shadow: 0 4px 0 #3b2c20; }
  .panel-wrap { position: relative; }
  .panel {
    position: relative; background: var(--surface); padding: 30px 26px 22px;
    border: 4px solid var(--gold);
    box-shadow: 0 0 0 4px var(--outline), 10px 10px 0 4px rgba(0,0,0,.45);
  }
  .panel::before { content: ''; position: absolute; inset: 4px; pointer-events: none; box-shadow: inset 0 0 0 2px rgba(255,209,102,.14); }
  .boss { position: absolute; right: 22px; top: -4px; transform: translateY(-100%); z-index: 2; }
  .boss svg { width: 44px; height: auto; display: block; }
  .bubble { position: absolute; z-index: 2; right: 78px; top: -46px; background: #fff; color: #1a1d21; font: 400 8px/1.5 ${UI.fontPixel};
    padding: 6px 8px; border: 2px solid var(--outline); white-space: nowrap; }
  .bubble::after { content: ''; position: absolute; right: -8px; bottom: 6px; border: 4px solid transparent; border-left-color: var(--outline); }
  label { display: block; font-family: ${UI.fontPixel}; font-size: 10px; color: var(--gold); margin: 0 0 9px; letter-spacing: 1px; }
  .field { position: relative; margin-bottom: 20px; }
  input {
    width: 100%; height: 44px; background: var(--night2); color: var(--text); border: 0; outline: none;
    font: 500 15px ${UI.fontMono}; padding: 0 12px;
    box-shadow: inset 0 0 0 2px var(--line), inset 3px 3px 0 2px rgba(0,0,0,.35);
  }
  input:focus { box-shadow: inset 0 0 0 2px var(--gold), inset 3px 3px 0 2px rgba(0,0,0,.35); }
  .pw input { padding-right: 46px; }
  .eye { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); border: 0; background: none; cursor: pointer;
    width: 36px; height: 36px; display: grid; place-items: center; color: var(--muted); }
  .eye:hover, .eye[aria-pressed="true"] { color: var(--gold); }
  .eye svg { width: 20px; height: 14px; }
  button.submit {
    width: 100%; height: 50px; margin-top: 6px; border: 0; cursor: pointer; color: #2a1d05;
    font: 400 12px ${UI.fontPixel}; letter-spacing: 1px; background: var(--gold);
    box-shadow: inset -4px -4px 0 var(--gold-dark), inset 4px 4px 0 #ffe7a3, 0 0 0 3px var(--outline), 0 6px 0 3px var(--outline);
    transition: transform .05s steps(1);
  }
  button.submit:hover { filter: brightness(1.06); }
  button.submit:active { transform: translateY(4px); box-shadow: inset 4px 4px 0 var(--gold-dark), 0 0 0 3px var(--outline), 0 2px 0 3px var(--outline); }
  button.submit:disabled { cursor: wait; filter: saturate(.6); }
  .error { background: #3a1616; color: #ffc9c5; font-size: 13px; padding: 10px 12px; margin: 0 0 18px;
    box-shadow: inset 0 0 0 2px var(--danger); display: flex; gap: 10px; align-items: center; }
  .error b { font-family: ${UI.fontPixel}; font-size: 10px; color: var(--danger); font-weight: 400; }
  .foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 18px; color: var(--muted); font-size: 11.5px; }
  .foot .dot { display: inline-block; width: 8px; height: 8px; background: var(--success); margin-right: 7px; box-shadow: 0 0 0 2px #17432f; }
  @media (max-width: 480px) {
    body { justify-content: flex-start; padding-top: 28px; }
    h1 { font-size: 16px; }
    .crew { flex-wrap: wrap; max-width: 260px; row-gap: 2px; }
    .mate { width: 60px; height: 58px; }
    .mate svg { width: 42px; }
    .ledge { margin-bottom: 52px; }
    .panel { padding: 26px 18px 18px; }
    .bubble { display: none; }
    .moon { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .mate svg, .sky i { animation: none; }
  }
</style>
</head>
<body>
<div class="sky" aria-hidden="true">${stars}</div>
<div class="moon" aria-hidden="true"></div>
<main>
  <h1>CLAUDE OFFICE</h1>
  <p class="tag">Tim Claude Anda sedang bekerja. Silakan masuk.</p>
  <ul class="crew" aria-label="Tim Claude">${crew}</ul>
  <div class="ledge" aria-hidden="true"></div>
  <div class="panel-wrap">
  <div class="boss" aria-hidden="true">${mascotSvg('Me-1', { size: 44 })}</div>
  <div class="bubble" aria-hidden="true">KERJA BAGUS, TIM!</div>
  <section class="panel">
    ${error ? `<div class="error" role="alert"><b>!</b><span>${esc(error)}</span></div>` : ''}
    <form method="post" action="/login" id="form">
      <input type="hidden" name="next" value="${esc(next)}">
      <label for="user">USER ID</label>
      <div class="field"><input id="user" name="user" autocomplete="username" value="${esc(user)}" required autofocus spellcheck="false" autocapitalize="off"></div>
      <label for="password">PASSWORD</label>
      <div class="field pw">
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="eye" type="button" id="eye" aria-label="Tampilkan password" aria-pressed="false">
          <svg viewBox="0 0 10 7" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M3 0h4v1H3zM1 1h2v1H1zM7 1h2v1H7zM0 2h1v3H0zM9 2h1v3H9zM1 5h2v1H1zM7 5h2v1H7zM3 6h4v1H3zM4 2h2v3H4z"/></svg>
        </button>
      </div>
      <button class="submit" type="submit" id="go">&gt;&gt; MASUK KANTOR &lt;&lt;</button>
    </form>
    <div class="foot"><span><span class="dot"></span>${host ? esc(host) : 'online'}</span><span>sesi 30 hari</span></div>
  </section>
  </div>
</main>
<script>
  var pw = document.getElementById('password'), eye = document.getElementById('eye');
  eye.onclick = function () { var show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; eye.setAttribute('aria-pressed', String(show)) };
  document.getElementById('form').onsubmit = function () { var g = document.getElementById('go'); g.disabled = true; g.textContent = 'MEMBUKA PINTU...' };
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
