"""Edit service: apply batched object edits with undo/redo support.

Every user action produces a batch (group of related edits).
Each edit writes an object_edits row with a full object_snapshot.
One undo_stack entry per batch with a human-readable description.
Undo restores objects from snapshots. Redo re-applies from snapshots.
"""
import json
import uuid

import aiosqlite

VALID_LABELS = {
    "title", "section_heading", "paragraph", "table",
    "figure", "caption", "footnote", "list", "formula",
    "page_header", "page_footer", "watermark",
}


async def _get_object(db: aiosqlite.Connection, object_id: str) -> dict | None:
    row = await db.execute_fetchall(
        """SELECT id, page_id, label, bbox_x1, bbox_y1, bbox_x2, bbox_y2,
                  confidence, reading_order, reading_order_manual, heading_level,
                  source, status, parent_id, continues_from, continues_to,
                  extraction_stale, created_at
           FROM objects WHERE id=?""",
        (object_id,),
    )
    if not row:
        return None
    r = row[0]
    return {
        "id": r[0], "page_id": r[1], "label": r[2],
        "bbox_x1": r[3], "bbox_y1": r[4], "bbox_x2": r[5], "bbox_y2": r[6],
        "confidence": r[7], "reading_order": r[8], "reading_order_manual": r[9],
        "heading_level": r[10], "source": r[11], "status": r[12],
        "parent_id": r[13], "continues_from": r[14], "continues_to": r[15],
        "extraction_stale": r[16], "created_at": r[17],
    }


async def _snapshot_object(db: aiosqlite.Connection, object_id: str) -> str:
    obj = await _get_object(db, object_id)
    return json.dumps(obj)


async def _restore_object_from_snapshot(db: aiosqlite.Connection, snapshot_json: str):
    obj = json.loads(snapshot_json)
    await db.execute(
        """INSERT OR REPLACE INTO objects
           (id, page_id, label, bbox_x1, bbox_y1, bbox_x2, bbox_y2,
            confidence, reading_order, reading_order_manual, heading_level,
            source, status, parent_id, continues_from, continues_to,
            extraction_stale, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (obj["id"], obj["page_id"], obj["label"],
         obj["bbox_x1"], obj["bbox_y1"], obj["bbox_x2"], obj["bbox_y2"],
         obj["confidence"], obj["reading_order"], obj["reading_order_manual"],
         obj["heading_level"], obj["source"], obj["status"],
         obj["parent_id"], obj["continues_from"], obj["continues_to"],
         obj["extraction_stale"], obj["created_at"]),
    )


async def _recompute_reading_order(db: aiosqlite.Connection, page_id: str) -> None:
    """Recompute reading order for non-pinned objects on a page.

    Pinned objects (reading_order_manual=1) keep their positions; new/unpinned
    objects fill the remaining slots using the detect-stage algorithm.

    Import inside the function to avoid a circular import (detect imports
    model_manager → indirectly imports aiosqlite + this module).
    """
    from app.services.detect import compute_column_clusters, compute_reading_order

    page_rows = await db.execute_fetchall(
        "SELECT width_px FROM pages WHERE id=?", (page_id,),
    )
    if not page_rows:
        return
    page_width = page_rows[0][0]

    obj_rows = await db.execute_fetchall(
        """SELECT id, bbox_x1, bbox_y1, bbox_x2, bbox_y2,
                  reading_order, reading_order_manual
           FROM objects WHERE page_id=?""",
        (page_id,),
    )
    if not obj_rows:
        return

    objects = [
        {
            "id": r[0],
            "bbox_x1": r[1], "bbox_y1": r[2],
            "bbox_x2": r[3], "bbox_y2": r[4],
        }
        for r in obj_rows
    ]
    pinned = {r[0]: r[5] for r in obj_rows if r[6]}

    column_assignments = compute_column_clusters(objects, page_width)
    ordered_indices = compute_reading_order(objects, column_assignments)

    # Allocate slots: pinned keeps its slot; others fill gaps.
    used_slots = set(pinned.values())
    new_order = {obj_id: slot for obj_id, slot in pinned.items()}

    next_slot = 0
    for idx in ordered_indices:
        obj_id = objects[idx]["id"]
        if obj_id in pinned:
            continue
        while next_slot in used_slots:
            next_slot += 1
        new_order[obj_id] = next_slot
        used_slots.add(next_slot)
        next_slot += 1

    for obj_id, slot in new_order.items():
        await db.execute(
            "UPDATE objects SET reading_order=? WHERE id=?",
            (slot, obj_id),
        )


async def _update_page_counts(db: aiosqlite.Connection, page_id: str):
    await db.execute(
        """UPDATE pages SET
             object_count = (SELECT COUNT(*) FROM objects WHERE page_id=?),
             confirmed_count = (SELECT COUNT(*) FROM objects WHERE page_id=? AND status='confirmed')
           WHERE id=?""",
        (page_id, page_id, page_id),
    )
    # Update review_status based on object statuses
    rows = await db.execute_fetchall(
        """SELECT
             COUNT(*) as total,
             SUM(CASE WHEN status='unreviewed' THEN 1 ELSE 0 END) as unreviewed
           FROM objects WHERE page_id=?""",
        (page_id,),
    )
    total, unreviewed = rows[0][0], rows[0][1]
    if total == 0:
        status = "not_started"
    elif unreviewed == 0:
        status = "complete"
    elif unreviewed < total:
        status = "in_progress"
    else:
        status = "not_started"
    await db.execute(
        "UPDATE pages SET review_status=? WHERE id=?",
        (status, page_id),
    )


def _describe_edit(edit: dict) -> str:
    """Generate human-readable description for undo toast."""
    action = edit.get("action", "")
    label = edit.get("label", edit.get("old_label", "object"))

    descriptions = {
        "confirm": f"Confirmed {label}",
        "reject": f"Rejected {label}",
        "relabel": f"Relabeled to {edit.get('label', '?')}",
        "move": f"Moved {label}",
        "resize": f"Resized {label}",
        "delete": f"Deleted {label}",
        "create": f"Drew new {edit.get('label', 'object')}",
        "set_heading_level": f"Set heading level {edit.get('heading_level', '?')}",
        "auto_confirm": f"Auto-confirmed {edit.get('count', '?')} objects above threshold",
    }
    return descriptions.get(action, f"Edited {label}")


async def apply_edits(
    db: aiosqlite.Connection,
    document_id: str,
    edits: list[dict],
) -> dict:
    """Apply a batch of edits to objects.

    Each edit dict has:
      action: confirm|reject|relabel|move|resize|delete|create|set_heading_level|auto_confirm
      object_id: str (not required for create)
      + action-specific fields (label, bbox_*, heading_level, etc.)

    Returns: {batch_id, description, affected_objects: [...]}
    """
    batch_id = str(uuid.uuid4())
    affected_objects = []
    affected_pages = set()
    descriptions = []

    # Truncate any undone entries (standard linear undo model)
    await db.execute(
        "DELETE FROM undo_stack WHERE document_id=? AND undone=1",
        (document_id,),
    )
    # Also delete orphaned object_edits for truncated undo entries
    await db.execute(
        """DELETE FROM object_edits WHERE document_id=? AND batch_id IN
           (SELECT batch_id FROM undo_stack WHERE document_id=? AND undone=1)""",
        (document_id, document_id),
    )

    for edit in edits:
        action = edit["action"]

        if action == "create":
            obj_id = str(uuid.uuid4())
            page_id = edit["page_id"]
            label = edit.get("label", "paragraph")
            if label not in VALID_LABELS:
                raise ValueError(f"Invalid label: {label}")

            await db.execute(
                """INSERT INTO objects (id, page_id, label, bbox_x1, bbox_y1, bbox_x2, bbox_y2,
                   source, status)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (obj_id, page_id, label,
                 edit["bbox_x1"], edit["bbox_y1"], edit["bbox_x2"], edit["bbox_y2"],
                 "manual", "unreviewed"),
            )

            snapshot = await _snapshot_object(db, obj_id)
            await db.execute(
                """INSERT INTO object_edits
                   (batch_id, document_id, object_id, edit_type, object_snapshot)
                   VALUES (?,?,?,?,?)""",
                (batch_id, document_id, obj_id, "create", snapshot),
            )
            affected_objects.append(obj_id)
            affected_pages.add(page_id)

        elif action == "delete":
            obj_id = edit["object_id"]
            snapshot = await _snapshot_object(db, obj_id)
            obj = json.loads(snapshot)
            affected_pages.add(obj["page_id"])

            await db.execute(
                """INSERT INTO object_edits
                   (batch_id, document_id, object_id, edit_type, object_snapshot)
                   VALUES (?,?,?,?,?)""",
                (batch_id, document_id, obj_id, "delete", snapshot),
            )
            await db.execute("DELETE FROM objects WHERE id=?", (obj_id,))
            affected_objects.append(obj_id)

        elif action in ("confirm", "reject"):
            obj_id = edit["object_id"]
            snapshot = await _snapshot_object(db, obj_id)
            obj = json.loads(snapshot)
            affected_pages.add(obj["page_id"])

            new_status = "confirmed" if action == "confirm" else "rejected"
            await db.execute(
                """INSERT INTO object_edits
                   (batch_id, document_id, object_id, edit_type, field_name,
                    old_value, new_value, object_snapshot)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (batch_id, document_id, obj_id, "update", "status",
                 obj["status"], new_status, snapshot),
            )
            await db.execute(
                "UPDATE objects SET status=? WHERE id=?",
                (new_status, obj_id),
            )
            affected_objects.append(obj_id)

        elif action == "relabel":
            obj_id = edit["object_id"]
            new_label = edit["label"]
            if new_label not in VALID_LABELS:
                raise ValueError(f"Invalid label: {new_label}")

            snapshot = await _snapshot_object(db, obj_id)
            obj = json.loads(snapshot)
            affected_pages.add(obj["page_id"])

            await db.execute(
                """INSERT INTO object_edits
                   (batch_id, document_id, object_id, edit_type, field_name,
                    old_value, new_value, object_snapshot)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (batch_id, document_id, obj_id, "update", "label",
                 obj["label"], new_label, snapshot),
            )
            await db.execute(
                "UPDATE objects SET label=?, extraction_stale=1 WHERE id=?",
                (new_label, obj_id),
            )
            affected_objects.append(obj_id)

        elif action in ("move", "resize"):
            obj_id = edit["object_id"]
            snapshot = await _snapshot_object(db, obj_id)
            obj = json.loads(snapshot)
            affected_pages.add(obj["page_id"])

            old_bbox = json.dumps({
                "bbox_x1": obj["bbox_x1"], "bbox_y1": obj["bbox_y1"],
                "bbox_x2": obj["bbox_x2"], "bbox_y2": obj["bbox_y2"],
            })
            new_bbox = json.dumps({
                "bbox_x1": edit["bbox_x1"], "bbox_y1": edit["bbox_y1"],
                "bbox_x2": edit["bbox_x2"], "bbox_y2": edit["bbox_y2"],
            })

            await db.execute(
                """INSERT INTO object_edits
                   (batch_id, document_id, object_id, edit_type, field_name,
                    old_value, new_value, object_snapshot)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (batch_id, document_id, obj_id, "update", "bbox",
                 old_bbox, new_bbox, snapshot),
            )
            await db.execute(
                """UPDATE objects SET
                     bbox_x1=?, bbox_y1=?, bbox_x2=?, bbox_y2=?, extraction_stale=1
                   WHERE id=?""",
                (edit["bbox_x1"], edit["bbox_y1"],
                 edit["bbox_x2"], edit["bbox_y2"], obj_id),
            )
            affected_objects.append(obj_id)

        elif action == "set_heading_level":
            obj_id = edit["object_id"]
            snapshot = await _snapshot_object(db, obj_id)
            obj = json.loads(snapshot)
            affected_pages.add(obj["page_id"])

            await db.execute(
                """INSERT INTO object_edits
                   (batch_id, document_id, object_id, edit_type, field_name,
                    old_value, new_value, object_snapshot)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (batch_id, document_id, obj_id, "update", "heading_level",
                 str(obj["heading_level"]), str(edit["heading_level"]), snapshot),
            )
            await db.execute(
                "UPDATE objects SET heading_level=? WHERE id=?",
                (edit["heading_level"], obj_id),
            )
            affected_objects.append(obj_id)

        elif action == "auto_confirm":
            threshold = edit.get("threshold", 0.90)
            rows = await db.execute_fetchall(
                """SELECT o.id, o.page_id FROM objects o
                   JOIN pages p ON o.page_id = p.id
                   WHERE p.document_id=? AND o.status='unreviewed'
                     AND o.confidence IS NOT NULL AND o.confidence >= ?""",
                (document_id, threshold),
            )
            count = 0
            for r in rows:
                obj_id, page_id = r[0], r[1]
                snapshot = await _snapshot_object(db, obj_id)
                await db.execute(
                    """INSERT INTO object_edits
                       (batch_id, document_id, object_id, edit_type, field_name,
                        old_value, new_value, object_snapshot)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (batch_id, document_id, obj_id, "update", "status",
                     "unreviewed", "confirmed", snapshot),
                )
                await db.execute(
                    "UPDATE objects SET status='confirmed' WHERE id=?",
                    (obj_id,),
                )
                affected_objects.append(obj_id)
                affected_pages.add(page_id)
                count += 1
            edit["count"] = count

        descriptions.append(_describe_edit(edit))

    # Update page counts + reading order for all affected pages
    for page_id in affected_pages:
        await _recompute_reading_order(db, page_id)
        await _update_page_counts(db, page_id)

    # Write undo stack entry
    description = "; ".join(descriptions) if len(descriptions) > 1 else (descriptions[0] if descriptions else "Edit")
    await db.execute(
        """INSERT INTO undo_stack (document_id, batch_id, description)
           VALUES (?,?,?)""",
        (document_id, batch_id, description),
    )

    await db.commit()

    # Fetch updated objects to return
    result_objects = []
    for obj_id in affected_objects:
        obj = await _get_object(db, obj_id)
        if obj:
            result_objects.append(obj)

    return {
        "batch_id": batch_id,
        "description": description,
        "affected_objects": result_objects,
    }


async def undo(db: aiosqlite.Connection, document_id: str) -> dict | None:
    """Undo the most recent non-undone batch. Returns batch info or None if nothing to undo."""
    rows = await db.execute_fetchall(
        """SELECT id, batch_id, description FROM undo_stack
           WHERE document_id=? AND undone=0
           ORDER BY id DESC LIMIT 1""",
        (document_id,),
    )
    if not rows:
        return None

    stack_id, batch_id, description = rows[0][0], rows[0][1], rows[0][2]

    # Get all edits in this batch, in reverse order
    edit_rows = await db.execute_fetchall(
        """SELECT id, object_id, edit_type, object_snapshot FROM object_edits
           WHERE batch_id=? ORDER BY id DESC""",
        (batch_id,),
    )

    affected_pages = set()

    for er in edit_rows:
        edit_id, object_id, edit_type, snapshot_json = er[0], er[1], er[2], er[3]

        if edit_type == "create":
            # Undo create = delete the object
            obj = await _get_object(db, object_id)
            if obj:
                affected_pages.add(obj["page_id"])
            await db.execute("DELETE FROM objects WHERE id=?", (object_id,))

        elif edit_type == "delete":
            # Undo delete = restore from snapshot
            obj = json.loads(snapshot_json)
            affected_pages.add(obj["page_id"])
            await _restore_object_from_snapshot(db, snapshot_json)

        elif edit_type == "update":
            # Undo update = restore from snapshot
            obj = json.loads(snapshot_json)
            affected_pages.add(obj["page_id"])
            await _restore_object_from_snapshot(db, snapshot_json)

    # Mark batch as undone
    await db.execute(
        "UPDATE undo_stack SET undone=1 WHERE id=?",
        (stack_id,),
    )

    for page_id in affected_pages:
        await _recompute_reading_order(db, page_id)
        await _update_page_counts(db, page_id)

    await db.commit()
    return {"batch_id": batch_id, "description": description, "action": "undo"}


async def redo(db: aiosqlite.Connection, document_id: str) -> dict | None:
    """Redo the most recently undone batch. Returns batch info or None if nothing to redo."""
    rows = await db.execute_fetchall(
        """SELECT id, batch_id, description FROM undo_stack
           WHERE document_id=? AND undone=1
           ORDER BY id ASC LIMIT 1""",
        (document_id,),
    )
    if not rows:
        return None

    stack_id, batch_id, description = rows[0][0], rows[0][1], rows[0][2]

    # Get all edits in this batch, in forward order
    edit_rows = await db.execute_fetchall(
        """SELECT id, object_id, edit_type, field_name, new_value, object_snapshot
           FROM object_edits WHERE batch_id=? ORDER BY id ASC""",
        (batch_id,),
    )

    affected_pages = set()

    for er in edit_rows:
        edit_id, object_id, edit_type = er[0], er[1], er[2]
        field_name, new_value, snapshot_json = er[3], er[4], er[5]

        if edit_type == "create":
            # Redo create = re-insert from the snapshot we stored AFTER creation
            obj_data = json.loads(snapshot_json)
            affected_pages.add(obj_data["page_id"])
            await _restore_object_from_snapshot(db, snapshot_json)

        elif edit_type == "delete":
            # Redo delete = delete again
            obj = await _get_object(db, object_id)
            if obj:
                affected_pages.add(obj["page_id"])
            await db.execute("DELETE FROM objects WHERE id=?", (object_id,))

        elif edit_type == "update":
            obj = await _get_object(db, object_id)
            if obj:
                affected_pages.add(obj["page_id"])

            if field_name == "status":
                await db.execute(
                    "UPDATE objects SET status=? WHERE id=?",
                    (new_value, object_id),
                )
            elif field_name == "label":
                await db.execute(
                    "UPDATE objects SET label=?, extraction_stale=1 WHERE id=?",
                    (new_value, object_id),
                )
            elif field_name == "bbox":
                bbox = json.loads(new_value)
                await db.execute(
                    """UPDATE objects SET
                         bbox_x1=?, bbox_y1=?, bbox_x2=?, bbox_y2=?, extraction_stale=1
                       WHERE id=?""",
                    (bbox["bbox_x1"], bbox["bbox_y1"],
                     bbox["bbox_x2"], bbox["bbox_y2"], object_id),
                )
            elif field_name == "heading_level":
                await db.execute(
                    "UPDATE objects SET heading_level=? WHERE id=?",
                    (int(new_value) if new_value else None, object_id),
                )

    # Mark batch as not-undone
    await db.execute(
        "UPDATE undo_stack SET undone=0 WHERE id=?",
        (stack_id,),
    )

    for page_id in affected_pages:
        await _recompute_reading_order(db, page_id)
        await _update_page_counts(db, page_id)

    await db.commit()
    return {"batch_id": batch_id, "description": description, "action": "redo"}


async def get_undo_state(db: aiosqlite.Connection, document_id: str) -> dict:
    """Get current undo/redo state for the document."""
    # Last undoable action
    undo_rows = await db.execute_fetchall(
        """SELECT description FROM undo_stack
           WHERE document_id=? AND undone=0
           ORDER BY id DESC LIMIT 1""",
        (document_id,),
    )
    # Next redoable action
    redo_rows = await db.execute_fetchall(
        """SELECT description FROM undo_stack
           WHERE document_id=? AND undone=1
           ORDER BY id ASC LIMIT 1""",
        (document_id,),
    )

    # Total edit count for corrections counter
    edit_count_rows = await db.execute_fetchall(
        """SELECT COUNT(*) FROM object_edits WHERE document_id=?""",
        (document_id,),
    )

    return {
        "can_undo": len(undo_rows) > 0,
        "undo_description": undo_rows[0][0] if undo_rows else None,
        "can_redo": len(redo_rows) > 0,
        "redo_description": redo_rows[0][0] if redo_rows else None,
        "total_edits": edit_count_rows[0][0],
    }
