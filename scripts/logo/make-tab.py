# The Protection tab's icon on iPhone, iPad and the Mac (the system's tab bar
# and sidebar tint it): Shroudly's logo in one colour, as make-mono.py makes
# it for Android, at the tab bar's 25 pt with a point of air.
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
images = []
for scale in (1, 2, 3):
    px = 25 * scale
    icon = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    inner = round(px * 23 / 25)
    icon.alpha_composite(mono.resize((inner, inner), Image.LANCZOS), ((px - inner) // 2, (px - inner) // 2))
    name = f'tabmark@{scale}x.png' if scale > 1 else 'tabmark.png'
    icon.save(f'{out}/{name}')
    images.append({'filename': name, 'idiom': 'universal', 'scale': f'{scale}x'})
json.dump({'images': images, 'info': {'author': 'xcode', 'version': 1}, 'properties': {'template-rendering-intent': 'template'}},
          open(f'{out}/Contents.json', 'w'), indent=2)
