"""The app's launcher icons and splash screens for Android and iPhone, from the web app's icons (and, for
the iPhone's 1024 px icon, the same drawing as them: Arial Black, Windows).
Usage (from movil/): python iconos.py"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
WEB = ROOT.parent
RES = ROOT / "android/app/src/main/res"
INK = (7, 20, 35, 255)                   # #071423, the app's background
icon = Image.open(WEB / "icon-512.png").convert("RGBA")
maskable = Image.open(WEB / "icon-maskable-512.png").convert("RGBA")

# Launcher icons (48 dp) and the adaptive icon's foreground (108 dp, of which a launcher shows the middle
# 72 dp): the maskable icon keeps what matters within its middle 80 %, so it fills 72/0.8 = 90 dp of it.
for folder, scale in {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}.items():
    out = RES / f"mipmap-{folder}"
    size = round(48 * scale)
    icon.resize((size, size), Image.LANCZOS).save(out / "ic_launcher.png")
    round_icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    disc = Image.new("L", (size * 4, size * 4), 0)
    from PIL import ImageDraw
    ImageDraw.Draw(disc).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    round_icon.paste(maskable.resize((size, size), Image.LANCZOS), (0, 0), disc.resize((size, size), Image.LANCZOS))
    round_icon.save(out / "ic_launcher_round.png")
    canvas = round(108 * scale)
    art = round(90 * scale)
    fore = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    fore.paste(maskable.resize((art, art), Image.LANCZOS), ((canvas - art) // 2, (canvas - art) // 2))
    fore.save(out / "ic_launcher_foreground.png")

(RES / "values/ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#071423</color>\n</resources>\n',
    encoding="utf-8")

# Splash screens: the icon in the middle of the app's background, the size each one already has.
for splash in RES.glob("drawable*/splash.png"):
    w, h = Image.open(splash).size
    side = round(min(w, h) * 0.32)
    screen = Image.new("RGBA", (w, h), INK)
    screen.paste(icon.resize((side, side), Image.LANCZOS), ((w - side) // 2, (h - side) // 2))
    screen.convert("RGB").save(splash)
# iPhone: one 1024 px icon without transparency (the App Store refuses one with it), and the splash: the
# icon on the app's background, at the size Capacitor's template has.
NAVY, WHITE, BLUE, DARK = (7, 20, 35), (255, 255, 255), (42, 168, 255), (4, 16, 27)
FONT = "C:/Windows/Fonts/ariblk.ttf"


def icon(size, content=0.78):
    """content: share of the side the drawing may use (smaller for maskable icons)."""
    big = size * 4  # drawn large and scaled down, for smooth edges
    img = Image.new("RGB", (big, big), NAVY)
    box = big * content
    # The letters, on their own layer to lean them like the site's logo.
    font = ImageFont.truetype(FONT, int(box * 0.52))
    text = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(text)
    l, t, r, b = d.textbbox((0, 0), "DH", font=font)
    d.text(((big - (r - l)) / 2 - l, big * 0.44 - (b - t) / 2 - t), "DH", font=font, fill=255)
    lean = 0.21  # about 12 degrees
    text = text.transform((big, big), Image.AFFINE, (1, lean, -lean * big * 0.44, 0, 1, 0), resample=Image.BICUBIC)
    img.paste(WHITE, (0, 0), text)
    # A blue underline, then the chequered finish strip: two rows of squares.
    d = ImageDraw.Draw(img)
    width = box * 0.74
    x0, y0 = (big - width) / 2, big * 0.44 + box * 0.22
    d.rectangle([x0, y0, x0 + width, y0 + box * 0.035], fill=BLUE)
    cells, rows = 10, 2
    side = width / cells
    y1 = y0 + box * 0.075
    for row in range(rows):
        for col in range(cells):
            colour = WHITE if (row + col) % 2 == 0 else DARK
            d.rectangle([x0 + col * side, y1 + row * side, x0 + (col + 1) * side, y1 + (row + 1) * side], fill=colour)
    return img.resize((size, size), Image.LANCZOS)


IOS = ROOT / "ios/App/App/Assets.xcassets"
icon(1024).save(IOS / "AppIcon.appiconset/AppIcon-512@2x.png", optimize=True)
for splash in (IOS / "Splash.imageset").glob("*.png"):
    w, h = Image.open(splash).size
    side = round(min(w, h) * 0.18)
    screen = Image.new("RGB", (w, h), INK[:3])
    screen.paste(icon(side), ((w - side) // 2, (h - side) // 2))
    screen.save(splash, optimize=True)
print("iconos listos")
