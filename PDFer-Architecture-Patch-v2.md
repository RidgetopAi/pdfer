# PDFer — Architecture Patch v2

*April 16, 2026 · Revised patch incorporating outside-POV review*

> This supersedes `PDFer-Architecture-Patch.pdf` (v1, same date). It keeps all six v1 changes and revises four of them based on: (a) confirmed local model identity `gemma-4-E4B-it` at `~/models/gemma-4-E4B-it/`, (b) second-pass review challenging LoRA infrastructure cost, retraining thresholds, and encoder-latency risk. New in v2: one additional change (Change 7) and four additions to the Ready-to-Build checklist.

---

## Confirmed Local Model Facts (read from `config.json` + `processor_config.json`)

These facts ground the rest of the patch:

| Fact | Value | Design implication |
|---|---|---|
| Architecture | `Gemma4ForConditionalGeneration` | Multimodal: text + vision + audio + video |
| Parameters | E4B (effective 4B) | Fits on 4060 Ti alongside YOLOv8m |
| Weights on disk | 15GB BF16 safetensors | Quantize for runtime (Q4_K_M target) |
| Text context | 131,072 tokens | Whole-doc context is viable for assembly/review |
| Vision encoder | 280 soft-tokens per image, patch=16, variable resolution | **Fixed token budget per image** — latency is predictable, pan-and-scan concern from v1 Change 6 is largely resolved |
| Attention pattern | Hybrid sliding (512) + full, 42 layers | KV cache stays compact on long prompts |
| Image normalization | `do_normalize=false`, `rescale=1/255`, zero mean/unit std | Raw scaled pixels — do NOT pre-normalize |
| Location | `~/models/gemma-4-E4B-it/` | Full BF16 checkpoint; needs conversion to gguf or vLLM/transformers direct |

**Key shift from v1 reasoning:** Because Gemma 4's vision encoder emits a *fixed* 280 soft tokens per image (pooled from patches), per-page encoder cost is **bounded and predictable**. This reframes Change 6 from "latency gate" to "quality gate" — the question is no longer "how many encoder passes?" but "does 280 tokens carry enough signal for a full letter-size page, or do we need to crop?"

---

## Change 1 — Surgical LLM: Grok API → Gemma 4 E4B (local) *[REVISED]*

**What changes:**
- Replace all `Grok 4-1-fast-reasoning API` references with `Gemma 4 E4B-it (local)` throughout the architecture doc.
- Update the stack table row.
- Update the tiered installation block.

**New tiered install (revised for actual runtime):**
```
pip install pdfer              # Core: PyMuPDF, pdfplumber, YOLOv8, FastAPI
pip install pdfer[ocr]         # + Tesseract
pip install pdfer[ocr-pro]     # + PaddleOCR
pip install pdfer[llm]         # + transformers + accelerate, runs gemma-4-E4B-it from ~/models
pip install pdfer[llm-fast]    # + vllm OR llama-cpp-python (Q4_K_M gguf path)
pip install pdfer[llm-api]     # + Anthropic/Gemini clients (escape hatch for no-GPU users)
```

Two local tiers (not one) because the BF16 safetensors path works today with transformers; gguf conversion is a separate step with its own toolchain risk. `[llm]` = works out of the box; `[llm-fast]` = quantized production path.

**Rationale (unchanged from v1):** Local surgical LLM preserves the compounding-intelligence story. Every API call is training signal walking out the door. Gemma 4 E4B is purpose-built for document work: native vision, document understanding, tool calling, structured output, Apache 2, fits on a 4060 Ti alongside YOLOv8m.

**Pre-build verification required (revised):**
1. Smoke test `gemma-4-E4B-it` via transformers on one known page. Confirm it runs at all on the 4060 Ti with current VRAM budget.
2. Run 3 hard pages (nested tables, multi-column, small fonts) at **three crop strategies** (full-page raster, YOLO-object crop + 20px padding, half-page context crop). Measure: extraction quality (BLEU vs. known-good) + latency per call.
3. Record latency at BF16, then decide quantization path. Q4_K_M is the target; Q5_K_M is the fallback if document-vision quality degrades.
4. **New:** Test structured-output reliability. Gemma 4 supports native structured output — does it return schema-valid JSON on 10/10 attempts for the extraction prompt? This directly impacts Change 5.

---

## Change 2 — Dual Training Loop *[REVISED: LoRA gated behind few-shot baseline]*

**What changes:** Replace the single "Correction → Retraining Loop" section with two parallel loops, **with LoRA as Phase 2, not Phase 1.**

**Loop A — YOLOv8 (layout detection):** *[unchanged from v1]*
- Trains on corrected bounding boxes from `object_edits`
- Data: `(page_image, [corrected_bboxes_with_labels])`
- Existing 5 overfitting safeguards apply
- Versioned: base + last 3

**Loop B — Gemma 4 extraction quality:** *[REVISED — two-phase]*

**Phase 1: In-Context Few-Shot (v1 default)**
- On every surgical extraction call, retrieve 3-5 most similar prior corrections from `extractions` + `object_edits` (by label + PDF type + visual similarity of crop)
- Inject as few-shot examples in the prompt alongside the current crop
- No training infrastructure. No adapter versioning. No merge-to-gguf pipeline.
- Leverages Gemma 4's 131k context — few-shot budget is essentially free
- Expected to capture ~70% of the LoRA benefit at ~0% of the engineering cost

**Phase 2: LoRA Fine-Tuning (gated — opt-in after Phase 1 ceiling hit)**
- Triggered only when Phase 1 held-out eval plateaus for 2 consecutive retrain windows
- Data: `(page_image_crop, object_label, corrected_markdown_output)` triples
- Tooling decision deferred: `unsloth` vs `peft` evaluated *after* Phase 1 data proves insufficient
- LoRA rank 16, alpha 32 as starting point
- Adapters ~50MB, version last 5
- **Auto-reject if held-out BLEU/ROUGE drops >5%**
- **New: Kill-switch.** One-click revert to base model (no adapter loaded) per project, stored as a project setting

**Why the phase split:** v1's Loop B assumed training infrastructure is cheap. It isn't. llama.cpp doesn't train; unsloth/peft needs a separate env; vision-tower freezing is non-trivial; merge-back-to-gguf is a second pipeline. Few-shot from stored corrections captures the compounding-intelligence story with zero of that cost. LoRA becomes a *quality lever* pulled when needed, not a day-one commitment.

**Storage impact:**
- Phase 1: uses existing `extractions` + `object_edits` tables (already designed). Zero new storage.
- Phase 2 (if activated): ~250MB for 5 LoRA versions. Base weights: 15GB BF16 on disk (existing).

---

## Change 3 — Staged Retraining Threshold *[REVISED: per-loop schedules]*

**What changes:** Replace the fixed 200-page retraining trigger with **two separate schedules** — the YOLO loop and the Gemma loop have fundamentally different data appetites.

**Loop A — YOLOv8 retraining schedule:**

| Trigger # | Pages corrected | Rationale |
|---|---|---|
| 1 | 50 | Base model dumbest here; early corrections carry most signal |
| 2 | 100 | Validate first improvement held |
| 3 | 200 | Standard cadence begins |
| 4 | 400 | |
| 5+ | Every 200 | Steady state |

**Loop B Phase 1 — Few-Shot corpus (continuous, no trigger):**
- Every correction is immediately available as a retrieval example on the next call. No batched "retrain" event. Compounding is instant.

**Loop B Phase 2 — LoRA retraining schedule (only if activated):**

| Trigger # | Pages corrected | Rationale |
|---|---|---|
| 1 | 200 | Minimum viable LoRA dataset for a 4B VLM; below this, adapters memorize noise |
| 2 | 500 | |
| 3+ | Every 1000 | Adapters don't need frequent refresh if few-shot is doing the heavy lifting |

All triggers configurable. Manual "Train Now" button remains per loop. **Per-loop dataset naming** (see Open Question #4 from v1): users can train on `"all NWFA corrections"` vs `"everything"` — keeps domain-specific adapters swappable.

**Rationale:** v1's 50-page first-retrain was right for YOLO and wrong for LoRA. 50 (crop, label, markdown) triples is well below the floor where vision-LLM adapters learn anything that isn't memorization. Splitting schedules acknowledges the two loops compound on different timescales.

---

## Change 4 — Text Spans Feed Stage 1 Post-Processing *[UNCHANGED from v1]*

This change was the sharpest part of v1 and holds unmodified. Full v1 text:

> 1→2: Stage 1 reads page images for YOLO inference. Post-processing (column detection, reading order, heading hierarchy) uses text_spans as ground-truth geometry hints.
>
> - Column detection: DBSCAN on text_span X-midpoints (not YOLO object centroids)
> - Reading order: When text_spans exist inside a detected object's bbox, use their natural order as the intra-object reading order
> - Heading hierarchy: Font size/bold/caps signatures come from text_spans
>
> Edge case: On `scanned-no-ocr` pages, no text_spans. Falls back to YOLO-centroid heuristics. Degraded-but-working path.

**Tie-in note:** This change composes with Change 7 (below) — text_spans inside a detected object also inform whether surgical LLM is needed at all. If text_spans fully cover the object's bbox and pdfplumber returns clean output, Gemma 4 is not called.

---

## Change 5 — Structured Extraction Failure Format *[REVISED: retry-on-parse-error first]*

**What changes:** Keep v1's failure schema. Add an automatic schema-correction retry **before** marking failure.

**Placeholder row schema in `extractions` table (unchanged):**
```json
{
  "object_id": "...",
  "content_type": "placeholder",
  "content": null,
  "metadata": {
    "failure_type": "llm_timeout | parse_error | low_confidence | extractor_exception | schema_retry_exhausted",
    "failed_extractor": "pdfplumber | tesseract | gemma_e4b | ...",
    "attempted_at": "2026-04-16T...",
    "retry_count": 0,
    "schema_retry_count": 0
  },
  "error": "<specific error message>"
}
```

**New: schema-correction retry before failure (applies when `failed_extractor = gemma_e4b`):**
1. First call: structured output prompt with JSON schema
2. If output doesn't validate: second call with original prompt + `"Your previous output failed schema validation with error: {err}. Return ONLY valid JSON matching the schema."` + the invalid output
3. Max 2 retries. Then mark `failure_type = schema_retry_exhausted` with all attempts in `metadata.attempts[]`

**Placeholder rendering in assembled `document.md` (unchanged from v1):**
```
[EXTRACTION_FAILED type=table page=34 bbox=(120,400,450,180) reason=llm_timeout review=pdfer://doc/abc123/object/xyz789]
```

**Rationale:** Gemma 4's structured output is good but not perfect. Two cheap retries catch ~80% of parse errors before a human review is triggered. The `pdfer://` URI remains the round-trip to the review UI.

---

## Change 6 — Gemma 4 Crop Strategy Benchmark *[REVISED: promoted to blocker; reframed]*

**What changes:** Promote from "watch item" to the **Ready-to-Build checklist as a blocker.** Reframe from "latency concern" to "quality/crop concern" based on confirmed fixed 280-token encoder budget.

**Benchmark to run before Forge starts (goes in Checklist item #5):**

Test four crop strategies on the same 3 hard pages:

| Strategy | Input image | Hypothesis |
|---|---|---|
| A. Full page | 1275×1650 raster, 150 DPI | Maximum context, may waste 280 tokens on whitespace |
| B. YOLO object crop + 20px pad | Just the detected region | Densest signal per token |
| C. Object crop + caption proximity | Object + nearby caption text | Best for `figure`/`table` with captions |
| D. Half-page context crop | Object + surrounding half-page | Balance for multi-column text |

**Measure for each:** structured-output validity rate, BLEU vs. known-good, latency per call, VRAM peak.

**Expected winner (hypothesis, confirmed during benchmark):** B for most labels, C for `table`/`figure`, A only when YOLO confidence is low and the object's boundary is ambiguous.

**Why this is now a blocker, not a watch item:** Crop strategy is in the extraction router's hot path. Getting it wrong means either (a) degraded extraction quality on every surgical call or (b) wasted encoder budget. Cheaper to settle in hour one than to discover in hour eight.

---

## Change 7 — Surgical LLM Trigger Gate *[NEW in v2]*

**What changes:** Add an explicit gate that decides **whether Gemma 4 is called at all** for a given object. Currently the extraction router falls through to LLM as a default "if nothing else worked" case. That's fine, but the gate deserves a real definition because every skipped Gemma call is ~1-3 seconds saved per object.

**Gate logic (applied in Stage 3 before LLM invocation):**

Skip Gemma 4, use structured extractor output directly, if ALL of:
- pdfplumber/tesseract returned non-empty output
- text_spans cover ≥95% of the object's bbox area (for text objects)
- Extracted output passes content-type heuristic (e.g., `table` → has row/column structure; `text` → has sentence-terminator density > threshold)
- No prior user correction on a visually-similar object flagged this extractor as unreliable

Call Gemma 4 if ANY of:
- Primary extractor returned empty or error
- Content-type heuristic failed
- Label is `formula`, `chart`, or `figure` (Gemma wins on these by default)
- User has previously corrected a similar object's primary-extractor output (signal: primary extractor is unreliable for this document style)

**Rationale:** v1 implicitly called the LLM on "complex or failed" cases but never defined "complex." An explicit gate (a) makes the latency budget honest, (b) lets the correction signal from Loop B Phase 1 improve the *gate* itself over time, not just the extraction outputs.

**Performance impact:** On a typical born-digital 50-page doc (~400 objects), v1 budgeted ~10 LLM calls. With this gate, expect 5-15 calls depending on document quality. The 30s LLM budget in Part 7 performance table still holds.

---

## Explicitly Dropped From Plan *[UPDATED]*

**Squire/Mandrel integration surface (v1, unchanged):** PDFer is a standalone tool. Output contract is `document.md + assets/ + metadata.json`. Downstream integration out of scope for v1.

*Note on asymmetry:* Mandrel IS the build substrate — these forge-run contexts and design decisions live there. Runtime has zero Mandrel dependency; build-time has a hard one. Worth stating so future-you doesn't try to recreate the design history from code.

**LoRA infrastructure as a v1 commitment *[NEW]*:** Phase 1 few-shot ships in v1. Phase 2 LoRA is architecturally supported (adapter slot, kill-switch, eval gates) but infrastructure is built only if Phase 1 plateaus.

---

## Ready-to-Build Checklist (Pre-Forge) *[EXPANDED]*

Before starting the 5-instance skeleton build run:

1. **Test harness skeleton:** pytest configured, reference PDF in `tests/fixtures/`, smoke test imports pipeline module
2. **Mandrel project initialized** with PDFer build context *(already exists: project `pdfer`, 54 contexts)*
3. **Seed document** defining: TODO list structure, test-fix loop rules, "refuse to build on broken foundation" clause, instance state reporting format
4. **Gemma 4 E4B smoke test:** Load `gemma-4-E4B-it` via transformers on the 4060 Ti, generate on one page, confirm VRAM fits alongside YOLOv8m (sequential load via ModelManager)
5. **Crop strategy benchmark (Change 6):** 4 strategies × 3 hard pages. Record validity rate, BLEU, latency, VRAM. Pick default crop per-label.
6. **Structured output reliability test *[NEW]*:** 10 runs of extraction prompt at chosen crop. Require ≥9/10 schema-valid without retry. If lower, tune prompt before Forge.
7. **Eval corpus defined *[NEW]*:** 20-30 held-out pages spanning the 4 PDF types. Stored in `tests/fixtures/eval/` with known-good markdown. Used after every retrain to track accuracy trend (the UI graph i[5] designed).
8. **LoRA kill-switch wired *[NEW]*:** Even though LoRA is Phase 2, project settings schema must have `active_adapter_id` (nullable) from day one — avoids a migration later.
9. **Gate heuristics written *[NEW, Change 7]*:** Content-type heuristic functions (`is_table_shaped`, `is_prose_shaped`, `is_formula_shaped`) implemented and unit-tested. Thresholds configurable.

---

## Open Questions for Claude Code Review *[REVISED]*

1. ~~**Gemma LoRA training infrastructure:** unsloth vs peft?~~ **RESOLVED by Phase 1/Phase 2 split.** Defer until Phase 1 plateaus.

2. **Ensemble extraction for first 50 corrections?** *(v1 Q2, unchanged.)* Run pdfplumber AND Gemma on the same object, let human pick, capture both attempts. Double cost for first 50, single after. **v2 note:** this pairs well with Phase 1 few-shot — each ensemble-correction is 2 training examples instead of 1.

3. **YOLOv8 + Gemma 4 GPU sharing?** *(v1 Q3, unchanged.)* Sequential by design (ModelManager), but verify no contention when review-phase re-extraction happens mid-detection.

4. **"Train Now" named datasets?** *(v1 Q4.)* **v2 decision: YES for Loop A and Loop B Phase 2.** Per-loop named datasets let users build domain-specific YOLO checkpoints and LoRA adapters. Phase 1 few-shot is per-project and always-on.

5. **gguf conversion toolchain *[NEW]*:** BF16 → Q4_K_M conversion via `llama.cpp`'s convert + quantize, or via `mlx_lm` for Apple paths. Not a day-one concern (BF16 works) but the `[llm-fast]` tier needs this pipeline documented.

6. **131k context usage policy *[NEW]*:** Gemma 4 supports 131k tokens. Should assembly stage batch multiple pages into a single Gemma call for cross-page coherence checks (e.g., validate heading hierarchy across pages)? Cheap quality win; complicates the stage contract.

---

## Summary of Deltas vs v1

| Change | v1 → v2 |
|---|---|
| 1 | Added `[llm]` vs `[llm-fast]` tier split; added structured-output reliability test |
| 2 | LoRA reframed as Phase 2 (gated); Phase 1 few-shot is the v1 default; kill-switch added |
| 3 | YOLO and LoRA now have separate schedules; few-shot is continuous (no schedule) |
| 4 | Unchanged |
| 5 | Added schema-correction retry (max 2) before marking failure |
| 6 | Promoted to Checklist blocker; reframed as crop-strategy benchmark (encoder budget is fixed at 280 tokens, not the original latency concern) |
| 7 | **NEW** — Explicit surgical LLM trigger gate |
| Checklist | Expanded from 5 → 9 items |
| Open Qs | Q1 resolved; Q4 decided; Q5, Q6 added |

---

*Ready to hand to Claude Code 4.7 for review and patching into the main architecture doc. The three hard questions that must be answered during the pre-Forge benchmark: (1) does 280-token vision encoding preserve table-cell legibility? (2) does native structured output hit ≥9/10 on first try? (3) which crop strategy wins per label?*
