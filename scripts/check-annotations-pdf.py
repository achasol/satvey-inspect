"""Verify annotation geometry survives the real Chromium PDF pipeline."""
from pathlib import Path
import sys
import pymupdf

path = Path(sys.argv[1])
doc = pymupdf.open(path)
found = False
for number, page in enumerate(doc, 1):
    drawings = page.get_drawings()
    red = [d for d in drawings if d.get("color") and d["color"][0] > .7 and d["color"][1] < .25]
    blue = [d for d in drawings if d.get("color") and d["color"][2] > .7 and d["color"][0] < .25]
    if not red:
        continue
    assert blue, "Missing circle annotation"
    source = page.get_image_info()[0]
    image = pymupdf.Rect(source["bbox"])
    expected = pymupdf.Rect(image.x0 + image.width * .1, image.y0 + image.height * .2,
                           image.x0 + image.width * .7, image.y0 + image.height * .6)
    actual = red[0]["rect"]
    assert max(abs(a - b) for a, b in zip(expected, actual)) < 1, (expected, actual)
    expected_circle = pymupdf.Rect(image.x0 + image.width * .5, image.y0 + image.height * .4,
                                  image.x0 + image.width * .8, image.y0 + image.height * .8)
    assert max(abs(a - b) for a, b in zip(expected_circle, blue[0]["rect"])) < 1
    page.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5)).save(path.with_name(f"report-annotated-page-{number}.png"))
    found = True
assert found, "No photo annotations rendered in PDF"
assert doc.get_toc(), "Missing report outline"
print(f"Annotated PDF: {len(doc)} pages; arrow and circle align with source pixels within 1 point")
