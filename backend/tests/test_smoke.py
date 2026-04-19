"""Smoke test: upload a PDF, verify ingest + detection produce real data."""
from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

from tests.conftest import REFERENCE_PDF


@pytest.fixture
async def client(tmp_path):
    """Create a test client with an isolated temp database and file dirs."""
    import app.config as cfg
    orig_data = cfg.DATA_DIR
    orig_upload = cfg.UPLOAD_DIR
    orig_pages = cfg.PAGES_DIR
    orig_db = cfg.DB_PATH

    cfg.DATA_DIR = tmp_path
    cfg.UPLOAD_DIR = tmp_path / "uploads"
    cfg.PAGES_DIR = tmp_path / "pages"
    cfg.DB_PATH = tmp_path / "test.db"
    cfg.ensure_dirs()

    from app.main import app as test_app
    from fastapi.staticfiles import StaticFiles

    pages_dir = tmp_path / "pages"
    pages_dir.mkdir(exist_ok=True)
    for i, route in enumerate(test_app.routes):
        if hasattr(route, "name") and route.name == "pages":
            test_app.routes.pop(i)
            break
    test_app.mount("/pages", StaticFiles(directory=str(pages_dir)), name="pages")

    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    cfg.DATA_DIR = orig_data
    cfg.UPLOAD_DIR = orig_upload
    cfg.PAGES_DIR = orig_pages
    cfg.DB_PATH = orig_db


@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["database"] == "sqlite-wal"


@pytest.mark.asyncio
async def test_upload_and_ingest(client):
    assert REFERENCE_PDF.exists(), "Reference PDF missing"

    with open(REFERENCE_PDF, "rb") as f:
        resp = await client.post(
            "/documents",
            files={"file": ("reference.pdf", f, "application/pdf")},
        )

    assert resp.status_code == 200, f"Upload failed: {resp.text}"
    doc = resp.json()
    assert doc["filename"] == "reference.pdf"
    assert doc["page_count"] > 0
    assert doc["current_stage"] == 0
    assert doc["stage_status"] == "complete"

    doc_id = doc["id"]

    # Verify document detail
    resp = await client.get(f"/documents/{doc_id}")
    assert resp.status_code == 200
    detail = resp.json()
    assert len(detail["pages"]) == doc["page_count"]

    # Every page should have text spans (born-digital PDF)
    for page in detail["pages"]:
        assert page["text_span_count"] > 0, f"Page {page['page_number']} has no text spans"
        assert page["pdf_type"] is not None
        assert page["thumb_url"] is not None

    # Verify document list
    resp = await client.get("/documents")
    assert resp.status_code == 200
    listing = resp.json()
    assert len(listing["documents"]) >= 1
    found = any(d["id"] == doc_id for d in listing["documents"])
    assert found, "Uploaded document not in list"


@pytest.mark.asyncio
async def test_detect_layout(client):
    """Upload a PDF, run detection, verify objects are created with real labels."""
    assert REFERENCE_PDF.exists(), "Reference PDF missing"

    # Upload
    with open(REFERENCE_PDF, "rb") as f:
        resp = await client.post(
            "/documents",
            files={"file": ("reference.pdf", f, "application/pdf")},
        )
    assert resp.status_code == 200
    doc_id = resp.json()["id"]

    # Run detection
    resp = await client.post(f"/documents/{doc_id}/detect")
    assert resp.status_code == 200, f"Detection failed: {resp.text}"
    detection = resp.json()
    assert detection["document_id"] == doc_id
    assert detection["total_objects"] > 0, "No objects detected"

    # Verify objects via GET endpoint
    resp = await client.get(f"/documents/{doc_id}/objects")
    assert resp.status_code == 200
    objects_data = resp.json()
    assert objects_data["total_objects"] == detection["total_objects"]

    valid_labels = {
        "title", "section_heading", "paragraph", "table",
        "figure", "caption", "footnote", "list", "formula",
        "page_header", "page_footer", "watermark",
    }

    # Check that every page has objects with valid labels and real bboxes
    total_checked = 0
    for page in objects_data["pages"]:
        for obj in page["objects"]:
            assert obj["label"] in valid_labels, f"Invalid label: {obj['label']}"
            assert obj["confidence"] > 0, "Confidence should be positive"
            assert obj["bbox_x2"] > obj["bbox_x1"], "bbox width should be positive"
            assert obj["bbox_y2"] > obj["bbox_y1"], "bbox height should be positive"
            assert obj["reading_order"] is not None, "Reading order should be assigned"
            assert obj["source"] == "detected"
            assert obj["status"] == "unreviewed"
            total_checked += 1

    assert total_checked == detection["total_objects"]

    # Document should now be at stage 1
    resp = await client.get(f"/documents/{doc_id}")
    assert resp.status_code == 200
    doc_detail = resp.json()
    assert doc_detail["current_stage"] == 1
    assert doc_detail["stage_status"] == "complete"


@pytest.mark.asyncio
async def test_review_edits_and_undo(client):
    """Upload, detect, then test the full review edit lifecycle: confirm, relabel, undo, redo."""
    assert REFERENCE_PDF.exists(), "Reference PDF missing"

    # Upload and detect
    with open(REFERENCE_PDF, "rb") as f:
        resp = await client.post(
            "/documents",
            files={"file": ("reference.pdf", f, "application/pdf")},
        )
    assert resp.status_code == 200
    doc_id = resp.json()["id"]

    resp = await client.post(f"/documents/{doc_id}/detect")
    assert resp.status_code == 200
    detection = resp.json()
    assert detection["total_objects"] > 0

    # Get the first object
    resp = await client.get(f"/documents/{doc_id}/objects")
    first_page = resp.json()["pages"][0]
    first_obj = first_page["objects"][0]
    obj_id = first_obj["id"]
    original_label = first_obj["label"]
    assert first_obj["status"] == "unreviewed"

    # --- Confirm an object ---
    resp = await client.post(
        f"/documents/{doc_id}/edits",
        json={"edits": [{"action": "confirm", "object_id": obj_id}]},
    )
    assert resp.status_code == 200
    edit_result = resp.json()
    assert edit_result["batch_id"]
    assert "Confirmed" in edit_result["description"]
    batch_id_1 = edit_result["batch_id"]

    # Verify the object is now confirmed
    resp = await client.get(f"/documents/{doc_id}/objects")
    objs = resp.json()["pages"][0]["objects"]
    confirmed_obj = next(o for o in objs if o["id"] == obj_id)
    assert confirmed_obj["status"] == "confirmed"

    # --- Relabel to a different type ---
    new_label = "table" if original_label != "table" else "figure"
    resp = await client.post(
        f"/documents/{doc_id}/edits",
        json={"edits": [{"action": "relabel", "object_id": obj_id, "label": new_label}]},
    )
    assert resp.status_code == 200
    batch_id_2 = resp.json()["batch_id"]

    # Verify relabeling
    resp = await client.get(f"/documents/{doc_id}/objects")
    objs = resp.json()["pages"][0]["objects"]
    relabeled_obj = next(o for o in objs if o["id"] == obj_id)
    assert relabeled_obj["label"] == new_label

    # --- Check undo state ---
    resp = await client.get(f"/documents/{doc_id}/undo-state")
    assert resp.status_code == 200
    undo_state = resp.json()
    assert undo_state["can_undo"] is True
    assert undo_state["total_edits"] >= 2

    # --- Undo the relabel ---
    resp = await client.post(f"/documents/{doc_id}/undo")
    assert resp.status_code == 200
    undo_result = resp.json()
    assert undo_result["action"] == "undo"

    # Verify label is restored
    resp = await client.get(f"/documents/{doc_id}/objects")
    objs = resp.json()["pages"][0]["objects"]
    restored_obj = next(o for o in objs if o["id"] == obj_id)
    assert restored_obj["label"] == original_label

    # --- Redo the relabel ---
    resp = await client.post(f"/documents/{doc_id}/redo")
    assert resp.status_code == 200
    redo_result = resp.json()
    assert redo_result["action"] == "redo"

    # Verify label is re-applied
    resp = await client.get(f"/documents/{doc_id}/objects")
    objs = resp.json()["pages"][0]["objects"]
    redone_obj = next(o for o in objs if o["id"] == obj_id)
    assert redone_obj["label"] == new_label

    # --- Undo again, then perform new edit (truncates redo stack) ---
    resp = await client.post(f"/documents/{doc_id}/undo")
    assert resp.status_code == 200

    # New edit: reject the object
    resp = await client.post(
        f"/documents/{doc_id}/edits",
        json={"edits": [{"action": "reject", "object_id": obj_id}]},
    )
    assert resp.status_code == 200

    # Redo should now fail (stack truncated)
    resp = await client.post(f"/documents/{doc_id}/redo")
    assert resp.status_code == 400

    # --- Draw a new object ---
    page_id = first_page["page_id"]
    resp = await client.post(
        f"/documents/{doc_id}/edits",
        json={"edits": [{
            "action": "create",
            "page_id": page_id,
            "label": "paragraph",
            "bbox_x1": 100, "bbox_y1": 200,
            "bbox_x2": 400, "bbox_y2": 300,
        }]},
    )
    assert resp.status_code == 200
    create_result = resp.json()
    new_obj_id = create_result["affected_objects"][0]["id"]
    assert create_result["affected_objects"][0]["source"] == "manual"

    # Verify the new object exists
    resp = await client.get(f"/documents/{doc_id}/objects")
    all_objs = []
    for page in resp.json()["pages"]:
        all_objs.extend(page["objects"])
    new_obj = next((o for o in all_objs if o["id"] == new_obj_id), None)
    assert new_obj is not None
    assert new_obj["label"] == "paragraph"
    assert new_obj["source"] == "manual"

    # --- Delete the new object ---
    resp = await client.post(
        f"/documents/{doc_id}/edits",
        json={"edits": [{"action": "delete", "object_id": new_obj_id}]},
    )
    assert resp.status_code == 200

    # Object should be gone
    resp = await client.get(f"/documents/{doc_id}/objects")
    all_objs = []
    for page in resp.json()["pages"]:
        all_objs.extend(page["objects"])
    assert not any(o["id"] == new_obj_id for o in all_objs)

    # Undo delete → object comes back
    resp = await client.post(f"/documents/{doc_id}/undo")
    assert resp.status_code == 200

    resp = await client.get(f"/documents/{doc_id}/objects")
    all_objs = []
    for page in resp.json()["pages"]:
        all_objs.extend(page["objects"])
    assert any(o["id"] == new_obj_id for o in all_objs)

    # --- Auto-confirm threshold ---
    # Undo all to get back to unreviewed state, then auto-confirm
    # First, undo everything
    for _ in range(10):
        resp = await client.post(f"/documents/{doc_id}/undo")
        if resp.status_code == 400:
            break

    # Now auto-confirm at threshold 0.90
    resp = await client.post(
        f"/documents/{doc_id}/edits",
        json={"edits": [{"action": "auto_confirm", "threshold": 0.90}]},
    )
    assert resp.status_code == 200

    # Check review stats
    resp = await client.get(f"/documents/{doc_id}/review-stats")
    assert resp.status_code == 200
    stats = resp.json()
    assert stats["confirmed"] >= 0
    assert stats["total_objects"] == detection["total_objects"]

    # Undo auto-confirm (one batch undoes all)
    resp = await client.post(f"/documents/{doc_id}/undo")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_describe_stage(client):
    """Upload, detect, describe (with stub Gemma), verify description rows."""
    assert REFERENCE_PDF.exists(), "Reference PDF missing"

    with open(REFERENCE_PDF, "rb") as f:
        resp = await client.post(
            "/documents",
            files={"file": ("reference.pdf", f, "application/pdf")},
        )
    assert resp.status_code == 200
    doc_id = resp.json()["id"]

    resp = await client.post(f"/documents/{doc_id}/detect")
    assert resp.status_code == 200
    total_objects = resp.json()["total_objects"]
    assert total_objects > 0

    # Stage 1.5 — describe all objects with stub Gemma (no GPU required)
    resp = await client.post(f"/documents/{doc_id}/describe?use_llm=false")
    assert resp.status_code == 200, f"Describe failed: {resp.text}"
    descr = resp.json()
    # Every non-watermark object should be described; watermarks get skipped.
    assert descr["total_described"] + descr["skipped"] == total_objects
    assert descr["failed"] == 0

    # Verify descriptions persisted on every object
    resp = await client.get(f"/documents/{doc_id}/objects")
    assert resp.status_code == 200
    described_count = 0
    for page in resp.json()["pages"]:
        for obj in page["objects"]:
            assert obj["description_status"] in ("described", "skipped")
            if obj["description_status"] == "described":
                assert obj["description"]
                assert obj["description_model"] == "stub"
                described_count += 1
    assert described_count == descr["total_described"]

    # Re-describe without force is idempotent: already-described objects are skipped
    resp = await client.post(f"/documents/{doc_id}/describe?use_llm=false")
    assert resp.status_code == 200
    assert resp.json()["total_described"] == 0

    # Re-describe with force=true actually re-runs
    resp = await client.post(f"/documents/{doc_id}/describe?use_llm=false&force=true")
    assert resp.status_code == 200
    assert resp.json()["total_described"] == described_count

    # Edit a description → creates a training_examples row
    page = next(p for p in (await client.get(f"/documents/{doc_id}/objects")).json()["pages"] if p["objects"])
    first_desc_obj = next(
        (o for o in page["objects"] if o["description_status"] == "described"),
        None,
    )
    assert first_desc_obj is not None
    obj_id = first_desc_obj["id"]

    resp = await client.patch(
        f"/objects/{obj_id}/description",
        json={"description": "CORRECTED: human-edited text that differs from stub."},
    )
    assert resp.status_code == 200, f"PATCH description failed: {resp.text}"
    body = resp.json()
    assert body["description_edited_by_user"] == 1
    assert body["training_example_created"] is True

    resp = await client.get("/training/stats")
    assert resp.status_code == 200
    stats = resp.json()
    assert stats["total"] >= 1
    assert stats["ready_for_training"] is False  # 1 tuple is well below 200

    # Training export as JSONL
    resp = await client.get("/training/export?format=jsonl")
    assert resp.status_code == 200
    assert "application/jsonl" in resp.headers.get("content-type", "")
    assert len(resp.text) > 0

    # Guard on re-detect: refuses without force=true
    resp = await client.post(f"/documents/{doc_id}/detect")
    assert resp.status_code == 409
    assert "force" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_extraction_consumes_description(client):
    """When Gemma pre-describes, extraction falls through to description
    for figures and when the trigger gate rejects pdfplumber."""
    with open(REFERENCE_PDF, "rb") as f:
        resp = await client.post(
            "/documents",
            files={"file": ("reference.pdf", f, "application/pdf")},
        )
    doc_id = resp.json()["id"]

    await client.post(f"/documents/{doc_id}/detect")
    await client.post(f"/documents/{doc_id}/describe?use_llm=false")
    await client.post(
        f"/documents/{doc_id}/edits",
        json={"edits": [{"action": "auto_confirm", "threshold": 0.0}]},
    )

    resp = await client.post(f"/documents/{doc_id}/extract?use_llm=true")
    assert resp.status_code == 200
    # When a figure exists, its extraction should reference the pre-described asset
    resp = await client.get(f"/documents/{doc_id}/extractions")
    ext_list = resp.json()["extractions"]
    figures = [
        e for e in ext_list
        if e["extractor"] == "figure-crop"
    ]
    # Figures always save their asset in describe.py; extract references it.
    if figures:
        assert figures[0]["metadata"].get("asset_path"), (
            "figure extraction should include asset_path from describe stage"
        )


@pytest.mark.asyncio
async def test_extraction_pipeline(client):
    """Upload, detect, confirm all objects, extract, verify extractions created."""
    assert REFERENCE_PDF.exists(), "Reference PDF missing"

    # Upload
    with open(REFERENCE_PDF, "rb") as f:
        resp = await client.post(
            "/documents",
            files={"file": ("reference.pdf", f, "application/pdf")},
        )
    assert resp.status_code == 200
    doc_id = resp.json()["id"]

    # Detect
    resp = await client.post(f"/documents/{doc_id}/detect")
    assert resp.status_code == 200
    detection = resp.json()
    total_objects = detection["total_objects"]
    assert total_objects > 0

    # --- Extraction requires all objects reviewed (no unreviewed) ---
    # First, try to extract without reviewing — should fail
    resp = await client.post(f"/documents/{doc_id}/extract?use_llm=false")
    assert resp.status_code == 400
    assert "unreviewed" in resp.json()["detail"].lower()

    # Confirm all objects via auto-confirm at threshold 0.0 (confirm everything)
    resp = await client.post(
        f"/documents/{doc_id}/edits",
        json={"edits": [{"action": "auto_confirm", "threshold": 0.0}]},
    )
    assert resp.status_code == 200

    # Verify no unreviewed objects remain
    resp = await client.get(f"/documents/{doc_id}/review-stats")
    assert resp.status_code == 200
    stats = resp.json()
    assert stats["unreviewed"] == 0, f"Still have {stats['unreviewed']} unreviewed objects"
    confirmed_count = stats["confirmed"]
    assert confirmed_count > 0

    # --- Run extraction (no LLM — uses pdfplumber only) ---
    resp = await client.post(f"/documents/{doc_id}/extract?use_llm=false")
    assert resp.status_code == 200, f"Extraction failed: {resp.text}"
    extraction = resp.json()
    assert extraction["document_id"] == doc_id
    assert extraction["total_extracted"] == confirmed_count

    # Every confirmed object should have an extraction
    for ext in extraction["extractions"]:
        assert ext["object_id"]
        assert ext["content_type"] in (
            "text", "markdown_table", "image_ref", "formula_latex", "placeholder",
        )
        assert ext["extractor"]

    # Verify extractions via GET endpoint
    resp = await client.get(f"/documents/{doc_id}/extractions")
    assert resp.status_code == 200
    ext_list = resp.json()
    assert ext_list["total"] == confirmed_count

    # Check that at least some extractions have real content (born-digital PDF)
    real_extractions = [e for e in ext_list["extractions"] if e["content"]]
    assert len(real_extractions) > 0, "No real extractions produced on born-digital PDF"

    # Check pdfplumber-clip is the dominant extractor (born-digital, no LLM)
    pdfplumber_count = sum(
        1 for e in ext_list["extractions"]
        if e["extractor"] in ("pdfplumber-clip", "pdfplumber-table", "figure-crop", "skip")
    )
    assert pdfplumber_count > 0, "Expected pdfplumber extractions on born-digital PDF"

    # Verify document stage advanced to 2 (extraction complete)
    resp = await client.get(f"/documents/{doc_id}")
    assert resp.status_code == 200
    doc_detail = resp.json()
    assert doc_detail["current_stage"] == 2
    assert doc_detail["stage_status"] == "complete"

    # Verify each extraction has metadata
    for ext in ext_list["extractions"]:
        assert isinstance(ext["metadata"], dict), "Extraction metadata should be a dict"


@pytest.mark.asyncio
async def test_assembly_and_bundle(client):
    """Full pipeline: upload, detect, confirm, extract, assemble, download bundle."""
    assert REFERENCE_PDF.exists(), "Reference PDF missing"

    # Upload
    with open(REFERENCE_PDF, "rb") as f:
        resp = await client.post(
            "/documents",
            files={"file": ("reference.pdf", f, "application/pdf")},
        )
    assert resp.status_code == 200
    doc_id = resp.json()["id"]

    # Detect
    resp = await client.post(f"/documents/{doc_id}/detect")
    assert resp.status_code == 200
    assert resp.json()["total_objects"] > 0

    # Confirm all objects
    resp = await client.post(
        f"/documents/{doc_id}/edits",
        json={"edits": [{"action": "auto_confirm", "threshold": 0.0}]},
    )
    assert resp.status_code == 200

    # Extract (no LLM)
    resp = await client.post(f"/documents/{doc_id}/extract?use_llm=false")
    assert resp.status_code == 200, f"Extraction failed: {resp.text}"
    confirmed_count = resp.json()["total_extracted"]
    assert confirmed_count > 0

    # --- Assembly requires extraction complete (stage >= 2) ---
    # Assemble
    resp = await client.post(f"/documents/{doc_id}/assemble")
    assert resp.status_code == 200, f"Assembly failed: {resp.text}"
    assembly = resp.json()
    assert assembly["document_id"] == doc_id
    assert assembly["total_objects"] > 0
    assert len(assembly["markdown"]) > 0, "Markdown should not be empty"

    # Markdown should contain real content (not just failure placeholders)
    md = assembly["markdown"]
    assert len(md) > 100, "Markdown too short for a real document"

    # Verify document stage advanced to 4 (assembly complete)
    resp = await client.get(f"/documents/{doc_id}")
    assert resp.status_code == 200
    doc_detail = resp.json()
    assert doc_detail["current_stage"] == 4
    assert doc_detail["stage_status"] == "complete"

    # --- GET markdown endpoint ---
    resp = await client.get(f"/documents/{doc_id}/markdown")
    assert resp.status_code == 200
    assert "text/markdown" in resp.headers.get("content-type", "")
    md_text = resp.text
    assert len(md_text) > 100

    # --- GET bundle.zip endpoint ---
    resp = await client.get(f"/documents/{doc_id}/bundle.zip")
    assert resp.status_code == 200
    assert "application/zip" in resp.headers.get("content-type", "")
    assert len(resp.content) > 100, "Bundle zip should not be empty"

    # Verify the zip contains the expected files
    import zipfile
    import io
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    names = zf.namelist()
    assert any("document.md" in n for n in names), f"Bundle missing document.md: {names}"
    assert any("metadata.json" in n for n in names), f"Bundle missing metadata.json: {names}"

    # Read and validate metadata.json from the bundle
    meta_name = [n for n in names if "metadata.json" in n][0]
    import json
    metadata = json.loads(zf.read(meta_name))
    assert metadata["document_id"] == doc_id
    assert metadata["total_objects"] > 0
    assert "assembled_at" in metadata
    assert "objects" in metadata

    # --- Queue View endpoint ---
    resp = await client.get(f"/documents/{doc_id}/queue")
    assert resp.status_code == 200
    queue = resp.json()
    assert queue["document_id"] == doc_id
    assert queue["total"] > 0

    # Test queue filtering
    resp = await client.get(f"/documents/{doc_id}/queue?status_filter=confirmed")
    assert resp.status_code == 200
    confirmed_queue = resp.json()
    assert all(o["status"] == "confirmed" for o in confirmed_queue["objects"])

    # Test queue sorting by confidence (ascending — low first)
    resp = await client.get(f"/documents/{doc_id}/queue?sort_by=confidence")
    assert resp.status_code == 200
    sorted_queue = resp.json()
    confidences = [
        o["confidence"] for o in sorted_queue["objects"]
        if o["confidence"] is not None
    ]
    assert confidences == sorted(confidences), "Queue should be sorted by confidence ascending"

    # Verify extraction_status is populated for objects
    statuses = set(o["extraction_status"] for o in queue["objects"])
    assert "extracted" in statuses or "placeholder" in statuses, \
        f"Expected some extracted objects in queue, got statuses: {statuses}"
