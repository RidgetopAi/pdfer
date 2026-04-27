"""Training-corpus export endpoints.

Right now exposes one route: GET /documents/{id}/yolo-export — emits a
zip in the canonical Ultralytics YOLO format so the corrections a reviewer
has produced can be fed back into a fine-tune without any reshaping step.

Source of truth is the live `objects` and `pages` tables. We don't write to
a separate "training" table during review — every confirmed/manual region
on a fully-reviewed page IS the training signal. This keeps the
correction-loop pipeline single-source-of-truth: edit history lives in
`object_edits` for undo/redo; training data is derived on demand from
current state.
"""
from __future__ import annotations

import io
import logging
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.database import get_db

logger = logging.getLogger(__name__)
router = APIRouter()


# Canonical class index — the order here defines the integer label written
# into every YOLO .txt file. NEVER reorder this list once a fine-tune has
# trained against it; append-only. Mirrors the 12 architecture labels.
YOLO_CLASS_ORDER: list[str] = [
    "title",
    "section_heading",
    "paragraph",
    "table",
    "figure",
    "caption",
    "footnote",
    "list",
    "formula",
    "page_header",
    "page_footer",
    "watermark",
]
LABEL_TO_INDEX = {name: i for i, name in enumerate(YOLO_CLASS_ORDER)}


@router.get("/documents/{doc_id}/yolo-export")
async def export_yolo_dataset(
    doc_id: str,
    include_in_progress: bool = Query(
        False,
        description="If true, also include pages whose review_status is 'in_progress'. "
                    "Default false — only fully-reviewed pages contribute training data.",
    ),
):
    """Emit a zip in Ultralytics YOLO format.

    Layout:
      images/{doc_id}_p{NNNN}.png      — one per included page
      labels/{doc_id}_p{NNNN}.txt      — one per page; YOLO format,
                                          one box per line: cls cx cy w h (all normalized)
      data.yaml                        — class names + relative paths (train: images/)

    A page contributes iff:
      - pages.review_status = 'complete'   (or 'in_progress' if include_in_progress=true)
      - the page has at least one object with status='confirmed' OR source='manual'

    Boxes are filtered to those same two criteria — confirmed detections + every
    manually-drawn region. Rejected boxes and unreviewed boxes are excluded.
    """
    db = await get_db()
    try:
        # Verify the document exists.
        doc_rows = await db.execute_fetchall(
            "SELECT filename FROM documents WHERE id=?", (doc_id,),
        )
        if not doc_rows:
            raise HTTPException(404, "Document not found")
        filename = doc_rows[0][0]

        # Build the page list — filter to reviewed pages.
        if include_in_progress:
            page_rows = await db.execute_fetchall(
                """SELECT id, page_number, image_path, width_px, height_px, review_status
                   FROM pages
                   WHERE document_id=? AND review_status IN ('complete', 'in_progress')
                   ORDER BY page_number""",
                (doc_id,),
            )
        else:
            page_rows = await db.execute_fetchall(
                """SELECT id, page_number, image_path, width_px, height_px, review_status
                   FROM pages
                   WHERE document_id=? AND review_status = 'complete'
                   ORDER BY page_number""",
                (doc_id,),
            )
        if not page_rows:
            raise HTTPException(
                409,
                "No reviewed pages to export. Confirm/draw regions on at least "
                "one page before requesting an export.",
            )

        # Materialize and check files exist on disk before we start streaming.
        included_pages: list[dict] = []
        skipped: list[dict] = []
        for pr in page_rows:
            page_id, page_number, image_path, w, h, review_status = pr
            obj_rows = await db.execute_fetchall(
                """SELECT label, bbox_x1, bbox_y1, bbox_x2, bbox_y2, status, source
                   FROM objects
                   WHERE page_id=? AND (status='confirmed' OR source='manual')""",
                (page_id,),
            )
            if not obj_rows:
                # Page is reviewed but every box was rejected/deleted. That's a
                # legitimate "this page has no labeled regions" sample — YOLO
                # treats an empty .txt as a true-negative, which we want.
                pass
            if not Path(image_path).is_file():
                skipped.append({"page": page_number, "reason": "image missing on disk"})
                continue
            included_pages.append({
                "page_id": page_id,
                "page_number": page_number,
                "image_path": image_path,
                "width": w,
                "height": h,
                "review_status": review_status,
                "objects": [
                    {
                        "label": r[0],
                        "x1": r[1], "y1": r[2], "x2": r[3], "y2": r[4],
                        "status": r[5], "source": r[6],
                    }
                    for r in obj_rows
                ],
            })

        if not included_pages:
            raise HTTPException(409, "No exportable pages (all sources missing on disk).")

        # Stream the zip.
        buf = io.BytesIO()
        total_boxes = 0
        with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            for p in included_pages:
                stem = f"{doc_id}_p{p['page_number']:04d}"

                # Image.
                zf.write(p["image_path"], arcname=f"images/{stem}.png")

                # Labels — YOLO format: one line per box, "cls cx cy w h" normalized.
                lines: list[str] = []
                w_px, h_px = p["width"], p["height"]
                for obj in p["objects"]:
                    cls_idx = LABEL_TO_INDEX.get(obj["label"])
                    if cls_idx is None:
                        logger.warning(
                            "Unknown label '%s' on page %s — skipped",
                            obj["label"], p["page_number"],
                        )
                        continue
                    x1, y1, x2, y2 = obj["x1"], obj["y1"], obj["x2"], obj["y2"]
                    # Clamp to page just in case of float drift past edges.
                    x1 = max(0, min(w_px, x1))
                    y1 = max(0, min(h_px, y1))
                    x2 = max(0, min(w_px, x2))
                    y2 = max(0, min(h_px, y2))
                    if x2 <= x1 or y2 <= y1:
                        continue
                    cx = ((x1 + x2) / 2) / w_px
                    cy = ((y1 + y2) / 2) / h_px
                    bw = (x2 - x1) / w_px
                    bh = (y2 - y1) / h_px
                    lines.append(f"{cls_idx} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
                    total_boxes += 1
                zf.writestr(f"labels/{stem}.txt", "\n".join(lines) + ("\n" if lines else ""))

            # data.yaml — Ultralytics format, train+val both point at images/
            # for the single-doc export. When you assemble a multi-doc corpus
            # later you'll write your own data.yaml across the merged tree.
            class_lines = "\n".join(f"  {i}: {name}" for i, name in enumerate(YOLO_CLASS_ORDER))
            yaml = (
                f"# PDFer YOLO export — document {doc_id}\n"
                f"# Source filename: {filename}\n"
                f"# Pages included: {len(included_pages)} | Boxes: {total_boxes}\n"
                f"# Pages skipped (image missing): {len(skipped)}\n"
                f"path: .\n"
                f"train: images\n"
                f"val: images\n"
                f"names:\n{class_lines}\n"
            )
            zf.writestr("data.yaml", yaml)

            # Manifest for the human auditing the export.
            manifest_lines = [
                f"PDFer YOLO export",
                f"document_id: {doc_id}",
                f"source_filename: {filename}",
                f"pages_included: {len(included_pages)}",
                f"pages_skipped: {len(skipped)}",
                f"total_boxes: {total_boxes}",
                f"include_in_progress: {include_in_progress}",
                f"",
                f"Pages included (page_number, status, n_boxes):",
            ]
            for p in included_pages:
                manifest_lines.append(
                    f"  p{p['page_number']:04d}  {p['review_status']:12s}  {len(p['objects'])} boxes"
                )
            if skipped:
                manifest_lines.append("")
                manifest_lines.append("Pages skipped:")
                for s in skipped:
                    manifest_lines.append(f"  p{s['page']:04d}  reason={s['reason']}")
            zf.writestr("MANIFEST.txt", "\n".join(manifest_lines))

        buf.seek(0)
        # Use the original filename (sanitized) in the Content-Disposition.
        safe_stem = "".join(c if c.isalnum() or c in "-_" else "_" for c in Path(filename).stem)
        download_name = f"yolo_export_{safe_stem}.zip"
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
        )
    finally:
        await db.close()


@router.get("/training/yolo-export-stats")
async def yolo_export_stats():
    """Aggregate counts across all documents — what's available to export.

    Returns per-class box counts (across all confirmed+manual objects on
    fully-reviewed pages, all docs). Lets the user see whether the corpus
    is balanced enough to fine-tune yet.
    """
    db = await get_db()
    try:
        # Total exportable pages and boxes.
        rows = await db.execute_fetchall(
            """SELECT
                 (SELECT COUNT(*) FROM pages WHERE review_status='complete')        AS pages_complete,
                 (SELECT COUNT(*) FROM pages WHERE review_status='in_progress')     AS pages_in_progress,
                 (SELECT COUNT(*) FROM objects o
                    JOIN pages p ON o.page_id=p.id
                    WHERE p.review_status='complete' AND
                          (o.status='confirmed' OR o.source='manual'))              AS exportable_boxes,
                 (SELECT COUNT(*) FROM objects WHERE source='manual')               AS manual_boxes_total,
                 (SELECT COUNT(*) FROM objects WHERE status='confirmed')            AS confirmed_boxes_total"""
        )
        r = rows[0]

        # Per-class breakdown, on fully-reviewed pages only.
        per_class_rows = await db.execute_fetchall(
            """SELECT o.label, COUNT(*) AS ct
               FROM objects o JOIN pages p ON o.page_id=p.id
               WHERE p.review_status='complete' AND
                     (o.status='confirmed' OR o.source='manual')
               GROUP BY o.label
               ORDER BY ct DESC"""
        )
        per_class = {row[0]: row[1] for row in per_class_rows}

        # Per-document exportable summary.
        per_doc_rows = await db.execute_fetchall(
            """SELECT d.id, d.filename,
                      SUM(CASE WHEN p.review_status='complete' THEN 1 ELSE 0 END) AS pages_complete
               FROM documents d
               LEFT JOIN pages p ON p.document_id=d.id
               GROUP BY d.id, d.filename
               HAVING pages_complete > 0
               ORDER BY pages_complete DESC"""
        )
        per_doc = [
            {"document_id": pr[0], "filename": pr[1], "pages_complete": pr[2]}
            for pr in per_doc_rows
        ]

        return {
            "pages_complete": r[0],
            "pages_in_progress": r[1],
            "exportable_boxes": r[2],
            "manual_boxes_total": r[3],
            "confirmed_boxes_total": r[4],
            "per_class": per_class,
            "per_document": per_doc,
        }
    finally:
        await db.close()
