#!/usr/bin/env python3
"""
Strip baked-in checkerboard "transparency" from PNG files.

Some image-export tools flatten the alpha channel into a literal
light/dark gray "transparency indicator" checkerboard pattern instead
of writing a real alpha channel. The image looks transparent in the
source app but renders as a visible checkerboard everywhere else.

This script:
  1. Loads each PNG as RGBA
  2. Flood-fills from each corner, marking checkerboard pixels
     (bright + grayscale: R/G/B all > 200, max channel deviation < 25)
     as fully transparent (alpha = 0). Flood-fill (vs. global
     threshold) guarantees we only touch pixels CONNECTED to a corner
     — interior highlights / accents in the artwork are never
     accidentally erased.
  3. Crops the result to the bounding box of remaining opaque pixels
     so there is no wasted padding.
  4. Writes back in-place.

Idempotent: running on already-cleaned PNGs is a no-op (no
checkerboard left to fill).

Usage:
  # Clean all PNGs under public/cards/ and public/brain/:
  python3 scripts/clean-pngs.py public/cards public/brain

  # Clean a single file:
  python3 scripts/clean-pngs.py public/brain/brain.png

  # No args: defaults to all PNGs under public/ recursively
  python3 scripts/clean-pngs.py
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
        print(f'  {path}: image is fully transparent — skipping')
        return
    cropped = img.crop(bbox)
    cropped.save(path, optimize=True)
    rel = path.relative_to(Path.cwd()) if path.is_absolute() else path
    print(f'  {rel}: cleared {cleared:,} px -> cropped to {cropped.size}')


def gather_targets(args):
    if not args:
        # Default: every PNG under public/, recursive.
        root = Path(__file__).resolve().parent.parent / 'public'
        return sorted(root.rglob('*.png'))

    targets = []
    for arg in args:
        p = Path(arg)
        if not p.is_absolute():
            # Resolve relative to repo root (one level up from scripts/).
            p = Path(__file__).resolve().parent.parent / p
        if p.is_file():
            targets.append(p)
        elif p.is_dir():
            targets.extend(sorted(p.rglob('*.png')))
        else:
            print(f'not found: {arg}')
            sys.exit(1)
    return targets


def main():
    targets = gather_targets(sys.argv[1:])
    if not targets:
        print('no PNGs found to clean')
        return
    print(f'cleaning {len(targets)} PNG(s)')
    for p in targets:
        clean_one(p)


if __name__ == '__main__':
    main()
