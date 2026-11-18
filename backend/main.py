"""
WIS+  backend/main.py
=====================
Ultra-lightweight local runtime API for the W201 workshop assistant.

Stack: FastAPI + uvicorn, read-only sqlite3 (FTS5), fastembed (ONNX CPU),
numpy, PyMuPDF. No PyTorch, no runtime LLM — target < 120 MB RAM on an
8 GB laptop (Arch Linux / Windows 11).

Run from the project root:

    python -m backend.main            # or: uvicorn backend.main:app --host 127.0.0.1

The server binds to **127.0.0.1 only** (local Tauri webview, never LAN).
Port: $WISPLUS_PORT (default 8321).
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Optional

# Make the project root importable regardless of CWD (shared/ has no __init__).
ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT / "backend"
for _p in (str(ROOT), str(BACKEND_DIR)):   # works via `python -m backend.main` and `uvicorn main:app`
    if _p not in sys.path:
        sys.path.insert(0, _p)

import fitz  # PyMuPDF — original-scan page rendering
from fastapi import FastAPI, HTTPException, Query, Response
from pydantic import BaseModel, Field

from shared.models import TorqueSpecRow, load_json
from search_engine import HybridSearchEngine

log = logging.getLogger("wisplus.api")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

PDF_DIR = ROOT / "pdfs"
USER_CONFIG_PATH = ROOT / "user_config.json"

DEFAULT_PROFILE = {"engine": "ALL", "transmission": "ALL", "year": None,
                   "facelift": None, "configured": False}


# ---------------------------------------------------------------------------
# Profile model — user-selectable build preferences. Defaults assume nothing:
# everything is 'ALL' until the user explicitly configures their car.
# ---------------------------------------------------------------------------
class UserConfig(BaseModel):
    engine: str = Field("ALL", min_length=1)          # e.g. 'M102_1.8', 'M103_2.3', 'ALL'
    transmission: str = Field("ALL", min_length=1)    # e.g. 'MANUAL_717.4', 'AUTO_722.4', 'ALL'
    year: Optional[int] = Field(None, ge=1983, le=1993)
    facelift: Optional[str] = Field(None, pattern="^(pre-facelift|facelift)$")
    configured: bool = False


# ---------------------------------------------------------------------------
# App + engine lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = HybridSearchEngine()          # opens DB ro, loads matrix
    yield
    app.state.engine.close()


app = FastAPI(
    title="WIS+ Local Runtime API",
    description="Hybrid FTS5 + vector search over the W201 workshop knowledge base.",
    version="0.4.0",
    lifespan=lifespan,
)

# CORS for Tauri webview origins: packaged app (tauri://localhost,
# https://tauri.localhost) and dev-server variants on localhost/127.0.0.1.
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

app.add_middleware(
    CORSMiddleware,
    allow_origins=["tauri://localhost", "https://tauri.localhost"],
    allow_origin_regex=r"^(?:https?|tauri)://(?:localhost|127\.0\.0\.1)(?::\d+)?$/",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _engine() -> HybridSearchEngine:
    return app.state.engine


# ---------------------------------------------------------------------------
# Health / profile
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    eng = _engine()
    return {"status": "ok", "db_loaded": eng.db_loaded, "procedure_count": eng.procedure_count}


def _read_profile() -> UserConfig:
    if USER_CONFIG_PATH.exists():
        try:
            raw = json.loads(USER_CONFIG_PATH.read_text(encoding="utf-8"))
            return UserConfig.model_validate({**DEFAULT_PROFILE, **raw})
        except (json.JSONDecodeError, ValueError) as exc:
            log.warning("user_config.json invalid (%s); using defaults", exc)
    return UserConfig(**DEFAULT_PROFILE)


@app.get("/api/profile")
def get_profile() -> UserConfig:
    """Current build preferences. Defaults to all-'ALL' — nothing is assumed."""
    return _read_profile()


@app.post("/api/profile", response_model=UserConfig)
def post_profile(config: UserConfig) -> UserConfig:
    """Persist the user's engine / transmission / year / facelift choice."""
    config.configured = True
    USER_CONFIG_PATH.write_text(
        json.dumps(config.model_dump(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return config


# ---------------------------------------------------------------------------
# Directory tree (collapsible index)
# ---------------------------------------------------------------------------
@app.get("/api/directory")
def directory(
    engine: Optional[str] = Query(None, description="Override profile engine filter"),
    transmission: Optional[str] = Query(None, description="Override profile transmission filter"),
) -> list[dict]:
    """Category -> Subcategory -> Procedure summaries, filtered by the active
    profile (query params override). Empty branches are omitted."""
    prof = _read_profile()
    eng = engine or prof.engine
    trans = transmission or prof.transmission
    return _engine().get_directory_tree(eng, trans)


# ---------------------------------------------------------------------------
# Spotlight search
# ---------------------------------------------------------------------------
@app.get("/api/search")
def search(
    q: str = Query(..., min_length=1, description="Free-text query"),
    engine: Optional[str] = Query(None),
    transmission: Optional[str] = Query(None),
    source: Optional[str] = Query(None, pattern="^(WIS|HAYNES)$", description="Manual source filter"),
    limit: int = Query(15, ge=1, le=50),
) -> dict:
    """Instant hybrid search as-you-type. ``synonyms_matched`` carries the
    alias chips for the UI's 'Also matching: ...' line."""
    eng = _engine()
    results = eng.search(
        q,
        engine_filter=engine,
        transmission_filter=transmission,
        source_filter=source,
        limit=limit,
    )
    return {
        "query": q,
        "results": [r.model_dump() for r in results],
        "synonyms_matched": eng.last_expansion,
    }


# ---------------------------------------------------------------------------
# Procedure detail
# ---------------------------------------------------------------------------
@app.get("/api/procedures/{procedure_id}")
def procedure_detail(procedure_id: int) -> dict:
    """Full procedure: separated removal/installation steps, tools, tips and
    torque specs (each with a normalized [x0, y0, x1, y1] bbox on the source
    page so the UI can flash the exact spot in the scan)."""
    eng = _engine()
    row = eng.get_procedure_row(procedure_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"procedure {procedure_id} not found")

    torque_rows = [TorqueSpecRow(**t).to_nested().model_dump() for t in eng.get_torque_specs(procedure_id)]

    return {
        "id": row["id"],
        "title": row["title"],
        "category": row["category"],
        "subcategory": row["subcategory"],
        "engine_variants": load_json(row["engine_variants"]),
        "transmission_variants": load_json(row["transmission_variants"]),
        "tools_required": load_json(row["tools_required"]),
        "removal_steps": load_json(row["removal_steps"]),
        "installation_steps": load_json(row["installation_steps"]),
        "general_tips": load_json(row["general_tips"]),
        "torque_specs": torque_rows,
        "page": {
            "document_id": row["document_id"],
            "page_number": row["page_number"],
            "orientation": row["orientation"],
            "source_type": row["source_type"],
            "filename": row["filename"],
        },
    }


# ---------------------------------------------------------------------------
# Original-scan page rendering (PyMuPDF -> PNG, LRU-cached)
# ---------------------------------------------------------------------------
@lru_cache(maxsize=24)                      # 24 pages x ~1.5 MB @180dpi < 40 MB
def _render_pdf_page(document_id: int, filename: str, page_number: int, dpi: int) -> bytes:
    """Render one original page as a crisp PNG (pure function of its inputs,
    so the LRU key is exact; evicted pages re-render in ~50 ms)."""
    pdf_path = PDF_DIR / filename
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail=f"PDF file missing: {filename}")
    with fitz.open(pdf_path) as doc:
        if page_number < 1 or page_number > len(doc):
            raise HTTPException(
                status_code=404,
                detail=f"page {page_number} out of range (document has {len(doc)} pages)",
            )
        page = doc.load_page(page_number - 1)
        zoom = dpi / 72.0
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        return pix.tobytes("png")


@app.get("/api/pdf/{document_id}/page/{page_number}")
def pdf_page(
    document_id: int,
    page_number: int,
    dpi: int = Query(180, ge=72, le=300),
) -> Response:
    """Original manual page as PNG. LRU-cached (maxsize=24) so scrolling and
    jumping between pages is instant."""
    doc = _engine().get_document(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail=f"document {document_id} not found")
    png_bytes = _render_pdf_page(document_id, doc["filename"], page_number, dpi)
    return Response(content=png_bytes, media_type="image/png", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("WISPLUS_PORT", "8321"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
