"""Redraws src/icons/icon.svg (48x48 viewBox) as PNG icons.

Chromium does not accept SVG extension icons. Draws at 8x and downsizes with LANCZOS for smooth edges.
"""
import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'icons')

VB = 48          # SVG viewBox birimi
SS = 8           # supersample factor
S  = VB * SS     # drawing canvas: 384px

BG     = (0x1a, 0x1a, 0x2e, 255)
ACCENT = (0x4A, 0x90, 0xE2, 255)


def u(v):
    """viewBox units -> canvas pixels"""
    return v * SS


def draw():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # <circle cx=24 cy=24 r=22 fill=#1a1a2e stroke=#4A90E2 stroke-width=2>
    # SVG strokes are centered on the edge, so the visible radius is 22 + 1 = 23
    r, sw = 22, 2
    d.ellipse(
        [u(24 - r), u(24 - r), u(24 + r), u(24 + r)],
        fill=BG, outline=ACCENT, width=int(u(sw)),
    )

    # <path d="M14 24 L24 14 L24 20 L34 20 L34 28 L24 28 L24 34 Z">
    pts = [(14, 24), (24, 14), (24, 20), (34, 20),
           (34, 28), (24, 28), (24, 34), (14, 24)]  # Z closes the path
    d.line([(u(x), u(y)) for x, y in pts],
           fill=ACCENT, width=int(u(2.5)), joint='curve')

    # joint='curve' rounds inner corners only, not the end point.
    # Equivalent of stroke-linecap=round: put a disc on the start point.
    cap = u(2.5) / 2
    for x, y in (pts[0],):
        d.ellipse([u(x) - cap, u(y) - cap, u(x) + cap, u(y) + cap], fill=ACCENT)

    return img


def main():
    base = draw()
    for size in (16, 48, 128):
        out = os.path.join(OUT_DIR, f'icon-{size}.png')
        base.resize((size, size), Image.LANCZOS).save(out)
        print(f'OK {out}')


if __name__ == '__main__':
    main()
