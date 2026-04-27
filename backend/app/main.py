"""PDFer — FastAPI application."""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import PAGES_DIR, ASSETS_DIR, ensure_dirs
from app.database import get_db
from app.routers.documents import router as documents_router
from app.routers.training import router as training_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    db = await get_db()
    await db.close()
    yield


app = FastAPI(title="PDFer", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(documents_router)
app.include_router(training_router)


@app.get("/health")
async def health():
    db = await get_db()
    try:
        rows = await db.execute_fetchall("SELECT COUNT(*) FROM documents")
        doc_count = rows[0][0]
        return {
            "status": "ok",
            "version": "0.1.0",
            "document_count": doc_count,
            "database": "sqlite-wal",
        }
    finally:
        await db.close()


# Serve page images, thumbnails, and extracted assets as static files
ensure_dirs()
app.mount("/pages", StaticFiles(directory=str(PAGES_DIR)), name="pages")
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")
