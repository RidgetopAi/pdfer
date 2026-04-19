"""Stage 3 — Extraction pipeline (deterministic, post-review).

The heavy lifting (Gemma inference, figure asset cropping) happens in Stage 1.5
(describe.py), BEFORE the human reviews objects. By the time we get here,
every object already has either:

  - object.description = Gemma's read (possibly edited by the human)
  - object.asset_path = cropped PNG (for figures)

So this stage is pure routing: pdfplumber output when the trigger gate says
pdfplumber is good enough, the human-validated description otherwise.

Routing by label:
  - watermark         → skip
  - figure            → asset_path + description (so assembly can embed both)
  - table             → pdfplumber-table if quality passes; else description
  - formula           → description (Gemma's LaTeX is canonical)
  - text labels       → pdfplumber-clip if trigger gate passes; else description

Every confirmed object gets exactly one extraction row. A row is a placeholder
only when BOTH pdfplumber and description are unavailable.
"""
import json
import logging
import time
import uuid

import aiosqlite
import pdfplumber

from app.config import PAGE_DPI
from app.services.gemma import is_prose_shaped, is_table_shaped

logger = logging.getLogger(__name__)


LABEL_TO_CONTENT_TYPE = {
    "title": "text",
    "section_heading": "text",
    "paragraph": "text",
    "caption": "text",
    "footnote": "text",
    "page_header": "text",
    "page_footer": "text",
    "list": "text",
    "table": "markdown_table",
    "figure": "image_ref",
    "formula": "formula_latex",
    "watermark": "text",
}

TEXT_LABELS = {
    "title", "section_heading", "paragraph", "caption",
    "footnote", "page_header", "page_footer", "list",
}


def _pixel_to_pdf_bbox(bbox_px: dict, page_height_px: int, dpi: int = PAGE_DPI) -> tuple:
    """Convert pixel-space bbox (top-left origin) to PDF-space bbox."""
    scale = 72.0 / dpi
    x0 = bbox_px["bbox_x1"] * scale
    x1 = bbox_px["bbox_x2"] * scale
    y0 = bbox_px["bbox_y1"] * scale
    y1 = bbox_px["bbox_y2"] * scale
    return (x0, y0, x1, y1)


def _extract_text_clip(pdf_page, bbox_pdf: tuple) -> str:
    """Extract text using pdfplumber.crop (not within_bbox — see 2026-04-18 fix)."""
    PAD = 2.0
    x0, y0, x1, y1 = bbox_pdf
    padded = (
        max(0.0, x0 - PAD),
        max(0.0, y0 - PAD),
        min(pdf_page.width, x1 + PAD),
        min(pdf_page.height, y1 + PAD),
    )
    cropped = pdf_page.crop(padded, strict=False)
    text = cropped.extract_text() or ""
    return text.strip()


def _extract_table(pdf_page, bbox_pdf: tuple) -> tuple[str, dict]:
    """Extract a table with quality validation."""
    cropped = pdf_page.within_bbox(bbox_pdf, strict=False)
    tables = cropped.find_tables()

    if not tables:
        return "", {"quality_passed": False, "reason": "no_tables_found"}

    table = tables[0]
    rows = table.extract()

    if not rows:
        return "", {"quality_passed": False, "reason": "empty_table"}

    num_rows = len(rows)
    num_cols = max(len(row) for row in rows) if rows else 0

    if num_rows < 2 or num_cols < 2:
        return "", {
            "quality_passed": False,
            "reason": f"too_small ({num_rows}x{num_cols})",
            "rows": num_rows, "cols": num_cols,
        }

    total_cells = sum(len(row) for row in rows)
    empty_cells = sum(1 for row in rows for cell in row if not cell or not cell.strip())
    empty_ratio = empty_cells / max(total_cells, 1)

    if empty_ratio > 0.4:
        return "", {
            "quality_passed": False,
            "reason": f"too_many_empty_cells ({empty_ratio:.0%})",
            "empty_ratio": empty_ratio,
        }

    def escape_cell(cell):
        if cell is None:
            return ""
        return cell.strip().replace("|", "\\|").replace("\n", " ")

    md_rows = []
    for i, row in enumerate(rows):
        cells = [escape_cell(c) for c in row]
        while len(cells) < num_cols:
            cells.append("")
        md_rows.append("| " + " | ".join(cells) + " |")
        if i == 0:
            md_rows.append("| " + " | ".join(["---"] * num_cols) + " |")

    md_table = "\n".join(md_rows)
    return md_table, {
        "quality_passed": True,
        "rows": num_rows, "cols": num_cols, "empty_ratio": empty_ratio,
    }


def _check_text_span_coverage(text_spans: list[dict], bbox_px: dict, dpi: int = PAGE_DPI) -> float:
    """Fraction of object bbox covered by text_spans (same-space coords)."""
    if not text_spans:
        return 0.0

    scale = 72.0 / dpi
    obj_x1 = bbox_px["bbox_x1"] * scale
    obj_y1 = bbox_px["bbox_y1"] * scale
    obj_x2 = bbox_px["bbox_x2"] * scale
    obj_y2 = bbox_px["bbox_y2"] * scale
    obj_area = max((obj_x2 - obj_x1) * (obj_y2 - obj_y1), 1.0)

    covered_area = 0.0
    for span in text_spans:
        ix1 = max(span["x1"], obj_x1)
        iy1 = max(span["y1"], obj_y1)
        ix2 = min(span["x2"], obj_x2)
        iy2 = min(span["y2"], obj_y2)
        if ix2 > ix1 and iy2 > iy1:
            covered_area += (ix2 - ix1) * (iy2 - iy1)

    return min(covered_area / obj_area, 1.0)


def _should_prefer_description(
    label: str,
    pdf_type: str,
    pdfplumber_output: str,
    text_span_coverage: float,
    text_spans_exist: bool,
    description: str | None,
) -> tuple[bool, str]:
    """Patch v2 Change 7 trigger gate, adapted for the pre-describe flow.

    Before: decides whether to *call* Gemma.
    Now: decides whether to *prefer* the pre-computed description over
    pdfplumber's output. Returns (prefer_description, reason).
    """
    # No description to prefer — always fall back to pdfplumber
    if not description or not description.strip():
        return False, "no_description_available"

    # Labels where Gemma wins by default
    if label in ("formula", "figure"):
        return True, f"label={label}_llm_wins"

    # Primary extractor empty → description is the only signal
    if not pdfplumber_output or len(pdfplumber_output.strip()) < 5:
        return True, "pdfplumber_empty"

    # Scanned pages → description is the only real signal
    if pdf_type == "scanned-no-ocr":
        return True, "scanned_no_ocr"

    if pdf_type == "born-digital-corrupt" and text_span_coverage < 0.5:
        return True, "corrupt_low_coverage"

    # For text labels, trust pdfplumber when text_spans fully cover the object
    if label in TEXT_LABELS:
        if text_spans_exist and text_span_coverage >= 0.95 and is_prose_shaped(pdfplumber_output):
            return False, "good_text_coverage_and_prose"
        if text_span_coverage < 0.5:
            return True, "low_text_span_coverage"

    if label == "table":
        if is_table_shaped(pdfplumber_output) or "|" in (pdfplumber_output or ""):
            return False, "table_quality_ok"
        return True, "table_quality_failed"

    # Default: trust pdfplumber output when it looks acceptable
    if pdfplumber_output and len(pdfplumber_output.strip()) >= 5:
        return False, "pdfplumber_output_acceptable"

    return True, "fallback_to_description"


async def extract_document(
    db: aiosqlite.Connection,
    doc_id: str,
    broadcast_fn=None,
    use_llm: bool = True,
) -> dict:
    """Run Stage 3 extraction on all confirmed objects.

    `use_llm` parameter retained for API compatibility. In the pre-describe
    flow, it means "prefer the description over pdfplumber when the gate is
    ambiguous." When False, pdfplumber output is preferred and description
    used only as last-resort fallback.
    """
    doc_rows = await db.execute_fetchall(
        "SELECT current_stage, stage_status, file_path FROM documents WHERE id=?",
        (doc_id,),
    )
    if not doc_rows:
        raise ValueError("Document not found")

    current_stage = doc_rows[0][0]
    file_path = doc_rows[0][2]

    if current_stage < 1:
        raise ValueError("Document must be detected (stage >= 1) before extraction")

    unreviewed_rows = await db.execute_fetchall(
        """SELECT COUNT(*) FROM objects o
           JOIN pages p ON o.page_id = p.id
           WHERE p.document_id = ? AND o.status = 'unreviewed'""",
        (doc_id,),
    )
    unreviewed_count = unreviewed_rows[0][0]
    if unreviewed_count > 0:
        raise ValueError(
            f"Cannot extract: {unreviewed_count} unreviewed objects remain. "
            "All objects must be confirmed or rejected before extraction."
        )

    await db.execute(
        "UPDATE documents SET current_stage=2, stage_status='running' WHERE id=?",
        (doc_id,),
    )
    await db.commit()

    # Clear prior extractions to keep the invariant (one row per confirmed object)
    await db.execute(
        """DELETE FROM extractions WHERE object_id IN
           (SELECT o.id FROM objects o
            JOIN pages p ON o.page_id = p.id
            WHERE p.document_id = ?)""",
        (doc_id,),
    )
    await db.commit()

    obj_rows = await db.execute_fetchall(
        """SELECT o.id, o.page_id, o.label,
                  o.bbox_x1, o.bbox_y1, o.bbox_x2, o.bbox_y2,
                  o.confidence, o.reading_order, o.heading_level,
                  p.page_number, p.pdf_type, p.image_path, p.width_px, p.height_px,
                  o.description, o.asset_path, o.description_edited_by_user
           FROM objects o
           JOIN pages p ON o.page_id = p.id
           WHERE p.document_id = ? AND o.status = 'confirmed'
           ORDER BY p.page_number, o.reading_order""",
        (doc_id,),
    )

    if not obj_rows:
        await db.execute(
            "UPDATE documents SET current_stage=2, stage_status='complete' WHERE id=?",
            (doc_id,),
        )
        await db.commit()
        return {"total_extracted": 0, "extractions": []}

    pdf = pdfplumber.open(file_path)

    results = []
    extraction_count = 0

    for row in obj_rows:
        obj_id = row[0]
        page_id = row[1]
        label = row[2]
        bbox_px = {
            "bbox_x1": row[3], "bbox_y1": row[4],
            "bbox_x2": row[5], "bbox_y2": row[6],
        }
        confidence = row[7]
        page_number = row[10]
        pdf_type = row[11]
        page_height_px = row[14]
        description = row[15]
        asset_path = row[16]
        description_edited = bool(row[17])

        content_type = LABEL_TO_CONTENT_TYPE.get(label, "text")
        extractor = "unknown"
        content = None
        extraction_metadata = {
            "description_edited_by_user": description_edited,
            "had_description": bool(description),
        }

        try:
            span_rows = await db.execute_fetchall(
                "SELECT text, x1, y1, x2, y2 FROM text_spans WHERE page_id=?",
                (page_id,),
            )
            text_spans = [{"text": s[0], "x1": s[1], "y1": s[2], "x2": s[3], "y2": s[4]} for s in span_rows]
            text_span_coverage = _check_text_span_coverage(text_spans, bbox_px)

            bbox_pdf = _pixel_to_pdf_bbox(bbox_px, page_height_px)
            plumber_page = pdf.pages[page_number]

            if label == "watermark":
                content = ""
                content_type = "text"
                extractor = "skip"
                extraction_metadata["reason"] = "watermark_skipped"

            elif label == "figure":
                # Asset already saved by describe.py; just reference it.
                # Fall back to a re-crop if somehow it's missing (legacy docs).
                if not asset_path:
                    from app.services.gemma import save_figure_asset
                    asset_path = save_figure_asset(
                        row[12], bbox_px, doc_id, obj_id,
                    )
                content = asset_path
                content_type = "image_ref"
                extractor = "figure-crop"
                extraction_metadata["asset_path"] = asset_path
                if description:
                    extraction_metadata["description"] = description

            elif label == "table":
                md_table, table_meta = _extract_table(plumber_page, bbox_pdf)
                extraction_metadata["pdfplumber_table"] = table_meta

                if table_meta.get("quality_passed"):
                    content = md_table
                    content_type = "markdown_table"
                    extractor = "pdfplumber-table"
                elif use_llm and description:
                    content = description
                    content_type = "markdown_table"
                    extractor = "gemma-e4b-prereview"
                else:
                    raw_text = _extract_text_clip(plumber_page, bbox_pdf)
                    if raw_text:
                        content = raw_text
                        extractor = "pdfplumber-clip-fallback"
                    elif description:
                        content = description
                        extractor = "gemma-e4b-prereview"

            elif label == "formula":
                if use_llm and description:
                    content = description
                    content_type = "formula_latex"
                    extractor = "gemma-e4b-prereview"
                else:
                    raw_text = _extract_text_clip(plumber_page, bbox_pdf)
                    content = raw_text if raw_text else description
                    extractor = "pdfplumber-clip-fallback" if raw_text else "gemma-e4b-prereview"

            elif label in TEXT_LABELS:
                if pdf_type in ("born-digital-clean", "born-digital-corrupt", "scanned-with-ocr"):
                    primary_text = _extract_text_clip(plumber_page, bbox_pdf)
                else:
                    primary_text = ""

                prefer_desc, gate_reason = _should_prefer_description(
                    label, pdf_type, primary_text,
                    text_span_coverage, len(text_spans) > 0,
                    description,
                )
                extraction_metadata["gate_decision"] = gate_reason

                if prefer_desc and use_llm and description:
                    content = description
                    extractor = "gemma-e4b-prereview"
                elif primary_text:
                    content = primary_text
                    extractor = "pdfplumber-clip"
                elif description:
                    content = description
                    extractor = "gemma-e4b-prereview"
                    extraction_metadata["gate_override"] = "fallback_description_last_resort"

            # Write extraction row
            extraction_id = str(uuid.uuid4())

            if content is not None and content != "":
                await db.execute(
                    """INSERT INTO extractions (id, object_id, content, content_type,
                       extractor, confidence, metadata_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (extraction_id, obj_id, content, content_type,
                     extractor, confidence, json.dumps(extraction_metadata)),
                )
                results.append({
                    "object_id": obj_id,
                    "content_type": content_type,
                    "extractor": extractor,
                })
            else:
                placeholder_meta = {
                    "failure_type": "no_content_available",
                    "failed_extractor": extractor,
                    "attempted_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    **extraction_metadata,
                }
                await db.execute(
                    """INSERT INTO extractions (id, object_id, content, content_type,
                       extractor, confidence, metadata_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (extraction_id, obj_id, None, "placeholder",
                     extractor, None, json.dumps(placeholder_meta)),
                )
                results.append({
                    "object_id": obj_id,
                    "content_type": "placeholder",
                    "extractor": extractor,
                })

            extraction_count += 1

            if broadcast_fn:
                await broadcast_fn(doc_id, "object.extracted", {
                    "object_id": obj_id,
                    "content_type": content_type if content else "placeholder",
                    "extractor": extractor,
                    "progress": f"{extraction_count}/{len(obj_rows)}",
                })

        except Exception as e:
            logger.error("Extraction failed for object %s: %s", obj_id, e)
            extraction_id = str(uuid.uuid4())
            placeholder_meta = {
                "failure_type": "extractor_exception",
                "failed_extractor": extractor,
                "attempted_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "error": str(e)[:500],
            }
            await db.execute(
                """INSERT INTO extractions (id, object_id, content, content_type,
                   extractor, confidence, metadata_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (extraction_id, obj_id, None, "placeholder",
                 "error", None, json.dumps(placeholder_meta)),
            )
            results.append({
                "object_id": obj_id,
                "content_type": "placeholder",
                "extractor": "error",
            })
            extraction_count += 1

    pdf.close()

    await db.execute(
        "UPDATE documents SET current_stage=2, stage_status='complete' WHERE id=?",
        (doc_id,),
    )
    await db.commit()

    if broadcast_fn:
        await broadcast_fn(doc_id, "stage.completed", {
            "stage": "extract",
            "total_extracted": extraction_count,
        })

    return {"total_extracted": extraction_count, "extractions": results}
