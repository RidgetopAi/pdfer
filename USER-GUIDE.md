# PDFer User Guide

How to run PDFer, take a PDF through all five stages, and get a clean Markdown bundle out the other side.

If you just want code layout or endpoint reference, see the [README](README.md). This document is task-oriented.

## 1. Install

### 1.1 System prerequisites

- Python 3.11 or newer
- Node.js 20 or newer, npm 10+
- ~4 GB free disk for model weights
- (Optional) NVIDIA GPU with ≥6 GB VRAM for Gemma extraction

### 1.2 Clone and install backend

```bash
cd ~/projects/pdfer/backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

### 1.3 Install frontend

```bash
cd ~/projects/pdfer/frontend
npm install
```

### 1.4 Place model weights

PDFer looks in fixed paths under `~/models/`:

| Path | What | Notes |
| --- | --- | --- |
| `~/models/yolo-doclaynet/yolov8m-doclaynet.pt` | Layout detector | Falls back to `backend/yolov8m.pt` (bundled) if missing — accuracy drops, but detection still runs. |
| `~/models/gemma-4-E4B-it/` | Text extractor | Required only if you want `use_llm=true`. BF16 safetensors. Quantized to NF4 at load. |

If you don't have Gemma, you can run the whole pipeline with `use_llm=false` — pdfplumber does the text work and LLM-gated objects produce structured placeholders that you can fill in manually.

## 2. Run it

Two terminals:

```bash
# Terminal 1 — backend
cd ~/projects/pdfer/backend
source .venv/bin/activate
uvicorn app.main:app --port 8000
```

```bash
# Terminal 2 — frontend
cd ~/projects/pdfer/frontend
npm run dev
```

Open http://localhost:5173.

The backend stores all state under `~/.pdfer/`. First run creates the SQLite database and required directories automatically.

### Health check

```bash
curl http://localhost:8000/health
# {"status":"ok","version":"0.1.0","document_count":0,"database":"sqlite-wal"}
```

## 3. Workflow — the five stages

Every PDF moves through five stages in order. The current stage is visible at the top of the Workspace and in the document list.

### Stage 0 — Ingest

**Trigger:** Upload a PDF via the front page form, or `POST /documents` with a multipart `file` field.

**What happens:**
- The file is stored in `~/.pdfer/uploads/{doc_id}.pdf`.
- PyMuPDF renders every page at 150 DPI → `~/.pdfer/pages/{doc_id}/page_XXXX.png`.
- A 200-px-wide WebP thumbnail is generated for each page.
- Text spans are extracted and saved to the `text_spans` table (used later for born-digital text extraction).
- A `pdf_type` is classified per page: `born-digital-clean`, `born-digital-corrupt`, `scanned-with-ocr`, or `scanned-no-ocr`.

**When it's done:** `current_stage = 0`, `stage_status = complete`. The WS event `document.ingested` fires.

### Stage 1 — Detect

**Trigger:** Click **Detect Layout** in the Workspace, or `POST /documents/{id}/detect`.

**What happens:**
- YOLOv8m (DocLayNet-finetuned) runs on every page image.
- Each detection becomes an `objects` row with a label from the schema set: `title`, `section_heading`, `paragraph`, `table`, `figure`, `caption`, `footnote`, `list`, `formula`, `page_header`, `page_footer`, `watermark`.
- Reading order is computed per page (column-aware for multi-column layouts).
- Heading levels are assigned where applicable.

**Tuning knobs** (`backend/app/config.py`):
- `YOLO_CONF_THRESHOLD = 0.25` — detection confidence floor
- `YOLO_IOU_THRESHOLD = 0.45` — NMS IoU threshold

**Gotcha:** calling detect twice inserts duplicate objects. Delete the document and re-upload if you need to redo detection.

### Stage 2 — Review

This is where humans earn their keep. The review UI has three areas:

- **Left:** Page list with thumbnails. Click to jump.
- **Center:** Konva canvas showing the page image with object bounding boxes overlaid.
- **Right:** Object Inspector — label, confidence, heading level, status.

**Common actions:**

| Action | How |
| --- | --- |
| Select an object | Click its box |
| Resize | Drag the handles |
| Move | Drag the box itself |
| Change label | Inspector dropdown |
| Set heading level | Inspector number input (1–6) |
| Confirm | Click the checkmark (or press Enter in Queue View) |
| Reject | Delete key (or X in Queue View) |
| Create a new box | Click and drag on empty space |
| Delete | Select + Delete key |
| Undo | `Ctrl+Z` |
| Redo | `Ctrl+Shift+Z` |
| Auto-confirm high-confidence objects | **Auto-Confirm** button — applies to objects with `confidence >= 0.90` by default |

**Queue View** (toggle button in top bar) is for rapid triage — it sorts objects by confidence ascending so the shakiest detections come first. Keyboard: `j`/`k` to navigate, `Enter` to confirm, `X` to reject, `G` to jump to the canvas for that object, `Esc` to close.

Every edit is journaled as a batch in `object_edits` with before/after values. Undo pops the top of `undo_stack`; redo pushes it back.

**Review-complete gate.** You can't advance to Stage 3 while any object is `unreviewed`. The Extract button stays disabled until everything is confirmed or rejected.

### Stage 3 — Extract

**Trigger:** Click **Extract** (enabled once review is complete), or `POST /documents/{id}/extract?use_llm=true`.

**What happens:**
- The ExtractionRouter walks every confirmed object and routes it by `label × pdf_type` through an ordered fallback chain:
  - **text-like labels (paragraph, list, caption, …)** → `pdfplumber-clip` (clips text spans inside the bbox)
  - **table** → `pdfplumber-table` (must yield ≥2 cols, ≥2 rows, <40% empty cells, else falls through)
  - **figure** → `figure-crop` (saves PNG to `~/.pdfer/assets/`, extraction row references the path)
  - **formula** → LaTeX extraction via Gemma (gated)
  - **hard cases** → surgical Gemma call if `use_llm=true`
- **Surgical LLM gate (Patch v2 Change 7):** Gemma is called per-object only when gated. Each call gets a cropped image (object bbox + 20–40 px padding), few-shot examples retrieved from past corrections on the same `label × pdf_type`, and a structured-output prompt. Retry limit: 2, with a schema correction prompt on retry.
- Failures produce a placeholder row with `content_type = placeholder` and metadata including `failure_type`, `bbox`, and a `pdfer://doc/{id}/object/{id}` review URI.

**Per-object WS events:** `object.extracted` fires as each one completes, with a running count. The UI shows a live extraction badge.

**Without GPU / Gemma:** pass `use_llm=false`. Text and table paths still work; figures still get saved; formulas and LLM-gated text slots become placeholders.

### Stage 4 — Assemble

**Trigger:** Click **Assemble**, or `POST /documents/{id}/assemble`.

**What happens:**
- Confirmed objects are walked in `page_number × reading_order`.
- Markdown is emitted per label:
  - `title` / `section_heading` → `#`–`######` per heading level
  - `table` → pdfplumber's markdown output
  - `figure` → `![alt](assets/filename.png)`
  - `formula` → `$$...$$` block
  - `caption` → `*italic*`
  - `footnote` → `> blockquote`
  - `list` → verbatim (pdfplumber preserves list markers)
  - `page_header`/`page_footer` → metadata only (not in body)
  - `watermark` → skipped
- Failure placeholders render inline as:
  ```
  [EXTRACTION_FAILED type=table page=3 bbox=(100,200,500,400) reason=pdfplumber_low_quality review=pdfer://doc/abc/object/xyz]
  ```
- Stage advances `2 → 3 (assembling) → 4 (complete)`.

**Output endpoints:**
- `GET /documents/{id}/markdown` — raw `document.md` as `text/markdown`
- `GET /documents/{id}/bundle.zip` — full bundle: `document.md` + `assets/` + `metadata.json`

**Markdown preview** in the UI (toggle button) shows the raw markdown in monospace. Rendered preview is a post-skeleton enhancement.

## 4. End-to-end with curl

Complete round trip on the command line — useful for testing or scripting.

```bash
DOC_ID=$(curl -s -F "file=@pdf-tests/PDFer-Architecture-Patch.pdf" \
  http://localhost:8000/documents | jq -r .id)

curl -sX POST http://localhost:8000/documents/$DOC_ID/detect >/dev/null

# Auto-confirm everything above the threshold
curl -sX POST http://localhost:8000/documents/$DOC_ID/edits \
  -H 'Content-Type: application/json' \
  -d '{"edits":[{"action":"auto-confirm","threshold":0.0}]}' >/dev/null

curl -sX POST "http://localhost:8000/documents/$DOC_ID/extract?use_llm=false" >/dev/null
curl -sX POST http://localhost:8000/documents/$DOC_ID/assemble >/dev/null

curl -s http://localhost:8000/documents/$DOC_ID/markdown > out.md
curl -s http://localhost:8000/documents/$DOC_ID/bundle.zip > out.zip
```

The `auto-confirm` edit with `threshold=0.0` confirms every detected object — fine for smoke-style tests, not for real output.

## 5. Troubleshooting

**Backend won't start — "port 8000 in use".**
Another uvicorn is running. `pkill -f 'uvicorn app.main'` and retry, or run on a different port.

**Frontend shows "Network Error" or CORS errors on upload.**
The backend accepts any `http://localhost:*` or `http://127.0.0.1:*` origin by regex, which covers Vite picking an alternate port (5174, 5178, …) when 5173 is busy. If you serve the frontend from a non-localhost host, edit `allow_origin_regex` in `backend/app/main.py` and restart the backend.

**YOLO detection is bad or returns nothing.**
Most likely the DocLayNet-finetuned weights aren't at `~/models/yolo-doclaynet/yolov8m-doclaynet.pt`. The bundled `backend/yolov8m.pt` is the base model and doesn't know document labels. Download the DocLayNet weights and put them at that path.

**Extract fails with "review not complete".**
There are still `unreviewed` objects. Hit `GET /documents/{id}/review-stats` to see how many. The Auto-Confirm button is the fastest cleanup — it confirms everything above the configured threshold (default 0.90).

**Gemma fails to load / CUDA OOM.**
- Check `~/models/gemma-4-E4B-it/` exists and has `model.safetensors.index.json` + shards.
- `GEMMA_QUANT` in `config.py` — drop from `nf4` (default, ~6 GB) to `int8` if VRAM is borderline, or just run extract with `use_llm=false`.
- Sequential loading is enforced by `ModelManager` — YOLO is unloaded before Gemma loads. If you suspect both models are resident, restart the backend.

**Extractions look wrong / text is truncated.**
- Check the `extractor` field on the extraction row — `pdfplumber-clip`, `pdfplumber-table`, `figure-crop`, or `gemma-4-e4b` tells you which path produced the content.
- Text truncated at bbox edges usually means YOLO drew the box slightly too small. Resize in the review canvas and re-extract (for now, re-extract means re-uploading — see known gaps).

**Assembly shows lots of `[EXTRACTION_FAILED …]` markers.**
Normal when running with `use_llm=false` on a complex document — anything that needs the LLM path becomes a placeholder. Re-run extract with `use_llm=true` on a GPU box to fill them.

**WebSocket disconnects immediately.**
The backend's WS endpoint only accepts connections for existing documents. Make sure the `{doc_id}` path segment matches a real upload.

## 6. Data layout cheat sheet

```
~/.pdfer/
├── pdfer.db                   # SQLite, WAL mode. Delete to start fresh.
├── uploads/{doc_id}.pdf       # Original upload
├── pages/{doc_id}/
│   ├── page_0001.png          # 150-DPI renders
│   ├── page_0001_thumb.webp   # 200-px thumbs
│   └── …
└── assets/{doc_id}/
    └── figure_*.png           # Extracted figure crops
```

To wipe everything and start over: `rm -rf ~/.pdfer`. The directories are re-created on next request.

## 7. What's intentionally not in the UI

These are explicitly out of scope for the skeleton and not surfaced anywhere in the frontend:

- Model retraining or LoRA fine-tuning (the `object_edits` table is the collection point; the trainer is a separate, future tool)
- Multi-user, auth, or cloud sync
- Job queue / background workers (everything is synchronous within a request)
- Rendered markdown preview

These are allowed for by the architecture but kept out of the skeleton to avoid dead-end UI.
