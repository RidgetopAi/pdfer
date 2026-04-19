"""Stage 1 — Layout Detection with post-processing.

YOLO inference → label mapping → DBSCAN column detection → reading order → heading hierarchy.
Per architecture Change 4: text_spans feed post-processing, not YOLO.
"""
import logging
import uuid
from collections import defaultdict

import numpy as np
from sklearn.cluster import DBSCAN

from app.config import YOLO_CONF_THRESHOLD, YOLO_IOU_THRESHOLD
from app.services.model_manager import model_manager

logger = logging.getLogger(__name__)

# DocLayNet 11 classes → architecture 12 labels
# DocLayNet has no "watermark" class; architecture includes it for manual labeling.
DOCLAYNET_TO_LABEL = {
    "Caption": "caption",
    "Footnote": "footnote",
    "Formula": "formula",
    "List-item": "list",
    "Page-footer": "page_footer",
    "Page-header": "page_header",
    "Picture": "figure",
    "Section-header": "section_heading",
    "Table": "table",
    "Text": "paragraph",
    "Title": "title",
}

# Label colors for frontend rendering (architecture-consistent)
LABEL_COLORS = {
    "title": "#f59e0b",
    "section_heading": "#eab308",
    "paragraph": "#3b82f6",
    "table": "#8b5cf6",
    "figure": "#22c55e",
    "caption": "#14b8a6",
    "footnote": "#6b7280",
    "list": "#06b6d4",
    "formula": "#ec4899",
    "page_header": "#64748b",
    "page_footer": "#64748b",
    "watermark": "#94a3b8",
}


def detect_page_objects(
    image_path: str,
    conf_threshold: float = YOLO_CONF_THRESHOLD,
    iou_threshold: float = YOLO_IOU_THRESHOLD,
) -> list[dict]:
    """Run YOLO on a single page image. Returns list of detected objects.

    Each object has: label, bbox (x1, y1, x2, y2 in pixels), confidence.
    """
    model = model_manager.get_yolo()
    results = model(
        image_path,
        conf=conf_threshold,
        iou=iou_threshold,
        verbose=False,
        imgsz=640,
    )
    r = results[0]

    objects = []
    for box in r.boxes:
        cls_idx = int(box.cls[0])
        doclaynet_name = model.names[cls_idx]
        label = DOCLAYNET_TO_LABEL.get(doclaynet_name)
        if label is None:
            logger.warning("Unknown DocLayNet class: %s", doclaynet_name)
            continue

        x1, y1, x2, y2 = box.xyxy[0].tolist()
        conf = float(box.conf[0])

        objects.append({
            "label": label,
            "bbox_x1": x1,
            "bbox_y1": y1,
            "bbox_x2": x2,
            "bbox_y2": y2,
            "confidence": conf,
        })

    return objects


def _bbox_overlap_area(a: dict, b: dict) -> float:
    """Intersection area between two bboxes (pixel space)."""
    ix1 = max(a["bbox_x1"], b["bbox_x1"])
    iy1 = max(a["bbox_y1"], b["bbox_y1"])
    ix2 = min(a["bbox_x2"], b["bbox_x2"])
    iy2 = min(a["bbox_y2"], b["bbox_y2"])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    return (ix2 - ix1) * (iy2 - iy1)


def _bbox_area(b: dict) -> float:
    return max((b["bbox_x2"] - b["bbox_x1"]) * (b["bbox_y2"] - b["bbox_y1"]), 1.0)


# Labels that should be absorbed into a parent figure when they sit inside one.
# STEP banners, caption labels, table captions — all get transcribed by Gemma
# as part of the figure, so they duplicate the output when YOLO separates them.
FIGURE_CONTAINED_LABELS = {
    "section_heading", "title", "caption", "list", "paragraph", "formula",
}

# How much of the inner object's area must sit inside the figure to merge.
CONTAINMENT_THRESHOLD = 0.70


def suppress_figure_contained(objects: list[dict]) -> list[dict]:
    """Drop text-ish objects that are mostly inside a figure.

    Gemma transcribes the full figure crop (text + diagram) during Stage 1.5,
    so any small heading/caption/paragraph YOLO detected inside a figure
    becomes duplicate output. Rather than separately extracting them we absorb
    them into the figure.

    Objects are kept but marked as absorbed (added to a `_merged_into` field)
    so the caller can log the decision. A filtered list is returned.
    """
    figures = [
        (i, o) for i, o in enumerate(objects) if o["label"] == "figure"
    ]
    keep = [True] * len(objects)

    for i, obj in enumerate(objects):
        if obj["label"] not in FIGURE_CONTAINED_LABELS:
            continue
        obj_area = _bbox_area(obj)
        for fi, fig in figures:
            if fi == i:
                continue
            overlap = _bbox_overlap_area(obj, fig)
            if overlap / obj_area >= CONTAINMENT_THRESHOLD:
                keep[i] = False
                obj["_absorbed_by"] = fi
                break

    return [o for i, o in enumerate(objects) if keep[i]]


def compute_column_clusters(
    objects: list[dict],
    page_width: int,
    full_width_ratio: float = 0.80,
    eps_fraction: float = 0.05,
) -> dict[str, int | None]:
    """Assign each object to a column via DBSCAN on X-midpoints.

    Full-width objects (>80% page width) get column=None.
    Returns mapping of object index → column number (0-based) or None.
    """
    assignments: dict[int, int | None] = {}
    column_candidates = []
    candidate_indices = []

    for i, obj in enumerate(objects):
        obj_width = obj["bbox_x2"] - obj["bbox_x1"]
        if obj_width / page_width >= full_width_ratio:
            assignments[i] = None  # full-width, independent of columns
        else:
            x_mid = (obj["bbox_x1"] + obj["bbox_x2"]) / 2
            column_candidates.append(x_mid)
            candidate_indices.append(i)

    if not column_candidates:
        return assignments

    X = np.array(column_candidates).reshape(-1, 1)
    eps = page_width * eps_fraction
    clustering = DBSCAN(eps=eps, min_samples=1).fit(X)

    # Sort cluster labels by mean X position (left to right)
    cluster_labels = clustering.labels_
    unique_labels = sorted(set(cluster_labels))
    cluster_means = {}
    for cl in unique_labels:
        mask = cluster_labels == cl
        cluster_means[cl] = np.mean(X[mask])

    sorted_clusters = sorted(unique_labels, key=lambda c: cluster_means[c])
    remap = {old: new for new, old in enumerate(sorted_clusters)}

    for idx, ci in zip(candidate_indices, cluster_labels):
        assignments[idx] = remap[ci]

    return assignments


def compute_reading_order(
    objects: list[dict],
    column_assignments: dict[int, int | None],
) -> list[int]:
    """Compute reading order per architecture D10: full-width + column interleaving.

    Full-width objects sorted by Y, independent of columns.
    Column objects: columns left-to-right, within column top-to-bottom.
    Full-width items interleaved with column groups by Y position.
    """
    # Separate full-width and column objects
    full_width = []  # (y_center, obj_index)
    columns: dict[int, list[tuple[float, int]]] = defaultdict(list)

    for i, obj in enumerate(objects):
        y_center = (obj["bbox_y1"] + obj["bbox_y2"]) / 2
        col = column_assignments.get(i)
        if col is None:
            full_width.append((y_center, i))
        else:
            columns[col].append((y_center, i))

    # Sort within each column by Y
    full_width.sort(key=lambda x: x[0])
    for col in columns:
        columns[col].sort(key=lambda x: x[0])

    # Build column groups: for each column, group objects between full-width items
    # Simple approach: interleave by Y position of first object in each group
    ordered_indices = []

    # Create groups from columns, ordered by column number
    col_groups = []
    sorted_cols = sorted(columns.keys())

    if not sorted_cols:
        # No column objects, just full-width
        ordered_indices = [idx for _, idx in full_width]
    else:
        # Build blocks: a block is a set of column objects between two full-width objects
        # We interleave by taking the top Y of each block

        # Get all full-width Y positions as dividers
        fw_items = list(full_width)  # (y, idx)

        # Collect all column items with their Y and column
        all_col_items = []
        for col_num in sorted_cols:
            for y, idx in columns[col_num]:
                all_col_items.append((y, col_num, idx))

        # Sort everything by Y position, with columns ordered left-to-right at same Y
        all_items = []
        for y, idx in fw_items:
            all_items.append((y, -1, idx))  # col=-1 means full-width
        for y, col, idx in all_col_items:
            all_items.append((y, col, idx))

        # Sort by Y first, then by column (full-width=-1 comes first at same Y)
        all_items.sort(key=lambda x: (x[0], x[1]))
        ordered_indices = [idx for _, _, idx in all_items]

    return ordered_indices


def infer_heading_hierarchy(
    objects: list[dict],
    text_spans: list[dict],
    page_height_px: int,
    dpi: int,
) -> dict[int, int]:
    """Infer heading_level for title and section_heading objects using font signatures.

    Returns mapping of object index → heading level (1-6).
    Uses text_spans inside each heading's bbox for font size/bold analysis.
    Per architecture D6: cluster by font signature, rank by visual prominence.
    """
    heading_indices = []
    heading_font_sigs = []

    for i, obj in enumerate(objects):
        if obj["label"] not in ("title", "section_heading"):
            continue
        heading_indices.append(i)

        # Find text_spans that fall within this object's bbox
        # text_spans are in PDF coords; objects are in pixel coords
        # Convert object bbox to PDF coords for comparison
        scale = 72.0 / dpi
        pdf_x1 = obj["bbox_x1"] * scale
        pdf_x2 = obj["bbox_x2"] * scale
        # PDF Y is bottom-up; pixel Y is top-down
        page_height_pts = page_height_px * scale
        pdf_y1 = page_height_pts - (obj["bbox_y2"] * scale)
        pdf_y2 = page_height_pts - (obj["bbox_y1"] * scale)

        matching_spans = []
        for span in text_spans:
            # Check overlap (not containment, because bbox edges may not align exactly)
            if (span["x1"] < pdf_x2 and span["x2"] > pdf_x1 and
                    span["y1"] < pdf_y2 and span["y2"] > pdf_y1):
                matching_spans.append(span)

        if matching_spans:
            # Font signature: max font size, bold presence
            max_size = max(s["font_size"] for s in matching_spans)
            is_bold = any(s["is_bold"] for s in matching_spans)
            heading_font_sigs.append((max_size, is_bold))
        else:
            # No matching spans — can happen on scanned pages
            heading_font_sigs.append((0.0, False))

    if not heading_indices:
        return {}

    # Cluster headings by font signature similarity
    # Sort by visual prominence: larger font size = higher level (lower number)
    # Bold at same size = higher level
    sig_to_level: dict[tuple[float, bool], int] = {}
    unique_sigs = sorted(set(heading_font_sigs),
                         key=lambda s: (-s[0], -int(s[1])))

    for rank, sig in enumerate(unique_sigs):
        sig_to_level[sig] = min(rank + 1, 6)

    # Title objects always get level 1 (override font-based ranking)
    result = {}
    for idx, sig in zip(heading_indices, heading_font_sigs):
        obj = objects[idx]
        if obj["label"] == "title":
            result[idx] = 1
        else:
            result[idx] = sig_to_level.get(sig, 3)

    return result


async def detect_document(db, doc_id: str, broadcast_fn=None) -> int:
    """Run Stage 1 detection on all pages of a document.

    Returns total number of objects detected.
    """
    # Verify document exists and is at stage 0 complete
    rows = await db.execute_fetchall(
        "SELECT current_stage, stage_status FROM documents WHERE id=?",
        (doc_id,),
    )
    if not rows:
        raise ValueError(f"Document {doc_id} not found")

    stage, status = rows[0]
    if stage < 0 or (stage == 0 and status != "complete"):
        raise ValueError(f"Document {doc_id} not ready for detection (stage={stage}, status={status})")

    # Mark as running
    await db.execute(
        "UPDATE documents SET current_stage=1, stage_status='running' WHERE id=?",
        (doc_id,),
    )
    await db.commit()

    # Get all pages
    page_rows = await db.execute_fetchall(
        """SELECT id, page_number, image_path, width_px, height_px, dpi
           FROM pages WHERE document_id=? ORDER BY page_number""",
        (doc_id,),
    )

    total_objects = 0

    for pr in page_rows:
        page_id, page_number, image_path, width_px, height_px, dpi = pr

        # Run YOLO detection
        raw_objects = detect_page_objects(image_path)

        if not raw_objects:
            logger.info("Page %d: no objects detected", page_number)
            if broadcast_fn:
                await broadcast_fn(doc_id, "page.detected", {
                    "document_id": doc_id,
                    "page_number": page_number,
                    "object_count": 0,
                })
            continue

        # Suppress text-ish objects that sit fully inside a figure bbox. YOLO
        # often detects STEP banners / tiny captions baked into a figure panel
        # as their own objects, but Gemma transcribes the whole figure crop —
        # keeping both would duplicate content in the markdown.
        before_count = len(raw_objects)
        raw_objects = suppress_figure_contained(raw_objects)
        absorbed = before_count - len(raw_objects)
        if absorbed:
            logger.info(
                "Page %d: absorbed %d objects into parent figure(s)",
                page_number, absorbed,
            )

        # Get text_spans for this page (for post-processing)
        span_rows = await db.execute_fetchall(
            """SELECT text, x1, y1, x2, y2, font_name, font_size, is_bold, is_italic, color
               FROM text_spans WHERE page_id=?""",
            (page_id,),
        )
        text_spans = [
            {
                "text": sr[0], "x1": sr[1], "y1": sr[2], "x2": sr[3], "y2": sr[4],
                "font_name": sr[5], "font_size": sr[6], "is_bold": sr[7],
                "is_italic": sr[8], "color": sr[9],
            }
            for sr in span_rows
        ]

        # Post-processing: column detection via DBSCAN on text_span X-midpoints
        column_assignments = compute_column_clusters(raw_objects, width_px)

        # Reading order
        ordered_indices = compute_reading_order(raw_objects, column_assignments)
        reading_order_map = {idx: order for order, idx in enumerate(ordered_indices)}

        # Heading hierarchy
        heading_levels = infer_heading_hierarchy(raw_objects, text_spans, height_px, dpi)

        # Insert objects into database
        for i, obj in enumerate(raw_objects):
            obj_id = str(uuid.uuid4())
            reading_order = reading_order_map.get(i, i)
            heading_level = heading_levels.get(i)

            await db.execute(
                """INSERT INTO objects
                   (id, page_id, label, bbox_x1, bbox_y1, bbox_x2, bbox_y2,
                    confidence, reading_order, heading_level, source, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'detected', 'unreviewed')""",
                (obj_id, page_id, obj["label"],
                 obj["bbox_x1"], obj["bbox_y1"], obj["bbox_x2"], obj["bbox_y2"],
                 obj["confidence"], reading_order, heading_level),
            )

        # Update page object count
        await db.execute(
            "UPDATE pages SET object_count=? WHERE id=?",
            (len(raw_objects), page_id),
        )
        await db.commit()

        total_objects += len(raw_objects)
        logger.info("Page %d: %d objects detected", page_number, len(raw_objects))

        if broadcast_fn:
            await broadcast_fn(doc_id, "page.detected", {
                "document_id": doc_id,
                "page_number": page_number,
                "object_count": len(raw_objects),
            })

    # Mark stage complete
    await db.execute(
        "UPDATE documents SET current_stage=1, stage_status='complete' WHERE id=?",
        (doc_id,),
    )
    await db.commit()

    if broadcast_fn:
        await broadcast_fn(doc_id, "stage.completed", {
            "stage": "detect",
            "total_objects": total_objects,
        })

    return total_objects
