/**
 * deploy/install-vps.sh (nginx) + deploy/login-gateway.mjs - what lets the
 * signed-in office page queue `@<session> <prompt>` online.
 *
 * The nginx snippets are rendered from the script's own heredocs (the script
 * itself needs root and apt): POST /chat asks the login page's soft check,
 * passes X-Office-Login on only from it, and no location lets a client's copy
 * through. With nginx installed the rendered config is also checked by
 * `nginx -t`. The soft check runs against the real login gateway.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DEPLOY = join(__dirname, '..', 'deploy')
const SCRIPT = readFileSync(join(DEPLOY, 'install-vps.sh'), 'utf8')

/** The heredoc `cat > <target> <<EOF2 ... EOF2`, expanded by bash with the given variables. */
function render(target: string, vars: Record<string, string>): string {
  const start = SCRIPT.indexOf(`cat > ${target} <<EOF2\n`)
  expect(start, target).toBeGreaterThan(-1)
  const body = SCRIPT.slice(start).split('\n').slice(1)
  const doc = body.slice(0, body.indexOf('EOF2')).join('\n')
  const r = spawnSync('bash', ['-c', `cat <<EOF2\n${doc}\nEOF2`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...vars } })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout
}

const VARS = { PORT: '3334', LOGIN_PORT: '3340' }
const proxy = render('/etc/nginx/snippets/claude-office-proxy.conf', VARS)
const locations = render('/etc/nginx/snippets/claude-office-locations.conf', VARS)
const chatLine = locations.split('\n').find(l => l.startsWith('location = /chat ')) ?? ''

describe('install-vps.sh: nginx for POST /chat', () => {
  it('location = /chat asks the soft login check and passes on only its X-Office-Login', () => {
    expect(chatLine).toContain('auth_request /_claude_office_login_state;')
    expect(chatLine).toContain('auth_request_set $claude_office_login $upstream_http_x_office_login;')
    expect(chatLine).toContain('include /etc/nginx/snippets/claude-office-proxy.conf;')
    // Why no login redirect here: hooks and scripts with the office token reach /chat without a cookie
    expect(chatLine).not.toContain('error_page 401')
    expect(locations).toMatch(/location = \/_claude_office_login_state \{\s+internal;\s+proxy_pass http:\/\/127\.0\.0\.1:3340\/auth\/check\?mode=soft;/)
  })

  it('every proxied location overrides the client\'s X-Office-Login; it is empty unless /chat set it', () => {
    expect(proxy).toContain('proxy_set_header X-Office-Login $claude_office_login;')
    expect(locations).toContain('set $claude_office_login "";')
    // No location reaches the office except through the snippet
    expect(locations).not.toContain('127.0.0.1:3334')
    expect(locations.match(/\$claude_office_login \$upstream_http_x_office_login/g)).toHaveLength(1)
  })

  it('the office trusts the header only where nginx is the proxy (AGENT_OFFICE_LOGIN_HEADER)', () => {
    expect(SCRIPT).toContain('LOGIN_HEADER=0; command -v nginx >/dev/null 2>&1 && LOGIN_HEADER=1')
    expect(SCRIPT).toContain('Environment=AGENT_OFFICE_LOGIN_HEADER=$LOGIN_HEADER')
    // Caddy forwards client headers: it drops this one
    expect(SCRIPT).toContain('header_up -X-Office-Login')
  })

  const nginx = spawnSync('nginx', ['-v']).status === 0
  it.skipIf(!nginx)('the rendered site passes nginx -t', () => {
    const dir = mkdtempSync(join(tmpdir(), 'office-nginx-'))
    writeFileSync(join(dir, 'proxy.conf'), proxy)
    writeFileSync(join(dir, 'locations.conf'), locations.replaceAll('/etc/nginx/snippets/claude-office-proxy.conf', join(dir, 'proxy.conf')))
    writeFileSync(join(dir, 'nginx.conf'), `pid ${dir}/nginx.pid; error_log ${dir}/error.log; events {}
http {
  access_log off;
  map $http_upgrade $claude_office_connection { default upgrade; '' close; }
  server { listen 127.0.0.1:18080; server_name office.example.com; include ${dir}/locations.conf; }
}
`)
    const r = spawnSync('nginx', ['-t', '-p', dir, '-c', join(dir, 'nginx.conf')], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  })
})

describe('login-gateway.mjs: GET /auth/check?mode=soft', () => {
  const secret = randomBytes(32).toString('hex')
  let gateway: ChildProcess
  let base: string

  const cookie = (claims: object) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `co_session=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
  }
  const check = (mode: string, cookieHeader?: string) =>
    fetch(`${base}/auth/check?mode=${mode}`, { headers: cookieHeader ? { Cookie: cookieHeader } : {} })

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'office-login-'))
    const file = join(dir, 'login.json')
    writeFileSync(file, JSON.stringify({ user: 'boss', salt: '00', hash: '00', secret }))
    const port = await new Promise<number>(resolve => {
      const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) })
    })
    base = `http://127.0.0.1:${port}`
    gateway = spawn(process.execPath, [join(DEPLOY, 'login-gateway.mjs')], {
      env: { PATH: process.env.PATH ?? '', OFFICE_LOGIN_PORT: String(port), OFFICE_LOGIN_FILE: file, OFFICE_TOKEN_FILE: join(dir, 'none') },
      stdio: 'ignore',
    })
    for (let i = 0; i < 50; i++) {
      try { await fetch(`${base}/login`); return } catch { await new Promise(r => setTimeout(r, 100)) }
    }
    throw new Error('login gateway did not start')
  })
  afterAll(() => { gateway?.kill() })

  it('a valid session: 204 with X-Office-Login: ok', async () => {
    const res = await check('soft', cookie({ u: 'boss', iat: Date.now() }))
    expect(res.status).toBe(204)
    expect(res.headers.get('x-office-login')).toBe('ok')
  })

  it('no cookie or a forged one: still 204 (token holders keep reaching /chat), without the header', async () => {
    for (const c of [undefined, 'co_session=e30.bad', cookie({ u: 'someone-else', iat: Date.now() })]) {
      const res = await check('soft', c)
      expect(res.status, String(c)).toBe(204)
      expect(res.headers.get('x-office-login'), String(c)).toBeNull()
    }
  })

  it('the page check is unchanged: 401 without a session, and never the header', async () => {
    expect((await check('none')).status).toBe(401)
    expect((await check('none', cookie({ u: 'boss', iat: Date.now() }))).headers.get('x-office-login')).toBeNull()
  })
})
