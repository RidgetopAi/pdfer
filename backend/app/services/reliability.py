"""Review reliability scoring.

YOLO's raw detection confidence is useful, but it is not the same thing as
"safe to auto-confirm." This module combines raw detector confidence with
deterministic PDF evidence and optional Gemma/pdfplumber agreement so review
automation can focus the human on genuinely uncertain objects.
"""
from __future__ import annotations

import json
import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

import aiosqlite
import pdfplumber

from app.config import PAGE_DPI
from app.services.gemma import is_prose_shaped, is_table_shaped

logger = logging.getLogger(__name__)


TEXT_LABELS = {
    "title", "section_heading", "paragraph", "caption",
    "footnote", "page_header", "page_footer", "list",
}


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _pixel_to_pdf_bbox(bbox_px: dict, dpi: int = PAGE_DPI) -> tuple[float, float, float, float]:
    scale = 72.0 / dpi
    return (
        bbox_px["bbox_x1"] * scale,
        bbox_px["bbox_y1"] * scale,
        bbox_px["bbox_x2"] * scale,
        bbox_px["bbox_y2"] * scale,
    )


def _extract_text_clip(pdf_page, bbox_pdf: tuple[float, float, float, float]) -> str:
    pad = 2.0
    x0, y0, x1, y1 = bbox_pdf
    padded = (
        max(0.0, x0 - pad),
        max(0.0, y0 - pad),
        min(pdf_page.width, x1 + pad),
        min(pdf_page.height, y1 + pad),
    )
    return (pdf_page.crop(padded, strict=False).extract_text() or "").strip()


def _table_quality(pdf_page, bbox_pdf: tuple[float, float, float, float]) -> dict:
    try:
        cropped = pdf_page.within_bbox(bbox_pdf, strict=False)
        tables = cropped.find_tables()
        if not tables:
            return {"passed": False, "reason": "no_tables_found"}
        rows = tables[0].extract()
    except Exception as e:
        return {"passed": False, "reason": "table_exception", "error": str(e)[:160]}

    if not rows:
        return {"passed": False, "reason": "empty_table"}
    num_rows = len(rows)
    num_cols = max(len(row) for row in rows) if rows else 0
    total_cells = sum(len(row) for row in rows)
    empty_cells = sum(1 for row in rows for cell in row if not cell or not cell.strip())
    empty_ratio = empty_cells / max(total_cells, 1)
    passed = num_rows >= 2 and num_cols >= 2 and empty_ratio <= 0.4
    return {
        "passed": passed,
        "rows": num_rows,
        "cols": num_cols,
        "empty_ratio": round(empty_ratio, 3),
        "reason": "quality_passed" if passed else "weak_table_shape",
    }


def _text_span_stats(text_spans: list[dict], bbox_px: dict, dpi: int = PAGE_DPI) -> dict:
    scale = 72.0 / dpi
    x1 = bbox_px["bbox_x1"] * scale
    y1 = bbox_px["bbox_y1"] * scale
    x2 = bbox_px["bbox_x2"] * scale
    y2 = bbox_px["bbox_y2"] * scale

    matches = []
    chars = 0
    for span in text_spans:
        if span["x1"] < x2 and span["x2"] > x1 and span["y1"] < y2 and span["y2"] > y1:
            matches.append(span)
            chars += len((span.get("text") or "").strip())

    return {
        "span_count": len(matches),
        "char_count": chars,
        "has_text": bool(chars),
    }


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def _agreement(a: str, b: str) -> float:
    ta = _tokens(a)
    tb = _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _bbox_iou(a: dict, b: dict) -> float:
    ix1 = max(a["bbox_x1"], b["bbox_x1"])
    iy1 = max(a["bbox_y1"], b["bbox_y1"])
    ix2 = min(a["bbox_x2"], b["bbox_x2"])
    iy2 = min(a["bbox_y2"], b["bbox_y2"])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area_a = max((a["bbox_x2"] - a["bbox_x1"]) * (a["bbox_y2"] - a["bbox_y1"]), 1.0)
    area_b = max((b["bbox_x2"] - b["bbox_x1"]) * (b["bbox_y2"] - b["bbox_y1"]), 1.0)
    return inter / max(area_a + area_b - inter, 1.0)


def _position_band(obj: dict, page_height: int) -> str:
    y_mid = (obj["bbox_y1"] + obj["bbox_y2"]) / 2
    ratio = y_mid / max(page_height, 1)
    if ratio < 0.16:
        return "top"
    if ratio > 0.84:
        return "bottom"
    return "body"


def _repeat_signatures(objects: list[dict]) -> Counter:
    signatures = Counter()
    for obj in objects:
        width = obj["page_width"]
        height = obj["page_height"]
        key = (
            obj["label"],
            round((obj["bbox_x1"] / max(width, 1)) * 20),
            round((obj["bbox_y1"] / max(height, 1)) * 20),
            round(((obj["bbox_x2"] - obj["bbox_x1"]) / max(width, 1)) * 20),
            round(((obj["bbox_y2"] - obj["bbox_y1"]) / max(height, 1)) * 20),
        )
        signatures[key] += 1
        obj["_repeat_key"] = key
    return signatures


@dataclass
class ReliabilityResult:
    score: float
    metadata: dict


def score_object(
    obj: dict,
    page_objects: list[dict],
    text_spans: list[dict],
    pdf_page,
    repeat_counts: Counter,
) -> ReliabilityResult:
    conf = obj.get("confidence")
    score = 0.35 + (0.45 * conf if conf is not None else 0.10)
    reasons: list[str] = []
    penalties: list[str] = []

    width = obj["page_width"]
    height = obj["page_height"]
    obj_w = obj["bbox_x2"] - obj["bbox_x1"]
    obj_h = obj["bbox_y2"] - obj["bbox_y1"]
    area_ratio = (obj_w * obj_h) / max(width * height, 1)
    bbox_ok = obj_w >= 8 and obj_h >= 8 and 0 < area_ratio < 0.92
    if bbox_ok:
        score += 0.06
        reasons.append("bbox_sane")
    else:
        score -= 0.18
        penalties.append("bbox_suspicious")

    overlap_count = 0
    for other in page_objects:
        if other["id"] == obj["id"]:
            continue
        if _bbox_iou(obj, other) >= 0.55:
            overlap_count += 1
    if overlap_count:
        score -= min(0.18, 0.08 * overlap_count)
        penalties.append(f"overlap_iou>=0.55:{overlap_count}")

    repeat_count = repeat_counts.get(obj.get("_repeat_key"), 0)
    if obj["label"] in ("page_header", "page_footer", "watermark") and repeat_count >= 3:
        score += 0.14
        reasons.append(f"repeating_page_furniture:{repeat_count}")

    band = _position_band(obj, height)
    if obj["label"] == "page_header":
        if band == "top":
            score += 0.10
            reasons.append("header_top_position")
        else:
            score -= 0.16
            penalties.append("header_not_top")
    elif obj["label"] == "page_footer":
        if band == "bottom":
            score += 0.10
            reasons.append("footer_bottom_position")
        else:
            score -= 0.16
            penalties.append("footer_not_bottom")

    bbox_pdf = _pixel_to_pdf_bbox(obj)
    span_stats = _text_span_stats(text_spans, obj)
    pdf_text = ""
    table_meta = None
    try:
        if obj["pdf_type"] in ("born-digital-clean", "born-digital-corrupt", "scanned-with-ocr"):
            pdf_text = _extract_text_clip(pdf_page, bbox_pdf)
    except Exception as e:
        penalties.append(f"pdfplumber_text_error:{str(e)[:80]}")

    label = obj["label"]
    description = (obj.get("description") or "").strip()
    description_status = obj.get("description_status") or "pending"
    description_edited = bool(obj.get("description_edited_by_user"))

    if label in TEXT_LABELS:
        if pdf_text:
            score += 0.16
            reasons.append("pdfplumber_text_present")
            if is_prose_shaped(pdf_text) or label in ("title", "section_heading", "caption", "page_header", "page_footer"):
                score += 0.06
                reasons.append("pdfplumber_text_shape_ok")
        elif span_stats["has_text"]:
            score += 0.08
            reasons.append("text_spans_present")
        else:
            score -= 0.16
            penalties.append("no_pdf_text_signal")

        if label == "list":
            if re.search(r"(^|\n)\s*([-*•]|\d+[.)])\s+", pdf_text):
                score += 0.08
                reasons.append("list_marker_detected")
            elif pdf_text:
                score -= 0.04
                penalties.append("list_without_marker")

    elif label == "table":
        table_meta = _table_quality(pdf_page, bbox_pdf)
        if table_meta.get("passed"):
            score += 0.22
            reasons.append("pdfplumber_table_quality_passed")
        elif is_table_shaped(description):
            score += 0.12
            reasons.append("gemma_table_shape_ok")
        else:
            score -= 0.10
            penalties.append(f"table_quality_failed:{table_meta.get('reason')}")

    elif label == "figure":
        if area_ratio >= 0.01:
            score += 0.10
            reasons.append("figure_bbox_large_enough")
        if description:
            score += 0.10
            reasons.append("gemma_figure_description_present")

    elif label == "formula":
        if description:
            score += 0.12
            reasons.append("gemma_formula_present")
        elif pdf_text:
            score += 0.04
            reasons.append("pdfplumber_formula_text_present")

    if description_status == "described" and description:
        score += 0.05
        reasons.append("gemma_description_present")
        if pdf_text:
            agree = _agreement(pdf_text, description)
            if agree >= 0.45:
                score += 0.10
                reasons.append(f"gemma_pdfplumber_agree:{agree:.2f}")
            elif agree < 0.12 and label in TEXT_LABELS:
                score -= 0.07
                penalties.append(f"gemma_pdfplumber_disagree:{agree:.2f}")
    elif description_status == "failed":
        score -= 0.04
        penalties.append("gemma_failed")

    if description_edited:
        score += 0.08
        reasons.append("human_corrected_description")

    if obj.get("source") == "manual":
        score = max(score, 0.92)
        reasons.append("manual_region")

    final = round(_clamp01(score), 4)
    metadata = {
        "score_version": 1,
        "yolo_confidence": conf,
        "label": label,
        "pdf_type": obj.get("pdf_type"),
        "bbox": {
            "width": round(obj_w, 2),
            "height": round(obj_h, 2),
            "area_ratio": round(area_ratio, 5),
        },
        "text_spans": span_stats,
        "pdfplumber": {
            "text_chars": len(pdf_text),
            "text_lines": sum(1 for line in pdf_text.splitlines() if line.strip()),
            "table": table_meta,
        },
        "gemma": {
            "status": description_status,
            "chars": len(description),
            "edited_by_user": description_edited,
        },
        "repeat_count": repeat_count,
        "reasons": reasons,
        "penalties": penalties,
    }
    return ReliabilityResult(final, metadata)


async def compute_document_reliability(
    db: aiosqlite.Connection,
    doc_id: str,
    object_ids: list[str] | None = None,
) -> int:
    """Compute and persist review reliability for a document or object subset."""
    doc_rows = await db.execute_fetchall(
        "SELECT file_path FROM documents WHERE id=?",
        (doc_id,),
    )
    if not doc_rows:
        raise ValueError("Document not found")
    file_path = doc_rows[0][0]

    page_rows = await db.execute_fetchall(
        """SELECT id, page_number, width_px, height_px, dpi, pdf_type
           FROM pages WHERE document_id=? ORDER BY page_number""",
        (doc_id,),
    )
    pages = {
        r[0]: {
            "page_id": r[0], "page_number": r[1], "width_px": r[2],
            "height_px": r[3], "dpi": r[4], "pdf_type": r[5],
        }
        for r in page_rows
    }

    obj_rows = await db.execute_fetchall(
        """SELECT o.id, o.page_id, o.label, o.bbox_x1, o.bbox_y1, o.bbox_x2, o.bbox_y2,
                  o.confidence, o.source, o.status, o.description, o.description_status,
                  o.description_edited_by_user
           FROM objects o
           JOIN pages p ON o.page_id=p.id
           WHERE p.document_id=?""",
        (doc_id,),
    )
    all_objects: list[dict] = []
    for r in obj_rows:
        page = pages[r[1]]
        all_objects.append({
            "id": r[0],
            "page_id": r[1],
            "page_number": page["page_number"],
            "page_width": page["width_px"],
            "page_height": page["height_px"],
            "dpi": page["dpi"],
            "pdf_type": page["pdf_type"],
            "label": r[2],
            "bbox_x1": r[3], "bbox_y1": r[4], "bbox_x2": r[5], "bbox_y2": r[6],
            "confidence": r[7],
            "source": r[8],
            "status": r[9],
            "description": r[10],
            "description_status": r[11],
            "description_edited_by_user": r[12],
        })

    target_ids = set(object_ids) if object_ids else {obj["id"] for obj in all_objects}
    repeat_counts = _repeat_signatures(all_objects)
    by_page: dict[str, list[dict]] = defaultdict(list)
    for obj in all_objects:
        by_page[obj["page_id"]].append(obj)

    spans_by_page: dict[str, list[dict]] = {}
    for page_id in pages:
        span_rows = await db.execute_fetchall(
            "SELECT text, x1, y1, x2, y2 FROM text_spans WHERE page_id=?",
            (page_id,),
        )
        spans_by_page[page_id] = [
            {"text": s[0], "x1": s[1], "y1": s[2], "x2": s[3], "y2": s[4]}
            for s in span_rows
        ]

    updated = 0
    try:
        with pdfplumber.open(file_path) as pdf:
            for obj in all_objects:
                if obj["id"] not in target_ids:
                    continue
                try:
                    pdf_page = pdf.pages[obj["page_number"]]
                    result = score_object(
                        obj,
                        by_page[obj["page_id"]],
                        spans_by_page[obj["page_id"]],
                        pdf_page,
                        repeat_counts,
                    )
                except Exception as e:
                    logger.warning("Reliability scoring failed for %s: %s", obj["id"], e)
                    fallback = obj.get("confidence")
                    result = ReliabilityResult(
                        round(_clamp01(fallback if fallback is not None else 0.0), 4),
                        {
                            "score_version": 1,
                            "yolo_confidence": fallback,
                            "reasons": ["fallback_yolo_confidence"],
                            "penalties": [f"scoring_exception:{str(e)[:160]}"],
                        },
                    )

                await db.execute(
                    """UPDATE objects
                       SET review_reliability=?, review_reliability_json=?
                       WHERE id=?""",
                    (result.score, json.dumps(result.metadata), obj["id"]),
                )
                updated += 1
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    return updated
