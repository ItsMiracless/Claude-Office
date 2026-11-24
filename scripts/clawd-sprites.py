#!/usr/bin/env python3
"""
clawd-sprites.py - redraw the office cast as pixel-art Claude Code mascots.

Every character sprite under public/sprites/characters/ (standing poses, walk
frames and seasonal copies) is replaced by a small blocky orange mascot with
its own outfit, drawn on the same canvas size so the office places it the way
it placed the original. The session Claudes get eight variants (Claude-1 ...
Claude-8, picked per session in src/theme.ts getSpritePath).

Run from the repository root:   python3 scripts/clawd-sprites.py
Needs Pillow (pip3 install Pillow).
"""
import os
import re
import sys
from PIL import Image, ImageDraw

DIR = os.path.join('public', 'sprites', 'characters')
NAME = re.compile(r'^(?P<base>.+?)-(?P<face>front|rear)-(?P<side>left|right)'
                  r'(?P<season>-[a-z]+?)?(?P<walk>-walk[1-4])?\.(?P<ext>png|webp)$')

# Logical grid: the mascot is drawn on 36 x 72 "pixels", then scaled up with
# nearest-neighbour so the pixel-art stays crisp. Feet touch the bottom row.
GW, GH = 36, 72
CROP_TOP = 22  # rows above the tallest hat (witch / santa / crown)

OUTLINE = (58, 30, 20, 255)
EYE = (31, 20, 16, 255)


def shade(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c[:3]) + (255,)


# body colours: the classic Claude orange plus a rainbow, one per session look
ORANGE = (217, 119, 87, 255)
GREEN = (96, 180, 104, 255)
BLUE = (84, 140, 220, 255)
PURPLE = (150, 104, 210, 255)
PINK = (232, 120, 170, 255)
YELLOW = (236, 190, 70, 255)
TEAL = (64, 178, 172, 255)
RED = (214, 78, 72, 255)
SKY = (120, 190, 235, 255)
LIME = (160, 205, 80, 255)
GREY = (150, 156, 166, 255)

# Outfits. Keys: body colour, hat, face (glasses...), neck (tie, scarf...), ears (headphones)
VARIANTS = {
    # session Claudes: each Claude Code session gets one of these (src/theme.ts)
    'Claude-1': dict(body=ORANGE, neck='lanyard'),
    'Claude-2': dict(body=GREEN, ears='headphones'),
    'Claude-3': dict(body=BLUE, hat='cap', hat_color=(240, 240, 240, 255)),
    'Claude-4': dict(body=PURPLE, face='glasses'),
    'Claude-5': dict(body=PINK, hat='beanie', hat_color=(90, 70, 160, 255)),
    'Claude-6': dict(body=YELLOW, neck='bowtie', neck_color=(200, 50, 60, 255)),
    'Claude-7': dict(body=TEAL, hat='hardhat'),
    'Claude-8': dict(body=RED, face='shades', neck='scarf', neck_color=(240, 220, 90, 255)),
    # the boss / manager: classic orange with a crown and a tie
    'Me-1': dict(body=ORANGE, hat='crown', neck='tie', neck_color=(40, 50, 90, 255), big=True),
    # subagent workers
    'dev-1': dict(body=SKY, ears='headphones'),
    'dev-2': dict(body=LIME, face='glasses', hat='cap', hat_color=(30, 30, 35, 255)),
    'employee-1': dict(body=GREY, neck='tie', neck_color=(180, 40, 50, 255)),
    'employee-2': dict(body=PINK, hat='beanie', hat_color=(240, 240, 240, 255)),
    'employee-3': dict(body=GREEN, neck='lanyard'),
    'Frontend-dev-1': dict(body=PURPLE, hat='beret', hat_color=(220, 70, 90, 255)),
    'explore-1': dict(body=YELLOW, hat='explorer'),
    'security-audit-1': dict(body=BLUE, face='shades', neck='tie', neck_color=(25, 25, 30, 255)),
}


class Pen:
    """Draws rectangles on the logical grid."""

    def __init__(self):
        self.im = Image.new('RGBA', (GW, GH), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)

    def rect(self, x0, y0, x1, y1, c):
        self.d.rectangle([x0, y0, x1, y1], fill=c)

    def px(self, x, y, c):
        if 0 <= x < GW and 0 <= y < GH:
            self.im.putpixel((x, y), c)


def draw(variant, front, walk, season):
    """Draw the mascot facing left (front-left / rear-left). Mirrored later for -right."""
    v = VARIANTS[variant]
    body = v['body']
    side = shade(body, 0.78)
    light = shade(body, 1.12)
    p = Pen()

    # walk phase: 0 standing, 1/3 contact (one pair of legs lifted), 2/4 passing (body bob)
    bob = 1 if walk in (2, 4) else 0
    lift_a = 2 if walk == 1 else 0
    lift_b = 2 if walk == 3 else 0
    arm_a = -1 if walk == 1 else (1 if walk == 3 else 0)

    top = 42 - bob - (2 if v.get('big') else 0)
    bot = 62 - bob
    x0, x1 = 6, 29

    # legs (4 stubby legs), the back pair a little darker
    legs = [(8, lift_a, body), (13, lift_b, side), (20, lift_a, side), (25, lift_b, body)]
    for lx, lift, col in legs:
        p.rect(lx, bot + 1, lx + 2, 70 - lift, col)

    # body block with a darker side face (3/4 view) and a lit top edge
    p.rect(x0, top, x1, bot, body)
    p.rect(x1 - 4, top, x1, bot, side)
    p.rect(x0, top, x1 - 5, top, light)

    # little arms / claws on both sides
    p.rect(x0 - 3, 50 - bob + arm_a, x0 - 1, 54 - bob + arm_a, body)
    p.rect(x1 + 1, 50 - bob - arm_a, x1 + 3, 54 - bob - arm_a, side)

    ey = top + 6
    if front:
        # two tall dark eyes, turned slightly toward the facing side
        p.rect(11, ey, 12, ey + 4, EYE)
        p.rect(18, ey, 19, ey + 4, EYE)

    face = v.get('face')
    if front and face == 'glasses':
        for ex in (10, 17):
            p.rect(ex - 1, ey - 1, ex + 3, ey - 1, OUTLINE)
            p.rect(ex - 1, ey + 5, ex + 3, ey + 5, OUTLINE)
            p.rect(ex - 1, ey - 1, ex - 1, ey + 5, OUTLINE)
            p.rect(ex + 3, ey - 1, ex + 3, ey + 5, OUTLINE)
        p.rect(14, ey + 1, 15, ey + 1, OUTLINE)
    if front and face == 'shades':
        p.rect(9, ey, 21, ey + 3, (20, 20, 24, 255))
        p.px(10, ey, (120, 120, 140, 255))
        p.px(17, ey, (120, 120, 140, 255))
    if not front and face in ('glasses', 'shades'):
        p.rect(x0, ey + 1, x1, ey + 1, OUTLINE)  # the strap behind

    neck = v.get('neck')
    nc = v.get('neck_color', (60, 60, 70, 255))
    ny = top + 13
    if season == '-xmas' and variant not in ('Claude-1',) and neck is None:
        neck, nc = 'scarf', (200, 40, 50, 255)
    if neck == 'tie' and front:
        p.rect(14, ny, 16, ny + 1, nc)
        p.rect(14, ny + 2, 16, bot - 2, nc)
        p.px(15, bot - 1, nc)
    elif neck == 'bowtie' and front:
        p.rect(12, ny, 13, ny + 2, nc)
        p.rect(17, ny, 18, ny + 2, nc)
        p.rect(14, ny + 1, 16, ny + 1, shade(nc, 0.7))
    elif neck == 'lanyard':
        if front:
            p.rect(10, ny - 1, 10, ny + 3, (230, 120, 40, 255))
            p.rect(20, ny - 1, 20, ny + 3, (230, 120, 40, 255))
            p.rect(13, ny + 3, 17, ny + 6, (235, 235, 235, 255))
            p.rect(14, ny + 4, 15, ny + 5, (110, 140, 200, 255))
        else:
            p.rect(x0, ny - 1, x1, ny - 1, (230, 120, 40, 255))
    elif neck == 'scarf':
        p.rect(x0 - 1, ny, x1 + 1, ny + 2, nc)
        p.rect(8, ny + 3, 10, ny + 7, shade(nc, 0.85))

    if v.get('ears') == 'headphones':
        hp = (40, 40, 48, 255)
        p.rect(x0 + 1, top - 3, x1 - 1, top - 2, hp)
        p.rect(x0 - 2, top - 2, x0 - 1, top + 6, hp)
        p.rect(x1 + 1, top - 2, x1 + 2, top + 6, hp)
        p.rect(x0 - 3, top + 2, x0 - 1, top + 7, (90, 200, 120, 255))
        p.rect(x1 + 1, top + 2, x1 + 3, top + 7, (90, 200, 120, 255))

    hat = v.get('hat')
    if season == '-xmas' and (variant == 'Me-1' or variant.startswith('Claude-')):
        hat = 'santa'  # these skip the office's overlay Santa hat (src/hat.ts NO_HAT)
    if season == '-halloween':
        hat = 'witch' if variant.startswith('Claude-') else 'wizard'
    hc = v.get('hat_color', (60, 60, 70, 255))
    t = top
    if hat == 'cap':
        p.rect(x0 + 2, t - 5, x1 - 2, t - 1, hc)
        p.rect(x0 - 4, t - 1, x0 + 6, t, shade(hc, 0.75))  # brim to the facing side
        p.px(17, t - 6, shade(hc, 0.75))
    elif hat == 'beanie':
        p.rect(x0 + 1, t - 6, x1 - 1, t - 1, hc)
        p.rect(x0, t - 2, x1, t, shade(hc, 0.75))
        p.rect(16, t - 9, 19, t - 7, (240, 240, 240, 255))
    elif hat == 'hardhat':
        y = (240, 196, 40, 255)
        p.rect(x0 + 2, t - 6, x1 - 2, t - 1, y)
        p.rect(x0 - 2, t - 1, x1 + 2, t, shade(y, 0.8))
        p.rect(16, t - 6, 18, t - 2, shade(y, 1.1))
    elif hat == 'crown':
        g = (246, 196, 50, 255)
        p.rect(x0 + 3, t - 4, x1 - 3, t - 1, g)
        for cx in (x0 + 3, 16, x1 - 4):
            p.rect(cx, t - 8, cx + 1, t - 4, g)
        p.px(16, t - 3, (220, 50, 60, 255))
        p.px(x0 + 6, t - 3, (60, 120, 220, 255))
    elif hat == 'beret':
        p.rect(x0 + 1, t - 4, x1 - 3, t - 1, hc)
        p.rect(x0 - 1, t - 3, x0 + 2, t - 2, hc)
        p.px(15, t - 5, shade(hc, 0.7))
    elif hat == 'explorer':
        k = (190, 160, 100, 255)
        p.rect(x0 + 3, t - 6, x1 - 3, t - 1, k)
        p.rect(x0 - 3, t - 1, x1 + 3, t, shade(k, 0.8))
        p.rect(x0 + 3, t - 3, x1 - 3, t - 3, (110, 70, 40, 255))
    elif hat == 'santa':
        r = (210, 40, 50, 255)
        p.rect(x0 + 2, t - 6, x1 - 2, t - 2, r)
        p.rect(x0 + 6, t - 10, x1 - 6, t - 6, r)
        p.rect(x0 - 2, t - 13, x0 + 6, t - 10, r)
        p.rect(x0 - 4, t - 14, x0 - 2, t - 12, (250, 250, 250, 255))
        p.rect(x0, t - 2, x1, t, (250, 250, 250, 255))
    elif hat in ('witch', 'wizard'):
        c = (60, 40, 90, 255) if hat == 'witch' else (40, 60, 150, 255)
        p.rect(x0 - 3, t - 1, x1 + 3, t, c)
        p.rect(x0 + 3, t - 5, x1 - 3, t - 2, c)
        p.rect(x0 + 6, t - 10, x1 - 6, t - 6, c)
        p.rect(x0 + 9, t - 15, x1 - 9, t - 11, c)
        p.rect(x0 + 3, t - 3, x1 - 3, t - 3, (240, 150, 40, 255) if hat == 'witch' else (240, 210, 60, 255))

    return outline(p.im)


def outline(im):
    """A one-pixel dark outline around everything drawn (classic pixel-art look)."""
    out = im.copy()
    a = im.load()
    o = out.load()
    for y in range(GH):
        for x in range(GW):
            if a[x, y][3]:
                continue
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < GW and 0 <= ny < GH and a[nx, ny][3]:
                    o[x, y] = OUTLINE
                    break
    return out


def render(variant, face, side, season, walk, size):
    W, H = size
    img = draw(variant, face == 'front', walk, season or '')
    if side == 'right':
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    # drop the empty sky above the tallest hat, so the mascot fills the canvas
    # the way the original (taller) people did; then scale to the canvas width
    # and sit on the bottom edge
    img = img.crop((0, CROP_TOP, GW, GH))
    gh = GH - CROP_TOP
    sw = W
    sh = round(W * gh / GW)
    if sh > H:
        sh = H
        sw = round(H * GW / gh)
    big = img.resize((sw, sh), Image.NEAREST)
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    canvas.alpha_composite(big, ((W - sw) // 2, H - sh))
    return canvas


def main():
    if not os.path.isdir(DIR):
        sys.exit('Run from the repository root (public/sprites/characters not found)')
    files = sorted(os.listdir(DIR))
    by_base = {}
    for f in files:
        m = NAME.match(f)
        if m:
            by_base.setdefault(m['base'], []).append(f)

    # Claude-2..8 take the same file set (sizes included) as Claude-1
    for i in range(2, 9):
        for f in by_base.get('Claude-1', []):
            by_base.setdefault(f'Claude-{i}', []).append(('Claude-1', f))

    n = 0
    for base, items in by_base.items():
        if base not in VARIANTS:
            continue
        for it in items:
            src_base, f = it if isinstance(it, tuple) else (base, it)
            m = NAME.match(f)
            size = Image.open(os.path.join(DIR, f)).size
            walk = int(m['walk'][-1]) if m['walk'] else 0
            img = render(base, m['face'], m['side'], m['season'], walk, size)
            out = f.replace(src_base, base, 1)
            path = os.path.join(DIR, out)
            if m['ext'] == 'webp':
                img.save(path, 'WEBP', lossless=True)
            else:
                img.save(path, 'PNG', optimize=True)
            n += 1
    print(f'wrote {n} sprites')


if __name__ == '__main__':
    main()
