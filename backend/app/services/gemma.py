"""Shared Gemma 4 helpers used by both describe (Stage 1.5) and extract (Stage 3).

Centralizes prompt construction, image cropping, asset saving, and the
schema-retry inference loop so the two services stay in sync.
"""
import logging
import time
from pathlib import Path

import aiosqlite
from PIL import Image

from app.config import ASSETS_DIR

logger = logging.getLogger(__name__)


LABEL_INSTRUCTIONS = {
    "paragraph": "Extract the text content as clean Markdown. Preserve line breaks and emphasis.",
    "title": "Extract the title text exactly as shown.",
    "section_heading": "Extract the section heading text exactly as shown.",
    "caption": "Extract the caption text exactly as shown.",
    "footnote": "Extract the footnote text, including any reference number.",
    "list": "Extract as a Markdown list. Preserve nesting, bullet/number formatting, and indentation.",
    "table": "Extract as a Markdown table with proper header separator row. Preserve all cell contents.",
    "formula": "Extract as LaTeX. Use $ delimiters for inline, $$ for display. If LaTeX is unclear, provide plain text description.",
    "figure": "Transcribe any text visible in the figure (step numbers, labels, callouts, captions baked into the image). Then give a one-sentence description of the visual content. Return text first, then description on a new line.",
    "page_header": "Extract the header text exactly.",
    "page_footer": "Extract the footer text exactly.",
}


def proportional_padding(bbox_px: dict, ratio: float = 0.10,
                         min_px: int = 4, max_px: int = 24) -> int:
    """Padding in pixels scaled to bbox height.

    Fixed padding breaks on small objects like list items (~30px tall) where
    20px of pad pulls in the rows above and below, causing Gemma to read
    adjacent content and hallucinate. Scaling to bbox height keeps the
    signal-to-padding ratio constant.

    Defaults: 10% of height, clipped to [4, 24]px.
      - A 30px list item → 4px (floor, no bleed)
      - A 100px caption → 10px
      - A 300px paragraph → 24px (ceiling, covers descender clipping)
    """
    h = max(int(bbox_px["bbox_y2"]) - int(bbox_px["bbox_y1"]), 1)
    return int(max(min_px, min(max_px, round(h * ratio))))


def crop_object_image(
    page_image_path: str,
    bbox_px: dict,
    padding: int | None = None,
) -> Image.Image:
    """Crop an object from a page image with padding.

    When `padding` is None, falls back to proportional padding.
    """
    if padding is None:
        padding = proportional_padding(bbox_px)
    img = Image.open(page_image_path)
    x1 = max(0, int(bbox_px["bbox_x1"]) - padding)
    y1 = max(0, int(bbox_px["bbox_y1"]) - padding)
    x2 = min(img.width, int(bbox_px["bbox_x2"]) + padding)
    y2 = min(img.height, int(bbox_px["bbox_y2"]) + padding)
    return img.crop((x1, y1, x2, y2))


def save_figure_asset(page_image_path: str, bbox_px: dict, doc_id: str, object_id: str) -> str:
    """Crop and save a figure as an asset. Returns the relative asset path."""
    asset_dir = ASSETS_DIR / doc_id
    asset_dir.mkdir(parents=True, exist_ok=True)

    crop = crop_object_image(page_image_path, bbox_px, padding=5)
    asset_filename = f"{object_id}.png"
    asset_path = asset_dir / asset_filename
    crop.save(asset_path, "PNG")

    return f"assets/{doc_id}/{asset_filename}"


def save_training_crop(page_image_path: str, bbox_px: dict, doc_id: str, object_id: str) -> str:
    """Save a frozen crop for training_examples. Returns absolute path as string.

    Separate from save_figure_asset so asset bundle contents stay clean.
    """
    train_dir = ASSETS_DIR / doc_id / "_training"
    train_dir.mkdir(parents=True, exist_ok=True)

    crop = crop_object_image(page_image_path, bbox_px, padding=20)
    path = train_dir / f"{object_id}_{int(time.time())}.png"
    crop.save(path, "PNG")
    return str(path)


async def get_few_shot_examples(
    db: aiosqlite.Connection,
    label: str,
    pdf_type: str | None,
    limit: int = 3,
) -> list[dict]:
    """Retrieve training tuples (Gemma output + human correction) for few-shot prompting.

    Loop B Phase 1 per Patch v2 Change 2: corrections feed back as few-shot
    examples immediately (no batched retrain). Searches training_examples
    filtered by label + pdf_type, ordered most-recent-first.
    """
    if pdf_type:
        rows = await db.execute_fetchall(
            """SELECT model_output, human_correction
               FROM training_examples
               WHERE label = ? AND pdf_type = ?
               ORDER BY created_at DESC
               LIMIT ?""",
            (label, pdf_type, limit),
        )
    else:
        rows = await db.execute_fetchall(
            """SELECT model_output, human_correction
               FROM training_examples
               WHERE label = ?
               ORDER BY created_at DESC
               LIMIT ?""",
            (label, limit),
        )
    return [{"model_output": r[0], "human_correction": r[1]} for r in rows]


def build_extraction_prompt(label: str, few_shot_examples: list[dict]) -> str:
    """Build the Gemma prompt for a single object."""
    instruction = LABEL_INSTRUCTIONS.get(label, "Extract the content as clean Markdown.")

    prompt_parts = [
        "You are a document extraction engine. Extract the content from this image region.",
        f"Object type: {label}",
        f"Task: {instruction}",
    ]

    if few_shot_examples:
        prompt_parts.append(
            "\nHere are examples of how a human corrected your output on similar objects. "
            "Learn from these corrections:"
        )
        for i, ex in enumerate(few_shot_examples, 1):
            prompt_parts.append(f"\nExample {i}:")
            prompt_parts.append(f"  Your previous output: {ex['model_output'][:400]}")
            prompt_parts.append(f"  Human-corrected output: {ex['human_correction'][:400]}")
        prompt_parts.append("\nNow extract from the provided image:")

    prompt_parts.append("\nReturn ONLY the extracted content, no preamble or explanation.")
    return "\n".join(prompt_parts)


async def run_gemma(
    model_manager,
    page_image_path: str,
    bbox_px: dict,
    label: str,
    few_shot_examples: list[dict],
) -> tuple[str | None, dict]:
    """Run Gemma 4 E4B on an object crop with schema-correction retry.

    Patch v2 Change 5: max 2 retries on empty/invalid output.
    Returns (content, metadata) where metadata captures every attempt.
    """
    from app.config import GEMMA_MAX_NEW_TOKENS

    prompt = build_extraction_prompt(label, few_shot_examples)

    # Table and figure labels benefit from a bit of caption-proximity context,
    # so they get a larger ceiling. Text labels (paragraph, list, heading)
    # scale with bbox height to avoid bleeding into adjacent rows on tight
    # layouts — see crop_padding_investigation 2026-04-18.
    if label in ("table", "figure"):
        padding = proportional_padding(bbox_px, ratio=0.08, min_px=12, max_px=40)
    else:
        padding = proportional_padding(bbox_px)

    crop_img = crop_object_image(page_image_path, bbox_px, padding=padding)

    metadata = {
        "crop_strategy": "object_crop_proportional",
        "padding_px": padding,
        "few_shot_count": len(few_shot_examples),
        "prompt": prompt,
        "attempts": [],
    }

    gemma = model_manager.get_gemma()
    model = gemma["model"]
    processor = gemma["processor"]

    import torch

    max_retries = 2
    last_output = None

    for attempt in range(max_retries + 1):
        attempt_start = time.time()
        try:
            if attempt == 0:
                current_prompt = prompt
            else:
                current_prompt = (
                    f"{prompt}\n\n"
                    f"Your previous output was:\n{last_output}\n\n"
                    f"Please clean up the output. Return ONLY the extracted content."
                )

            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": crop_img},
                        {"type": "text", "text": current_prompt},
                    ],
                }
            ]

            prompt_text = processor.apply_chat_template(
                messages, add_generation_prompt=True, tokenize=False,
            )
            inputs = processor(
                text=[prompt_text], images=[crop_img], return_tensors="pt",
            ).to(model.device)

            for k, v in inputs.items():
                if v.dtype in (torch.float32, torch.float16):
                    inputs[k] = v.to(torch.bfloat16)

            with torch.inference_mode():
                out = model.generate(
                    **inputs,
                    max_new_tokens=GEMMA_MAX_NEW_TOKENS,
                    do_sample=False,
                )

            input_len = inputs["input_ids"].shape[-1]
            new_tokens = out.shape[-1] - input_len
            text = processor.batch_decode(
                out[:, input_len:], skip_special_tokens=True,
            )[0].strip()

            attempt_time = time.time() - attempt_start
            metadata["attempts"].append({
                "attempt": attempt,
                "success": True,
                "tokens": new_tokens,
                "time_s": round(attempt_time, 2),
            })

            if text and len(text) > 2:
                metadata["inference_time_ms"] = round(attempt_time * 1000)
                metadata["tokens_generated"] = new_tokens
                return text, metadata

            last_output = text

        except Exception as e:
            attempt_time = time.time() - attempt_start
            metadata["attempts"].append({
                "attempt": attempt,
                "success": False,
                "error": str(e)[:200],
                "time_s": round(attempt_time, 2),
            })
            last_output = str(e)[:200]
            logger.error("Gemma inference attempt %d failed: %s", attempt, e)

    return None, metadata


def is_table_shaped(text: str) -> bool:
    if not text:
        return False
    lines = text.strip().split("\n")
    if len(lines) < 2:
        return False
    pipe_lines = sum(1 for l in lines if "|" in l)
    if pipe_lines >= len(lines) * 0.5:
        return True
    tab_lines = sum(1 for l in lines if "\t" in l or "  " in l)
    if tab_lines >= len(lines) * 0.6:
        return True
    return False


def is_prose_shaped(text: str) -> bool:
    if not text or len(text) < 10:
        return False
    terminators = sum(1 for c in text if c in ".!?;:")
    words = len(text.split())
    if words < 3:
        return False
    return terminators > 0 or words > 5
