"""ModelManager — Sequential GPU model loading.

Only one heavy model (YOLO, Gemma) is loaded at a time. Models are loaded on
first use and unloaded before switching to another.
"""
import gc
import logging
from typing import Any

from app.config import YOLO_WEIGHTS, GEMMA_MODEL_DIR, GEMMA_QUANT

logger = logging.getLogger(__name__)


class ModelManager:
    """Manages sequential loading of GPU models."""

    def __init__(self):
        self._yolo_model: Any | None = None
        self._gemma: dict | None = None  # {"model": ..., "processor": ...}
        self._active: str | None = None

    def _unload_current(self):
        if self._active == "yolo" and self._yolo_model is not None:
            del self._yolo_model
            self._yolo_model = None
            logger.info("Unloaded YOLO model")
        elif self._active == "gemma" and self._gemma is not None:
            del self._gemma
            self._gemma = None
            logger.info("Unloaded Gemma model")
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
        gc.collect()
        self._active = None

    def get_yolo(self):
        """Get the YOLO model, loading it if needed."""
        if self._active != "yolo":
            self._unload_current()
            from ultralytics import YOLO
            logger.info("Loading YOLO model from %s", YOLO_WEIGHTS)
            self._yolo_model = YOLO(str(YOLO_WEIGHTS))
            self._active = "yolo"
            logger.info("YOLO model loaded")
        return self._yolo_model

    def get_gemma(self) -> dict:
        """Get Gemma 4 model + processor, loading if needed.

        Returns {"model": model, "processor": processor}.
        Uses the config from smoke_gemma4.py: NF4 language tower, BF16 vision tower.
        Skip-list MUST include model.-prefixed keys per LESSONS L003.
        """
        if self._active != "gemma":
            self._unload_current()

            import torch
            from transformers import AutoProcessor, AutoModelForImageTextToText, BitsAndBytesConfig

            logger.info("Loading Gemma 4 E4B-it from %s (quant=%s)", GEMMA_MODEL_DIR, GEMMA_QUANT)

            processor = AutoProcessor.from_pretrained(str(GEMMA_MODEL_DIR))

            load_kwargs: dict[str, Any] = {"device_map": "cuda:0", "dtype": torch.bfloat16}

            # CRITICAL: skip keys must be prefixed with "model." because transformers
            # uses re.match (anchor at start) against the full module path.
            # Without the prefix, the vision tower gets quantized -> visual hallucination.
            # See LESSONS L003.
            skip_modules = [
                "model.vision_tower", "model.multi_modal_projector",
                "model.embed_vision", "model.vision_model",
                "lm_head", "model.embed_tokens",
            ]

            if GEMMA_QUANT == "nf4":
                load_kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_compute_dtype=torch.bfloat16,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_use_double_quant=True,
                    llm_int8_skip_modules=skip_modules,
                )
            elif GEMMA_QUANT == "int8":
                load_kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_8bit=True,
                    llm_int8_skip_modules=skip_modules,
                )

            model = AutoModelForImageTextToText.from_pretrained(
                str(GEMMA_MODEL_DIR), **load_kwargs
            )
            model.eval()

            self._gemma = {"model": model, "processor": processor}
            self._active = "gemma"

            if torch.cuda.is_available():
                vram = torch.cuda.memory_allocated() / 1024 / 1024
                logger.info("Gemma model loaded, VRAM: %.0f MiB", vram)
            else:
                logger.info("Gemma model loaded (CPU)")

        return self._gemma

    def unload_all(self):
        self._unload_current()


# Singleton
model_manager = ModelManager()
