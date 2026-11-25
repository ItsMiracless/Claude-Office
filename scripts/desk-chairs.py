#!/usr/bin/env python3
"""
desk-chairs.py - the office chairs at the main office's desks (src/deskChairs.ts).

Every desk spot has a swivel chair, turned the way the person at that desk
faces (the spot's spriteFacing). The art is the meeting room's own chair
(public/sprites/rooms/meeting-chair-*.webp, this repository's art), so the
two rooms share one chair: the two drawn turns are copied as they are and
the other two are their mirror images.

  python3 scripts/desk-chairs.py            writes the four files
  python3 scripts/desk-chairs.py --check    exits 1 when a file is missing or stale

Writes public/sprites/furniture/desk-chair-{front-left,front-right,rear-left,rear-right}.webp
(lossless WebP, transparent background). Needs Pillow.
"""

import io
import sys
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'public' / 'sprites' / 'rooms'
OUT = ROOT / 'public' / 'sprites' / 'furniture'

# facing -> (source chair, mirrored?)
# "rear-left" is a chair whose sitter faces away from us, up and to the left:
# we see its backrest. "front-right" faces us, down and to the right.
CHAIRS = {
    'rear-left': ('meeting-chair-rear-left.webp', False),
    'rear-right': ('meeting-chair-rear-left.webp', True),
    'front-right': ('meeting-chair-front-right.webp', False),
    'front-left': ('meeting-chair-front-right.webp', True),
}


def render(source: str, mirrored: bool) -> bytes:
    im = Image.open(SRC / source).convert('RGBA')
    if mirrored:
        im = ImageOps.mirror(im)
    buf = io.BytesIO()
    im.save(buf, 'WEBP', lossless=True, quality=100, method=6)
    return buf.getvalue()


def main(argv: list[str]) -> int:
    check = '--check' in argv
    stale = []
    for facing, (source, mirrored) in CHAIRS.items():
        target = OUT / f'desk-chair-{facing}.webp'
        want = Image.open(io.BytesIO(render(source, mirrored))).convert('RGBA')
        if check:
            if not target.exists() or Image.open(target).convert('RGBA').tobytes() != want.tobytes():
                stale.append(target.name)
            continue
        target.write_bytes(render(source, mirrored))
        print(f'wrote {target.relative_to(ROOT)} {want.size[0]}x{want.size[1]}')
    if stale:
        print('missing or stale: ' + ', '.join(stale) + ' (run python3 scripts/desk-chairs.py)')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
