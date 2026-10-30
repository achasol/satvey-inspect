"""Create static PDF fonts from the app's OFL-licensed variable font.

Run only when updating the font, in a container with fonttools and brotli.
Static TrueType avoids variable-font Type 3 output in Chromium PDF exports.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

assets = Path("/workspace/apps/api/internal/app/report_assets")
for name, weight in [("regular", 400), ("semibold", 600), ("bold", 700)]:
    font = TTFont(assets / "dm-sans.woff2")
    axes = {axis.axisTag: axis.defaultValue for axis in font["fvar"].axes}
    axes["wght"] = weight
    instantiateVariableFont(font, axes, inplace=True, updateFontNames=True)
    font.flavor = None
    font.save(assets / f"dm-sans-{name}.ttf")
