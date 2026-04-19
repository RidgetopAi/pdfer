# PDF → Markdown: Problem Map & Architecture
*A working session — problem identification through proposed solution*

---

## The Starting Point

The question wasn't "how do we parse PDFs better." It was: **what is actually broken and why?**

Known symptoms going in: multi-column documents parse as interleaved garbage, images disappear, tables collapse, text encoding produces gibberish. Every tool has different failure modes. No tool solves it cleanly.

---

## The Root Cause

**PDF is a print format, not a reading format.**

PDF is descended from PostScript — a language designed in the 1980s to tell printers where to put dots. The PDF content stream is a list of paint instructions:

```
Draw glyph "H" at position (72, 680) in font F1 at size 12
Draw glyph "e" at position (80, 680) in font F1 at size 12
```

The file knows **where** to put ink. It has no concept of **what** that ink means.

**PDF encodes visual truth but has no required semantic layer.**

Position is mandatory. Meaning is optional.

The spec IS fully rules-based — it's an ISO standard. The problem isn't missing rules. It's that the rules describe a **renderer**, not a **reader**.

An optional feature called a **Structure Tree** (Tagged PDF) exists that adds semantic meaning — but fewer than 5% of real-world PDFs use it.

---

## The Actual Problem Inventory

| Problem | Root Cause |
|---|---|
| Multi-column reads as one line | Parser sweeps left-to-right across full page width, ignoring column structure |
| Reading order wrong | PDF stores glyphs in **draw order**, not reading order. Order must be inferred. |
| Tables broken | No required cell structure in file. Borders are decoration, not data. |
| Images lost | Images are just pixel regions. No text. No meaning. No attachment to captions. |
| Font encoding garbage | Some PDFs use custom glyph maps with no unicode translation table. Information may not exist in the file. |
| Headers/footers pollute text | No positional metadata distinguishing body from page furniture |
| Headings guessed wrong | Font size is the only signal — and it's unreliable |
| Scanned PDFs have no text | Scanned docs are literally just images. Zero text layer. |

**The fundamental mismatch:** Every parser tries to solve layout and extraction simultaneously in one pass through a broken text stream.

---

## The Key Insight

Since **position IS deterministic** in every PDF, the problem reduces to:

> Can you write geometric rules that translate spatial relationships into semantic structure?

Mostly yes — with known failure boundaries.

The implicit geometric rules that exist:

| Geometric Fact | Semantic Inference |
|---|---|
| Characters within ~3px horizontally | Same word |
| Lines within ~1.5x line-height vertically | Same paragraph |
| Two vertical bands of text across page | Two columns |
| Font size significantly larger than body | Heading candidate |
| Consistent X-indent across lines | List item |
| Grid-aligned text blocks | Table candidate |

This is geometry-to-semantics translation. The ruleset exists. Nobody has built a complete, composable translation engine on top of it.

---

## The Proposed Architecture

**Core principle:** Separate the layout problem from the extraction problem. Solve layout first. Get objects. Then solve extraction per object type.

```
PDF → Image → Detect Objects → Human Reviews → Extract Per Object → Assemble Output
```

### Stage 0 — Ingest
- Tool: `PyMuPDF (fitz)`
- Render each PDF page as a high-res image (150–300 DPI)
- Also extract raw text stream here (broken but useful later for coordinate clipping)
- From this point forward: work on images + coordinates, not the PDF text stream

### Stage 1 — Layout Detection
- Tool: `YOLOv8` fine-tuned on `PubLayNet` or `DocLayNet`
- Runs locally, no API call, no frontier model
- Model size: 50–300MB depending on accuracy tier
- Output: labeled bounding boxes per page

```json
[
  { "label": "Header",   "bbox": [x1,y1,x2,y2], "confidence": 0.94 },
  { "label": "Column",   "bbox": [x1,y1,x2,y2], "confidence": 0.91 },
  { "label": "Column",   "bbox": [x1,y1,x2,y2], "confidence": 0.89 },
  { "label": "Table",    "bbox": [x1,y1,x2,y2], "confidence": 0.87 },
  { "label": "Figure",   "bbox": [x1,y1,x2,y2], "confidence": 0.96 },
  { "label": "Caption",  "bbox": [x1,y1,x2,y2], "confidence": 0.82 },
  { "label": "Footnote", "bbox": [x1,y1,x2,y2], "confidence": 0.78 }
]
```

Object classes: Header, Paragraph, Column, Table, Figure, Caption, Footnote, List, Sidebar, PageNumber, Watermark

### Stage 2 — Human Review UI
- Stack: `React` + `Konva.js` or `Fabric.js` (canvas overlay)
- Backend: `FastAPI`
- Page renders as image with bounding boxes drawn as clickable overlays
- Human can: confirm, relabel, draw new boxes, delete false positives, merge, split, flag for LLM

**This is the accuracy multiplier.** Every correction is also training data. The system gets smarter the more it's used.

### Stage 3 — Extraction Router
Each confirmed object routes to the right extractor by label:

| Label | Extractor |
|---|---|
| Header / Paragraph / Column | `pdfplumber` clipped to bounding box |
| Table | `Camelot` (lattice) or custom grid logic |
| Figure | Crop and save as image asset |
| Caption / Footnote | `pdfplumber` clipped to bounding box |
| Figure with embedded text | `PaddleOCR` or `Tesseract` on cropped image |
| Flagged ambiguous | Small LLM call scoped to that object only |

Key: `pdfplumber` is accurate when clipped to a tight bounding box. It fails on full pages. Object isolation fixes that.

### Stage 4 — Ambiguity Handler (Surgical LLM)
- Only flagged/low-confidence objects go here
- Small local model (Qwen 7B on RTX 4060 Ti) or Claude API
- Input: cropped image of object + extracted text snippet
- Output: corrected text, semantic label, structured content
- **Not a whole-document call. One object at a time.**

### Stage 5 — Reading Order Assembly
- Sort objects by: page number → Y position (top to bottom) → X position (left to right)
- Column grouping: objects with overlapping X ranges = same column group, read column by column
- Output: ordered list of objects with content and semantic label

### Stage 6 — Markdown Assembly
Simple Python templating. No ML.

```
Header     →  ## Header Text
Paragraph  →  plain text block
Column     →  plain text block (in sequence)
Table      →  | markdown | table | syntax |
Figure     →  ![caption text](figure_001.png)
Footnote   →  [^1]: footnote text
```

---

## Honest Assessment — What This Fixes

| Problem | Before | After This Architecture |
|---|---|---|
| Multi-column reading order | Broken | **Fixed** |
| Tables | Broken | Better, not perfect |
| Images | Lost | Contained and named |
| Font encoding | Broken | Still broken |
| Scanned docs | Broken | Better with OCR routing |
| Heading hierarchy | Guessing | Meaningfully improved |
| Headers / footers in output | Polluting | **Eliminated** |
| Footnote threading | Lost | Detected, not threaded |

---

## The One Unfixable Thing

**Custom font encoding.** If the glyph map is missing or corrupt in the PDF, pdfplumber reads garbage from that bounding box. Object isolation doesn't fix corrupt encoding. The information may literally not exist in the file. This is the one genuinely lossy problem that lives below the pipeline.

Everything else is a structural problem. Font encoding is potentially a data loss problem.

---

## The Unexpected Strength

Every human correction in Stage 2 is **training data.**

Log corrections → dataset → fine-tune the layout model on your specific document types → accuracy improves over time.

That compounding loop is not present in any existing tool. It's the part that makes this worth building.

---

## Accuracy Target

**80–95% on standard business and academic documents.** Possibly conservative. The ceiling will be custom encoded fonts and heavily degraded scans — edge cases, not the common case.

The 100% ceiling that nobody reaches is driven by two things: lossy font encoding and artistic layouts. Everything else is solvable.

---

## What This Is Not (v1 Scope)

- Not a general-purpose parser — scope to document types that matter
- Not cloud-first — local pipeline
- Not trying to solve magazine/artistic layouts in v1
- The LLM is a scalpel, not a bulldozer

---

*Session notes for SIRK/forge pass — RidgetopAI Live*
