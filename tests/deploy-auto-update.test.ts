/**
 * deploy/auto-update.sh - the VPS timer that deploys new commits on main.
 * Run against a throwaway origin and checkout; OFFICE_INSTALL_CMD stands in
 * for install-vps.sh.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, '..', 'deploy', 'auto-update.sh')
const isRoot = process.getuid?.() === 0

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim()
}

/** An origin with one commit, a checkout of it, then a second commit on origin */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'office-autoupdate-'))
  const origin = join(dir, 'origin')
  git(dir, 'init', '-q', origin)
  writeFileSync(join(origin, 'a.txt'), '1\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'one')
  git(dir, 'clone', '-q', origin, 'src')
  const src = join(dir, 'src')
  writeFileSync(join(origin, 'a.txt'), '2\n')
  git(origin, 'commit', '-qam', 'two')
  const env = join(dir, 'autoupdate.env')
  writeFileSync(env, `OFFICE_SRC=${src}\nOFFICE_DOMAIN=office.example.com\nOFFICE_BRANCH=main\n`)
  return { dir, origin, src, env, marker: join(dir, 'installed') }
}

function run(s: ReturnType<typeof setup>, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: s.dir,
      OFFICE_AUTOUPDATE_ENV: s.env,
      OFFICE_AUTOUPDATE_LOCK: join(s.dir, 'lock'),
      OFFICE_INSTALL_CMD: `git rev-parse --short HEAD > '${s.marker}'`,
      ...extraEnv,
    },
  })
}

describe('deploy/auto-update.sh', () => {
  it('fast-forwards to the new commit and runs the install', () => {
    const s = setup()
    const r = run(s)
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(s.src, 'a.txt'), 'utf8')).toBe('2\n')
    expect(readFileSync(s.marker, 'utf8').trim()).toBe(git(s.origin, 'rev-parse', '--short', 'HEAD'))
  })

  it('does nothing when already up to date', () => {
    const s = setup()
    run(s)
    writeFileSync(s.marker, 'untouched')
    expect(run(s).status).toBe(0)
    expect(readFileSync(s.marker, 'utf8')).toBe('untouched')
  })

  // The bug that kept office.irvinhub.com on its first commit: the timer runs
  // as root (no SUDO_UID) over a checkout another user owns
  it.runIf(isRoot)('as root, deploys a checkout owned by another user and gives the files back', () => {
    const s = setup()
    execFileSync('chown', ['-R', '65534:65534', s.src])
    const r = run(s, { SUDO_UID: '' })
    expect(r.stderr).not.toMatch(/dubious ownership/)
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(s.src, 'a.txt'), 'utf8')).toBe('2\n')
    expect(statSync(join(s.src, 'a.txt')).uid).toBe(65534)
    expect(statSync(join(s.src, '.git', 'FETCH_HEAD')).uid).toBe(65534)
  })
})
