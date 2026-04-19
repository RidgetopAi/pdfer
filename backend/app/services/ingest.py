"""Stage 0 — Ingest pipeline.

Renders page images via PyMuPDF, extracts text_spans, classifies PDF type per page.
"""
import hashlib
import re
import uuid
from pathlib import Path

import fitz
from PIL import Image

from app.config import PAGE_DPI, THUMB_WIDTH, PAGES_DIR


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def render_page(page: fitz.Page, dpi: int = PAGE_DPI) -> tuple[Image.Image, int, int]:
    pix = page.get_pixmap(dpi=dpi, alpha=False)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    return img, pix.width, pix.height


def save_page_image(img: Image.Image, doc_id: str, page_num: int) -> tuple[str, str]:
    page_dir = PAGES_DIR / doc_id
    page_dir.mkdir(parents=True, exist_ok=True)

    image_path = page_dir / f"page_{page_num:04d}.png"
    img.save(image_path, "PNG")

    thumb_path = page_dir / f"page_{page_num:04d}_thumb.webp"
    ratio = THUMB_WIDTH / img.width
    thumb = img.resize((THUMB_WIDTH, int(img.height * ratio)), Image.LANCZOS)
    thumb.save(thumb_path, "WEBP", quality=80)

    return str(image_path), str(thumb_path)


# Regex for "garbage" characters: non-ASCII, non-whitespace, non-common-punctuation
_GARBAGE_RE = re.compile(r"[^\x20-\x7E\t\n\r\u00A0-\u00FF\u2000-\u206F\u2018-\u201F\u2013\u2014\u2026]")


def classify_pdf_type(page: fitz.Page) -> str:
    """Classify a page's PDF type based on text content analysis.

    Returns one of: born-digital-clean, born-digital-corrupt, scanned-with-ocr, scanned-no-ocr
    """
    text = page.get_text("text")
    char_count = len(text.strip())

    if char_count < 20:
        return "scanned-no-ocr"

    garbage_chars = len(_GARBAGE_RE.findall(text))
    total_chars = max(len(text), 1)
    garbage_ratio = garbage_chars / total_chars

    if char_count < 200 and garbage_ratio < 0.1:
        return "scanned-with-ocr"

    if garbage_ratio > 0.3:
        return "born-digital-corrupt"

    return "born-digital-clean"


def extract_text_spans(page: fitz.Page) -> list[dict]:
    """Extract text spans with font metadata and bounding boxes.

    Returns spans in PDF coordinate space (origin bottom-left, points).
    """
    spans = []
    blocks = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE)["blocks"]

    for block in blocks:
        if block.get("type") != 0:  # text block
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span.get("text", "").strip()
                if not text:
                    continue

                bbox = span["bbox"]  # (x0, y0, x1, y1) in PDF coords
                flags = span.get("flags", 0)
                is_bold = bool(flags & (1 << 4))  # bit 4 = bold
                is_italic = bool(flags & (1 << 1))  # bit 1 = italic
                color_int = span.get("color", 0)
                color_hex = f"#{color_int:06X}"

                spans.append({
                    "text": text,
                    "x1": bbox[0],
                    "y1": bbox[1],
                    "x2": bbox[2],
                    "y2": bbox[3],
                    "font_name": span.get("font", ""),
                    "font_size": span.get("size", 0.0),
                    "is_bold": int(is_bold),
                    "is_italic": int(is_italic),
                    "color": color_hex,
                })

    return spans


async def ingest_document(db, doc_id: str, pdf_path: Path) -> int:
    """Run Stage 0 ingest on a document. Returns page count."""
    doc = fitz.open(str(pdf_path))
    page_count = len(doc)

    await db.execute(
        "UPDATE documents SET stage_status='running', page_count=? WHERE id=?",
        (page_count, doc_id),
    )
    await db.commit()

    for page_num in range(page_count):
        page = doc[page_num]
        page_id = str(uuid.uuid4())

        # Render
        img, w, h = render_page(page)
        image_path, thumb_path = save_page_image(img, doc_id, page_num)

        # Classify
        pdf_type = classify_pdf_type(page)

        # Insert page
        await db.execute(
            """INSERT INTO pages (id, document_id, page_number, image_path, thumb_path,
               width_px, height_px, dpi, pdf_type)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (page_id, doc_id, page_num, image_path, thumb_path, w, h, PAGE_DPI, pdf_type),
        )

        # Extract and insert text spans
        spans = extract_text_spans(page)
        for span in spans:
            await db.execute(
                """INSERT INTO text_spans (page_id, text, x1, y1, x2, y2,
                   font_name, font_size, is_bold, is_italic, color)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (page_id, span["text"], span["x1"], span["y1"], span["x2"], span["y2"],
                 span["font_name"], span["font_size"], span["is_bold"], span["is_italic"],
                 span["color"]),
            )

    await db.execute(
        "UPDATE documents SET current_stage=0, stage_status='complete' WHERE id=?",
        (doc_id,),
    )
    await db.commit()
    doc.close()

    return page_count
