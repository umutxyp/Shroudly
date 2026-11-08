# Apple TV's icon layers and Top Shelf images: Shroudly's logo, as at the
# app's top left, large on the app's own dark background. Run from the repo
# root: python3 scripts/logo/make-tv.py /tmp/mark-open.png
import sys, os
from PIL import Image, ImageDraw, ImageFont
mark = Image.open(sys.argv[1]).convert('RGBA')
base = 'apple/App/Assets.xcassets/App Icon & Top Shelf Image.brandassets'
TOP, BOT = (28, 36, 53), (11, 15, 23)

def back(w, h):
    im = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(round(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)))
    return im

def logo(px):
    box = mark.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    s = mark.crop(box)
    k = px / s.height
    return s.resize((round(s.width * k), px), Image.LANCZOS)

for stack, sizes in (('App Icon', ((400, 240, '1'), (800, 480, '2'))), ('App Icon - App Store', ((1280, 768, '1'),))):
    for w, h, sc in sizes:
        d = f'{base}/{stack}.imagestack'
        back(w, h).save(f'{d}/Back.imagestacklayer/Content.imageset/back@{sc}x.png')
        f = Image.new('RGBA', (w, h))
        l = logo(round(h * 0.66))
        f.alpha_composite(l, ((w - l.width) // 2, (h - l.height) // 2))
        f.save(f'{d}/Front.imagestacklayer/Content.imageset/front@{sc}x.png')

font = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 10)
for name, sizes in (('Top Shelf Image', ((1920, 720, '1'), (3840, 1440, '2'))), ('Top Shelf Image Wide', ((2320, 720, '1'), (4640, 1440, '2')))):
    for w, h, sc in sizes:
        im = back(w, h).convert('RGBA')
        l = logo(round(h * 0.42))
        f = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', round(h * 0.2))
        try: f.set_variation_by_name('Bold')
        except Exception: pass
        d = ImageDraw.Draw(im)
        tw = d.textlength('Shroudly', font=f)
        gap = h * 0.08
        x0 = (w - (l.width + gap + tw)) / 2
        im.alpha_composite(l, (round(x0), (h - l.height) // 2))
        asc, desc = f.getmetrics()
        d.text((x0 + l.width + gap, h / 2), 'Shroudly', font=f, fill=(232, 237, 246), anchor='lm')
        im.convert('RGB').save(f'{base}/{name}.imageset/shelf@{sc}x.png')
