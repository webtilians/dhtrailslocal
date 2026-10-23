"""The app's launcher icons and splash screens for Android, from the web app's icons.
Usage (from movil/): python iconos.py"""
from pathlib import Path

from PIL import Image

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
print("iconos listos")
