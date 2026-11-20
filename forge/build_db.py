"""
WIS+  forge/build_db.py
========================
End-to-end ingestion CLI: PDF -> normalized pages -> 3-engine OCR consensus
-> VLM structuring (Qwen3.8-27B via local llama.cpp) -> SQLite knowledge base.

Usage::

    python -m forge.build_db --pdf-dir ./pdfs \
        --db-path ./data/w201_kb.sqlite \
        --llama-url http://127.0.0.1:8080

Pipeline (per PDF, in strict Task order):

  1. ``shared/schema.sql`` is executed to (re)initialize the database.
  2. Each page is rendered with ``forge.pdf_normalizer.render_normalized_page``
     and preprocessed for OCR; source type (WIS vs HAYNES) comes from
     ``parse_wis_filename`` on the file name.
  3. Three OCR engines run in pinned single-worker process pools (one worker
     per engine, so each heavy model loads exactly once across the whole run)
     and ``compute_consensus`` fuses them into text + disputed regions.
  4. Repeating margin boilerplate is detected across the whole document and
     filtered out before consensus text is finalized.
  5. ``forge.vlm_enricher.VLMEnricher`` structures every page (checkpoint-
     cached in ``forge/.cache/`` so interrupted runs resume instantly).
  6. Deterministic post-processing: torque specs are sanitized against extreme
     values, every torque value and step is matched back to its exact
     normalized bounding box in the OCR token list, procedure text is expanded
     with ``shared/synonyms.json`` terms, and 384-dim embeddings are generated
     with fastembed (BAAI/bge-small-en-v1.5).
  7. documents / pages / procedures / torque_specs rows are written - exact
     file-hash duplicates are skipped up front and procedure-level overlap is
     resolved (cleaner copy kept, secondary copies hidden from search) - and
     the FTS5 index fills itself via the schema triggers.

Only the standard library + the Task 1/2 forge modules + httpx/fastembed are
used here — no new dependencies.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sqlite3
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

# ---------------------------------------------------------------------------
# Repo-root imports: `shared` and `forge` are sibling namespace packages.
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import pymupdf  # PyMuPDF — hard dependency (forge/requirements.txt)

from shared.models import (  # noqa: E402
    ProcedureRecord,
    ProcedureStep,
    StepMode,
    ToolItem,
    TorqueSpecRow,
    dump_json,
)
from forge.pdf_normalizer import (  # noqa: E402
    detect_repeating_margins,
    filter_boilerplate_tokens,
    parse_wis_filename,
    preprocess_scan_for_ocr,
    render_normalized_page,
)
from forge.ocr_consensus import (  # noqa: E402
    ENGINE_NAMES,
    OCRProgressTracker,
    OcrConsensusCache,
    TieBreakProgressTracker,
    compute_consensus,
    detect_disputed_page,
    prewarm_easyocr_weights,
    run_easyocr_engine,
    run_fast_ocr_engines,
    silence_easyocr_torch_warnings,
    verify_ocr_engines,
)
from forge.vlm_enricher import (  # noqa: E402
    VLMEnricher,
    match_step_bbox,
    match_torque_bbox,
)

SCHEMA_PATH = REPO_ROOT / "shared" / "schema.sql"
SYNONYMS_PATH = REPO_ROOT / "shared" / "synonyms.json"
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384


# ---------------------------------------------------------------------------
# Counters for the summary report
# ---------------------------------------------------------------------------
@dataclass
class RunStats:
    pdfs_total: int = 0
    pdfs_skipped_existing: int = 0
    pdfs_skipped_hash: int = 0        # exact SHA-256 duplicates (different filename)
    procedures_dedup_replaced: int = 0   # weaker existing copy updated in place
    procedures_dedup_suppressed: int = 0 # secondary copies hidden from search
    wis_docs: int = 0
    haynes_docs: int = 0
    pages_processed: int = 0
    boilerplate_skipped: int = 0
    spec_tables: int = 0
    diagrams: int = 0
    procedures_extracted: int = 0
    steps_indexed: int = 0
    torque_specs_indexed: int = 0
    torque_bboxes_matched: int = 0   # bboxes tighter than the full page
    disputed_regions_total: int = 0
    disputed_resolutions: int = 0
    embeddings_written: int = 0
    errors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Error diagnostics state + pre-flight checks
# ---------------------------------------------------------------------------
_SQL_TRACE: dict = {"sql": ""}


def _sql_trace(sql: str) -> None:
    """Record the most recent SQL statement (set as the connection trace callback)."""
    _SQL_TRACE["sql"] = sql


def _check_llama_server(llama_url: str, timeout_s: float = 5.0) -> None:
    """Ping llama-server; exit(1) with remediation if it is unreachable."""
    import httpx
    from urllib.parse import urlsplit

    parts = urlsplit(llama_url)
    origin = f"{parts.scheme}://{parts.netloc}"
    endpoints = [f"{origin}/health", f"{origin}/v1/models"]
    last_err = "no response"
    for ep in endpoints:
        try:
            r = httpx.get(ep, timeout=timeout_s)
            if r.status_code < 500:  # any non-5xx means the server is up
                return
            last_err = f"HTTP {r.status_code}"
        except Exception as exc:  # noqa: BLE001 - report any failure mode
            last_err = f"{type(exc).__name__}: {exc}"
    print(
        "[build_db] ERROR: cannot reach llama-server (VLM enrichment would fail).\n"
        "            Endpoints tried:\n"
        + "".join(f"              - {ep}\n" for ep in endpoints)
        + f"            Last error: {last_err}\n"
        "            Fix: start the vision server, e.g.\n"
        "              llama-server -m <Qwen-VL-model> --port 8080\n"
        "            (or pass --skip-vlm to build OCR-only data without VLM enrichment).",
        file=sys.stderr,
    )
    sys.exit(1)


def _preflight(args: argparse.Namespace) -> None:
    """Fail fast with actionable diagnostics before any heavy work starts.

    Checks, in order: the PDF directory (exists + non-empty), shared/schema.sql
    (exists + readable), llama-server reachability (unless --skip-vlm), and the
    OCR engines (>=2 available, or 3 if --strict).  Any failure prints an exact,
    human-readable remediation and exits with status 1 — nothing exits silently.
    """
    pdf_dir = Path(args.pdf_dir).resolve()
    if not pdf_dir.is_dir():
        print(f"[build_db] ERROR: --pdf-dir does not exist or is not a directory:\n"
              f"            {pdf_dir}\n"
              f"            Place the WIS/Haynes PDFs there (or pass --pdf-dir) and re-run.",
              file=sys.stderr)
        sys.exit(1)
    if not list(pdf_dir.glob("*.pdf")):
        print(f"[build_db] ERROR: no .pdf files found in:\n            {pdf_dir}\n"
              f"            Copy the WIS/Haynes PDFs into that folder and re-run.",
              file=sys.stderr)
        sys.exit(1)

    if not SCHEMA_PATH.is_file():
        print(f"[build_db] ERROR: database schema not found at:\n            {SCHEMA_PATH}\n"
              f"            Restore shared/schema.sql (it defines the SQLite schema) and re-run.",
              file=sys.stderr)
        sys.exit(1)
    try:
        with open(SCHEMA_PATH, "r", encoding="utf-8-sig") as fh:
            _ = fh.read()
    except OSError as exc:
        print(f"[build_db] ERROR: cannot read schema {SCHEMA_PATH}: {exc}", file=sys.stderr)
        sys.exit(1)

    if not getattr(args, "skip_vlm", False):
        _check_llama_server(args.llama_url)

    try:
        verify_ocr_engines(strict=getattr(args, "strict", False))
    except RuntimeError as exc:
        print(f"\n[build_db] Aborting: {exc}", file=sys.stderr)
        sys.exit(1)


def init_db(db_path: Path) -> sqlite3.Connection:
    """Create/overwrite the SQLite KB from shared/schema.sql.

    The schema is intentionally destructive (DROP ... IF EXISTS + CREATE):
    every run rebuilds the DB from source PDFs; VLM time is still saved by the
    forge/.cache/ checkpoint layer.
    """
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.set_trace_callback(_sql_trace)  # capture last SQL for error diagnostics
    conn.execute("PRAGMA foreign_keys = ON")
    with open(SCHEMA_PATH, "r", encoding="utf-8-sig") as f:
        conn.executescript(f.read())
    conn.commit()
    return conn


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def insert_document(
    conn: sqlite3.Connection,
    file_name: str,
    source_type: str,
    section: Optional[str],
    subsection: Optional[str],
    page_count: int,
    checksum: str,
) -> tuple[int, bool]:
    """Insert the document row. Returns ``(doc_id, is_fresh)``; a pre-existing
    row with an identical sha256 means the file was already ingested this run
    (duplicate in --pdf-dir) and can be skipped."""
    cur = conn.execute(
        "SELECT id, checksum_sha256 FROM documents WHERE filename = ?",
        (file_name,),
    )
    row = cur.fetchone()
    if row is not None:
        if row["checksum_sha256"] == checksum:
            return int(row["id"]), False
        conn.execute("DELETE FROM documents WHERE id = ?", (row["id"],))  # cascade
    cur = conn.execute(
        "INSERT INTO documents (filename, source_type, wis_section, wis_subsection,"
        " page_count, checksum_sha256) VALUES (?, ?, ?, ?, ?, ?)",
        (file_name, source_type, section, subsection, page_count, checksum),
    )
    return int(cur.lastrowid), True


def upsert_page(
    conn: sqlite3.Connection,
    doc_id: int,
    page_number: int,
    orientation: str,
    norm_width: float,
    norm_height: float,
    page_type: str,
    raw_ocr_text: Optional[str],
) -> int:
    cur = conn.execute(
        "INSERT INTO pages (document_id, page_number, orientation,"
        " norm_width, norm_height, page_type, raw_ocr_text)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (doc_id, page_number, orientation, norm_width, norm_height,
         page_type, raw_ocr_text),
    )
    return int(cur.lastrowid)


def insert_procedure(
    conn: sqlite3.Connection,
    page_id: int,
    rec: ProcedureRecord,
    ocr_confidence: Optional[float] = None,
    is_duplicate: int = 0,
    duplicate_of: Optional[int] = None,
) -> int:
    cur = conn.execute(
        "INSERT INTO procedures (page_id, category, subcategory, title, search_text,"
        " engine_variants, transmission_variants, tools_required, removal_steps,"
        " installation_steps, general_tips, embedding_dim, ocr_confidence,"
        " is_duplicate, duplicate_of)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (page_id, rec.category, rec.subcategory, rec.title, rec.search_text,
         dump_json(rec.engine_variants), dump_json(rec.transmission_variants),
         dump_json([t.model_dump() for t in rec.tools_required]),
         dump_json([s.model_dump() for s in rec.removal_steps]),
         dump_json([s.model_dump() for s in rec.installation_steps]),
         dump_json(rec.general_tips), None, ocr_confidence, is_duplicate, duplicate_of),
    )
    return int(cur.lastrowid)


def update_procedure_content(
    conn: sqlite3.Connection,
    procedure_id: int,
    page_id: int,
    rec: ProcedureRecord,
    ocr_confidence: Optional[float],
) -> None:
    """Overwrite an existing procedure row with a cleaner re-extraction of the
    same workshop job (dedup 'replace' path).  The FTS trigger keeps the
    index in sync automatically."""
    conn.execute(
        "UPDATE procedures SET page_id = ?, category = ?, subcategory = ?, title = ?,"
        " search_text = ?, engine_variants = ?, transmission_variants = ?,"
        " tools_required = ?, removal_steps = ?, installation_steps = ?,"
        " general_tips = ?, ocr_confidence = ? WHERE id = ?",
        (page_id, rec.category, rec.subcategory, rec.title, rec.search_text,
         dump_json(rec.engine_variants), dump_json(rec.transmission_variants),
         dump_json([t.model_dump() for t in rec.tools_required]),
         dump_json([s.model_dump() for s in rec.removal_steps]),
         dump_json([s.model_dump() for s in rec.installation_steps]),
         dump_json(rec.general_tips), ocr_confidence, procedure_id),
    )


def clear_torque_specs(conn: sqlite3.Connection, procedure_id: int) -> None:
    """Drop a procedure's torque rows (re-inserted right after an in-place update)."""
    conn.execute("DELETE FROM torque_specs WHERE procedure_id = ?", (procedure_id,))


def insert_torque_spec(
    conn: sqlite3.Connection,
    procedure_id: Optional[int],
    page_id: int,
    row: TorqueSpecRow,
) -> None:
    conn.execute(
        "INSERT INTO torque_specs (procedure_id, page_id, component_name, value_nm,"
        " value_ftlb, raw_text, step_mode, bbox_x0, bbox_y0, bbox_x1, bbox_y1)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (procedure_id, page_id, row.component_name, row.value_nm, row.value_ftlb,
         row.raw_text, row.step_mode, row.bbox_x0, row.bbox_y0, row.bbox_x1, row.bbox_y1),
    )


def set_embedding(conn: sqlite3.Connection, procedure_id: int, vec) -> None:
    import numpy as np

    arr = np.asarray(vec, dtype="float32")
    conn.execute(
        "UPDATE procedures SET embedding = ?, embedding_dim = ? WHERE id = ?",
        (arr.tobytes(), arr.shape[0], procedure_id),
    )


# ---------------------------------------------------------------------------
# Synonym expansion (shared/synonyms.json)
# ---------------------------------------------------------------------------
def load_synonyms() -> dict[str, list[str]]:
    with open(SYNONYMS_PATH, "r", encoding="utf-8-sig") as f:
        raw = json.load(f)
    return {k: v for k, v in raw.items() if k != "_meta" and isinstance(v, list)}


def expand_search_text(base_text: str, synonyms: dict[str, list[str]]) -> str:
    """Append every synonym family that has a hit in the base text.

    Deterministic word-boundary matching (case-insensitive).  The result is
    what gets FTS5-indexed and embedded, so 'shock absorber' procedures also
    match user queries for 'strut', 'damper', etc.
    """
    low = base_text.casefold()
    extra: list[str] = []
    seen: set[str] = set()
    for canonical, syns in synonyms.items():
        terms = [canonical, *[s for s in syns]]
        hit = False
        for t in terms:
            if re.search(rf"\b{re.escape(t.casefold())}\b", low):
                hit = True
                break
        if hit:
            for t in terms:
                key = t.casefold()
                if key not in seen:
                    seen.add(key)
                    extra.append(t)
    return " ".join([base_text] + extra)


# ---------------------------------------------------------------------------
# OCR stage — pinned single-worker pools (one per engine)
# ---------------------------------------------------------------------------
def _make_engine_pools() -> Optional[tuple[list[ProcessPoolExecutor], list]]:
    """Reuse Task 2's worker functions directly so each heavy model
    (onnxruntime / tesseract / torch+easyocr) loads exactly ONCE per process
    for the whole run, instead of re-spawning per page as run_ocr_engines
    would.  Falls back to None -> caller uses run_ocr_engines per page."""
    from forge import ocr_consensus as oc

    try:
        fns = [oc._worker_rapidocr, oc._worker_tesseract, oc._worker_easyocr]
    except AttributeError:  # pragma: no cover - Task 2 API drift guard
        return None
    prewarm_easyocr_weights()  # cache EasyOCR weights once before spawning workers
    pools = [ProcessPoolExecutor(max_workers=1) for _ in fns]
    return pools, fns


def _fast_ocr_pinned(pools_fns, gray: "np.ndarray",
                     progress=None) -> tuple[list[dict], list[dict]]:
    """Stage 1: run ONLY the two fast engines (RapidOCR, Tesseract) on one page.

    EasyOCR is deliberately excluded from Stage 1 — it runs later as an
    on-demand tie-breaker over disputed pages only (see process_pdf Stage 3)."""
    pools, fns = pools_fns
    t_submit = time.perf_counter()
    futures = {pools[i].submit(fns[i], gray): i for i in range(2)}
    results: list[list[dict]] = [None] * 2
    for fut in as_completed(futures):
        i = futures[fut]
        elapsed = time.perf_counter() - t_submit
        try:
            results[i] = fut.result()
            failed = False
        except Exception as e:  # engine crash on a degenerate page is not fatal
            print(f"      [warn] OCR engine failed on this page: {e}", file=sys.stderr)
            results[i] = []
            failed = True
        if progress is not None:
            progress.record(ENGINE_NAMES[i], elapsed, failed=failed)
    return results[0], results[1]


def _easy_ocr_pinned(pools_fns, gray: "np.ndarray") -> list[dict]:
    """Stage 3: run EasyOCR (pinned pool index 2) on one disputed page."""
    pools, fns = pools_fns
    try:
        return pools[2].submit(fns[2], gray).result()
    except Exception as e:
        print(f"      [warn] EasyOCR tie-break failed on this page: {e}",
              file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# Post-processing: VLM payload -> ProcedureRecord / TorqueSpecRow rows
# ---------------------------------------------------------------------------
def _steps_to_records(raw_steps: list[dict], tokens: list[dict]) -> list[ProcedureStep]:
    out: list[ProcedureStep] = []
    for s in raw_steps:
        bbox = match_step_bbox(s["text"], tokens)
        out.append(ProcedureStep(
            step_num=s["step_num"], text=s["text"], tip=s.get("tip"), bbox=bbox,
        ))
    return out


def _torque_rows(payload: dict, tokens: list[dict],
                 procedure_id: int, page_id: int) -> list[TorqueSpecRow]:
    rows: list[TorqueSpecRow] = []
    for t in payload["torque_specs"]:
        bbox = match_torque_bbox(t["raw_text"], tokens)
        rows.append(TorqueSpecRow(
            procedure_id=procedure_id,
            page_id=page_id,
            component_name=t["component_name"],
            value_nm=t["value_nm"],
            value_ftlb=t["value_ftlb"],
            raw_text=t["raw_text"],
            step_mode=StepMode(t["step_mode"]),
            bbox_x0=bbox.x0, bbox_y0=bbox.y0, bbox_x1=bbox.x1, bbox_y1=bbox.y1,
        ))
    return rows


def _build_search_text(payload: dict, synonyms: dict[str, list[str]]) -> str:
    parts: list[str] = []
    for key in ("category", "subcategory", "title"):
        if payload.get(key):
            parts.append(str(payload[key]))
    for s in payload["removal_steps"] + payload["installation_steps"]:
        parts.append(s["text"])
        if s.get("tip"):
            parts.append(s["tip"])
    for t in payload["tools_required"]:
        parts.append(t["name"])
        if t.get("size_or_code"):
            parts.append(t["size_or_code"])
    for t in payload["torque_specs"]:
        parts.append(f"{t['component_name']} {t['raw_text']}")
    parts.extend(payload["general_tips"])
    base = " ".join(p.strip() for p in parts if p and p.strip())
    return expand_search_text(base, synonyms) if base else ""


# ---------------------------------------------------------------------------
# Embeddings (fastembed, BAAI/bge-small-en-v1.5 -> 384-dim float32)
# ---------------------------------------------------------------------------
def embed_texts(texts: list[str]) -> list["np.ndarray"]:
    """Batch-embed with fastembed. Lazy import keeps --help usable without the
    model downloaded. Returns numpy float32 vectors of shape (384,)."""
    from fastembed import TextEmbedding

    model = TextEmbedding(EMBEDDING_MODEL)
    vecs = []
    for i in range(0, len(texts), 64):
        batch = list(model.embed(texts[i:i + 64]))
        vecs.extend(batch)
    return vecs


# ---------------------------------------------------------------------------
# Per-PDF pipeline
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Procedure-level deduplication (overlapping WIS PDFs)
#
# A newer 190E scan may already be covered by an existing chapter PDF, or two
# files may describe the same workshop job.  Rules:
#   * exact file duplicates are skipped earlier, in ``process_pdf``;
#   * here we match procedures within ONE manual type only - WIS and
#     Haynes/Supplement copies of the same job are deliberately kept apart so
#     factory data and DIY notes stay cross-referenceable;
#   * a match is (a) identical normalized (wis_doc_code, title), or
#     (b) >= PROC_JACCARD_THRESHOLD Jaccard word overlap on the steps for
#     compatible engine codes.
#   * the cleaner copy wins: higher OCR-consensus confidence, tie-broken by
#     more torque specs.  The loser is kept in the DB (provenance) but flagged
#     is_duplicate=1 so Spotlight Search never returns it twice.
# ---------------------------------------------------------------------------
PROC_JACCARD_THRESHOLD = 0.88

_WORD_RE = re.compile(r"[a-z0-9]+")


def wis_doc_code(section: Optional[str], subsection: Optional[str]) -> str:
    """WIS document code, e.g. '01-03'; '' when the source has none (Haynes)."""
    if section and subsection:
        return f"{section}-{subsection}"
    return section or ""


def _norm_title(title: str) -> str:
    return " ".join(_WORD_RE.findall((title or "").casefold()))


def _iter_step_texts(steps) -> list[str]:
    out: list[str] = []
    for s in steps or []:
        if isinstance(s, dict):
            out.append(str(s.get("text") or ""))
            tip = s.get("tip")
        else:
            out.append(s.text)
            tip = s.tip
        if tip:
            out.append(str(tip))
    return out


def _step_words(steps) -> set[str]:
    words: set[str] = set()
    for text in _iter_step_texts(steps):
        words.update(_WORD_RE.findall(text.casefold()))
    return words


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    union = len(a | b)
    return len(a & b) / union if union else 0.0


def _engines_compatible(a, b) -> bool:
    sa = {str(e).strip().upper() for e in (a or [])}
    sb = {str(e).strip().upper() for e in (b or [])}
    if not sa or not sb or "ALL" in sa or "ALL" in sb:
        return True
    return bool(sa & sb)


def _bbox_overlap(box, other) -> bool:
    ax0, ay0, ax1, ay1 = box
    bx0, by0, bx1, by1 = (other.x0, other.y0, other.x1, other.y1) if hasattr(other, "x0") else other
    return ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1


def procedure_consensus_confidence(tokens: list[dict], rec: ProcedureRecord) -> float:
    """Mean OCR-consensus confidence for one structured procedure.

    Prefers tokens whose bbox overlaps a step of this procedure (the text the
    VLM actually read); falls back to the page-wide mean when no step bboxes
    are available.  0.0 when the page produced no tokens.
    """
    boxes = [s.bbox for s in (*rec.removal_steps, *rec.installation_steps) if s.bbox is not None]
    all_conf: list[float] = []
    hit_conf: list[float] = []
    for t in tokens or []:
        conf = float(t.get("confidence") or 0.0)
        all_conf.append(conf)
        box = t.get("box")
        if boxes and box is not None and any(_bbox_overlap(box, b) for b in boxes):
            hit_conf.append(conf)
    pool = hit_conf or all_conf
    return sum(pool) / len(pool) if pool else 0.0


def _procedure_entry(proc_id: int, source_type: str, doc_code: str, rec: ProcedureRecord,
                     confidence: float, torque_count: int, is_dup: bool = False) -> dict:
    return {
        "proc_id": proc_id,
        "source_type": source_type,
        "doc_code": doc_code,
        "norm_title": _norm_title(rec.title),
        "engines": {str(e).strip().upper() for e in rec.engine_variants},
        "step_words": _step_words(rec),
        "confidence": confidence,
        "torque_count": torque_count,
        "is_dup": is_dup,
    }


def _dedup_decision(existing: dict, new_confidence: float, new_torque_count: int) -> str:
    """'replace' when the new copy is strictly cleaner (higher consensus
    confidence, tie-broken by more torque specs); else 'suppress'."""
    old_conf = existing["confidence"] or 0.0
    if new_confidence > old_conf + 1e-9:
        return "replace"
    if abs(new_confidence - old_conf) <= 1e-9 and new_torque_count > existing["torque_count"]:
        return "replace"
    return "suppress"


class ProcedureDedupIndex:
    """Registry of procedures seen so far, for overlap detection.

    The schema rebuilds the DB from scratch each run, so the registry is seeded
    from the (normally empty) ``procedures`` table at start-up and grows as rows
    are inserted - no full-table scan per insert.  Suppressed secondary copies
    are kept for provenance but never matched against.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._entries: list[dict] = []
        self._title_index: dict[tuple[str, str], list[int]] = {}
        self._by_proc_id: dict[int, int] = {}
        self._seed(conn)

    def _seed(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            "SELECT p.id, d.source_type, d.wis_section, d.wis_subsection, p.title,"
            " p.engine_variants, p.removal_steps, p.installation_steps,"
            " p.ocr_confidence, p.is_duplicate"
            " FROM procedures p"
            " JOIN pages pg ON pg.id = p.page_id"
            " JOIN documents d ON d.id = pg.document_id"
            " ORDER BY p.id"
        ).fetchall()
        torque_counts = dict(conn.execute(
            "SELECT procedure_id, COUNT(*) FROM torque_specs GROUP BY procedure_id"
        ))
        for r in rows:
            removal = json.loads(r["removal_steps"] or "[]")
            installation = json.loads(r["installation_steps"] or "[]")
            self.add({
                "proc_id": int(r["id"]),
                "source_type": r["source_type"],
                "doc_code": wis_doc_code(r["wis_section"], r["wis_subsection"]),
                "norm_title": _norm_title(r["title"]),
                "engines": {str(e).strip().upper() for e in json.loads(r["engine_variants"] or "[]")},
                "step_words": _step_words(removal + installation),
                "confidence": float(r["ocr_confidence"] or 0.0),
                "torque_count": int(torque_counts.get(int(r["id"]), 0)),
                "is_dup": bool(r["is_duplicate"]),
            })

    def add(self, entry: dict) -> None:
        idx = len(self._entries)
        self._entries.append(entry)
        self._by_proc_id[entry["proc_id"]] = idx
        if not entry["is_dup"]:
            key = (entry["source_type"], entry["norm_title"])
            self._title_index.setdefault(key, []).append(idx)

    def upgrade(self, entry: dict, rec: ProcedureRecord, confidence: float, torque_count: int) -> None:
        """Refresh a canonical entry after its row was updated in place."""
        idx = self._by_proc_id[entry["proc_id"]]
        old_key = (entry["source_type"], entry["norm_title"])
        new_norm = _norm_title(rec.title)
        if old_key in self._title_index:
            try:
                self._title_index[old_key].remove(idx)
            except ValueError:
                pass
            if not self._title_index[old_key]:
                del self._title_index[old_key]
        entry.update({
            "norm_title": new_norm,
            "engines": {str(e).strip().upper() for e in rec.engine_variants},
            "step_words": _step_words(rec),
            "confidence": confidence,
            "torque_count": torque_count,
        })
        if not entry["is_dup"]:
            self._title_index.setdefault((entry["source_type"], new_norm), []).append(idx)

    def find_duplicate(
        self,
        source_type: str,
        doc_code: str,
        norm_title: str,
        engines,
        step_words: set[str],
    ) -> tuple[Optional[dict], Optional[str]]:
        """Return ``(entry, reason)`` for an overlapping canonical procedure."""
        for idx in self._title_index.get((source_type, norm_title), []):
            e = self._entries[idx]
            if not e["is_dup"] and e["doc_code"] == doc_code:
                return e, f"same WIS doc code '{doc_code or '-'}' + normalized title"
        best: Optional[dict] = None
        best_j = 0.0
        for e in self._entries:
            if e["is_dup"] or e["source_type"] != source_type:
                continue
            if not _engines_compatible(engines, e["engines"]):
                continue
            j = _jaccard(step_words, e["step_words"])
            if j >= PROC_JACCARD_THRESHOLD and j > best_j:
                best, best_j = e, j
        if best is not None:
            return best, f"Jaccard step overlap {best_j:.2f} >= {PROC_JACCARD_THRESHOLD}"
        return None, None


async def process_pdf(
    conn: sqlite3.Connection,
    pdf_path: Path,
    vlm: VLMEnricher,
    synonyms: dict[str, list[str]],
    pools_fns: Optional[tuple],
    target_long_edge: int,
    vlm_concurrency: int,
    max_pages: Optional[int],
    stats: RunStats,
    dedup_index: ProcedureDedupIndex,
    reset_cache: bool = False,
) -> None:
    file_name = pdf_path.name
    section, subsection = parse_wis_filename(file_name)
    source_type = "WIS" if (section is not None and subsection is not None) else "HAYNES"
    checksum = sha256_file(pdf_path)
    doc_hash16 = checksum[:16]   # cache-key truncation; full hash stored in DB
    doc_code = wis_doc_code(section, subsection)

    if not reset_cache:
        prev = conn.execute(
            "SELECT filename FROM documents WHERE checksum_sha256 = ? ORDER BY id LIMIT 1",
            (checksum,),
        ).fetchone()
        if prev is not None and prev["filename"] != file_name:
            stats.pdfs_skipped_hash += 1
            print(f"[skip] {file_name}: exact duplicate of {prev['filename']} "
                  f"(sha256 {doc_hash16}...)")
            return

    with pymupdf.open(str(pdf_path)) as doc:
        page_count = len(doc)
        if max_pages is not None:
            page_count = min(page_count, max_pages)

        doc_id, fresh = insert_document(
            conn, file_name, source_type, section, subsection, page_count, checksum,
        )
        if not fresh:
            stats.pdfs_skipped_existing += 1
            print(f"[skip] {file_name}: identical checksum already ingested this run")
            return
        conn.commit()

        stats.pdfs_total += 1
        if source_type == "WIS":
            stats.wis_docs += 1
        else:
            stats.haynes_docs += 1
        print(f"[ingest] {file_name} ({source_type}, {page_count} pages)")

        # ---- Pass 1 / Stage 1: fast dual-OCR (RapidOCR + Tesseract) ---------
        engine_results: list[list[list[dict]]] = []   # [page][engine] -> tokens
        metas: list[dict] = []
        ocr_progress = OCRProgressTracker(
            total_pages=page_count, label=file_name,
            stage="OCR-Fast", engine_names=("rapidocr", "tesseract"),
        )
        for i in range(page_count):
            img, meta = render_normalized_page(doc, i, target_long_edge=target_long_edge)
            gray = preprocess_scan_for_ocr(img)
            try:
                if pools_fns is not None:
                    rapid_toks, tess_toks = _fast_ocr_pinned(
                        pools_fns, gray, progress=ocr_progress)
                else:
                    rapid_toks, tess_toks = run_fast_ocr_engines(gray)
            except Exception as e:
                import traceback
                print(f"      [error] OCR failed on {file_name} page {i+1}: "
                      f"{type(e).__name__}: {e}\n{traceback.format_exc()}",
                      file=sys.stderr)
                ocr_progress.finish()
                raise RuntimeError(
                    f"OCR failed for {file_name} (page {i + 1}): {type(e).__name__}: {e}"
                ) from e
            engine_results.append([rapid_toks, tess_toks, []])
            metas.append(meta)
            del img, gray
        ocr_progress.finish()  # idempotent: auto-fires on the last completion

        # ---- Stage 2: disagreement detection (RapidOCR vs Tesseract) --------
        disputed_pages: list[tuple[int, str]] = []
        for i in range(page_count):
            reason = detect_disputed_page(engine_results[i][0], engine_results[i][1])
            if reason is not None:
                disputed_pages.append((i, reason))

        # ---- Stage 3: EasyOCR tie-breaker (disputed pages only, zero-safe) --
        tie_progress = TieBreakProgressTracker(
            total_pages=len(disputed_pages),
            agreed_pages=page_count - len(disputed_pages),
            label=file_name,
        )
        if disputed_pages:
            for i, _reason in disputed_pages:
                img, _ = render_normalized_page(doc, i, target_long_edge=target_long_edge)
                gray = preprocess_scan_for_ocr(img)
                del img
                easy_toks = (
                    _easy_ocr_pinned(pools_fns, gray) if pools_fns is not None
                    else run_easyocr_engine(gray)
                )
                del gray
                engine_results[i][2] = easy_toks
                tie_progress.record()
        # Always prints the final line — including "Skipped (0 disputed pages ...)"
        # when nothing was in dispute.
        tie_progress.finish()

        # ---- Repeating-margin boilerplate across the whole document ---------
        all_page_tokens = [
            [t for eng in er for t in eng] for er in engine_results
        ]
        repeating_margins = detect_repeating_margins(all_page_tokens)
        doc_stem = pdf_path.stem
        ocr_cache = OcrConsensusCache(Path(__file__).resolve().parent / ".cache")

        # ---- Pass 2: consensus + VLM + DB rows (streaming, one page at a time)
        proc_ids_for_embed: list[tuple[int, str]] = []  # (procedure_id, search_text)

        for i in range(page_count):
            meta = metas[i]
            filtered_engines = [
                filter_boilerplate_tokens(eng, repeating_margins) for eng in engine_results[i]
            ]
            consensus = ocr_cache.load(doc_stem, i + 1)
            if consensus is None:
                consensus = compute_consensus(filtered_engines)
                ocr_cache.save(doc_stem, i + 1, consensus)
            stats.disputed_regions_total += len(consensus["disputed_regions"])

            img, _ = render_normalized_page(doc, i, target_long_edge=target_long_edge)
            try:
                payload = await vlm.enrich_page(doc_stem, i + 1, img, consensus)
            finally:
                del img

            stats.pages_processed += 1
            page_type = payload["page_type"]
            if page_type == "boilerplate_skip":
                stats.boilerplate_skipped += 1
            elif page_type == "spec_table":
                stats.spec_tables += 1
            elif page_type == "diagram":
                stats.diagrams += 1

            try:
                tokens = consensus["tokens"]
                page_id = upsert_page(
                    conn, doc_id, i + 1, meta["orientation"], meta["norm_width"],
                    meta["norm_height"], page_type, consensus["text"],
                )

                if page_type != "procedure":
                    continue

                # ---- build the structured procedure ------------------------------
                removal = _steps_to_records(payload["removal_steps"], tokens)
                installation = _steps_to_records(payload["installation_steps"], tokens)
                tools = [
                    ToolItem(name=t["name"], size_or_code=t.get("size_or_code"),
                             is_mercedes_special=t.get("is_mercedes_special", False))
                    for t in payload["tools_required"]
                ]
                search_text = _build_search_text(payload, synonyms)
                rec = ProcedureRecord(
                    page_id=page_id,
                    category=payload.get("category"),
                    subcategory=payload.get("subcategory"),
                    title=payload.get("title"),
                    search_text=search_text,
                    engine_variants=payload["engine_variants"],
                    transmission_variants=payload["transmission_variants"],
                    tools_required=tools,
                    removal_steps=removal,
                    installation_steps=installation,
                    general_tips=payload["general_tips"],
                )
                confidence = procedure_consensus_confidence(tokens, rec)
                new_torque_count = len(payload["torque_specs"])
                existing, reason = dedup_index.find_duplicate(
                    source_type=source_type,
                    doc_code=doc_code,
                    norm_title=_norm_title(rec.title),
                    engines=rec.engine_variants,
                    step_words=_step_words(rec),
                )
                suppressed = False
                if existing is None:
                    proc_id = insert_procedure(conn, page_id, rec, ocr_confidence=confidence)
                    stats.procedures_extracted += 1
                    dedup_index.add(_procedure_entry(
                        proc_id, source_type, doc_code, rec, confidence, new_torque_count))
                elif _dedup_decision(existing, confidence, new_torque_count) == "replace":
                    proc_id = int(existing["proc_id"])
                    update_procedure_content(conn, proc_id, page_id, rec, confidence)
                    clear_torque_specs(conn, proc_id)
                    stats.procedures_dedup_replaced += 1
                    dedup_index.upgrade(existing, rec, confidence, new_torque_count)
                    print(f"[dedup] {file_name}: '{rec.title}' is cleaner than existing "
                          f"procedure #{proc_id} (confidence {confidence:.2f} vs "
                          f"{existing['confidence'] or 0.0:.2f}, {new_torque_count} vs "
                          f"{existing['torque_count']} torque specs) - updated in place [{reason}]")
                else:
                    proc_id = insert_procedure(
                        conn, page_id, rec, ocr_confidence=confidence,
                        is_duplicate=1, duplicate_of=int(existing["proc_id"]))
                    stats.procedures_dedup_suppressed += 1
                    suppressed = True
                    dedup_index.add(_procedure_entry(
                        proc_id, source_type, doc_code, rec, confidence,
                        new_torque_count, is_dup=True))
                    print(f"[dedup] {file_name}: '{rec.title}' overlaps existing "
                          f"procedure #{existing['proc_id']} [{reason}] - stored as "
                          f"secondary copy (hidden from Spotlight search)")
                stats.steps_indexed += len(removal) + len(installation)
                if search_text and not suppressed:
                    proc_ids_for_embed.append((proc_id, search_text))

                for trow in _torque_rows(payload, tokens, proc_id, page_id):
                    insert_torque_spec(conn, proc_id, page_id, trow)
                    stats.torque_specs_indexed += 1
                    if not (trow.bbox_x0 <= 1e-9 and trow.bbox_y0 <= 1e-9
                            and trow.bbox_x1 >= 1 - 1e-9 and trow.bbox_y1 >= 1 - 1e-9):
                        stats.torque_bboxes_matched += 1

                if payload.get("disputed_resolutions"):
                    stats.disputed_resolutions += len(payload["disputed_resolutions"])
            except sqlite3.Error as exc:
                conn.rollback()
                stmt = (_SQL_TRACE.get("sql") or "<unknown>").strip().replace("\n", " ")
                if len(stmt) > 120:
                    stmt = stmt[:120] + "…"
                detail = (f"SQLite {type(exc).__name__} writing {file_name} "
                          f"(document_id={doc_id}, page_number={i + 1}): {exc}\n"
                          f"    statement: {stmt}")
                print(f"[error] {detail}\n        Rolled back this document's uncommitted "
                      f"writes; database left consistent.", file=sys.stderr)
                raise RuntimeError(detail) from exc

        conn.commit()   # document complete -> safe point (VLM cache also done)

    # ---- Embeddings for this document's procedures ---------------------------
    if proc_ids_for_embed:
        texts = [t for _, t in proc_ids_for_embed]
        vecs = embed_texts(texts)
        for (proc_id, _), vec in zip(proc_ids_for_embed, vecs):
            if vec.shape[0] != EMBEDDING_DIM:
                raise RuntimeError(
                    f"embedding dim {vec.shape[0]} != expected {EMBEDDING_DIM}"
                )
            set_embedding(conn, proc_id, vec)
        stats.embeddings_written += len(vecs)
        conn.commit()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
def _fmt_elapsed(s: float) -> str:
    h, rem = divmod(int(s), 3600)
    m, sec = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m {sec:02d}s"
    if m:
        return f"{m}m {sec:02d}s"
    return f"{sec}s"


def print_summary(stats: RunStats, db_path: Path, elapsed: float) -> None:
    line = "=" * 64
    thin = "-" * 64
    print(f"\n{line}")
    print(" WIS+ ingestion summary")
    print(thin)
    print(f" PDFs processed ............ {stats.pdfs_total:>5}   (WIS: {stats.wis_docs}, HAYNES: {stats.haynes_docs})")
    if stats.pdfs_skipped_existing:
        print(f" Skipped (duplicate) ......... {stats.pdfs_skipped_existing:>5}")
    if stats.pdfs_skipped_hash:
        print(f" Skipped (exact file hash) ... {stats.pdfs_skipped_hash:>5}")
    print(f" Pages processed ............. {stats.pages_processed:>5}")
    print(f"   boilerplate skipped ....... {stats.boilerplate_skipped:>5}   (covers / TOC / index)")
    print(f"   spec tables / diagrams .... {stats.spec_tables:>3} / {stats.diagrams}")
    print(f" Procedures extracted ........ {stats.procedures_extracted:>5}")
    if stats.procedures_dedup_replaced or stats.procedures_dedup_suppressed:
        print(f"   procedure dedup ........... replaced {stats.procedures_dedup_replaced:>3}   suppressed {stats.procedures_dedup_suppressed:>3} (secondary copies hidden from search)")
    print(f"   steps indexed ............. {stats.steps_indexed:>5}")
    print(f" Torque specs indexed ........ {stats.torque_specs_indexed:>5}   (exact bbox matched: {stats.torque_bboxes_matched})")
    print(f" Disputed regions ............ {stats.disputed_regions_total:>5}   (VLM resolutions: {stats.disputed_resolutions})")
    print(f" Embeddings written .......... {stats.embeddings_written:>5}   ({EMBEDDING_DIM}-dim, {EMBEDDING_MODEL})")
    if stats.errors:
        print(thin)
        for e in stats.errors:
            print(f" [error] {e}")
    print(f" Elapsed ..................... {_fmt_elapsed(elapsed)}")
    print(f" Database .................... {db_path}")
    print(line + "\n")


def _reset_caches(args: argparse.Namespace) -> None:
    """Optionally clear the on-disk OCR/VLM checkpoint caches before a build."""
    base = Path(__file__).resolve().parent / ".cache"
    targets: list[str] = []
    if getattr(args, "reset_cache", False):
        targets += ["ocr", "vlm"]
    elif getattr(args, "reset_vlm_cache", False):
        targets += ["vlm"]
    for name in targets:
        d = base / name
        removed = 0
        if d.is_dir():
            for f in d.iterdir():
                if f.is_file():
                    f.unlink(missing_ok=True)
                    removed += 1
        print(f"[cache] reset forge/.cache/{name}/ ({removed} file(s) removed)")


def run(args: argparse.Namespace) -> int:
    _preflight(args)  # fails loudly (sys.exit(1)) on any missing dependency
    _reset_caches(args)
    pdf_dir = Path(args.pdf_dir).resolve()
    db_path = Path(args.db_path)
    pdfs = sorted(pdf_dir.glob("*.pdf"))

    t0 = time.time()
    conn = init_db(db_path)
    stats = RunStats()
    synonyms = load_synonyms()
    dedup_index = ProcedureDedupIndex(conn)
    pools_fns = _make_engine_pools()

    try:
        async def _main() -> None:
            async with VLMEnricher(llama_url=args.llama_url) as vlm:
                for pdf_path in pdfs:
                    try:
                        await process_pdf(
                            conn, pdf_path, vlm, synonyms, pools_fns,
                            target_long_edge=args.target_long_edge,
                            vlm_concurrency=args.vlm_concurrency,
                            max_pages=args.max_pages,
                            stats=stats,
                            reset_cache=getattr(args, "reset_cache", False),
                            dedup_index=dedup_index,
                        )
                    except Exception as e:
                        # One bad PDF must not kill the whole batch; the VLM
                        # checkpoint cache makes a re-run of it cheap.
                        conn.rollback()
                        msg = f"{pdf_path.name}: {type(e).__name__}: {e}"
                        stats.errors.append(msg)
                        print(f"[error] {msg}", file=sys.stderr)

        asyncio.run(_main())
    finally:
        if pools_fns is not None:
            for p in pools_fns[0]:
                p.shutdown(wait=True)
        conn.close()

    print_summary(stats, db_path, time.time() - t0)
    return 1 if stats.errors else 0


def main(argv: Optional[list[str]] = None) -> int:
    # Entry point: silence EasyOCR's noisy internal PyTorch warnings before any
    # torch import/initialization happens in this process (the pre-flight engine
    # check builds an easyocr.Reader here).  Worker processes re-apply the same
    # filters themselves (see ocr_consensus._worker_easyocr).
    silence_easyocr_torch_warnings()
    parser = argparse.ArgumentParser(
        prog="python -m forge.build_db",
        description="Build the WIS+ SQLite knowledge base from raw manual PDFs "
                    "(normalize -> 3-engine OCR consensus -> VLM structuring -> "
                    "embeddings + FTS5).",
    )
    parser.add_argument("--pdf-dir", default="./pdfs",
                        help="directory of raw WIS/Haynes PDFs (default: ./pdfs)")
    parser.add_argument("--db-path", default="./data/w201_kb.sqlite",
                        help="output SQLite path (default: ./data/w201_kb.sqlite)")
    parser.add_argument("--llama-url", default="http://127.0.0.1:8080",
                        help="local llama.cpp server base URL "
                             "(default: http://127.0.0.1:8080)")
    parser.add_argument("--target-long-edge", type=int, default=2200,
                        help="normalized-page render target (px, default: 2200)")
    parser.add_argument("--vlm-concurrency", type=int, default=1,
                        help="parallel VLM requests; keep at 1 for a single-stream "
                             "llama.cpp server (default: 1)")
    parser.add_argument("--max-pages", type=int, default=None,
                        help="cap pages per PDF (smoke-testing large Haynes books)")
    parser.add_argument("--skip-vlm", action="store_true",
                        help="Skip VLM enrichment (OCR-only build); also skips the "
                             "llama-server reachability check.")
    parser.add_argument("--strict", action="store_true",
                        help="Require all 3 OCR engines (full consensus) instead of any 2 of 3.")
    parser.add_argument("--reset-cache", action="store_true",
                        help="Delete ALL cached OCR + VLM results under forge/.cache/ "
                             "(ocr/ and vlm/) before starting a fresh build.")
    parser.add_argument("--reset-vlm-cache", action="store_true",
                        help="Delete only the VLM cache (forge/.cache/vlm/) so cached "
                             "OCR consensus is preserved while Qwen3.8-27B re-runs.")
    args = parser.parse_args(argv)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
