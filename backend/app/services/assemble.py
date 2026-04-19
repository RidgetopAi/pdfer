"""Stage 4 — Assembly pipeline.

Assembles extracted content into a markdown document with assets and metadata.
Produces the output contract: document.md + assets/ + metadata.json, bundled as a zip.

Failure placeholders render as:
  [EXTRACTION_FAILED type=... page=N bbox=(...) reason=... review=pdfer://doc/.../object/...]

Heading hierarchy comes from object heading_level. Reading order from the detect stage.
Cross-page linking handled by page-by-page assembly in reading order.
"""
import io
import json
import logging
import re
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite

from app.config import ASSETS_DIR, DATA_DIR

logger = logging.getLogger(__name__)

# Numbered-step banner pattern: matches "STEP 1", "Step 3", "STEP 12", etc.
# Used to synthesize H3 headings from figure descriptions that have baked-in
# step labels (common in installation guides, recipe cards, tutorials).
STEP_HEADING_PATTERN = re.compile(
    r"^\s*(STEP\s+\d+|Step\s+\d+)\b",
    re.IGNORECASE | re.MULTILINE,
)


def _short_synopsis(description: str, max_chars: int = 140) -> str:
    """First sentence of the description, clipped — used for image alt text.

    Gemma often writes "This image shows..." as the final sentence. Prefer the
    first sentence since it usually names what the figure is.
    """
    if not description:
        return ""
    text = description.strip().replace("\n", " ")
    # Strip square brackets so markdown alt doesn't break
    text = text.replace("[", "(").replace("]", ")")
    # First sentence, naive split
    match = re.split(r"(?<=[.!?])\s+", text, maxsplit=1)
    first = match[0] if match else text
    if len(first) <= max_chars:
        return first
    return first[: max_chars - 1].rstrip() + "…"


def _synthesize_step_heading(description: str) -> str | None:
    """Return "STEP 3" etc. if the description opens with a step banner.

    Used to emit an H3 above the figure so downstream consumers (RAG chunkers)
    get proper document structure even though YOLO detected the banner as a
    merged-into-figure heading.
    """
    if not description:
        return None
    m = STEP_HEADING_PATTERN.match(description)
    if not m:
        return None
    return m.group(1).strip().upper().replace("  ", " ")


# Ordered-list item pattern: "1.", "1)", "12." etc. at the start of a line.
ORDERED_ITEM_PATTERN = re.compile(r"^\s*(\d+)[.\)]\s+")
# Existing markdown bullet prefixes we should strip before re-emitting
BULLET_PREFIX_PATTERN = re.compile(r"^\s*[-*•]\s+")


def _normalize_list_item(content: str) -> tuple[str, bool]:
    """Strip bullet/number prefix from an extracted list item.

    Returns (cleaned_text, is_ordered_item). Keeps inner structure intact
    (multi-line content stays multi-line, indented with two spaces on
    continuation so it lands inside the bullet in GFM).
    """
    if not content:
        return "", False

    lines = content.strip().split("\n")
    first = lines[0]

    ordered = False
    m = ORDERED_ITEM_PATTERN.match(first)
    if m:
        ordered = True
        first = ORDERED_ITEM_PATTERN.sub("", first, count=1)
    else:
        first = BULLET_PREFIX_PATTERN.sub("", first, count=1)

    cleaned_lines = [first.strip()]
    for line in lines[1:]:
        cleaned_lines.append("  " + line.strip())  # continuation indent
    return "\n".join(cleaned_lines), ordered


def _flush_list_buffer(md_parts: list[str], buffer: list[tuple[str, bool]]) -> None:
    """Emit a buffered run of list items as a single markdown list.

    `buffer` is a list of (cleaned_text, is_ordered) tuples. If any item was
    ordered-prefixed in the source, render the whole block as ordered using
    sequential numbers; otherwise render as unordered with `-`.
    """
    if not buffer:
        return

    any_ordered = any(is_ord for _, is_ord in buffer)

    if any_ordered:
        for i, (text, _) in enumerate(buffer, 1):
            head, *rest = text.split("\n", 1)
            md_parts.append(f"{i}. {head}")
            if rest:
                md_parts.append(rest[0])
    else:
        for text, _ in buffer:
            head, *rest = text.split("\n", 1)
            md_parts.append(f"- {head}")
            if rest:
                md_parts.append(rest[0])

    md_parts.append("")
    buffer.clear()


async def assemble_document(
    db: aiosqlite.Connection,
    doc_id: str,
    broadcast_fn=None,
) -> dict:
    """Run Stage 4 assembly: produce markdown + assets + metadata from extractions.

    Gate: requires current_stage >= 2 (extraction complete).

    Returns {markdown: str, asset_count: int, metadata: dict}
    """
    # Check document state
    doc_rows = await db.execute_fetchall(
        "SELECT current_stage, stage_status, filename FROM documents WHERE id=?",
        (doc_id,),
    )
    if not doc_rows:
        raise ValueError("Document not found")

    current_stage = doc_rows[0][0]
    filename = doc_rows[0][1]

    if current_stage < 2:
        raise ValueError("Document must be extracted (stage >= 2) before assembly")

    # Mark as assembling
    await db.execute(
        "UPDATE documents SET current_stage=3, stage_status='running' WHERE id=?",
        (doc_id,),
    )
    await db.commit()

    # Get all confirmed objects with their extractions, ordered by page then reading_order
    rows = await db.execute_fetchall(
        """SELECT o.id, o.label, o.bbox_x1, o.bbox_y1, o.bbox_x2, o.bbox_y2,
                  o.confidence, o.reading_order, o.heading_level,
                  p.page_number, p.width_px, p.height_px,
                  e.id as extraction_id, e.content, e.content_type,
                  e.extractor, e.confidence as ext_confidence, e.metadata_json
           FROM objects o
           JOIN pages p ON o.page_id = p.id
           LEFT JOIN extractions e ON e.object_id = o.id
           WHERE p.document_id = ? AND o.status = 'confirmed'
           ORDER BY p.page_number, o.reading_order""",
        (doc_id,),
    )

    # Get page count
    page_count_rows = await db.execute_fetchall(
        "SELECT page_count FROM documents WHERE id=?", (doc_id,),
    )
    page_count = page_count_rows[0][0] if page_count_rows else 0

    # Get correction count for metadata
    correction_rows = await db.execute_fetchall(
        "SELECT COUNT(*) FROM object_edits WHERE document_id=?", (doc_id,),
    )
    total_corrections = correction_rows[0][0]

    # Build markdown sections page by page
    md_parts = []
    metadata_objects = []
    assets_collected = []  # list of (relative_path, absolute_path)
    current_page = None
    list_buffer: list[tuple[str, bool]] = []

    for row in rows:
        obj_id = row[0]
        label = row[1]
        bbox = (row[2], row[3], row[4], row[5])
        confidence = row[6]
        reading_order = row[7]
        heading_level = row[8]
        page_number = row[9]
        page_width = row[10]
        page_height = row[11]
        extraction_id = row[12]
        content = row[13]
        content_type = row[14]
        extractor = row[15]
        ext_confidence = row[16]
        metadata_json_str = row[17]

        ext_metadata = json.loads(metadata_json_str) if metadata_json_str else {}

        # Page break marker. Flush any buffered list before crossing a page.
        if page_number != current_page:
            _flush_list_buffer(md_parts, list_buffer)
            if current_page is not None:
                md_parts.append("")  # blank line between pages
            current_page = page_number

        # Build metadata entry for this object
        meta_entry = {
            "object_id": obj_id,
            "page": page_number,
            "label": label,
            "content_type": content_type or "unknown",
            "extractor": extractor or "none",
            "correction_status": "none",
            "bbox": list(bbox),
            "confidence": confidence,
            "extraction_confidence": ext_confidence,
        }

        # Check if this object was corrected
        edit_rows = await db.execute_fetchall(
            "SELECT COUNT(*) FROM object_edits WHERE object_id=?", (obj_id,),
        )
        if edit_rows[0][0] > 0:
            meta_entry["correction_status"] = "corrected"

        # Handle failure placeholders
        if content_type == "placeholder" or content is None:
            _flush_list_buffer(md_parts, list_buffer)
            failure_type = ext_metadata.get("failure_type", "unknown")
            error_detail = (
                ext_metadata.get("error")
                or ext_metadata.get("llm_metadata", {}).get("error")
            )
            placeholder = (
                f"[EXTRACTION_FAILED type={label} page={page_number} "
                f"bbox=({int(bbox[0])},{int(bbox[1])},{int(bbox[2])},{int(bbox[3])}) "
                f"reason={failure_type} "
                f"review=pdfer://doc/{doc_id}/object/{obj_id}]"
            )
            md_parts.append(placeholder)
            md_parts.append("")
            meta_entry["correction_status"] = "failed"
            meta_entry["failure_type"] = failure_type
            meta_entry["failed_extractor"] = ext_metadata.get(
                "failed_extractor", extractor or "unknown"
            )
            if error_detail:
                meta_entry["error"] = error_detail
            metadata_objects.append(meta_entry)
            continue

        # Any emission of a non-list element terminates a running list block.
        if label != "list":
            _flush_list_buffer(md_parts, list_buffer)

        # Build markdown based on label type
        if label in ("title", "section_heading"):
            level = heading_level or (1 if label == "title" else 2)
            prefix = "#" * min(level, 6)
            md_parts.append(f"{prefix} {content.strip()}")
            md_parts.append("")

        elif label == "table":
            # Tables may already be in markdown format from pdfplumber
            md_parts.append(content.strip())
            md_parts.append("")

        elif label == "figure":
            # Figure routing (Option A dedup):
            #   - alt text  = short synopsis (first sentence of description)
            #   - image     = rendered once
            #   - body text = full description (so text baked into pixels
            #                  reaches RAG/full-text search)
            # Synthesize an H3 heading from "STEP N" banners when present.
            asset_rel = ext_metadata.get("asset_path") or (
                content if content and content.startswith("assets/") else None
            )
            asset_abs = (DATA_DIR / asset_rel) if asset_rel else None
            description = (ext_metadata.get("description") or "").strip()

            step_heading = _synthesize_step_heading(description)
            if step_heading:
                md_parts.append(f"### {step_heading}")
                md_parts.append("")
                meta_entry["synthesized_heading"] = step_heading
                # Strip the step banner from the body so it isn't repeated
                description = STEP_HEADING_PATTERN.sub("", description, count=1).strip()

            if asset_abs and asset_abs.exists():
                rel_path = f"assets/{asset_abs.name}"
                assets_collected.append((rel_path, str(asset_abs)))
                meta_entry["asset_path"] = rel_path
                alt_text = (
                    _short_synopsis(description)
                    if description
                    else f"Figure on page {page_number}"
                )
                md_parts.append(f"![{alt_text}]({rel_path})")
                md_parts.append("")
                if description:
                    md_parts.append(description)
                    md_parts.append("")
            elif description:
                md_parts.append(description)
                md_parts.append("")
            else:
                md_parts.append(f"![Figure on page {page_number}](missing-asset)")
                md_parts.append("")

        elif label == "formula":
            # LaTeX formulas
            text = content.strip()
            if text.startswith("$") or text.startswith("\\"):
                md_parts.append(f"$${text}$$")
            else:
                md_parts.append(f"$${text}$$")
            md_parts.append("")

        elif label == "list":
            # Buffer consecutive list items so they render as one markdown list
            # block rather than three standalone one-item lists. Ordered vs
            # unordered is inferred from the item's leading digit.
            cleaned, ordered = _normalize_list_item(content.strip())
            if cleaned:
                list_buffer.append((cleaned, ordered))

        elif label == "caption":
            md_parts.append(f"*{content.strip()}*")
            md_parts.append("")

        elif label == "footnote":
            md_parts.append(f"> {content.strip()}")
            md_parts.append("")

        elif label in ("page_header", "page_footer"):
            # Headers/footers are typically not included in the main body
            # but we include them as metadata-only (not in markdown)
            metadata_objects.append(meta_entry)
            continue

        elif label == "watermark":
            # Skip watermarks entirely
            metadata_objects.append(meta_entry)
            continue

        else:
            # Default: paragraph-like content
            md_parts.append(content.strip())
            md_parts.append("")

        metadata_objects.append(meta_entry)

    # Document ended on a list — flush remaining buffered items.
    _flush_list_buffer(md_parts, list_buffer)

    # Build the final markdown
    title_stem = Path(filename).stem if filename else "document"
    markdown = "\n".join(md_parts).strip() + "\n"

    # Build metadata.json
    metadata = {
        "document_id": doc_id,
        "filename": filename,
        "page_count": page_count,
        "total_objects": len(metadata_objects),
        "total_assets": len(assets_collected),
        "total_corrections": total_corrections,
        "assembled_at": datetime.now(timezone.utc).isoformat(),
        "objects": metadata_objects,
    }

    # Mark assembly complete
    await db.execute(
        "UPDATE documents SET current_stage=4, stage_status='complete' WHERE id=?",
        (doc_id,),
    )
    await db.commit()

    if broadcast_fn:
        await broadcast_fn(doc_id, "document.assembled", {
            "document_id": doc_id,
            "object_count": len(metadata_objects),
            "asset_count": len(assets_collected),
        })

    return {
        "markdown": markdown,
        "asset_count": len(assets_collected),
        "metadata": metadata,
        "assets": assets_collected,
    }


async def build_bundle_zip(
    db: aiosqlite.Connection,
    doc_id: str,
    broadcast_fn=None,
) -> bytes:
    """Build a zip bundle containing document.md, assets/, and metadata.json.

    If assembly hasn't been run yet, runs it first.
    Returns the zip file content as bytes.
    """
    # Check if already assembled
    doc_rows = await db.execute_fetchall(
        "SELECT current_stage, filename FROM documents WHERE id=?",
        (doc_id,),
    )
    if not doc_rows:
        raise ValueError("Document not found")

    current_stage = doc_rows[0][0]
    filename = doc_rows[0][1]

    # Run assembly if not done yet
    if current_stage < 4:
        result = await assemble_document(db, doc_id, broadcast_fn=broadcast_fn)
    else:
        # Re-assemble to get fresh content (assembly is fast, ~1-2s)
        # First reset stage so assemble_document doesn't reject
        await db.execute(
            "UPDATE documents SET current_stage=2, stage_status='complete' WHERE id=?",
            (doc_id,),
        )
        await db.commit()
        result = await assemble_document(db, doc_id, broadcast_fn=broadcast_fn)

    title_stem = Path(filename).stem if filename else "document"

    # Build zip in memory
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # document.md
        zf.writestr(f"{title_stem}/document.md", result["markdown"])

        # metadata.json
        zf.writestr(
            f"{title_stem}/metadata.json",
            json.dumps(result["metadata"], indent=2),
        )

        # assets/
        for rel_path, abs_path in result["assets"]:
            abs_p = Path(abs_path)
            if abs_p.exists():
                zf.write(str(abs_p), f"{title_stem}/{rel_path}")

    buf.seek(0)
    return buf.read()
