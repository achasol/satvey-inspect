"""Check structured inspection results in an actual Gotenberg/Chromium PDF."""
import re
import sys
from pathlib import Path

import pymupdf

path = Path(sys.argv[1])
doc = pymupdf.open(path)
text = "\n".join(page.get_text() for page in doc)
assert "Inspectieformat" in text and "Wandkwaliteit" in text
assert "Acceptabel" in text and "Formatstraat 42" in text
assert "F01" in text and "Bronfoto" in text
assert "file:///" not in text and "meta-models" not in text
outline = doc.get_toc()
assert outline[0][1] == "Inspectierapport"
assert any(level == 3 and "Keuken" in title for level, title, _ in outline)
assert doc.xref_get_key(doc.pdf_catalog(), "StructTreeRoot")[0] != "null"
assert any(page.get_images() for page in doc)
assert any(page.get_links() for page in doc)
for level, title, page in outline:
    assert title in doc[page - 1].get_text().replace("\n", " ")
for number, page in enumerate(doc, 1):
    assert abs(page.rect.width - 595.28) < 1 and abs(page.rect.height - 841.89) < 1
    assert re.search(rf"Pagina\s+{number}\s+van\s+{len(doc)}", page.get_text())
    for x0, y0, x1, y1, word, *_ in page.get_text("words"):
        assert x0 >= 30 and x1 <= page.rect.width - 30, (number, word)
        assert y0 >= 5 and y1 <= page.rect.height - 5, (number, word)
    for link in page.get_links():
        assert link["kind"] in (pymupdf.LINK_GOTO, pymupdf.LINK_NAMED)
        assert 0 <= link["page"] < len(doc)
    page.get_pixmap(matrix=pymupdf.Matrix(1.2, 1.2)).save(
        path.with_name(f"{path.stem}-page-{number}.png")
    )
print(f"Structured report: {len(doc)} pages, {len(outline)} bookmarks; layout and evidence links valid")
