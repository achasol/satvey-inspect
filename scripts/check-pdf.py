"""Check actual server-generated PDFs, their outline, geometry and embedded content."""
import json
import re
import sys
from pathlib import Path
import pymupdf

for filename in sys.argv[1:]:
    path = Path(filename)
    document = pymupdf.open(path)
    outline = document.get_toc()
    for index in sorted(set(range(min(3, len(document)))) | {len(document) - 1}):
        document[index].get_pixmap(matrix=pymupdf.Matrix(1.35, 1.35)).save(path.with_name(f"{path.stem}-page-{index + 1}.png"))
    assert outline and outline[0][1] == "Inspectierapport", outline
    assert any(level == 2 and title == "1. Overzicht" for level, title, page in outline), outline
    assert any(level == 2 and title == "2. Bevindingen per ruimte" for level, title, page in outline), outline
    assert any(level == 3 and "Badkamer" in title for level, title, page in outline), outline
    for index, (level, title, page) in enumerate(outline):
        assert 1 <= page <= len(document), (title, page)
        assert index == 0 or level <= outline[index - 1][0] + 1, outline
        # Bookmark destinations must point at pages that actually contain their headings.
        assert title in document[page - 1].get_text().replace("\n", " "), (title, page)

    all_text = "\n".join(page.get_text() for page in document)
    assert "Lindelaan 42" in all_text and "Woningcorporatie Voorbeeld" in all_text
    assert "Lekkage bij de wastafelkraan" in all_text
    assert "Niet acceptabel" in all_text
    assert "F01" in all_text
    assert "file:///" not in all_text and "http://" not in all_text
    fonts = {font[3] for page in document for font in page.get_fonts()}
    assert any("DMSans" in font.replace("-", "") for font in fonts), fonts
    assert any(page.get_images() for page in document), "Missing source photograph"
    assert any(page.get_links() for page in document), "Missing internal navigation"
    assert document.xref_get_key(document.pdf_catalog(), "StructTreeRoot")[0] != "null", "Missing PDF structure tags"
    total = len(document)
    for number, page in enumerate(document, 1):
        assert abs(page.rect.width - 595.28) < 1 and abs(page.rect.height - 841.89) < 1, page.rect
        words = page.get_text("words")
        text = page.get_text()
        assert re.search(rf"Pagina\s+{number}\s+van\s+{total}", text), (number, text[-200:])
        assert "INSPECTIERAPPORT" in text, f"Missing running header on page {number}"
        # Header and footer are outside the body margins; all text must remain on paper.
        for x0, y0, x1, y1, word, *_ in words:
            assert x0 >= 30 and x1 <= page.rect.width - 30, (number, word, x0, x1)
            assert y0 >= 5 and y1 <= page.rect.height - 5, (number, word, y0, y1)
        for image in page.get_image_info():
            rectangle = pymupdf.Rect(image["bbox"])
            assert rectangle.x0 >= 45 and rectangle.x1 <= page.rect.width - 45, (number, rectangle)
            assert rectangle.y0 >= 50 and rectangle.y1 <= page.rect.height - 50, (number, rectangle)
            assert abs(rectangle.width / rectangle.height - image["width"] / image["height"]) < 0.03, ("distorted photo", number, image)
        for link in page.get_links():
            assert link["kind"] in (pymupdf.LINK_GOTO, pymupdf.LINK_NAMED) and 0 <= link["page"] < total, ("broken internal link", number, link)
        assert len(words) > 10, f"Blank page {number}"
        if "draft" in path.stem:
            assert "CONCEPT" in text, f"Draft status missing on page {number}"
        else:
            assert "CONCEPT" not in text, f"Draft label leaked into final page {number}"
    if "long" in path.stem:
        assert total >= 5, f"Long fixture did not exercise pagination: {total}"
        assert "EINDE-CONTROLE-98765" in all_text, "Final finding text was truncated"
        assert sum(len(page.get_image_info()) for page in document) == 4, "Missing portrait/landscape source photos"
        for room in ["Badkamer", "Keuken", "Woonkamer", "Slaapkamer", "Entree", "Buitenruimte"]:
            assert any(level == 3 and room in title for level, title, page in outline), room
    print(json.dumps({"file": path.name, "pages": total, "bookmarks": len(outline), "fonts": sorted(fonts)}, ensure_ascii=False))
