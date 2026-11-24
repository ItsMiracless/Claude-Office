// =============================================================================
// pixel-tokens.mjs — the office's look, written down once for pages outside the
// React app (the login page, deploy/login-gateway.mjs).
//
// Mascots: the same eight session Claudes and the boss as the office sprites,
// mirrored from scripts/clawd-sprites.py (VARIANTS and draw()): a 36 x 72
// logical grid, blocky body with a darker side face, four legs, two claws,
// tall eyes, accessories, and a one-pixel dark outline. Keep the two in step.
//
// UI: fonts and colours of the office UI (src/styles/office.css).
// =============================================================================

export const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Press+Start+2P&display=swap'

export const UI = {
  fontPixel: "'Press Start 2P', monospace",
  fontMono: "'JetBrains Mono', ui-monospace, monospace",
  night: '#0f1220',
  night2: '#1a1d21',
  surface: '#2a2520',
  surface2: '#35363a',
  line: '#4e5157',
  text: '#e8e6e3',
  muted: '#8b8d91',
  gold: '#ffd166',
  goldDark: '#c9952a',
  clay: '#cc785c',
  success: '#2bac76',
  danger: '#ff5f57',
  outline: '#3a1e14',
}

// --- mascots (scripts/clawd-sprites.py) -----------------------------------------
const C = {
  ORANGE: [217, 119, 87], GREEN: [96, 180, 104], BLUE: [84, 140, 220], PURPLE: [150, 104, 210],
  PINK: [232, 120, 170], YELLOW: [236, 190, 70], TEAL: [64, 178, 172], RED: [214, 78, 72],
}

export const MASCOTS = {
  'Claude-1': { body: C.ORANGE, neck: 'lanyard' },
  'Claude-2': { body: C.GREEN, ears: 'headphones' },
  'Claude-3': { body: C.BLUE, hat: 'cap', hatColor: [240, 240, 240] },
  'Claude-4': { body: C.PURPLE, face: 'glasses' },
  'Claude-5': { body: C.PINK, hat: 'beanie', hatColor: [90, 70, 160] },
  'Claude-6': { body: C.YELLOW, neck: 'bowtie', neckColor: [200, 50, 60] },
  'Claude-7': { body: C.TEAL, hat: 'hardhat' },
  'Claude-8': { body: C.RED, face: 'shades', neck: 'scarf', neckColor: [240, 220, 90] },
  'Me-1': { body: C.ORANGE, hat: 'crown', neck: 'tie', neckColor: [40, 50, 90], big: true },
}

export const SESSION_CLAUDES = Object.keys(MASCOTS).filter((k) => k.startsWith('Claude-'))

const GW = 36
const GH = 72
const CROP_TOP = 22 // rows above the tallest hat, as in clawd-sprites.py

const OUTLINE = [58, 30, 20]
const EYE = [31, 20, 16]
const shade = (c, f) => c.map((v) => Math.max(0, Math.min(255, Math.round(v * f))))
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

/** Draw one mascot, front view facing left (the sprite's front-left standing pose). */
function drawGrid(name) {
  const v = MASCOTS[name]
  const grid = Array.from({ length: GH }, () => new Array(GW).fill(null))
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = Math.max(0, y0); y <= Math.min(GH - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(GW - 1, x1); x++) grid[y][x] = c
  }
  const px = (x, y, c) => rect(x, y, x, y, c)

  const body = v.body
  const side = shade(body, 0.78)
  const light = shade(body, 1.12)
  const top = 42 - (v.big ? 2 : 0)
  const bot = 62
  const x0 = 6
  const x1 = 29

  for (const [lx, col] of [[8, body], [13, side], [20, side], [25, body]]) rect(lx, bot + 1, lx + 2, 70, col)
  rect(x0, top, x1, bot, body)
  rect(x1 - 4, top, x1, bot, side)
  rect(x0, top, x1 - 5, top, light)
  rect(x0 - 3, 50, x0 - 1, 54, body)
  rect(x1 + 1, 50, x1 + 3, 54, side)

  const ey = top + 6
  rect(11, ey, 12, ey + 4, EYE)
  rect(18, ey, 19, ey + 4, EYE)

  if (v.face === 'glasses') {
    for (const ex of [10, 17]) {
      rect(ex - 1, ey - 1, ex + 3, ey - 1, OUTLINE)
      rect(ex - 1, ey + 5, ex + 3, ey + 5, OUTLINE)
      rect(ex - 1, ey - 1, ex - 1, ey + 5, OUTLINE)
      rect(ex + 3, ey - 1, ex + 3, ey + 5, OUTLINE)
    }
    rect(14, ey + 1, 15, ey + 1, OUTLINE)
  }
  if (v.face === 'shades') {
    rect(9, ey, 21, ey + 3, [20, 20, 24])
    px(10, ey, [120, 120, 140])
    px(17, ey, [120, 120, 140])
  }

  const nc = v.neckColor || [60, 60, 70]
  const ny = top + 13
  if (v.neck === 'tie') {
    rect(14, ny, 16, ny + 1, nc)
    rect(14, ny + 2, 16, bot - 2, nc)
    px(15, bot - 1, nc)
  } else if (v.neck === 'bowtie') {
    rect(12, ny, 13, ny + 2, nc)
    rect(17, ny, 18, ny + 2, nc)
    rect(14, ny + 1, 16, ny + 1, shade(nc, 0.7))
  } else if (v.neck === 'lanyard') {
    rect(10, ny - 1, 10, ny + 3, [230, 120, 40])
    rect(20, ny - 1, 20, ny + 3, [230, 120, 40])
    rect(13, ny + 3, 17, ny + 6, [235, 235, 235])
    rect(14, ny + 4, 15, ny + 5, [110, 140, 200])
  } else if (v.neck === 'scarf') {
    rect(x0 - 1, ny, x1 + 1, ny + 2, nc)
    rect(8, ny + 3, 10, ny + 7, shade(nc, 0.85))
  }

  if (v.ears === 'headphones') {
    const hp = [40, 40, 48]
    rect(x0 + 1, top - 3, x1 - 1, top - 2, hp)
    rect(x0 - 2, top - 2, x0 - 1, top + 6, hp)
    rect(x1 + 1, top - 2, x1 + 2, top + 6, hp)
    rect(x0 - 3, top + 2, x0 - 1, top + 7, [90, 200, 120])
    rect(x1 + 1, top + 2, x1 + 3, top + 7, [90, 200, 120])
  }

  const hc = v.hatColor || [60, 60, 70]
  const t = top
  if (v.hat === 'cap') {
    rect(x0 + 2, t - 5, x1 - 2, t - 1, hc)
    rect(x0 - 4, t - 1, x0 + 6, t, shade(hc, 0.75))
    px(17, t - 6, shade(hc, 0.75))
  } else if (v.hat === 'beanie') {
    rect(x0 + 1, t - 6, x1 - 1, t - 1, hc)
    rect(x0, t - 2, x1, t, shade(hc, 0.75))
    rect(16, t - 9, 19, t - 7, [240, 240, 240])
  } else if (v.hat === 'hardhat') {
    const y = [240, 196, 40]
    rect(x0 + 2, t - 6, x1 - 2, t - 1, y)
    rect(x0 - 2, t - 1, x1 + 2, t, shade(y, 0.8))
    rect(16, t - 6, 18, t - 2, shade(y, 1.1))
  } else if (v.hat === 'crown') {
    const g = [246, 196, 50]
    rect(x0 + 3, t - 4, x1 - 3, t - 1, g)
    for (const cx of [x0 + 3, 16, x1 - 4]) rect(cx, t - 8, cx + 1, t - 4, g)
    px(16, t - 3, [220, 50, 60])
    px(x0 + 6, t - 3, [60, 120, 220])
  }

  // one-pixel dark outline around everything drawn
  const out = grid.map((row) => row.slice())
  for (let y = 0; y < GH; y++)
    for (let x = 0; x < GW; x++) {
      if (grid[y][x]) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny2 = y + dy
        if (nx >= 0 && nx < GW && ny2 >= 0 && ny2 < GH && grid[ny2][nx]) { out[y][x] = OUTLINE; break }
      }
    }
  return out
}

/**
 * A mascot as an inline SVG string: one <path> per colour, crisp pixels.
 * @param {string} name a key of MASCOTS
 * @param {{ size?: number, title?: string }} [opts] size = rendered width in CSS px
 */
export function mascotSvg(name, { size = 72, title = '' } = {}) {
  const grid = drawGrid(name)
  const byColour = new Map()
  for (let y = CROP_TOP; y < GH; y++)
    for (let x = 0; x < GW; x++) {
      const c = grid[y][x]
      if (!c) continue
      const k = hex(c)
      byColour.set(k, (byColour.get(k) || '') + `M${x} ${y - CROP_TOP}h1v1h-1z`)
    }
  const h = GH - CROP_TOP
  const paths = [...byColour].map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`).join('')
  const label = title ? `<title>${title}</title>` : ''
  return `<svg class="mascot-svg" viewBox="0 0 ${GW} ${h}" width="${size}" height="${Math.round((size * h) / GW)}" shape-rendering="crispEdges" role="img" aria-label="${title || name}">${label}${paths}</svg>`
}
