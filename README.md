# PDFer

A local-first PDF-to-Markdown pipeline with human-in-the-loop review. Upload a PDF, review the layout the model detects, and download a clean Markdown bundle with assets.

Everything runs on your machine: the backend is FastAPI + SQLite, the UI is React, and the models (YOLO for layout detection, Gemma 4 E4B for text extraction) load locally. No cloud, no API keys.

## Status

Skeleton build complete, plus pre-describe (Stage 1.5) — Gemma runs **before** review so the reviewer validates the AI's read instead of evaluating it blind. Corrections are captured as `(input_crop, model_output, human_correction)` training tuples (Loop B Phase 1 per Patch v2 Change 2).

| Slice | Stage | What it does |
| --- | --- | --- |
| 1 | Ingest | PDF → pages, thumbnails, text spans |
| 2 | Detect | YOLO layout detection + reading order |
| 2.5 | **Describe** | **Gemma transcribes every object; figures also saved as assets** |
| 3 | Review | Konva canvas with edits, undo/redo, auto-confirm, inline AI-read editor |
| 4 | Extract | Deterministic router: pdfplumber + pre-computed descriptions |
| 5 | Assemble | Markdown + assets bundle, Queue View triage |

Extraction is deterministic now (no Gemma calls in Stage 3). All model inference happens in Stage 1.5 where the human can see and correct it.

Smoke test (`pytest tests/test_smoke.py`) covers the entire pipeline: 8 tests, all passing.

## Architecture

```
┌─────────────────┐   HTTP + WS   ┌──────────────────┐
│  React frontend │ ◄───────────► │  FastAPI backend │
│  (Vite, Konva)  │               │  (uvicorn)       │
└─────────────────┘               └────────┬─────────┘
                                           │
                       ┌───────────────────┼──────────────────┐
                       ▼                   ▼                  ▼
                 ┌──────────┐        ┌──────────┐      ┌────────────┐
                 │ SQLite   │        │ YOLOv8m  │      │ Gemma 4    │
                 │ (WAL)    │        │ doclay   │      │ E4B-it NF4 │
                 └──────────┘        └──────────┘      └────────────┘
```

Stages are linear: `0 ingest → 1 detect → 1.5 describe → 2 extract → 3 assembling → 4 complete`. `current_stage` column stays on the 0–4 scale; Stage 1.5 lives as `stage_status='running'` while describe runs and flips to `'complete'` on finish (document stays at `current_stage=1`). Each stage reads only from the database; no in-memory state between stages. Every user edit is journaled into `object_edits` for undo/redo. Every description correction additionally writes a `training_examples` row for Loop B Phase 1 retrieval.

Canonical spec: [`PDFer-Architecture-Patch-v2.md`](PDFer-Architecture-Patch-v2.md).

## Repo layout

```
pdfer/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app + static mounts
│   │   ├── config.py            # Paths, thresholds, model locations
│   │   ├── database.py          # SQLite schema + connection
│   │   ├── ws.py                # WebSocket broadcaster
│   │   ├── models/schemas.py    # Pydantic request/response models
│   │   ├── routers/documents.py # All HTTP endpoints
│   │   └── services/
│   │       ├── ingest.py        # Stage 0: PDF → pages + text spans
│   │       ├── detect.py        # Stage 1: YOLO + reading order
│   │       ├── edit.py          # Stage 2: edit batches, undo/redo
│   │       ├── extract.py       # Stage 3: ExtractionRouter
│   │       ├── assemble.py      # Stage 4: markdown + bundle zip
│   │       └── model_manager.py # Sequential YOLO/Gemma loading
│   ├── tests/test_smoke.py      # End-to-end pipeline test
│   ├── pyproject.toml
│   └── yolov8m.pt               # Base YOLO weights (fallback)
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── api/client.ts        # Typed API client + WS helper
│   │   ├── store/               # Zustand stores
│   │   └── components/
│   │       ├── UploadForm.tsx
│   │       ├── DocumentList.tsx
│   │       ├── DocumentDetail.tsx
│   │       ├── Workspace.tsx    # Top-level review shell
│   │       ├── PageList.tsx
│   │       ├── PageCanvas.tsx
│   │       ├── ReviewCanvas.tsx # Konva canvas for editing objects
│   │       ├── ObjectInspector.tsx
│   │       └── QueueView.tsx    # Keyboard triage view
│   └── package.json
├── pdf-tests/                   # Sample PDFs for smoke testing
├── PDFer-Architecture-Patch-v2.md
├── pdf_pipeline_problem_map.md
└── USER-GUIDE.md
```

## Requirements

- **Python 3.11+**
- **Node 20+** / npm 10+
- **~4 GB disk** for model weights
- **GPU optional**: Gemma runs on CUDA with NF4 quantization (~6 GB VRAM). Without a GPU, pass `use_llm=false` to the extract endpoint — pdfplumber handles the text path and the LLM-gated objects become structured placeholders.

Models live under `~/models/`:
- `~/models/yolo-doclaynet/yolov8m-doclaynet.pt` (DocLayNet-finetuned layout model; falls back to `backend/yolov8m.pt` if missing)
- `~/models/gemma-4-E4B-it/` (BF16 safetensors, loaded with bitsandbytes NF4 quant)

Data lives under `~/.pdfer/`:
```
~/.pdfer/
├── pdfer.db          # SQLite WAL database
├── uploads/          # Original PDFs by doc UUID
├── pages/            # Rendered page PNGs + WebP thumbs
└── assets/           # Extracted figure crops
```

## Quick start

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --port 8000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
# open http://localhost:5173
```

See [USER-GUIDE.md](USER-GUIDE.md) for the walkthrough.

## Smoke test

```bash
cd backend
source .venv/bin/activate
pytest tests/test_smoke.py -v
```

Six tests: health → upload+ingest → detect → review+undo → extract → assemble+bundle. The test uses `use_llm=false` so it runs without a GPU.

## HTTP API (flat surface)

All routes are under `http://localhost:8000`.

| Method | Path | Stage | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | — | DB-backed liveness probe |
| POST | `/documents` | 0 | Upload PDF (multipart `file`), ingests synchronously |
| GET | `/documents` | — | List all documents |
| GET | `/documents/{id}` | — | Document + page summaries |
| POST | `/documents/{id}/detect` | 1 | Run YOLO layout detection |
| GET | `/documents/{id}/objects` | — | All objects grouped by page |
| POST | `/documents/{id}/edits` | 2 | Submit an edit batch (`create`/`update`/`delete`/`auto-confirm`) |
| POST | `/documents/{id}/undo` | 2 | Undo last batch |
| POST | `/documents/{id}/redo` | 2 | Redo last undone batch |
| GET | `/documents/{id}/undo-state` | 2 | `{can_undo, can_redo, …}` |
| GET | `/documents/{id}/review-stats` | 2 | Object + page review counts |
| POST | `/documents/{id}/extract?use_llm=true` | 3 | Run extraction (review-complete gated) |
| GET | `/documents/{id}/extractions` | — | All extraction rows |
| POST | `/documents/{id}/assemble` | 4 | Build markdown from confirmed objects |
| GET | `/documents/{id}/markdown` | — | `text/markdown` response |
| GET | `/documents/{id}/bundle.zip` | — | Full output (md + assets + metadata.json) |
| GET | `/documents/{id}/queue` | — | Queue View — `sort_by=confidence\|page`, `status_filter=all\|unreviewed\|confirmed\|low_confidence` |
| WS | `/ws/documents/{id}` | — | Events: `document.ingested`, `object.edited`, `object.extracted`, `document.assembled` |

Static mounts: `/pages/...` serves page PNGs + thumbs, `/assets/...` serves extracted figures.

## Key design rules

- **No stubs, no dead-ends.** Every endpoint does real work; every button triggers a real effect.
- **Review-complete gate.** Extraction refuses to run while any object is `unreviewed`.
- **Surgical LLM gate.** Gemma is called per-object only when the gate decides (low-confidence label, table/formula with pdfplumber failure, etc.). Default path is pdfplumber.
- **Structured failures.** When extraction fails, a placeholder row is written with a `pdfer://doc/{id}/object/{id}` review URI — never a silent drop.
- **Out of scope (intentionally not wired into UI):** model retraining, LoRA fine-tuning, multi-user/auth. The architecture allows for them; the skeleton does not surface them.

## Known gaps (skeleton-level)

1. No re-detection / re-extraction guards — calling `/detect` or `/extract` twice inserts duplicates.
2. Reading order is not recomputed after manual edits.
3. Assembly re-runs on every `/markdown` and `/bundle.zip` call (no cache — fine at ~1–2 s).
4. Markdown preview in the UI is raw monospace, not rendered HTML.
5. Gemma is not exercised in CI; use `smoke_gemma4.py` on a GPU box for integration.
6. Cross-page object chains (`continues_from`/`continues_to`) exist in schema but extraction treats objects independently.

None of these block the vertical slice — they are the first post-skeleton enhancements.

## License

TBD.
