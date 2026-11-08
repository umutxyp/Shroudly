# The Protection tab's icon everywhere (each app tints it as its other tab
# icons): Shroudly's logo in one colour, as make-mono.py makes it for
# Android's status bar. Apple's TabMark as tall as the system's symbols; Android's ic_tab_logo at 24 dp; the desktop's public/tab-mark.png.
# Run from the repo root: python3 scripts/logo/make-tab.py
import json, os
from PIL import Image, ImageFilter, ImageChops
mark = Image.open('apple/App/Assets.xcassets/Mark.imageset/mark.png').convert('RGBA')
s = mark.crop(mark.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox())
side = max(s.size)
sq = Image.new('RGBA', (side, side))
sq.alpha_composite(s, ((side - s.width) // 2, (side - s.height) // 2))
r, g, b, a = sq.split()
lit = b.point(lambda v: max(0, min(255, (v - 70) * 255 // 26)))
small = a.resize((512, 512), Image.LANCZOS).point(lambda v: 255 if v > 128 else 0)
inner = small
for _ in range(round(512 * 0.06)):
    inner = inner.filter(ImageFilter.MinFilter(3))
rim = ImageChops.subtract(small, inner).filter(ImageFilter.GaussianBlur(0.6)).resize(sq.size, Image.LANCZOS)
lit = ImageChops.lighter(lit, rim)
lit = lit.point(lambda v: 0 if v < 110 else min(255, (v - 110) * 255 // 60))
alpha = Image.composite(lit, Image.new('L', sq.size, 0), a.point(lambda v: 255 if v > 128 else v * 2))
mono = Image.new('RGBA', sq.size, (0, 0, 0, 0))
mono.putalpha(alpha)
out = 'apple/App/Assets.xcassets/TabMark.imageset'
os.makedirs(out, exist_ok=True)
for f in os.listdir(out):
    if f.endswith('.png'): os.remove(f'{out}/{f}')
images = []
# As tall as the system's symbols beside it: 28 pt in the iPhone's and iPad's
# bar, 16 in the Mac's sidebar, 46 in Apple TV's bar.
for idiom, pt, scales in (('universal', 28, (1, 2, 3)), ('mac', 16, (1, 2)), ('tv', 46, (1, 2))):
    for scale in scales:
        px = pt * scale
        icon = Image.new('RGBA', (px, px), (0, 0, 0, 0))
        inner = round(px * 27 / 28)
        icon.alpha_composite(mono.resize((inner, inner), Image.LANCZOS), ((px - inner) // 2, (px - inner) // 2))
        name = f'tabmark-{idiom}@{scale}x.png'
        icon.save(f'{out}/{name}')
        images.append({'filename': name, 'idiom': idiom, 'scale': f'{scale}x'})
json.dump({'images': images, 'info': {'author': 'xcode', 'version': 1}, 'properties': {'template-rendering-intent': 'template'}},
          open(f'{out}/Contents.json', 'w'), indent=2)

# Android: the bottom bar's 24 dp (Chrome.kt), tinted there.
for d, px in (('mdpi', 24), ('hdpi', 36), ('xhdpi', 48), ('xxhdpi', 72), ('xxxhdpi', 96)):
    icon = Image.new('RGBA', (px, px), (255, 255, 255, 0))
    inner = round(px * 21 / 24)
    white = Image.new('RGBA', (inner, inner), (255, 255, 255, 0))
    white.putalpha(mono.getchannel('A').resize((inner, inner), Image.LANCZOS))
    icon.alpha_composite(white, ((px - inner) // 2, (px - inner) // 2))
    icon.save(f'android/app/src/main/res/drawable-{d}/ic_tab_logo.png')
# The desktop: a mask over currentColor (components/icons.js), 4x its 24 px,
# within the 20 of 24 the Lucide icons beside it fill.
desk = Image.new('RGBA', (96, 96), (255, 255, 255, 0))
white = Image.new('RGBA', (80, 80), (255, 255, 255, 0))
white.putalpha(mono.getchannel('A').resize((80, 80), Image.LANCZOS))
desk.alpha_composite(white, (8, 8))
desk.save('public/tab-mark.png', optimize=True)
