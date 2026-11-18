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
  7. documents / pages / procedures / torque_specs rows are written; the FTS5
     index fills itself via the schema triggers.

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
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Repo-root imports: `shared` and `forge` are sibling namespace packages.
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import fitz  # pymupdf — hard dependency (forge/requirements.txt)

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
from forge.ocr_consensus import compute_consensus, run_ocr_engines  # noqa: E402
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
    section: Optional[int],
    subsection: Optional[int],
    page_count: int,
    checksum: str,
) -> tuple[int, bool]:
    """Insert the document row. Returns ``(doc_id, is_fresh)``; a pre-existing
    row with an identical sha256 means the file was already ingested this run
    (duplicate in --pdf-dir) and can be skipped."""
    cur = conn.execute(
        "SELECT id, checksum_sha256 FROM documents WHERE file_name = ?",
        (file_name,),
    )
    row = cur.fetchone()
    if row is not None:
        if row["checksum_sha256"] == checksum:
            return int(row["id"]), False
        conn.execute("DELETE FROM documents WHERE id = ?", (row["id"],))  # cascade
    cur = conn.execute(
        "INSERT INTO documents (file_name, source_type, section, subsection,"
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


def insert_procedure(conn: sqlite3.Connection, page_id: int, rec: ProcedureRecord) -> int:
    cur = conn.execute(
        "INSERT INTO procedures (page_id, category, subcategory, title, search_text,"
        " engine_variants, transmission_variants, tools_required, removal_steps,"
        " installation_steps, general_tips, embedding_dim)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (page_id, rec.category, rec.subcategory, rec.title, rec.search_text,
         dump_json(rec.engine_variants), dump_json(rec.transmission_variants),
         dump_json([t.model_dump() for t in rec.tools_required]),
         dump_json([s.model_dump() for s in rec.removal_steps]),
         dump_json([s.model_dump() for s in rec.installation_steps]),
         dump_json(rec.general_tips), None),
    )
    return int(cur.lastrowid)


def insert_torque_spec(
    conn: sqlite3.Connection,
    procedure_id: Optional[int],
    page_id: int,
    row: TorqueSpecRow,
) -> None:
    conn.execute(
        "INSERT INTO torque_specs (procedure_id, page_id, component_name, value_nm,"
        " value_ftlb, raw_text, step_mode, bbox) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (procedure_id, page_id, row.component_name, row.value_nm, row.value_ftlb,
         row.raw_text, row.step_mode, dump_json(row.bbox.model_dump())),
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
    pools = [ProcessPoolExecutor(max_workers=1) for _ in fns]
    return pools, fns


def _ocr_page_pinned(pools_fns, gray: "np.ndarray") -> list[list[dict]]:
    """Run all three engines on one preprocessed page via the pinned pools."""
    pools, fns = pools_fns
    futures = [pools[i].submit(fns[i], gray) for i in range(len(fns))]
    results: list[list[dict]] = []
    for fut in futures:
        try:
            results.append(fut.result())
        except Exception as e:  # engine crash on a degenerate page is not fatal
            print(f"      [warn] OCR engine failed on this page: {e}", file=sys.stderr)
            results.append([])
    return results


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


def _torque_rows(payload: dict, tokens: list[dict]) -> list[TorqueSpecRow]:
    rows: list[TorqueSpecRow] = []
    for t in payload["torque_specs"]:
        bbox = match_torque_bbox(t["raw_text"], tokens)
        rows.append(TorqueSpecRow(
            component_name=t["component_name"],
            value_nm=t["value_nm"],
            value_ftlb=t["value_ftlb"],
            raw_text=t["raw_text"],
            step_mode=StepMode(t["step_mode"]),
            bbox=bbox,
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
) -> None:
    file_name = pdf_path.name
    section, subsection = parse_wis_filename(file_name)
    source_type = "WIS" if (section is not None and subsection is not None) else "HAYNES"
    checksum = sha256_file(pdf_path)
    doc_hash16 = checksum[:16]   # cache-key truncation; full hash stored in DB

    with fitz.open(str(pdf_path)) as doc:
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

        # ---- Pass 1: OCR (images freed immediately; tokens are tiny) --------
        engine_results: list[list[list[dict]]] = []   # [page][engine] -> tokens
        metas: list[dict] = []
        for i in range(page_count):
            img, meta = render_normalized_page(doc, i, target_long_edge=target_long_edge)
            gray = preprocess_scan_for_ocr(img)
            if pools_fns is not None:
                try:
                    eng = _ocr_page_pinned(pools_fns, gray)
                except Exception as e:
                    print(f"      [warn] OCR failed on page {i+1}: {e}", file=sys.stderr)
                    eng = run_ocr_engines(gray)  # last-resort public API
            else:
                eng = run_ocr_engines(gray)
            engine_results.append(eng)
            metas.append(meta)
            del img, gray
            if (i + 1) % 25 == 0 or i + 1 == page_count:
                print(f"      OCR: {i+1}/{page_count} pages")

        # ---- Repeating-margin boilerplate across the whole document ---------
        all_page_tokens = [
            [t for eng in er for t in eng] for er in engine_results
        ]
        repeating_margins = detect_repeating_margins(all_page_tokens)

        # ---- Pass 2: consensus + VLM + DB rows (streaming, one page at a time)
        proc_ids_for_embed: list[tuple[int, str]] = []  # (procedure_id, search_text)

        for i in range(page_count):
            meta = metas[i]
            filtered_engines = [
                filter_boilerplate_tokens(eng, repeating_margins) for eng in engine_results[i]
            ]
            consensus = compute_consensus(filtered_engines)
            stats.disputed_regions_total += len(consensus["disputed_regions"])

            img, _ = render_normalized_page(doc, i, target_long_edge=target_long_edge)
            try:
                payload = await vlm.enrich_page(doc_hash16, i + 1, img, consensus)
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

            tokens = consensus["tokens"]
            page_id = upsert_page(
                conn, doc_id, i + 1, meta["orientation"], meta["width"],
                meta["height"], page_type, consensus["text"],
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
            proc_id = insert_procedure(conn, page_id, rec)
            stats.procedures_extracted += 1
            stats.steps_indexed += len(removal) + len(installation)
            if search_text:
                proc_ids_for_embed.append((proc_id, search_text))

            for trow in _torque_rows(payload, tokens):
                insert_torque_spec(conn, proc_id, page_id, trow)
                stats.torque_specs_indexed += 1
                b = trow.bbox
                if not (b.x0 <= 1e-9 and b.y0 <= 1e-9 and b.x1 >= 1 - 1e-9
                        and b.y1 >= 1 - 1e-9):
                    stats.torque_bboxes_matched += 1

            if payload.get("disputed_resolutions"):
                stats.disputed_resolutions += len(payload["disputed_resolutions"])

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
    print(f" Pages processed ............. {stats.pages_processed:>5}")
    print(f"   boilerplate skipped ....... {stats.boilerplate_skipped:>5}   (covers / TOC / index)")
    print(f"   spec tables / diagrams .... {stats.spec_tables:>3} / {stats.diagrams}")
    print(f" Procedures extracted ........ {stats.procedures_extracted:>5}")
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


def run(args: argparse.Namespace) -> int:
    pdf_dir = Path(args.pdf_dir)
    db_path = Path(args.db_path)
    if not pdf_dir.is_dir():
        print(f"error: --pdf-dir {pdf_dir} is not a directory", file=sys.stderr)
        return 2

    pdfs = sorted(pdf_dir.glob("*.pdf"))
    if not pdfs:
        print(f"error: no *.pdf files found in {pdf_dir}", file=sys.stderr)
        return 2

    t0 = time.time()
    conn = init_db(db_path)
    stats = RunStats()
    synonyms = load_synonyms()
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
    args = parser.parse_args(argv)
    return run(args)


if __name__ == "main":
    sys.exit(main())
