"""Render the existing Satvey house mark for native icons (requires Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "apps/web"
OLIVE, CANVAS = "#4e5d43", "#f7f5ef"


def mark(size, foreground=False):
    scale = 4
    image = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0) if foreground else OLIVE)
    draw = ImageDraw.Draw(image)
    # Android adaptive foreground includes the platform's safe inset.
    factor = size * scale / (68 if foreground else 48)
    offset = (size * scale - 40 * factor) / 2
    for path in [[(11, 28), (11, 17), (20, 10), (29, 17), (29, 28)], [(16, 28), (16, 18), (20, 15), (24, 18), (24, 28)]]:
        draw.line([(offset + x * factor, offset + y * factor) for x, y in path], fill=CANVAS, width=max(1, round(1.8 * factor)), joint="curve")
    return image.resize((size, size), Image.Resampling.LANCZOS)


for folder, icon, foreground in [("mdpi", 48, 108), ("hdpi", 72, 162), ("xhdpi", 96, 216), ("xxhdpi", 144, 324), ("xxxhdpi", 192, 432)]:
    directory = ROOT / f"android/app/src/main/res/mipmap-{folder}"
    for name in ["ic_launcher.png", "ic_launcher_round.png"]:
        mark(icon).save(directory / name)
    mark(foreground, True).save(directory / "ic_launcher_foreground.png")

mark(1024).convert("RGB").save(ROOT / "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")
for path in list((ROOT / "android/app/src/main/res").glob("drawable*/splash.png")) + list((ROOT / "ios/App/App/Assets.xcassets/Splash.imageset").glob("*.png")):
    with Image.open(path) as old:
        dimensions = old.size
    image = Image.new("RGB", dimensions, CANVAS)
    size = max(64, round(min(dimensions) * .16))
    logo = mark(size).convert("RGB")
    image.paste(logo, ((dimensions[0] - size) // 2, (dimensions[1] - size) // 2))
    image.save(path)
