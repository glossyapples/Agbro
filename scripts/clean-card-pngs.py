#!/usr/bin/env python3
"""
Clean checkerboard transparency from card PNGs.

The card artwork PNGs are sometimes exported from image tools that
flatten the alpha channel into a literal light/dark gray
"transparency indicator" checkerboard. The card visual itself sits
inside this padding, so when we render the PNG with rounded corners
the checkerboard leaks out around the rounded card art.

This script:
  1. Loads each PNG in public/cards/ as RGBA
  2. Flood-fills from each corner, marking checkerboard pixels
     (bright + grayscale, R/G/B all > 200, max channel deviation < 25)
     as fully transparent (alpha = 0). Flood-fill guarantees we only
     touch pixels CONNECTED to the corner — interior highlights /
     accents in the artwork are never accidentally erased.
  3. Crops the result to the bounding box of remaining opaque pixels
     so there's no wasted padding.
  4. Writes back in-place.

Idempotent: running on already-cleaned PNGs is a no-op (no
checkerboard left to fill).

Usage:
  python3 scripts/clean-card-pngs.py             # process all cards
  python3 scripts/clean-card-pngs.py FILENAME    # just one
"""

from PIL import Image
from collections import deque
from pathlib import Path
import sys


def is_checkerboard(px):
    r, g, b = px[0], px[1], px[2]
    if r < 200 or g < 200 or b < 200:
        return False
    return abs(r - g) < 25 and abs(g - b) < 25 and abs(r - b) < 25


def flood_clear(img):
    """Flood-fill from each corner; clear matching pixels. Returns count."""
    w, h = img.size
    px = img.load()
    visited = bytearray(w * h)

    def vidx(x, y):
        return y * w + x

    seeds = []
    for sx, sy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if is_checkerboard(px[sx, sy]):
            seeds.append((sx, sy))

    queue = deque(seeds)
    cleared = 0
    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        if visited[vidx(x, y)]:
            continue
        visited[vidx(x, y)] = 1
        if not is_checkerboard(px[x, y]):
            continue
        px[x, y] = (0, 0, 0, 0)
        cleared += 1
        queue.append((x + 1, y))
        queue.append((x - 1, y))
        queue.append((x, y + 1))
        queue.append((x, y - 1))
    return cleared


def clean_one(path: Path) -> None:
    img = Image.open(path).convert('RGBA')
    cleared = flood_clear(img)
    bbox = img.getbbox()
    if bbox is None:
        print(f'  {path.name}: image is fully transparent — skipping')
        return
    cropped = img.crop(bbox)
    cropped.save(path, optimize=True)
    print(f'  {path.name}: cleared {cleared:,} px → cropped to {cropped.size}')


def main():
    cards_dir = Path(__file__).resolve().parent.parent / 'public' / 'cards'
    if not cards_dir.is_dir():
        print(f'public/cards not found at {cards_dir}')
        sys.exit(1)

    targets = []
    if len(sys.argv) > 1:
        for arg in sys.argv[1:]:
            p = cards_dir / arg
            if not p.exists():
                print(f'not found: {p}')
                sys.exit(1)
            targets.append(p)
    else:
        targets = sorted(cards_dir.glob('*.png'))

    print(f'cleaning {len(targets)} PNG(s) in {cards_dir}')
    for p in targets:
        clean_one(p)


if __name__ == '__main__':
    main()
