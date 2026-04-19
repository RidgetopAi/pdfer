import aiosqlite
from app.config import DB_PATH, ensure_dirs

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  settings_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  filename TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  page_count INTEGER,
  current_stage INTEGER NOT NULL DEFAULT 0 CHECK (current_stage BETWEEN 0 AND 4),
  stage_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (stage_status IN ('pending','running','complete','failed')),
  detected_language TEXT DEFAULT 'en',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  page_number INTEGER NOT NULL,
  image_path TEXT NOT NULL,
  thumb_path TEXT,
  width_px INTEGER NOT NULL,
  height_px INTEGER NOT NULL,
  dpi INTEGER NOT NULL DEFAULT 150,
  pdf_type TEXT CHECK (pdf_type IN
    ('born-digital-clean','born-digital-corrupt','scanned-with-ocr','scanned-no-ocr')),
  review_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (review_status IN ('not_started','in_progress','complete')),
  object_count INTEGER NOT NULL DEFAULT 0,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(document_id, page_number)
);
CREATE INDEX IF NOT EXISTS idx_pages_document ON pages(document_id);

CREATE TABLE IF NOT EXISTS text_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL REFERENCES pages(id),
  text TEXT NOT NULL,
  x1 REAL NOT NULL, y1 REAL NOT NULL,
  x2 REAL NOT NULL, y2 REAL NOT NULL,
  font_name TEXT,
  font_size REAL,
  is_bold INTEGER DEFAULT 0,
  is_italic INTEGER DEFAULT 0,
  color TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_page ON text_spans(page_id);
CREATE INDEX IF NOT EXISTS idx_spans_font ON text_spans(font_name, font_size);

CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  label TEXT NOT NULL CHECK (label IN ('title','section_heading','paragraph','table',
    'figure','caption','footnote','list','formula','page_header','page_footer','watermark')),
  bbox_x1 REAL NOT NULL, bbox_y1 REAL NOT NULL,
  bbox_x2 REAL NOT NULL, bbox_y2 REAL NOT NULL,
  confidence REAL,
  reading_order INTEGER,
  reading_order_manual INTEGER DEFAULT 0,
  heading_level INTEGER CHECK (heading_level BETWEEN 1 AND 6),
  source TEXT NOT NULL DEFAULT 'detected' CHECK (source IN ('detected','manual')),
  status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (status IN ('unreviewed','confirmed','rejected')),
  parent_id TEXT REFERENCES objects(id),
  continues_from TEXT REFERENCES objects(id),
  continues_to TEXT REFERENCES objects(id),
  extraction_stale INTEGER DEFAULT 0,
  description TEXT,
  description_model TEXT,
  description_metadata_json TEXT DEFAULT '{}',
  description_edited_by_user INTEGER DEFAULT 0,
  description_status TEXT DEFAULT 'pending'
    CHECK (description_status IN ('pending','described','failed','skipped')),
  asset_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_objects_page ON objects(page_id);
CREATE INDEX IF NOT EXISTS idx_objects_status ON objects(status);
CREATE INDEX IF NOT EXISTS idx_objects_label ON objects(label);

CREATE TABLE IF NOT EXISTS training_examples (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  object_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  label TEXT NOT NULL,
  pdf_type TEXT,
  image_crop_path TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model_output TEXT NOT NULL,
  human_correction TEXT NOT NULL,
  edit_distance INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_training_label_type ON training_examples(label, pdf_type);
CREATE INDEX IF NOT EXISTS idx_training_created ON training_examples(created_at DESC);

CREATE TABLE IF NOT EXISTS object_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id),
  object_id TEXT NOT NULL,
  edit_type TEXT NOT NULL CHECK (edit_type IN ('create','update','delete')),
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  object_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_edits_batch ON object_edits(batch_id);
CREATE INDEX IF NOT EXISTS idx_edits_document ON object_edits(document_id);

CREATE TABLE IF NOT EXISTS undo_stack (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id),
  batch_id TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_undo_document ON undo_stack(document_id);

CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  content TEXT,
  content_type TEXT NOT NULL CHECK (content_type IN
    ('text','markdown_table','image_ref','formula_latex','empty','placeholder')),
  extractor TEXT NOT NULL,
  confidence REAL,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_extractions_object ON extractions(object_id);
"""


OBJECT_COLUMN_MIGRATIONS = [
    ("description", "TEXT"),
    ("description_model", "TEXT"),
    ("description_metadata_json", "TEXT DEFAULT '{}'"),
    ("description_edited_by_user", "INTEGER DEFAULT 0"),
    ("description_status", "TEXT DEFAULT 'pending'"),
    ("asset_path", "TEXT"),
]


async def _apply_object_column_migrations(db: aiosqlite.Connection) -> None:
    """Add description + asset_path columns to an existing objects table.

    CREATE TABLE IF NOT EXISTS is a no-op when the table already exists,
    so new columns must be added explicitly. ALTER TABLE raises on duplicate
    columns; we swallow that specific case.
    """
    for col, col_type in OBJECT_COLUMN_MIGRATIONS:
        try:
            await db.execute(f"ALTER TABLE objects ADD COLUMN {col} {col_type}")
        except Exception as e:  # aiosqlite wraps sqlite3.OperationalError
            if "duplicate column" not in str(e).lower():
                raise
    # Indexes on new columns must come AFTER the ALTERs complete — a fresh DB
    # also needs this index, and CREATE INDEX in SCHEMA would fire before the
    # migration on existing DBs.
    await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_objects_description_status "
        "ON objects(description_status)",
    )
    await db.commit()


async def get_db() -> aiosqlite.Connection:
    ensure_dirs()
    db = await aiosqlite.connect(str(DB_PATH))
    db.row_factory = aiosqlite.Row
    await db.executescript(SCHEMA)
    await _apply_object_column_migrations(db)
    return db
