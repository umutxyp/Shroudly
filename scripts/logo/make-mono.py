# Android's one-colour icons (the status bar, the Quick Settings tile, the
# themed launcher icon) from Shroudly's logo itself: its light parts (the
# shield's rim, the lid, the eye's ring and pupil) kept, its navy left out.
# Run from the repo root: python3 scripts/logo/make-mono.py /tmp/mark-open.png
import sys
from PIL import Image
mark = Image.open(sys.argv[1]).convert('RGBA')
box = mark.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
s = mark.crop(box)
side = max(s.size)
sq = Image.new('RGBA', (side, side))
sq.alpha_composite(s, ((side - s.width) // 2, (side - s.height) // 2))
r, g, b, a = sq.split()
# Blue above the navy (~65) shows, fully from ~96.
lit = b.point(lambda v: max(0, min(255, (v - 70) * 255 // 26)))
# The shield's rim, the same width all round: its gradient darkens towards
# the lower right, where the blue alone left the edge out.
from PIL import ImageFilter, ImageChops
small = a.resize((512, 512), Image.LANCZOS).point(lambda v: 255 if v > 128 else 0)
inner = small
for _ in range(round(512 * 0.052)):
    inner = inner.filter(ImageFilter.MinFilter(3))
rim = ImageChops.subtract(small, inner).filter(ImageFilter.GaussianBlur(0.6)).resize(sq.size, Image.LANCZOS)
lit = ImageChops.lighter(lit, rim)
# Clean edges: faint shading left out, the rest solid.
lit = lit.point(lambda v: 0 if v < 110 else min(255, (v - 110) * 255 // 60))
alpha = Image.composite(lit, Image.new('L', sq.size, 0), a.point(lambda v: 255 if v > 128 else v * 2))
mono = Image.new('RGBA', sq.size, (255, 255, 255, 0))
mono.putalpha(alpha)
res = 'android/app/src/main/res'
for d, px in (('mdpi', 24), ('hdpi', 36), ('xhdpi', 48), ('xxhdpi', 72), ('xxxhdpi', 96)):
    # 24 dp with 2 dp of air, as Android's status bar icons.
    icon = Image.new('RGBA', (px, px), (255, 255, 255, 0))
    inner = round(px * 20 / 24)
    icon.alpha_composite(mono.resize((inner, inner), Image.LANCZOS), ((px - inner) // 2, (px - inner) // 2))
    import os; os.makedirs(f'{res}/drawable-{d}', exist_ok=True)
    icon.save(f'{res}/drawable-{d}/ic_stat_logo.png')
# The themed launcher icon: 108 dp, the logo in the middle 48 dp.
L = Image.new('RGBA', (432, 432), (255, 255, 255, 0))
inner = 192
L.alpha_composite(mono.resize((inner, inner), Image.LANCZOS), ((432 - inner) // 2, (432 - inner) // 2))
L.save(f'{res}/drawable-nodpi/ic_launcher_mono_logo.png')
