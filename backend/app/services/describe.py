"""Stage 1.5 — Pre-review Description.

Runs Gemma 4 on every detected object BEFORE human review. The model's read
is stored on the object row so the reviewer sees it inline during Stage 2.
This is the architectural fix from 2026-04-18: doctors review AI radiology
reads, they don't review raw images. Corrections against Gemma's actual
output become high-quality training tuples (see training_examples table).

Re-run is idempotent per object: objects with description_status='described'
are skipped unless `force=True`.

For figures, this is also where the asset PNG is cropped and saved.
"""
import json
import logging
import time

import aiosqlite

from app.services.gemma import (
    get_few_shot_examples,
    run_gemma,
    save_figure_asset,
)

logger = logging.getLogger(__name__)


SKIP_LABELS = {"watermark"}


async def describe_document(
    db: aiosqlite.Connection,
    doc_id: str,
    broadcast_fn=None,
    use_llm: bool = True,
    force: bool = False,
) -> dict:
    """Run Gemma on every object in the document.

    Args:
        force: if True, re-describe objects already marked 'described'.
        use_llm: if False, writes deterministic stub descriptions.
                 Only used for smoke tests where GPU is unavailable.

    Returns {total_described, failed, skipped, objects: [{object_id, status}]}
    """
    doc_rows = await db.execute_fetchall(
        "SELECT current_stage, stage_status FROM documents WHERE id=?",
        (doc_id,),
    )
    if not doc_rows:
        raise ValueError("Document not found")

    current_stage, _status = doc_rows[0]
    if current_stage < 1:
        raise ValueError(
            f"Document must be detected (stage >= 1) before description (stage={current_stage})"
        )

    obj_rows = await db.execute_fetchall(
        """SELECT o.id, o.label, o.description_status,
                  o.bbox_x1, o.bbox_y1, o.bbox_x2, o.bbox_y2,
                  p.image_path, p.pdf_type, p.page_number
           FROM objects o
           JOIN pages p ON o.page_id = p.id
           WHERE p.document_id = ?
           ORDER BY p.page_number, o.reading_order""",
        (doc_id,),
    )

    if not obj_rows:
        return {"total_described": 0, "failed": 0, "skipped": 0, "objects": []}

    await db.execute(
        "UPDATE documents SET stage_status='running' WHERE id=?",
        (doc_id,),
    )
    await db.commit()

    # Lazy-load model manager only when a real LLM call is required.
    model_manager = None

    results = []
    described = 0
    failed = 0
    skipped = 0

    for row in obj_rows:
        obj_id = row[0]
        label = row[1]
        existing_status = row[2]
        bbox_px = {
            "bbox_x1": row[3], "bbox_y1": row[4],
            "bbox_x2": row[5], "bbox_y2": row[6],
        }
        image_path = row[7]
        pdf_type = row[8]

        # Idempotency: skip already-described unless forced.
        # Stub rows are NOT considered real descriptions — a real Gemma run
        # must always overwrite them.
        if existing_status == "described" and not force:
            existing_model_rows = await db.execute_fetchall(
                "SELECT description_model FROM objects WHERE id=?", (obj_id,),
            )
            existing_model = existing_model_rows[0][0] if existing_model_rows else None
            is_stub = existing_model == "stub"
            # Only skip when the existing description is non-stub, OR when the
            # caller is also running a stub pass (re-stubbing is pointless).
            if not is_stub or not use_llm:
                skipped += 1
                results.append({"object_id": obj_id, "status": "already_described"})
                continue

        # Fixed skips
        if label in SKIP_LABELS:
            await db.execute(
                """UPDATE objects
                   SET description_status='skipped', description=?,
                       description_model=NULL, description_metadata_json=?
                   WHERE id=?""",
                ("", json.dumps({"reason": f"{label}_skipped"}), obj_id),
            )
            skipped += 1
            results.append({"object_id": obj_id, "status": "skipped"})
            continue

        # Figures always save their asset PNG during this stage
        asset_path = None
        if label == "figure":
            try:
                asset_path = save_figure_asset(image_path, bbox_px, doc_id, obj_id)
                await db.execute(
                    "UPDATE objects SET asset_path=? WHERE id=?",
                    (asset_path, obj_id),
                )
            except Exception as e:
                logger.warning("Figure asset save failed for %s: %s", obj_id, e)

        # Run the model (or stub)
        content: str | None = None
        metadata: dict = {}
        model_name = "gemma-4-E4B-it"

        if not use_llm:
            content = f"[stub description: label={label}]"
            metadata = {"stub": True, "reason": "use_llm=false"}
            model_name = "stub"
        else:
            try:
                few_shot = await get_few_shot_examples(db, label, pdf_type)
                if model_manager is None:
                    from app.services.model_manager import model_manager as mm
                    model_manager = mm
                content, metadata = await run_gemma(
                    model_manager, image_path, bbox_px, label, few_shot,
                )
            except Exception as e:
                logger.warning("Gemma unavailable for object %s (%s): %s", obj_id, label, e)
                metadata = {"llm_unavailable": True, "error": str(e)[:500]}

        if content:
            new_status = "described"
            described += 1
        else:
            new_status = "failed"
            failed += 1
            metadata["failed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")

        await db.execute(
            """UPDATE objects
               SET description=?, description_model=?, description_metadata_json=?,
                   description_status=?
               WHERE id=?""",
            (content, model_name, json.dumps(metadata), new_status, obj_id),
        )
        await db.commit()

        results.append({
            "object_id": obj_id,
            "status": new_status,
            "has_asset": asset_path is not None,
        })

        if broadcast_fn:
            await broadcast_fn(doc_id, "object.described", {
                "object_id": obj_id,
                "status": new_status,
                "progress": f"{described + failed + skipped}/{len(obj_rows)}",
            })

    await db.execute(
        "UPDATE documents SET stage_status='complete' WHERE id=?",
        (doc_id,),
    )
    await db.commit()

    if broadcast_fn:
        await broadcast_fn(doc_id, "stage.completed", {
            "stage": "describe",
            "total_described": described,
            "failed": failed,
            "skipped": skipped,
        })

    return {
        "total_described": described,
        "failed": failed,
        "skipped": skipped,
        "objects": results,
    }


async def describe_single_object(
    db: aiosqlite.Connection,
    object_id: str,
    use_llm: bool = True,
) -> dict:
    """Re-describe a single object (for the per-object retry button in the UI)."""
    rows = await db.execute_fetchall(
        """SELECT o.id, o.label,
                  o.bbox_x1, o.bbox_y1, o.bbox_x2, o.bbox_y2,
                  p.image_path, p.pdf_type, p.document_id
           FROM objects o
           JOIN pages p ON o.page_id = p.id
           WHERE o.id = ?""",
        (object_id,),
    )
    if not rows:
        raise ValueError("Object not found")

    r = rows[0]
    bbox_px = {
        "bbox_x1": r[2], "bbox_y1": r[3],
        "bbox_x2": r[4], "bbox_y2": r[5],
    }
    label = r[1]
    image_path = r[6]
    pdf_type = r[7]

    if label in SKIP_LABELS:
        return {"object_id": object_id, "status": "skipped"}

    content: str | None = None
    metadata: dict = {}
    model_name = "gemma-4-E4B-it"

    if not use_llm:
        content = f"[stub description: label={label}]"
        metadata = {"stub": True}
        model_name = "stub"
    else:
        few_shot = await get_few_shot_examples(db, label, pdf_type)
        from app.services.model_manager import model_manager as mm
        content, metadata = await run_gemma(mm, image_path, bbox_px, label, few_shot)

    new_status = "described" if content else "failed"
    await db.execute(
        """UPDATE objects
           SET description=?, description_model=?, description_metadata_json=?,
               description_status=?, description_edited_by_user=0
           WHERE id=?""",
        (content, model_name, json.dumps(metadata), new_status, object_id),
    )
    await db.commit()

    return {"object_id": object_id, "status": new_status, "description": content}
