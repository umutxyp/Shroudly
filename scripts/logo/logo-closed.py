# Shroudly's logo with its eye shut: the original icon.png, the eye covered
# with the shield's own navy, and a shut lid with lashes in the logo's blue.
import sys
from PIL import Image, ImageDraw, ImageFilter
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
W = im.width; S = 4
# Drawn in public/icon.png's coordinates (512, its shield at 93,73 to 420,431),
# moved onto this file's shield.
bx0, by0, bx1, by1 = im.getchannel('A').point(lambda a: 255 if a > 20 else 0).getbbox()
k = (bx1 - bx0) / 327.0
def mx(x): return bx0 + (x - 93) * k
def my(y): return by0 + (y - 73) * k
def P(x, y): return (mx(x) * S, my(y) * S)
def bez(p0, c1, c2, p3, n=80):
    pts = []
    for i in range(n + 1):
        t = i / n; u = 1 - t
        pts.append((u**3*p0[0]+3*u*u*t*c1[0]+3*u*t*t*c2[0]+t**3*p3[0], u**3*p0[1]+3*u*u*t*c1[1]+3*u*t*t*c2[1]+t**3*p3[1]))
    return pts
big = (W * S, W * S)
# 1. the eye's area, filled with the navy round it
lens = bez((168, 252), (205, 190), (307, 190), (344, 252)) + bez((344, 252), (307, 312), (205, 312), (168, 252))[1:]
m = Image.new('L', big, 0)
ImageDraw.Draw(m).polygon([P(*p) for p in lens], fill=255)
m = m.resize((W, W), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.8 * k))
navy = Image.new('RGBA', (W, W))
nd = ImageDraw.Draw(navy)
for y in range(W):
    t = min(1, max(0, ((y - by0) / k + 73 - 190) / 120))
    c = (round(2 + t), round(27 - 3 * t), round(67 - 8 * t), 255)
    nd.line([(0, y), (W, y)], fill=c)
im = Image.composite(navy, im, m)
# 2. the shut lid, a crescent as the logo's lower lid, and its lashes
top = bez((176, 249), (212, 274), (300, 274), (336, 249))
bot = bez((336, 249), (302, 293), (210, 293), (176, 249))
L = Image.new('L', big, 0)
d = ImageDraw.Draw(L)
d.polygon([P(*p) for p in top + bot[1:]], fill=255)
for (x0, y0, x1, y1) in ((221, 280, 213, 297), (256, 285, 256, 303), (291, 280, 299, 297)):
    lw = 10 * k * S
    d.line([P(x0, y0), P(x1, y1)], fill=255, width=round(lw))
    for (x, y) in ((x0, y0), (x1, y1)):
        X, Y = P(x, y); d.ellipse([X - lw/2, Y - lw/2, X + lw/2, Y + lw/2], fill=255)
L = L.resize((W, W), Image.LANCZOS)
blue = Image.new('RGBA', (W, W))
bd = ImageDraw.Draw(blue)
for y in range(W):
    t = min(1, max(0, ((y - by0) / k + 73 - 250) / 55))
    c = (round(15 - 3 * t), round(94 - 34 * t), round(208 - 61 * t), 255)
    bd.line([(0, y), (W, y)], fill=c)
im = Image.composite(blue, im, L)
im.save(out)

# A square of the shield alone, a little margin round it (mark files).
if len(sys.argv) > 3:
    side = round(max(bx1 - bx0, by1 - by0) * 1.04)
    cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
    box = (round(cx - side / 2), round(cy - side / 2), round(cx - side / 2) + side, round(cy - side / 2) + side)
    for f, img in ((sys.argv[3], Image.open(src).convert('RGBA')), (sys.argv[4], im)):
        img.crop(box).resize((1024, 1024), Image.LANCZOS).save(f)

# The shut logo in grey, lightened so its navy still shows on a dark
# background (the app's orb while off, and the tray): as a fifth argument.
if len(sys.argv) > 5:
    shut = Image.open(sys.argv[4]).convert('RGBA')
    r, g, b, a = shut.split()
    lum = Image.merge('RGB', (r, g, b)).convert('L').point(lambda v: min(255, round(30 + v * 1.25)))
    grey = Image.merge('RGBA', (lum, lum, lum, a))
    grey.save(sys.argv[5])
