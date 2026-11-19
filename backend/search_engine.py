"""
WIS+  backend/search_engine.py
===============================
Hybrid search over ``data/w201_kb.sqlite`` (built by ``forge/``, schema in
``shared/schema.sql``):

* **Lexical**  — SQLite FTS5 with BM25 ranking over ``procedures_fts``.
* **Semantic** — cosine similarity against pre-computed 384-dim float32
  embeddings (``BAAI/bge-small-en-v1.5`` via ``fastembed``, ONNX CPU).
* **Fusion**   — Reciprocal Rank Fusion (k = 60) over the two ranked lists.

Design constraints (see project brief):
* The database is opened **read-only** (``file:...?mode=ro``) — the runtime
  never writes to the knowledge base; ``forge/`` owns that.
* All procedure embeddings are loaded once at startup into a single compact,
  C-contiguous ``numpy.float32`` matrix (N x 384). For ~5k procedures that is
  ~7.5 MB — well inside the 120 MB RAM budget.
* The ONNX embedder itself is loaded lazily on first search so that
  directory browsing / PDF rendering never pays for it.
* Query terms are expanded with ``shared/synonyms.json``; the matched alias
  chips are exposed via :attr:`HybridSearchEngine.last_expansion` so the UI can
  render e.g. ``Also matching: shock absorber, damper``.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Optional

import numpy as np

# --- shared / project layout -------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent          # project root (WIS+/)
DB_PATH = ROOT / "data" / "w201_kb.sqlite"
SYNONYMS_PATH = ROOT / "shared" / "synonyms.json"

EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"            # 384-dim, ONNX CPU
RRF_K = 60                                            # standard RRF constant
_CANDIDATE_FACTOR = 4                                 # fetch limit*N per list
_MAX_CANDIDATES = 80                                  # hard cap per ranked list

log = logging.getLogger("wisplus.search")

# Make the project root importable regardless of CWD (shared/ has no __init__).
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ---------------------------------------------------------------------------
# Synonyms (shared/synonyms.json) — loaded once, keyed casefolded.
# ---------------------------------------------------------------------------
def load_synonym_families(path: Path = SYNONYMS_PATH) -> dict[str, list[str]]:
    """Return ``{canonical: [alias, ...]}`` from shared/synonyms.json.

    The ``_meta`` key is ignored. Missing/corrupt file degrades to an empty
    map (search still works, just without expansion).
    """
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:  # pragma: no cover
        log.warning("synonyms file unavailable (%s); expansion disabled", exc)
        return {}
    return {
        str(k): [str(t) for t in v]
        for k, v in raw.items()
        if k != "_meta" and isinstance(v, list)
    }


def _quote_fts_phrase(phrase: str) -> str:
    """Safely quote one phrase for an FTS5 MATCH expression."""
    return '"' + phrase.replace('"', '""') + '"'


# ---------------------------------------------------------------------------
# HybridSearchEngine
# ---------------------------------------------------------------------------
class HybridSearchEngine:
    """Read-only hybrid (FTS5 BM25 + vector cosine, RRF-fused) search engine."""

    def __init__(self, db_path: Path | str = DB_PATH) -> None:
        self.db_path = Path(db_path)
        self.db_loaded = False
        self.procedure_count = 0
        #: Human-readable reason when db_loaded is False (None == healthy).
        self.db_error: Optional[str] = None

        # Embedding matrix (N x dim), L2-normalized rows, C-contiguous float32.
        self._embed_matrix: Optional[np.ndarray] = None
        self._embed_index: dict[int, int] = {}      # procedure_id -> row index

        # Lazy singletons / state.
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = threading.Lock()               # serializes sqlite access
        self._text_embedder = None                  # fastembed.TextEmbedding
        self._source_map: dict[int, str] = {}       # procedure_id -> source_type
        #: True once _open_db confirms procedures.is_duplicate exists (schema v2+);
        #: secondary duplicate copies are then hidden from every result path.
        self._has_dup_flag = False
        self.families = load_synonym_families()

        #: Alias chips from the most recent :meth:`search` call (UI "Also matching").
        self.last_expansion: list[str] = []

        if self.db_path.exists():
            try:
                self._open_db()
            except Exception as exc:  # corrupt/empty DB, missing schema, locked file ...
                self._conn = None
                self.db_loaded = False
                self.db_error = (
                    f"Could not open database at {self.db_path} "
                    f"({type(exc).__name__}: {exc}). Rebuild it with forge.build_db "
                    f"or restore a good copy of w201_kb.sqlite into data/."
                )
                log.error("knowledge base failed to open at %s (%s: %s) — starting in DEGRADED mode with no data.",
                          self.db_path, type(exc).__name__, exc)
        else:
            self.db_error = (
                f"Database not found at {self.db_path} — run forge.build_db on Windows "
                f"or copy w201_kb.sqlite into data/."
            )
            log.warning(
                "Database not found at %s — run forge.build_db on Windows or copy "
                "w201_kb.sqlite into data/. Starting in DEGRADED mode with no searchable data.",
                self.db_path,
            )

    # -- lifecycle -----------------------------------------------------------
    def _open_db(self) -> None:
        """Open the DB read-only and preload embeddings + source map."""
        uri = f"file:{self.db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        self._conn = conn
        self.db_loaded = True

        cols = {r["name"] for r in conn.execute("PRAGMA table_info(procedures)")}
        self._has_dup_flag = "is_duplicate" in cols
        dup_where = " WHERE is_duplicate = 0" if self._has_dup_flag else ""
        self.procedure_count = int(
            conn.execute(f"SELECT COUNT(*) AS n FROM procedures{dup_where}").fetchone()["n"]
        )

        # procedure_id -> source_type (WIS / HAYNES), via pages -> documents.
        self._source_map = {
            row["id"]: row["source_type"]
            for row in conn.execute(
                "SELECT p.id AS id, d.source_type AS source_type"
                " FROM procedures p"
                " JOIN pages pg ON pg.id = p.page_id"
                " JOIN documents d ON d.id = pg.document_id"
            )
        }

        self._load_embeddings()
        log.info(
            "loaded %s: %d procedures, %d embedded", self.db_path.name,
            self.procedure_count, len(self._embed_index),
        )

    def _load_embeddings(self) -> None:
        """Pack every stored embedding BLOB into one contiguous float32 matrix."""
        assert self._conn is not None
        dup_clause = " AND is_duplicate = 0" if self._has_dup_flag else ""
        rows = self._conn.execute(
            "SELECT id, embedding FROM procedures"
            " WHERE embedding IS NOT NULL AND length(embedding) > 0" + dup_clause
        ).fetchall()
        if not rows:
            return
        dim = len(rows[0]["embedding"]) // 4
        m = np.empty((len(rows), dim), dtype=np.float32)
        keep_ids: list[int] = []
        for i, row in enumerate(rows):
            blob = row["embedding"]
            if len(blob) != dim * 4:      # defensive: skip a torn write
                continue
            m[i] = np.frombuffer(blob, dtype=np.float32)
            keep_ids.append(int(row["id"]))
        if not keep_ids:
            return
        m = m[: len(keep_ids)]
        # L2-normalize once at load time -> cosine == dot product at query time.
        norms = np.linalg.norm(m, axis=1)
        norms[norms == 0.0] = 1.0
        m /= norms[:, None]
        self._embed_matrix = np.ascontiguousarray(m, dtype=np.float32)
        self._embed_index = {pid: i for i, pid in enumerate(keep_ids)}

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    # -- fastembed (lazy, ONNX CPU) -------------------------------------------
    def _get_embedder(self):
        """Load the ONNX embedder on first use; None if unavailable."""
        if self._text_embedder is None:
            try:
                from fastembed import TextEmbedding
                self._text_embedder = TextEmbedding(EMBEDDING_MODEL)
            except Exception as exc:  # pragma: no cover - env dependent
                log.warning("fastembed unavailable (%s); vector search off", exc)
                return None
        return self._text_embedder

    # -- synonym expansion ------------------------------------------------------
    def expand_query(self, query: str) -> tuple[list[str], list[str]]:
        """Expand a raw query into FTS phrases + matched alias chips.

        Returns ``(phrases, chips)`` where ``phrases`` are quoted-term building
        blocks for the MATCH expression (user tokens first, then every term of
        each synonym family that was triggered) and ``chips`` are the family
        terms *not* already present in the query — what the UI shows as
        ``Also matching: ...``.
        """
        low = query.casefold()
        phrases: list[str] = []
        chips: list[str] = []
        seen_p: set[str] = set()
        seen_c: set[str] = set()

        def add_phrase(p: str) -> None:
            key = p.casefold()
            if key and key not in seen_p:
                seen_p.add(key)
                phrases.append(p)

        # 1. The user's own tokens (word boundary safe via FTS phrase quoting).
        for tok in re.findall(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", query):
            add_phrase(tok)

        # 2. Synonym families: trigger when any member appears as a whole word.
        for canonical, aliases in self.families.items():
            members = [canonical, *aliases]
            if not any(re.search(rf"\b{re.escape(m.casefold())}\b", low) for m in members):
                continue
            for m in members:
                add_phrase(m)
                if not re.search(rf"\b{re.escape(m.casefold())}\b", low) and m.casefold() not in seen_c:
                    seen_c.add(m.casefold())
                    chips.append(m)

        return phrases, chips

    # -- vector side ------------------------------------------------------------
    def _vector_top(self, query_text: str, k: int) -> list[tuple[int, float]]:
        """Top-k (procedure_id, cosine) by dot product against the matrix."""
        if self._embed_matrix is None or not self._embed_index:
            return []
        embedder = self._get_embedder()
        if embedder is None:
            return []
        try:
            vecs = list(embedder.embed([query_text]))
            qv = np.asarray(vecs[0], dtype=np.float32).ravel()
        except Exception as exc:  # pragma: no cover - model/runtime errors
            log.warning("query embedding failed (%s); vector search off", exc)
            return []
        norm = float(np.linalg.norm(qv))
        if norm == 0.0:
            return []
        qv /= norm
        sims = self._embed_matrix @ qv                       # rows are unit-norm
        k = min(k, len(sims))
        top = np.argpartition(-sims, k - 1)[:k] if k < len(sims) else np.arange(len(sims))
        order = top[np.argsort(-sims[top])]
        # map row index -> procedure id (inverse of _embed_index)
        inv = {i: pid for pid, i in self._embed_index.items()}
        return [(inv[int(i)], float(sims[i])) for i in order]

    # -- filters ------------------------------------------------------------------
    @staticmethod
    def _variant_match(variants_json: Optional[str], filt: Optional[str]) -> bool:
        """True when the procedure passes a variant filter.

        ``None``/``''``/``'ALL'`` means no filtering; otherwise the procedure's
        JSON variant array must contain the requested value **or** be tagged
        ``ALL`` (applies to every build).
        """
        if not filt or filt.strip().upper() == "ALL":
            return True
        want = filt.strip()
        try:
            arr = json.loads(variants_json) if variants_json else []
        except json.JSONDecodeError:
            arr = []
        return any(str(v).strip() == want or str(v).strip().upper() == "ALL" for v in arr)

    # -- public API -----------------------------------------------------------------
    def search(
        self,
        query: str,
        engine_filter: Optional[str] = None,
        transmission_filter: Optional[str] = None,
        source_filter: Optional[str] = None,
        limit: int = 15,
    ) -> list["SearchResultItem"]:
        """Hybrid search. See module docstring for the pipeline.

        Populates :attr:`last_expansion` with matched synonym alias chips.
        """
        from shared.models import SearchResultItem   # local: keep import light

        self.last_expansion = []
        if not self.db_loaded or not query.strip():
            return []
        limit = max(1, min(int(limit), 50))
        cand = min(max(limit * _CANDIDATE_FACTOR, 20), _MAX_CANDIDATES)

        phrases, chips = self.expand_query(query)
        self.last_expansion = chips
        if not phrases:
            return []

        fts_expr = " OR ".join(_quote_fts_phrase(p) for p in phrases)

        # ---- 1. FTS5 / BM25 list (lower rank is better) ----------------------
        fts_hits: list[tuple[int, float, Optional[str]]] = []
        with self._lock:
            try:
                dup_clause = " AND p.is_duplicate = 0" if self._has_dup_flag else ""
                rows = self._conn.execute(
                    "SELECT p.id AS id, bm25(procedures_fts) AS rank,"
                    " snippet(procedures_fts, 3, '«', '»', ' … ', 16) AS snip"
                    " FROM procedures_fts"
                    " JOIN procedures AS p ON p.id = procedures_fts.rowid"
                    " WHERE procedures_fts MATCH ?" + dup_clause +
                    " ORDER BY rank LIMIT ?",
                    (fts_expr, cand),
                ).fetchall()
            except sqlite3.OperationalError as exc:  # bad MATCH syntax etc.
                log.warning("FTS5 query failed (%s): %s", fts_expr, exc)
                rows = []
            fts_hits = [(int(r["id"]), float(r["rank"]), r["snip"]) for r in rows]

        # ---- 2. Vector list (higher cosine is better) ------------------------
        vec_hits = self._vector_top(" ".join(phrases), k=cand)

        if not fts_hits and not vec_hits:
            return []

        # ---- 3. Load candidate rows + torque counts in one round-trip --------
        union_ids = [pid for pid, _, _ in fts_hits] + [pid for pid, _ in vec_hits]
        seen: set[int] = set()
        union_ids = [p for p in union_ids if not (p in seen or seen.add(p))]

        with self._lock:
            rows = self._conn.execute(
                "SELECT id, title, category, subcategory, engine_variants,"
                " transmission_variants, page_id FROM procedures WHERE id IN (" + ",".join("?" * len(union_ids)) + ")",
                union_ids,
            ).fetchall()
            tq = self._conn.execute(
                "SELECT procedure_id, COUNT(*) AS n FROM torque_specs"
                " WHERE procedure_id IN (" + ",".join("?" * len(union_ids)) + ")"
                " GROUP BY procedure_id",
                union_ids,
            ).fetchall()
        meta = {int(r["id"]): r for r in rows}
        torque_counts = {int(r["procedure_id"]): int(r["n"]) for r in tq}

        # ---- 4. Reciprocal Rank Fusion ---------------------------------------
        scores: dict[int, float] = {}
        fts_rank_of: dict[int, float] = {}
        cos_of: dict[int, float] = {}
        snip_of: dict[int, Optional[str]] = {}
        for rank0, (pid, bm25, snip) in enumerate(fts_hits):
            scores[pid] = scores.get(pid, 0.0) + 1.0 / (RRF_K + rank0 + 1)
            fts_rank_of[pid] = bm25
            snip_of[pid] = snip
        for rank0, (pid, cos) in enumerate(vec_hits):
            scores[pid] = scores.get(pid, 0.0) + 1.0 / (RRF_K + rank0 + 1)
            cos_of[pid] = cos

        # ---- 5. Apply user filters (ALL-tagged procedures always retained) ---
        results: list[SearchResultItem] = []
        for pid, fused in scores.items():
            row = meta.get(pid)
            if row is None:
                continue
            if not self._variant_match(row["engine_variants"], engine_filter):
                continue
            if not self._variant_match(row["transmission_variants"], transmission_filter):
                continue
            if source_filter and source_filter.strip().upper() != "ALL":
                if self._source_map.get(pid) != source_filter.strip().upper():
                    continue
            results.append(
                SearchResultItem(
                    procedure_id=pid,
                    title=row["title"],
                    category=row["category"],
                    subcategory=row["subcategory"],
                    snippet=snip_of.get(pid),
                    fts_rank=round(fts_rank_of.get(pid, 0.0), 4),
                    vector_score=round(cos_of[pid], 4) if pid in cos_of else None,
                    combined_score=round(fused, 6),
                    engine_variants=json.loads(row["engine_variants"] or "[]"),
                    transmission_variants=json.loads(row["transmission_variants"] or "[]"),
                    page_id=row["page_id"],
                    torque_count=torque_counts.get(pid, 0),
                )
            )
        results.sort(key=lambda r: (-r.combined_score, -(r.vector_score or 0.0)))
        return results[:limit]

    # -- directory tree -----------------------------------------------------------
    def get_directory_tree(
        self,
        engine_filter: Optional[str] = None,
        transmission_filter: Optional[str] = None,
    ) -> list[dict]:
        """Collapsible index: Category -> Subcategory -> Procedure summaries.

        Shape::

            [{"category": "M102 Engine", "subcategories": [
                 {"name": "1.8L", "procedures": [{"id": 3, "title": "..."}]}
             ]}]
        """
        if not self.db_loaded:
            return []

        where: list[str] = []
        params: list[str] = []
        if self._has_dup_flag:
            where.append("is_duplicate = 0")
        for col, filt in (("engine_variants", engine_filter), ("transmission_variants", transmission_filter)):
            if filt and filt.strip().upper() != "ALL":
                where.append(f"({col} LIKE ? OR {col} LIKE '%\"ALL\"%')")
                params.append(f'%"{filt.strip()}"%')
        sql = (
            "SELECT id, category, subcategory, title FROM procedures"
            + (f" WHERE {' AND '.join(where)}" if where else "")
            + " ORDER BY category, subcategory, title"
        )

        tree: dict[str, dict[str, dict]] = {}
        with self._lock:
            for row in self._conn.execute(sql, params):
                cat = tree.setdefault(row["category"], {})
                sub = cat.setdefault(row["subcategory"], {"name": row["subcategory"], "procedures": []})
                sub["procedures"].append({"id": int(row["id"]), "title": row["title"]})

        return [
            {"category": c, "subcategories": list(subs.values())}
            for c, subs in tree.items()
        ]

    # -- document / pdf helpers -----------------------------------------------------
    def get_document(self, document_id: int) -> Optional[dict]:
        """Row from ``documents`` by id (filename needed for ./pdfs lookup)."""
        if not self.db_loaded:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT id, filename, source_type, wis_section, wis_subsection, page_count"
                " FROM documents WHERE id = ?",
                (document_id,),
            ).fetchone()
        return dict(row) if row is not None else None

    def get_procedure_row(self, procedure_id: int) -> Optional[dict]:
        """Full ``procedures`` row joined with its page + document context."""
        if not self.db_loaded:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT p.*, pg.page_number AS page_number, pg.orientation AS orientation,"
                " d.id AS document_id, d.filename AS filename, d.source_type AS source_type"
                " FROM procedures p"
                " JOIN pages pg ON pg.id = p.page_id"
                " JOIN documents d ON d.id = pg.document_id"
                " WHERE p.id = ?",
                (procedure_id,),
            ).fetchone()
        return dict(row) if row is not None else None

    def get_torque_specs(self, procedure_id: int) -> list[dict]:
        """All torque rows for a procedure (flat bbox_x0..y1 columns)."""
        if not self.db_loaded:
            return []
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, procedure_id, page_id, step_mode, component_name, value_nm,"
                " value_ftlb, raw_text, bbox_x0, bbox_y0, bbox_x1, bbox_y1"
                " FROM torque_specs WHERE procedure_id = ?"
                " ORDER BY step_mode, component_name, id",
                (procedure_id,),
            ).fetchall()
        return [dict(r) for r in rows]
