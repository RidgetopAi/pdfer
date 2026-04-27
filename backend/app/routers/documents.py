"""Document CRUD, ingest, detection, review edit, extraction, and assembly endpoints."""
import json
import logging
import uuid
from pathlib import Path

import aiosqlite
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

from app.config import UPLOAD_DIR
from app.database import get_db
from app.models.schemas import (
    AssemblyResponse,
    DescribeObjectRequest,
    DescribeObjectResponse,
    DescribeResponse,
    DetectionResponse,
    DocumentDetail,
    DocumentListResponse,
    DocumentResponse,
    EditBatchRequest,
    EditBatchResponse,
    ExtractionDetail,
    ExtractionResponse,
    ExtractionResult,
    ExtractionsListResponse,
    ObjectResponse,
    PageObjects,
    PageSummary,
    QueueObject,
    QueueViewResponse,
    ReviewStatsResponse,
    TrainingStatsResponse,
    UndoRedoResponse,
    UndoStateResponse,
)
from app.services.ingest import file_hash, ingest_document
from app.services.detect import detect_document
from app.services.edit import apply_edits, undo, redo, get_undo_state
from app.services.extract import extract_document
from app.services.describe import describe_document, describe_single_object
from app.services.assemble import assemble_document, build_bundle_zip
from app.services.gemma import save_training_crop
from app.services.model_manager import model_manager
from app.ws import manager

logger = logging.getLogger(__name__)
router = APIRouter()


DEFAULT_PROJECT_ID = "default"


async def _run_detect_background(doc_id: str) -> None:
    """Run YOLO detection on a freshly-ingested doc, with its own DB connection.

    Called from BackgroundTasks after upload returns. Failures are logged and
    flipped on the document so the dashboard surfaces stage_status='failed'
    instead of a permanent 'pending' that looks like a hang.
    """
    db = await get_db()
    try:
        await detect_document(db, doc_id, broadcast_fn=manager.broadcast)
    except Exception:
        logger.exception("Auto-detect failed for document %s", doc_id)
        try:
            await db.execute(
                "UPDATE documents SET current_stage=1, stage_status='failed' WHERE id=?",
                (doc_id,),
            )
            await db.commit()
            await manager.broadcast(doc_id, "stage.failed", {"stage": "detect"})
        except Exception:
            logger.exception("Failed to mark detect as failed for %s", doc_id)
    finally:
        await db.close()


async def ensure_default_project(db: aiosqlite.Connection):
    row = await db.execute_fetchall(
        "SELECT id FROM projects WHERE id=?", (DEFAULT_PROJECT_ID,)
    )
    if not row:
        await db.execute(
            "INSERT INTO projects (id, name) VALUES (?, ?)",
            (DEFAULT_PROJECT_ID, "Default"),
        )
        await db.commit()


@router.post("/documents", response_model=DocumentResponse)
async def upload_document(file: UploadFile, background_tasks: BackgroundTasks):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted")

    db = await get_db()
    try:
        await ensure_default_project(db)

        doc_id = str(uuid.uuid4())
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        dest = UPLOAD_DIR / f"{doc_id}.pdf"

        content = await file.read()
        dest.write_bytes(content)

        fhash = file_hash(dest)

        await db.execute(
            """INSERT INTO documents (id, project_id, filename, file_hash, file_path)
               VALUES (?, ?, ?, ?, ?)""",
            (doc_id, DEFAULT_PROJECT_ID, file.filename, fhash, str(dest)),
        )
        await db.commit()

        page_count = await ingest_document(db, doc_id, dest)

        await manager.broadcast(doc_id, "document.ingested", {
            "document_id": doc_id,
            "filename": file.filename,
            "page_count": page_count,
        })

        row = await db.execute_fetchall(
            "SELECT id, filename, page_count, current_stage, stage_status, created_at FROM documents WHERE id=?",
            (doc_id,),
        )
        r = row[0]
        # Auto-trigger detection. Runs in the background so the upload response
        # returns immediately; the dashboard picks up the stage transition via
        # WebSocket (stage.completed) and its 1.5s adaptive poll.
        background_tasks.add_task(_run_detect_background, doc_id)
        return DocumentResponse(
            id=r[0], filename=r[1], page_count=r[2],
            current_stage=r[3], stage_status=r[4], created_at=r[5],
        )
    finally:
        await db.close()


@router.get("/models/status")
async def models_status():
    """Snapshot of GPU model load state for the dashboard indicator.

    Returns {"active", "yolo", "gemma", "vram_mib"}. `active` is which model
    currently owns the GPU ("yolo" | "gemma" | None); the per-model fields
    report whether each is currently resident in memory.
    """
    return model_manager.status()


@router.get("/documents", response_model=DocumentListResponse)
async def list_documents():
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id, filename, page_count, current_stage, stage_status, created_at FROM documents ORDER BY created_at DESC"
        )
        docs = [
            DocumentResponse(
                id=r[0], filename=r[1], page_count=r[2],
                current_stage=r[3], stage_status=r[4], created_at=r[5],
            )
            for r in rows
        ]
        return DocumentListResponse(documents=docs)
    finally:
        await db.close()


@router.get("/documents/{doc_id}", response_model=DocumentDetail)
async def get_document(doc_id: str):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id, filename, page_count, current_stage, stage_status, created_at FROM documents WHERE id=?",
            (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")
        r = rows[0]

        page_rows = await db.execute_fetchall(
            """SELECT p.id, p.page_number, p.width_px, p.height_px, p.pdf_type, p.thumb_path,
               (SELECT COUNT(*) FROM text_spans ts WHERE ts.page_id = p.id) as span_count
               FROM pages p WHERE p.document_id=? ORDER BY p.page_number""",
            (doc_id,),
        )

        pages = [
            PageSummary(
                id=pr[0],
                page_number=pr[1],
                width_px=pr[2],
                height_px=pr[3],
                pdf_type=pr[4],
                thumb_url=f"/pages/{doc_id}/page_{pr[1]:04d}_thumb.webp" if pr[5] else None,
                text_span_count=pr[6],
            )
            for pr in page_rows
        ]

        return DocumentDetail(
            id=r[0], filename=r[1], page_count=r[2],
            current_stage=r[3], stage_status=r[4], created_at=r[5],
            pages=pages,
        )
    finally:
        await db.close()


@router.post("/documents/{doc_id}/detect", response_model=DetectionResponse)
async def detect_layout(doc_id: str, force: bool = False):
    db = await get_db()
    try:
        # Guard: detection is destructive to review work. Refuse if objects exist
        # unless the caller explicitly opts in with force=true.
        existing_rows = await db.execute_fetchall(
            """SELECT COUNT(*) FROM objects o
               JOIN pages p ON o.page_id = p.id
               WHERE p.document_id = ?""",
            (doc_id,),
        )
        existing_count = existing_rows[0][0] if existing_rows else 0
        if existing_count > 0 and not force:
            raise HTTPException(
                409,
                f"Detection already run ({existing_count} objects exist). "
                "Pass force=true to clear review work and re-detect.",
            )
        if existing_count > 0 and force:
            # Wipe objects + derived data for this document
            await db.execute(
                """DELETE FROM extractions WHERE object_id IN
                   (SELECT o.id FROM objects o
                    JOIN pages p ON o.page_id = p.id
                    WHERE p.document_id = ?)""",
                (doc_id,),
            )
            await db.execute(
                "DELETE FROM undo_stack WHERE document_id=?", (doc_id,),
            )
            await db.execute(
                "DELETE FROM object_edits WHERE document_id=?", (doc_id,),
            )
            await db.execute(
                """DELETE FROM objects WHERE id IN
                   (SELECT o.id FROM objects o
                    JOIN pages p ON o.page_id = p.id
                    WHERE p.document_id = ?)""",
                (doc_id,),
            )
            await db.commit()

        total = await detect_document(db, doc_id, broadcast_fn=manager.broadcast)

        # Fetch all objects grouped by page
        page_rows = await db.execute_fetchall(
            "SELECT id, page_number FROM pages WHERE document_id=? ORDER BY page_number",
            (doc_id,),
        )

        pages = []
        for pr in page_rows:
            page_id, page_number = pr[0], pr[1]
            obj_rows = await db.execute_fetchall(
                """SELECT id, page_id, label, bbox_x1, bbox_y1, bbox_x2, bbox_y2,
                          confidence, reading_order, heading_level, source, status,
                          description, description_model, description_status,
                          description_edited_by_user, asset_path
                   FROM objects WHERE page_id=? ORDER BY reading_order""",
                (page_id,),
            )
            objects = [
                ObjectResponse(
                    id=o[0], page_id=o[1], label=o[2],
                    bbox_x1=o[3], bbox_y1=o[4], bbox_x2=o[5], bbox_y2=o[6],
                    confidence=o[7], reading_order=o[8], heading_level=o[9],
                    source=o[10], status=o[11],
                    description=o[12], description_model=o[13],
                    description_status=o[14] or "pending",
                    description_edited_by_user=o[15] or 0,
                    asset_path=o[16],
                )
                for o in obj_rows
            ]
            pages.append(PageObjects(
                page_id=page_id, page_number=page_number, objects=objects,
            ))

        return DetectionResponse(
            document_id=doc_id, total_objects=total, pages=pages,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        await db.close()


@router.get("/documents/{doc_id}/objects")
async def get_objects(doc_id: str):
    db = await get_db()
    try:
        # Verify document exists
        rows = await db.execute_fetchall(
            "SELECT id FROM documents WHERE id=?", (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")

        page_rows = await db.execute_fetchall(
            "SELECT id, page_number FROM pages WHERE document_id=? ORDER BY page_number",
            (doc_id,),
        )

        pages = []
        for pr in page_rows:
            page_id, page_number = pr[0], pr[1]
            obj_rows = await db.execute_fetchall(
                """SELECT id, page_id, label, bbox_x1, bbox_y1, bbox_x2, bbox_y2,
                          confidence, reading_order, heading_level, source, status,
                          description, description_model, description_status,
                          description_edited_by_user, asset_path
                   FROM objects WHERE page_id=? ORDER BY reading_order""",
                (page_id,),
            )
            objects = [
                ObjectResponse(
                    id=o[0], page_id=o[1], label=o[2],
                    bbox_x1=o[3], bbox_y1=o[4], bbox_x2=o[5], bbox_y2=o[6],
                    confidence=o[7], reading_order=o[8], heading_level=o[9],
                    source=o[10], status=o[11],
                    description=o[12], description_model=o[13],
                    description_status=o[14] or "pending",
                    description_edited_by_user=o[15] or 0,
                    asset_path=o[16],
                )
                for o in obj_rows
            ]
            pages.append(PageObjects(
                page_id=page_id, page_number=page_number, objects=objects,
            ))

        return DetectionResponse(
            document_id=doc_id,
            total_objects=sum(len(p.objects) for p in pages),
            pages=pages,
        )
    finally:
        await db.close()


@router.post("/documents/{doc_id}/edits", response_model=EditBatchResponse)
async def edit_objects(doc_id: str, request: EditBatchRequest):
    db = await get_db()
    try:
        # Verify document exists
        rows = await db.execute_fetchall(
            "SELECT id FROM documents WHERE id=?", (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")

        result = await apply_edits(db, doc_id, [e.model_dump() for e in request.edits])

        await manager.broadcast(doc_id, "object.edited", {
            "batch_id": result["batch_id"],
            "description": result["description"],
            "affected_object_ids": [o["id"] for o in result["affected_objects"]],
        })

        return EditBatchResponse(**result)
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        await db.close()


@router.post("/documents/{doc_id}/undo")
async def undo_action(doc_id: str):
    db = await get_db()
    try:
        result = await undo(db, doc_id)
        if result is None:
            raise HTTPException(400, "Nothing to undo")

        await manager.broadcast(doc_id, "object.edited", {
            "batch_id": result["batch_id"],
            "action": "undo",
            "description": result["description"],
        })

        return UndoRedoResponse(**result)
    finally:
        await db.close()


@router.post("/documents/{doc_id}/redo")
async def redo_action(doc_id: str):
    db = await get_db()
    try:
        result = await redo(db, doc_id)
        if result is None:
            raise HTTPException(400, "Nothing to redo")

        await manager.broadcast(doc_id, "object.edited", {
            "batch_id": result["batch_id"],
            "action": "redo",
            "description": result["description"],
        })

        return UndoRedoResponse(**result)
    finally:
        await db.close()


@router.get("/documents/{doc_id}/undo-state", response_model=UndoStateResponse)
async def undo_state(doc_id: str):
    db = await get_db()
    try:
        state = await get_undo_state(db, doc_id)
        return UndoStateResponse(**state)
    finally:
        await db.close()


@router.get("/documents/{doc_id}/review-stats", response_model=ReviewStatsResponse)
async def review_stats(doc_id: str):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id FROM documents WHERE id=?", (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")

        obj_rows = await db.execute_fetchall(
            """SELECT
                 COUNT(*) as total,
                 SUM(CASE WHEN o.status='confirmed' THEN 1 ELSE 0 END) as confirmed,
                 SUM(CASE WHEN o.status='rejected' THEN 1 ELSE 0 END) as rejected,
                 SUM(CASE WHEN o.status='unreviewed' THEN 1 ELSE 0 END) as unreviewed
               FROM objects o
               JOIN pages p ON o.page_id = p.id
               WHERE p.document_id=?""",
            (doc_id,),
        )

        page_rows = await db.execute_fetchall(
            """SELECT
                 COUNT(*) as total,
                 SUM(CASE WHEN review_status='complete' THEN 1 ELSE 0 END) as complete
               FROM pages WHERE document_id=?""",
            (doc_id,),
        )

        r = obj_rows[0]
        p = page_rows[0]
        return ReviewStatsResponse(
            total_objects=r[0], confirmed=r[1], rejected=r[2], unreviewed=r[3],
            pages_complete=p[1], pages_total=p[0],
        )
    finally:
        await db.close()


@router.post("/documents/{doc_id}/describe", response_model=DescribeResponse)
async def describe_objects(doc_id: str, use_llm: bool = True, force: bool = False):
    """Stage 1.5 — run Gemma on every detected object before human review.

    Use `force=true` to re-describe objects already marked 'described'
    (e.g., after changing the prompt or model).
    """
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id FROM documents WHERE id=?", (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")

        result = await describe_document(
            db, doc_id, broadcast_fn=manager.broadcast,
            use_llm=use_llm, force=force,
        )
        return DescribeResponse(
            document_id=doc_id,
            total_described=result["total_described"],
            failed=result["failed"],
            skipped=result["skipped"],
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        await db.close()


@router.patch("/objects/{object_id}/description", response_model=DescribeObjectResponse)
async def patch_object_description(object_id: str, body: DescribeObjectRequest):
    """Save a human-corrected description.

    If the new text differs from Gemma's output, write a training_examples row.
    This is Loop B Phase 1 data collection (Patch v2 Change 2).
    """
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            """SELECT o.description, o.description_metadata_json,
                      o.label, p.pdf_type, p.id, p.document_id,
                      p.image_path, o.bbox_x1, o.bbox_y1, o.bbox_x2, o.bbox_y2
               FROM objects o
               JOIN pages p ON o.page_id = p.id
               WHERE o.id = ?""",
            (object_id,),
        )
        if not rows:
            raise HTTPException(404, "Object not found")

        r = rows[0]
        model_output = r[0] or ""
        metadata = json.loads(r[1]) if r[1] else {}
        label = r[2]
        pdf_type = r[3]
        page_id = r[4]
        document_id = r[5]
        image_path = r[6]
        bbox_px = {
            "bbox_x1": r[7], "bbox_y1": r[8], "bbox_x2": r[9], "bbox_y2": r[10],
        }

        new_text = body.description
        training_example_created = False

        # Only record a training tuple when the human actually changed something.
        # Skip when there was no prior model output (nothing to correct).
        if model_output and new_text.strip() != model_output.strip():
            try:
                crop_path = save_training_crop(image_path, bbox_px, document_id, object_id)
                prompt = metadata.get("prompt", "")
                edit_distance = abs(len(new_text) - len(model_output))
                await db.execute(
                    """INSERT INTO training_examples
                       (id, document_id, object_id, page_id, label, pdf_type,
                        image_crop_path, prompt, model_output, human_correction,
                        edit_distance)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (str(uuid.uuid4()), document_id, object_id, page_id, label,
                     pdf_type, crop_path, prompt, model_output, new_text,
                     edit_distance),
                )
                training_example_created = True
            except Exception as e:
                # Training capture failure must not block the user's edit
                import logging
                logging.getLogger(__name__).warning(
                    "Training capture failed for %s: %s", object_id, e,
                )

        await db.execute(
            """UPDATE objects
               SET description=?, description_edited_by_user=1
               WHERE id=?""",
            (new_text, object_id),
        )
        await db.commit()

        await manager.broadcast(document_id, "object.description_edited", {
            "object_id": object_id,
            "training_example_created": training_example_created,
        })

        return DescribeObjectResponse(
            object_id=object_id,
            description=new_text,
            description_edited_by_user=1,
            training_example_created=training_example_created,
        )
    finally:
        await db.close()


@router.post("/objects/{object_id}/redescribe", response_model=DescribeObjectResponse)
async def redescribe_single_object(object_id: str, use_llm: bool = True):
    """Re-run Gemma on a single object (per-object retry in the Inspector)."""
    db = await get_db()
    try:
        result = await describe_single_object(db, object_id, use_llm=use_llm)
        return DescribeObjectResponse(
            object_id=object_id,
            description=result.get("description"),
            description_edited_by_user=0,
            training_example_created=False,
        )
    except ValueError as e:
        raise HTTPException(404, str(e))
    finally:
        await db.close()


@router.get("/training/stats", response_model=TrainingStatsResponse)
async def training_stats():
    """Loop B Phase 1 corpus stats. Gates Phase 2 LoRA activation (>= 200 tuples)."""
    db = await get_db()
    try:
        total_rows = await db.execute_fetchall(
            "SELECT COUNT(*) FROM training_examples",
        )
        total = total_rows[0][0] if total_rows else 0

        label_rows = await db.execute_fetchall(
            "SELECT label, COUNT(*) FROM training_examples GROUP BY label",
        )
        by_label = {r[0]: r[1] for r in label_rows}

        type_rows = await db.execute_fetchall(
            "SELECT COALESCE(pdf_type, 'unknown'), COUNT(*) FROM training_examples GROUP BY pdf_type",
        )
        by_pdf_type = {r[0]: r[1] for r in type_rows}

        return TrainingStatsResponse(
            total=total,
            by_label=by_label,
            by_pdf_type=by_pdf_type,
            ready_for_training=total >= 200,
        )
    finally:
        await db.close()


@router.get("/training/export")
async def training_export(format: str = "jsonl"):
    """Export the training corpus for LoRA fine-tuning.

    format=jsonl → one JSON object per line, {image, prompt, completion}
    """
    if format != "jsonl":
        raise HTTPException(400, f"Unsupported format: {format}")

    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            """SELECT image_crop_path, prompt, human_correction, label, pdf_type
               FROM training_examples
               ORDER BY created_at""",
        )
        lines = []
        for r in rows:
            lines.append(json.dumps({
                "image": r[0],
                "prompt": r[1],
                "completion": r[2],
                "metadata": {"label": r[3], "pdf_type": r[4]},
            }))
        body = "\n".join(lines) + ("\n" if lines else "")
        return Response(
            content=body,
            media_type="application/jsonl",
            headers={
                "Content-Disposition": 'attachment; filename="pdfer-training.jsonl"',
            },
        )
    finally:
        await db.close()


@router.post("/documents/{doc_id}/extract", response_model=ExtractionResponse)
async def extract_objects(doc_id: str, use_llm: bool = True, force: bool = False):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id FROM documents WHERE id=?", (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")

        # Re-extract guard: refuse if extractions already exist unless force=true
        existing_rows = await db.execute_fetchall(
            """SELECT COUNT(*) FROM extractions e
               JOIN objects o ON e.object_id = o.id
               JOIN pages p ON o.page_id = p.id
               WHERE p.document_id = ?""",
            (doc_id,),
        )
        existing = existing_rows[0][0] if existing_rows else 0
        if existing > 0 and not force:
            # Allow re-extraction of only stale objects via default (checked in service)
            pass  # The service handles extraction_stale incremental re-run

        result = await extract_document(
            db, doc_id, broadcast_fn=manager.broadcast, use_llm=use_llm,
        )

        return ExtractionResponse(
            document_id=doc_id,
            total_extracted=result["total_extracted"],
            extractions=[
                ExtractionResult(**e) for e in result["extractions"]
            ],
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        await db.close()


@router.get("/documents/{doc_id}/extractions", response_model=ExtractionsListResponse)
async def get_extractions(doc_id: str):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id FROM documents WHERE id=?", (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")

        ext_rows = await db.execute_fetchall(
            """SELECT e.id, e.object_id, e.content, e.content_type,
                      e.extractor, e.confidence, e.metadata_json
               FROM extractions e
               JOIN objects o ON e.object_id = o.id
               JOIN pages p ON o.page_id = p.id
               WHERE p.document_id = ?
               ORDER BY p.page_number, o.reading_order""",
            (doc_id,),
        )

        extractions = [
            ExtractionDetail(
                id=r[0],
                object_id=r[1],
                content=r[2],
                content_type=r[3],
                extractor=r[4],
                confidence=r[5],
                metadata=json.loads(r[6]) if r[6] else {},
            )
            for r in ext_rows
        ]

        return ExtractionsListResponse(
            document_id=doc_id,
            total=len(extractions),
            extractions=extractions,
        )
    finally:
        await db.close()


@router.post("/documents/{doc_id}/assemble", response_model=AssemblyResponse)
async def assemble(doc_id: str):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id FROM documents WHERE id=?", (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")

        result = await assemble_document(db, doc_id, broadcast_fn=manager.broadcast)

        return AssemblyResponse(
            document_id=doc_id,
            markdown=result["markdown"],
            asset_count=result["asset_count"],
            total_objects=result["metadata"]["total_objects"],
            total_corrections=result["metadata"]["total_corrections"],
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        await db.close()


@router.get("/documents/{doc_id}/markdown")
async def get_markdown(doc_id: str):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id FROM documents WHERE id=?", (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")

        result = await assemble_document(db, doc_id, broadcast_fn=manager.broadcast)
        return Response(
            content=result["markdown"],
            media_type="text/markdown",
            headers={"Content-Disposition": f'inline; filename="document.md"'},
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        await db.close()


@router.get("/documents/{doc_id}/bundle.zip")
async def get_bundle(doc_id: str):
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id, filename FROM documents WHERE id=?", (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")

        filename = rows[0][1]
        stem = Path(filename).stem if filename else "document"

        zip_bytes = await build_bundle_zip(db, doc_id, broadcast_fn=manager.broadcast)
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{stem}_bundle.zip"'},
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        await db.close()


@router.get("/documents/{doc_id}/queue", response_model=QueueViewResponse)
async def get_queue(doc_id: str, sort_by: str = "confidence", status_filter: str = "all"):
    """Queue View: returns objects sorted for rapid triage.

    sort_by: confidence (default, ascending — low confidence first), page, reading_order
    status_filter: all, unreviewed, confirmed, low_confidence
    """
    db = await get_db()
    try:
        rows = await db.execute_fetchall(
            "SELECT id FROM documents WHERE id=?", (doc_id,),
        )
        if not rows:
            raise HTTPException(404, "Document not found")

        # Get all objects with extraction status
        obj_rows = await db.execute_fetchall(
            """SELECT o.id, p.page_number, o.label, o.confidence, o.status,
                      o.bbox_x1, o.bbox_y1, o.bbox_x2, o.bbox_y2,
                      o.reading_order,
                      CASE
                        WHEN e.content_type = 'placeholder' THEN 'placeholder'
                        WHEN e.id IS NOT NULL THEN 'extracted'
                        ELSE 'none'
                      END as extraction_status
               FROM objects o
               JOIN pages p ON o.page_id = p.id
               LEFT JOIN extractions e ON e.object_id = o.id
               WHERE p.document_id = ?""",
            (doc_id,),
        )

        objects = []
        for r in obj_rows:
            obj = QueueObject(
                object_id=r[0],
                page_number=r[1],
                label=r[2],
                confidence=r[3],
                status=r[4],
                bbox_x1=r[5],
                bbox_y1=r[6],
                bbox_x2=r[7],
                bbox_y2=r[8],
                extraction_status=r[10],
            )
            objects.append(obj)

        # Apply status filter
        if status_filter == "unreviewed":
            objects = [o for o in objects if o.status == "unreviewed"]
        elif status_filter == "confirmed":
            objects = [o for o in objects if o.status == "confirmed"]
        elif status_filter == "low_confidence":
            objects = [o for o in objects if o.confidence is not None and o.confidence < 0.5]

        # Sort
        if sort_by == "confidence":
            objects.sort(key=lambda o: (o.confidence if o.confidence is not None else 999))
        elif sort_by == "page":
            objects.sort(key=lambda o: o.page_number)

        return QueueViewResponse(
            document_id=doc_id,
            total=len(objects),
            objects=objects,
        )
    finally:
        await db.close()


@router.websocket("/ws/documents/{doc_id}")
async def document_websocket(websocket: WebSocket, doc_id: str):
    await manager.connect(doc_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(doc_id, websocket)
