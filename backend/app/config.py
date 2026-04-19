from pathlib import Path

DATA_DIR = Path.home() / ".pdfer"
UPLOAD_DIR = DATA_DIR / "uploads"
PAGES_DIR = DATA_DIR / "pages"
DB_PATH = DATA_DIR / "pdfer.db"

PAGE_DPI = 150
THUMB_WIDTH = 200

# Model paths
YOLO_WEIGHTS = Path.home() / "models" / "yolo-doclaynet" / "yolov8m-doclaynet.pt"
YOLO_CONF_THRESHOLD = 0.25
# Lowered from 0.45 → 0.30 on 2026-04-18 because YOLO was double-classifying
# logos (two overlapping figure boxes). Tighter NMS at the cost of occasionally
# dropping a legitimate same-class neighbor — acceptable because the reviewer
# can always draw a missing box, but can't easily find a duplicate.
YOLO_IOU_THRESHOLD = 0.30

GEMMA_MODEL_DIR = Path.home() / "models" / "gemma-4-E4B-it"
GEMMA_QUANT = "nf4"  # nf4 | int8 | bf16
GEMMA_MAX_NEW_TOKENS = 1024
GEMMA_TIMEOUT_SECONDS = 60

# Extraction
ASSETS_DIR = DATA_DIR / "assets"
AUTO_CONFIRM_THRESHOLD = 0.90

def ensure_dirs():
    for d in (DATA_DIR, UPLOAD_DIR, PAGES_DIR, ASSETS_DIR):
        d.mkdir(parents=True, exist_ok=True)
