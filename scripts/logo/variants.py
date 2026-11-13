# The logos a user can choose between (Settings, Appearance): each one drawn
# here, in code, and written out in the sizes and shapes every system wants.
#
#   python3 scripts/logo/variants.py            every file, into the repo
#   python3 scripts/logo/variants.py --sheet f  one picture of all of them
#
# "classic" is the logo Shroudly has always had and is not drawn here: its
# files are the ones already in the repo. Every other logo is flat: one
# background colour, a mark on it, no gradient and no shadow, so it stays
# clear at 16 pixels and the system's own mask (a circle, a squircle) can cut
# it anywhere. The country ones are for countries where people use Shroudly
# against blocking; the shield is the flag, with its sign where it has a
# simple one and no emblem that divides the people who live there.
from PIL import Image, ImageDraw
import math, os, sys

S = 1024; SS = 4; N = S * SS          # drawn at four times the size, then scaled down
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def bez(p0, p1, p2, p3, n=40):
    out = []
    for i in range(n + 1):
        t = i / n; u = 1 - t
        out.append((u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
                    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]))
    return out
def shield(cx=0.5, cy=0.5, w=0.66, h=0.76):
    r = []
    r += bez((0.5, 0.0), (0.62, 0.09), (0.80, 0.13), (1.0, 0.14))
    r += bez((1.0, 0.14), (1.0, 0.30), (1.0, 0.42), (0.985, 0.52))
    r += bez((0.985, 0.52), (0.95, 0.76), (0.74, 0.90), (0.5, 1.0))
    pts = r + [(1 - x, y) for x, y in reversed(r)]
    return [(cx + (x - 0.5) * w, cy + (y - 0.5) * h) for x, y in pts]
def px(pts): return [(x * N, y * N) for x, y in pts]
def eye(cx, cy, w, h):
    return bez((cx - w/2, cy), (cx - w/4, cy - h), (cx + w/4, cy - h), (cx + w/2, cy), 60) + \
           bez((cx + w/2, cy), (cx + w/4, cy + h), (cx - w/4, cy + h), (cx - w/2, cy), 60)
# The whole square in the background's colour: the corners are cut later, by
# us (rounded) or by the system. BG remembers the colour of the logo being drawn.
BG = [None]
def bg(color):
    BG[0] = color
    im = Image.new('RGBA', (N, N), color); d = ImageDraw.Draw(im)
    return im, d
def circle(d, cx, cy, r, fill): d.ellipse([(cx - r) * N, (cy - r) * N, (cx + r) * N, (cy + r) * N], fill=fill)
def stroke(d, pts, width, fill, closed=True):
    p = px(pts)
    if closed: p = p + [p[0]]
    d.line(p, fill=fill, width=int(width * N), joint='curve')
    r = width * N / 2
    for x, y in p[::6]: d.ellipse([x - r, y - r, x + r, y + r], fill=fill)
def star(cx, cy, r, rot=-90, k=0.40, n=5):
    pts = []
    for i in range(n * 2):
        a = math.radians(rot + i * 180 / n); rr = r if i % 2 == 0 else r * k
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts
def heart(cx, cy, s):
    pts = []
    for i in range(200):
        t = 2 * math.pi * i / 200
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2*t) - 2 * math.cos(3*t) - math.cos(4*t)
        pts.append((cx + x * s / 34, cy - y * s / 34))
    return pts
def finish(im): return im.resize((S, S), Image.LANCZOS)
def flat_mark(d, bgc, fg, pupil=None, cy=0.5):
    d.polygon(px(shield(cy=cy)), fill=fg)
    d.polygon(px(eye(0.5, cy - 0.03, 0.40, 0.19)), fill=bgc)
    if pupil is not False: circle(d, 0.5, cy - 0.03, 0.072, pupil or fg)

icons = {}

def flat(bgc, fg):
    def f():
        im, d = bg(bgc); flat_mark(d, bgc, fg); return finish(im)
    return f
def line(bgc, fg, w=0.030):
    def f():
        im, d = bg(bgc)
        stroke(d, shield(), w, fg)
        stroke(d, eye(0.5, 0.47, 0.34, 0.16), w, fg)
        circle(d, 0.5, 0.47, 0.050, fg)
        return finish(im)
    return f
def keyhole():
    bgc = (245, 166, 35, 255); fg = (33, 24, 8, 255)
    im, d = bg(bgc)
    d.polygon(px(shield()), fill=fg)
    circle(d, 0.5, 0.42, 0.095, bgc)
    d.polygon(px([(0.455, 0.44), (0.545, 0.44), (0.585, 0.66), (0.415, 0.66)]), fill=bgc)
    return finish(im)
def veil():
    bgc = (58, 36, 110, 255)
    im, d = bg(bgc)
    sh = Image.new('L', (N, N), 0); ImageDraw.Draw(sh).polygon(px(shield()), fill=255)
    layer = Image.new('RGBA', (N, N), (255, 255, 255, 255)); ld = ImageDraw.Draw(layer)
    gap = bez((0.5, 0.10), (0.30, 0.40), (0.34, 0.66), (0.5, 0.92), 80) + bez((0.5, 0.92), (0.66, 0.66), (0.70, 0.40), (0.5, 0.10), 80)
    ld.polygon(px(gap), fill=bgc)
    circle(ld, 0.5, 0.50, 0.062, (255, 255, 255, 255))
    im.paste(layer, (0, 0), sh)
    return finish(im)
def terminal():
    bgc = (8, 12, 10, 255); fg = (57, 255, 136, 255)
    im, d = bg(bgc)
    stroke(d, shield(), 0.026, fg)
    stroke(d, [(0.36, 0.38), (0.48, 0.47), (0.36, 0.56)], 0.040, fg, closed=False)
    stroke(d, [(0.52, 0.58), (0.65, 0.58)], 0.040, fg, closed=False)
    return finish(im)
icons['flat'] = flat((24, 95, 220, 255), (255, 255, 255, 255))
icons['line'] = line((12, 12, 14, 255), (245, 245, 245, 255))
icons['paper'] = flat((246, 243, 236, 255), (22, 22, 24, 255))
icons['key'] = keyhole
icons['veil'] = veil
icons['terminal'] = terminal
icons['night'] = flat((26, 29, 33, 255), (94, 234, 190, 255))
icons['coral'] = flat((235, 87, 72, 255), (255, 244, 232, 255))

def newyear():
    g = (14, 82, 52, 255); w = (255, 255, 255, 255); red = (214, 40, 57, 255)
    im, d = bg(g)
    for x, y, r in [(0.14, 0.20, 0.012), (0.86, 0.30, 0.010), (0.20, 0.80, 0.010), (0.80, 0.84, 0.013), (0.10, 0.52, 0.008), (0.90, 0.60, 0.009), (0.70, 0.10, 0.008)]:
        circle(d, x, y, r, w)
    flat_mark(d, g, w, cy=0.585)
    # the hat: a red cap whose tip falls to the right, a white brim, a
    # pompom; a gap in the background's colour keeps it apart from the shield
    brim = bez((0.185, 0.345), (0.33, 0.290), (0.50, 0.262), (0.675, 0.250), 50)
    cap = bez((0.215, 0.320), (0.26, 0.170), (0.44, 0.075), (0.62, 0.075), 50) \
        + bez((0.62, 0.075), (0.76, 0.065), (0.845, 0.150), (0.850, 0.262), 40) \
        + bez((0.800, 0.280), (0.790, 0.195), (0.735, 0.175), (0.668, 0.222), 30) \
        + list(reversed(bez((0.215, 0.320), (0.34, 0.272), (0.50, 0.245), (0.668, 0.232), 50)))
    stroke(d, cap, 0.034, g)
    stroke(d, brim, 0.112, g, closed=False)
    circle(d, 0.826, 0.292, 0.070, g)
    d.polygon(px(cap), fill=red)
    stroke(d, brim, 0.072, w, closed=False)
    circle(d, 0.826, 0.292, 0.050, w)
    return finish(im)
icons['newyear'] = newyear

def halloween():
    night = (27, 16, 38, 255); orange = (255, 122, 24, 255); dark = (198, 84, 8, 255); glow = (255, 214, 64, 255)
    im, d = bg(night)
    sh = shield(cy=0.53)
    d.polygon(px(sh), fill=orange)
    mask = Image.new('L', (N, N), 0); ImageDraw.Draw(mask).polygon(px(sh), fill=255)
    ribs = Image.new('RGBA', (N, N), (0, 0, 0, 0)); rd = ImageDraw.Draw(ribs)
    for x0 in (0.335, 0.665):
        rd.line(px(bez((x0, 0.18), (x0 - (0.5 - x0) * 0.30, 0.42), (x0 - (0.5 - x0) * 0.20, 0.66), (0.5 + (x0 - 0.5) * 0.45, 0.90), 40)), fill=dark, width=int(0.016 * N))
    im.paste(ribs, (0, 0), Image.composite(ribs.getchannel('A'), Image.new('L', (N, N), 0), mask))
    # two carved eyes and a grin
    for sx in (-1, 1):
        d.polygon(px([(0.5 + sx * 0.055, 0.47), (0.5 + sx * 0.20, 0.365), (0.5 + sx * 0.205, 0.485)]), fill=night)
        d.polygon(px([(0.5 + sx * 0.085, 0.462), (0.5 + sx * 0.18, 0.405), (0.5 + sx * 0.183, 0.468)]), fill=glow)
    grin = [(0.335, 0.585), (0.39, 0.625), (0.43, 0.595), (0.47, 0.64), (0.5, 0.605), (0.53, 0.64), (0.57, 0.595), (0.61, 0.625), (0.665, 0.585),
            (0.60, 0.70), (0.56, 0.675), (0.53, 0.715), (0.5, 0.685), (0.47, 0.715), (0.44, 0.675), (0.40, 0.70)]
    d.polygon(px(grin), fill=night)
    # the stem
    d.polygon(px([(0.47, 0.165), (0.50, 0.075), (0.555, 0.085), (0.535, 0.170)]), fill=(72, 140, 60, 255))
    return finish(im)
icons['halloween'] = halloween

def valentine():
    pink = (255, 79, 121, 255); w = (255, 255, 255, 255)
    im, d = bg(pink)
    flat_mark(d, pink, w, pupil=False)
    d.polygon(px(heart(0.5, 0.475, 0.150)), fill=w)
    return finish(im)
icons['valentine'] = valentine

def spring():
    g = (46, 158, 91, 255); w = (255, 255, 255, 255); y = (255, 204, 51, 255); p = (255, 143, 171, 255)
    im, d = bg(g)
    flat_mark(d, g, w, pupil=False)
    for i in range(5):
        a = math.radians(-90 + i * 72)
        circle(d, 0.5 + 0.058 * math.cos(a), 0.47 + 0.058 * math.sin(a), 0.046, p)
    circle(d, 0.5, 0.47, 0.036, y)
    return finish(im)
icons['spring'] = spring

def ramadan():
    navy = (14, 27, 61, 255); gold = (242, 196, 90, 255)
    im, d = bg(navy)
    stroke(d, shield(), 0.026, gold)
    circle(d, 0.47, 0.47, 0.165, gold)
    circle(d, 0.535, 0.435, 0.140, navy)
    d.polygon(px(star(0.615, 0.475, 0.058)), fill=gold)
    for x, y, r in [(0.15, 0.22, 0.010), (0.85, 0.24, 0.008), (0.14, 0.70, 0.008), (0.86, 0.72, 0.010)]: circle(d, x, y, r, gold)
    return finish(im)
icons['ramadan'] = ramadan

def winter():
    ice = (221, 238, 255, 255); navy = (22, 48, 92, 255)
    im, d = bg(ice)
    flat_mark(d, ice, navy)
    def flake(cx, cy, r):
        for i in range(3):
            a = math.radians(i * 60)
            stroke(d, [(cx - r * math.cos(a), cy - r * math.sin(a)), (cx + r * math.cos(a), cy + r * math.sin(a))], 0.009, navy, closed=False)
    for cx, cy, r in [(0.13, 0.16, 0.045), (0.87, 0.20, 0.035), (0.14, 0.82, 0.035), (0.87, 0.80, 0.045)]: flake(cx, cy, r)
    return finish(im)
icons['winter'] = winter

def flag(stripes, mark=None, outline=(255, 255, 255, 255), base=(21, 23, 28, 255)):
    """The shield as the country's flag: its bands, and its sign where it has a simple one. No eye."""
    def f():
        im, d = bg(base)
        sh = shield()
        mask = Image.new('L', (N, N), 0); ImageDraw.Draw(mask).polygon(px(sh), fill=255)
        band = Image.new('RGBA', (N, N), (0, 0, 0, 0)); bd = ImageDraw.Draw(band)
        top, bot = 0.5 - 0.38, 0.5 + 0.38
        n = len(stripes)
        for i, c in enumerate(stripes):
            bd.rectangle([0, (top + i * (bot - top) / n) * N, N, (top + (i + 1) * (bot - top) / n) * N], fill=c)
        if mark == 'pk':   # the white band at the hoist
            bd.rectangle([0, 0, (0.17 + 0.66 * 0.25) * N, N], fill=(255, 255, 255, 255))
        im.paste(band, (0, 0), mask)
        d = ImageDraw.Draw(im)
        w = (255, 255, 255, 255)
        if mark == 'tr':
            c = stripes[0]
            circle(d, 0.455, 0.47, 0.150, w); circle(d, 0.495, 0.47, 0.120, c)
            d.polygon(px(star(0.612, 0.47, 0.062, rot=180)), fill=w)
        elif mark == 'pk':
            c = stripes[0]
            circle(d, 0.575, 0.47, 0.135, w); circle(d, 0.612, 0.445, 0.115, c)
            d.polygon(px(star(0.660, 0.415, 0.050, rot=-90 + 20)), fill=w)
        elif mark == 'az':
            c = stripes[1]
            circle(d, 0.470, 0.50, 0.090, w); circle(d, 0.497, 0.50, 0.074, c)
            d.polygon(px(star(0.575, 0.50, 0.046, rot=-90, k=0.55, n=8)), fill=w)
        elif mark == 'cn':
            y = (255, 222, 0, 255)
            d.polygon(px(star(0.385, 0.385, 0.105)), fill=y)
            for ax, ay in [(0.545, 0.275), (0.615, 0.345), (0.615, 0.445), (0.545, 0.515)]:
                d.polygon(px(star(ax, ay, 0.036, rot=math.degrees(math.atan2(0.385 - ay, 0.385 - ax)))), fill=y)
        elif mark == 'vn':
            d.polygon(px(star(0.5, 0.47, 0.185)), fill=(255, 255, 0, 255))
        elif mark == 'kz':
            y = (254, 197, 12, 255)
            for i in range(24):
                a = math.radians(i * 15)
                stroke(d, [(0.5 + 0.118 * math.cos(a), 0.45 + 0.118 * math.sin(a)), (0.5 + 0.185 * math.cos(a), 0.45 + 0.185 * math.sin(a))], 0.013, y, closed=False)
            circle(d, 0.5, 0.45, 0.095, y)
        stroke(d, sh, 0.016, outline)
        return finish(im)
    return f
icons['tr'] = flag([(227, 10, 23, 255)], 'tr')
icons['ir'] = flag([(35, 159, 64, 255), (255, 255, 255, 255), (218, 0, 0, 255)])
icons['ru'] = flag([(255, 255, 255, 255), (0, 57, 166, 255), (213, 43, 30, 255)])
icons['cn'] = flag([(222, 41, 16, 255)], 'cn')
icons['pk'] = flag([(1, 65, 28, 255)], 'pk')
icons['az'] = flag([(0, 181, 226, 255), (239, 51, 64, 255), (80, 158, 47, 255)], 'az')
icons['kz'] = flag([(0, 175, 202, 255)], 'kz')
icons['eg'] = flag([(206, 17, 38, 255), (255, 255, 255, 255), (0, 0, 0, 255)], outline=(200, 200, 205, 255))
icons['vn'] = flag([(218, 37, 29, 255)], 'vn')


# What the app shows them as: the order, and the three groups of Settings.
GROUPS = [
    ('styles', ['classic', 'flat', 'line', 'paper', 'key', 'veil', 'terminal', 'night', 'coral']),
    ('days', ['newyear', 'halloween', 'valentine', 'spring', 'ramadan', 'winter']),
    ('countries', ['tr', 'ir', 'ru', 'cn', 'pk', 'az', 'kz', 'eg', 'vn']),
]
IDS = [i for _, ids in GROUPS for i in ids]

def art(i):
    """The logo as a full square (1024 px) and its background colour."""
    im = icons[i]()
    return im, BG[0]

def rounded(im, radius=0.225):
    m = Image.new('L', (S * 2, S * 2), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, S * 2 - 1, S * 2 - 1], radius=int(S * 2 * radius), fill=255)
    out = im.copy(); out.putalpha(m.resize((S, S), Image.LANCZOS))
    return out

def inset(im, color, k):
    """The art at k of its size in the middle of a square of its own colour: room for a system's mask."""
    out = Image.new('RGBA', (S, S), color)
    s = im.resize((int(S * k), int(S * k)), Image.LANCZOS)
    out.alpha_composite(s, ((S - s.width) // 2, (S - s.height) // 2))
    return out

def classic_square():
    """Today's logo on its own dark ground, for the sheet and the pickers."""
    src = Image.open(os.path.join(ROOT, 'apple', 'App', 'AppIcon.icon', 'Assets', 'shield.png')).convert('RGBA')
    im = Image.new('RGBA', (S, S)); d = ImageDraw.Draw(im)
    for y in range(S):
        t = y / S
        d.line([(0, y), (S, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip((28, 36, 53), (11, 15, 23))) + (255,))
    box = src.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    m = src.crop(box); k = 0.70 * S / max(m.size); m = m.resize((int(m.width * k), int(m.height * k)), Image.LANCZOS)
    im.alpha_composite(m, ((S - m.width) // 2, (S - m.height) // 2))
    return im, (20, 26, 38, 255)

def square(i): return classic_square() if i == 'classic' else art(i)

def write():
    # public/logos: the pictures the window shows. logos/: what the main
    # process puts on the window, the taskbar and the Dock (shipped beside
    # the app, not inside its pages).
    pub = os.path.join(ROOT, 'public', 'logos'); os.makedirs(pub, exist_ok=True)
    own = os.path.join(ROOT, 'logos'); os.makedirs(own, exist_ok=True)
    res = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
    xc = os.path.join(ROOT, 'apple', 'App', 'Assets.xcassets')
    colors = []
    for i in IDS:
        im, color = square(i)
        r = rounded(im)
        # The desktop: the pickers and the window's corner (PNG), Windows' window and taskbar (ICO), the Dock (a margin, as macOS icons have).
        r.resize((256, 256), Image.LANCZOS).save(os.path.join(pub, f'{i}.png'))
        # The pickers' pictures, the classic one's too.
        os.makedirs(os.path.join(res, 'drawable-nodpi'), exist_ok=True)
        r.resize((192, 192), Image.LANCZOS).save(os.path.join(res, 'drawable-nodpi', f'logo_{i}.png'))
        dset = os.path.join(xc, f'LogoPick-{i}.imageset'); os.makedirs(dset, exist_ok=True)
        r.resize((256, 256), Image.LANCZOS).save(os.path.join(dset, 'logo.png'))
        with open(os.path.join(dset, 'Contents.json'), 'w') as f:
            f.write('{\n  "images" : [\n    {\n      "filename" : "logo.png",\n      "idiom" : "universal"\n    }\n  ],\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n')
        if i == 'classic': continue        # its app icons are the ones the repo has
        r.resize((256, 256), Image.LANCZOS).save(os.path.join(own, f'{i}.png'))
        r.resize((256, 256), Image.LANCZOS).save(os.path.join(own, f'{i}.ico'), sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
        dock = Image.new('RGBA', (S, S)); dr = r.resize((824, 824), Image.LANCZOS); dock.alpha_composite(dr, (100, 100))
        dock.resize((512, 512), Image.LANCZOS).save(os.path.join(own, f'{i}-dock.png'))
        # Android: the adaptive icon's foreground (the launcher cuts its own shape) and the picker's picture.
        inset(im, color, 0.60).resize((432, 432), Image.LANCZOS).save(os.path.join(res, 'drawable-nodpi', f'logo_{i}_fg.png'))
        colors.append((i, '#%02X%02X%02X' % color[:3]))
        with open(os.path.join(res, 'mipmap-anydpi', f'ic_logo_{i}.xml'), 'w') as f:
            f.write('<?xml version="1.0" encoding="utf-8"?>\n<!-- Written by scripts/logo/variants.py. -->\n'
                    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                    f'    <background android:drawable="@color/logo_{i}_bg" />\n'
                    f'    <foreground android:drawable="@drawable/logo_{i}_fg" />\n</adaptive-icon>\n')
        # Apple: an app icon set for iPhone and iPad (the system cuts the corners
        # itself), and the Mac's Dock picture (a margin, as macOS icons have).
        dset = os.path.join(xc, f'Logo-{i}.appiconset'); os.makedirs(dset, exist_ok=True)
        im.convert('RGB').save(os.path.join(dset, 'logo.png'))
        with open(os.path.join(dset, 'Contents.json'), 'w') as f:
            f.write('{\n  "images" : [\n    {\n      "filename" : "logo.png",\n      "idiom" : "universal",\n      "platform" : "ios",\n      "size" : "1024x1024"\n    }\n  ],\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n')
        dset = os.path.join(xc, f'LogoDock-{i}.imageset'); os.makedirs(dset, exist_ok=True)
        dock.resize((512, 512), Image.LANCZOS).save(os.path.join(dset, 'logo.png'))
        with open(os.path.join(dset, 'Contents.json'), 'w') as f:
            f.write('{\n  "images" : [\n    {\n      "filename" : "logo.png",\n      "idiom" : "mac"\n    }\n  ],\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n')
    with open(os.path.join(res, 'values', 'logo_colors.xml'), 'w') as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<!-- Written by scripts/logo/variants.py: the ground of each logo\'s adaptive icon. -->\n<resources>\n'
                + ''.join(f'    <color name="logo_{i}_bg">{c}</color>\n' for i, c in colors) + '</resources>\n')
    print(f'{len(IDS)} logos written')

def sheet(path):
    cols = 6; pad = 40; big = 220; rows = math.ceil(len(IDS) / cols)
    out = Image.new('RGB', (pad + cols * (big + pad), pad + rows * (big + pad)), (236, 236, 240))
    for n, i in enumerate(IDS):
        r = rounded(square(i)[0]).resize((big, big), Image.LANCZOS)
        out.paste(r, (pad + (n % cols) * (big + pad), pad + (n // cols) * (big + pad)), r)
    out.save(path)

if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--sheet': sheet(sys.argv[2])
    else: write()
