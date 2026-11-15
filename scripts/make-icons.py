#!/usr/bin/env python3
"""Generate the Check-in app icons with the Python standard library only.

A filled accent circle (the "on it" check-in dot) on the light accent background,
with a smaller hollow ring beside it. Opaque, full bleed, so iOS can round the corners.
Run from the project root: python3 scripts/make-icons.py
"""
import math
import os
import struct
import zlib

BG = (0xDC, 0xEF, 0xE8)       # --accentbg
ACCENT = (0x1F, 0x6F, 0x5C)   # --accent
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'icons')


def png(width, height, rows):
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def coverage(d, r):
    """Anti-aliased coverage of a pixel whose center is `d` from a circle edge of radius `r`."""
    return max(0.0, min(1.0, r - d + 0.5))


def make(size):
    s = size
    big_c = (s * 0.42, s * 0.5)
    big_r = s * 0.22
    ring_c = (s * 0.74, s * 0.5)
    ring_r = s * 0.085
    ring_w = s * 0.03
    rows = []
    for y in range(s):
        row = []
        for x in range(s):
            px, py = x + 0.5, y + 0.5
            d1 = math.hypot(px - big_c[0], py - big_c[1])
            d2 = math.hypot(px - ring_c[0], py - ring_c[1])
            a = coverage(d1, big_r)
            ring = coverage(d2, ring_r) - coverage(d2, ring_r - ring_w)
            a = max(a, ring)
            row.extend(round(BG[i] + (ACCENT[i] - BG[i]) * a) for i in range(3))
        rows.append(row)
    return png(s, s, rows)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size in (('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)):
        with open(os.path.join(OUT, name), 'wb') as f:
            f.write(make(size))
        print('wrote', name)


if __name__ == '__main__':
    main()
