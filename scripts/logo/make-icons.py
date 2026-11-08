# The desktop's tray and menu bar icons from Shroudly's logo, exactly as at
# the window's top left: the logo while protection is on, the same logo with
# its eye shut and in grey (logo-closed.py) while off. Run from the repo root:
#   python3 scripts/logo/logo-closed.py apple/App/AppIcon.icon/Assets/shield.png \
#       /tmp/shield-closed.png /tmp/mark-open.png /tmp/mark-closed.png \
#       /tmp/mark-closed-grey.png
#   python3 scripts/logo/make-icons.py /tmp/mark-open.png /tmp/mark-closed-grey.png
import sys
from PIL import Image
open_, closed = (Image.open(f).convert('RGBA') for f in sys.argv[1:3])

def fit(img, px):
    # The shield fills the square (its own margin is trimmed first).
    box = img.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    s = img.crop(box)
    side = max(s.size)
    sq = Image.new('RGBA', (side, side))
    sq.alpha_composite(s, ((side - s.width) // 2, (side - s.height) // 2))
    return sq.resize((px, px), Image.LANCZOS)

for name, img in (('on', open_), ('off', closed)):
    # macOS menu bar (18 pt) and Linux, @2x and @3x picked up by Electron.
    fit(img, 18).save(f'public/tray-{name}.png')
    fit(img, 36).save(f'public/tray-{name}@2x.png')
    fit(img, 54).save(f'public/tray-{name}@3x.png')
    # Windows' notification area, every size a display scale asks for.
    sizes = [16, 20, 24, 32, 40, 48, 64]
    big = fit(img, 256)
    big.save(f'public/tray-{name}.ico', sizes=[(s, s) for s in sizes])
