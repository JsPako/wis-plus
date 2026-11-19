"""
WIS+  forge/ocr_consensus.py
============================
Three-engine OCR with spatial consensus for the WIS+ ingestion pipeline.

A normalized page image (see ``forge.pdf_normalizer.render_normalized_page``) is
sent to **three independent OCR engines** — RapidOCR, Tesseract 5 (via pytesseract)
and EasyOCR — in parallel using a ``concurrent.futures.ProcessPoolExecutor`` tuned
for the build machine's multi-core CPU.  Each engine emits normalized word/line
tokens ``{text, x0, y0, x1, y1, confidence}``.

``compute_consensus`` then:

* aligns spatially overlapping boxes across engines with Intersection-over-Union,
* locks a token on majority vote (>= 2/3 agreement),
* flags disputed tokens — especially numeric values or low-agreement regions — in
  ``disputed_regions`` (normalized ``[x0, y0, x1, y1]``) so the downstream
  Qwen3.8-27B VLM can visually inspect and resolve them from the page image,
* reconstructs clean reading-order text that copes with multi-column layouts.
"""

from __future__ import annotations

import math
import os
import sys
import threading
import time
import warnings
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Optional, Sequence

import numpy as np

# ---------------------------------------------------------------------------
# Geometry helpers (normalized [0,1] boxes)
# ---------------------------------------------------------------------------
def _points_to_bbox(points) -> list[float]:
    """Convert a 4-point box ``[[x,y]*4]`` to an axis-aligned ``[x0,y0,x1,y1]``."""
    xs = [float(p[0]) for p in points]
    ys = [float(p[1]) for p in points]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    return [x0, y0, x1, y1]


def _iou(a: list[float], b: list[float]) -> float:
    """Intersection-over-Union of two ``[x0,y0,x1,y1]`` boxes (any units)."""
    ix0 = max(a[0], b[0]); iy0 = max(a[1], b[1])
    ix1 = min(a[2], b[2]); iy1 = min(a[3], b[3])
    iw = max(0.0, ix1 - ix0)
    ih = max(0.0, iy1 - iy0)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _union(a: list[float], b: list[float]) -> list[float]:
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def _norm_text(text: str) -> str:
    import re
    return re.sub(r"\s+", " ", (text or "")).strip().casefold()


def _has_digit(text: str) -> bool:
    return any(ch.isdigit() for ch in text)


def _digits_of(text: str) -> str:
    return "".join(ch for ch in text if ch.isdigit())


# ---------------------------------------------------------------------------
# PyTorch warning hygiene (EasyOCR on CPU)
# ---------------------------------------------------------------------------
def silence_easyocr_torch_warnings() -> None:
    """Silence the internal PyTorch ``UserWarning``s EasyOCR emits on CPU-only boxes.

    Two harmless, noisy warnings are known to fire when EasyOCR initializes and
    runs without a GPU:

    * ``torch.quantize_per_tensor ... are deprecated and will be removed in a
      future PyTorch release`` — raised from
      ``torch.ao.nn.quantized.dynamic.modules.rnn``; we never use quantized RNNs.
    * ``'pin_memory' argument is set as true but no accelerator is found, then
      device pinned memory won't be used.`` — raised from
      ``torch.utils.data.dataloader`` because EasyOCR sets ``pin_memory=True``
      unconditionally.

    This must be called in *every* process that runs EasyOCR: on Windows,
    ``ProcessPoolExecutor`` uses the ``spawn`` start method, so worker processes
    do NOT inherit runtime ``warnings`` filters set by the parent.  Idempotent —
    safe to call repeatedly (filters are additive).
    """
    warnings.filterwarnings(
        "ignore",
        message=r".*torch\.quantize_per_tensor.*",
        category=UserWarning,
    )
    warnings.filterwarnings(
        "ignore",
        message=r".*'pin_memory' argument is set as true.*",
        category=UserWarning,
    )


_EASYOCR_PREWARMED: bool = False


def prewarm_easyocr_weights() -> None:
    """Initialize EasyOCR once in the calling process so its weights are cached.

    Builds ``easyocr.Reader(['en'], gpu=False, verbose=False)`` in the main
    process *before* any ``ProcessPoolExecutor`` workers spawn, so the detection
    (``craft_mlt_25k.pth``) and recognition (``english_g2.pth``) models are
    downloaded/cached cleanly a single time instead of racing across worker
    processes on first use.  Memoized per process; a failure does not raise —
    the easyocr engine then degrades to empty token lists per page, exactly as
    it would for a worker-side failure.
    """
    global _EASYOCR_PREWARMED
    if _EASYOCR_PREWARMED:
        return
    silence_easyocr_torch_warnings()
    try:
        import easyocr  # type: ignore
        easyocr.Reader(["en"], gpu=False, verbose=False)
        _EASYOCR_PREWARMED = True
    except Exception as exc:  # noqa: BLE001 - degrade; worker reports per page
        print(
            f"[ocr_consensus] EasyOCR pre-warm failed ({type(exc).__name__}: {exc}); "
            "the easyocr engine will degrade to empty results.",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# Per-engine OCR workers.
#
# Each is a top-level function so it can be pickled and dispatched to a worker
# process.  Models are lazy-initialized into a per-process cache (``_MODEL_CACHE``)
# — under ProcessPoolExecutor every worker is its own OS process, so each one loads
# its own model exactly once and never shares heavy objects across the pool.
# Any engine failure (missing Tesseract binary, model download hiccup, ...) degrades
# to an empty token list instead of crashing the whole consensus run.
# ---------------------------------------------------------------------------
_MODEL_CACHE: dict = {}


def _log_worker_failure(engine: str) -> None:
    """Print the full traceback of a per-engine OCR failure to stderr.

    Workers run in separate OS processes under ``ProcessPoolExecutor``; an
    exception that is not logged there is effectively silent (it only resurfaces,
    if at all, as a bare re-raise at the caller).  Logging it here — tagged with
    the engine name — guarantees the failure is never invisible.  The exception is
    then re-raised so the caller (which knows the PDF filename + page number) can
    add that context before degrading to an empty token list.
    """
    import traceback

    print(f"[ocr_consensus] OCR worker '{engine}' failed:", file=sys.stderr)
    traceback.print_exc(file=sys.stderr)


def _worker_rapidocr(img: np.ndarray) -> list[dict]:
    try:
        if "rapid" not in _MODEL_CACHE:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore
            _MODEL_CACHE["rapid"] = RapidOCR()
        ocr = _MODEL_CACHE["rapid"]
        res, _el = ocr(img)
        h, w = img.shape[:2]
        tokens: list[dict] = []
        for item in (res or []):
            box, text, conf = item[0], item[1], float(item[2])
            if not text or not text.strip():
                continue
            x0, y0, x1, y1 = _points_to_bbox(box)
            # RapidOCR returns one box per line; Tesseract/EasyOCR return word
            # boxes. Split the line into proportional word sub-boxes so all three
            # engines emit word-level tokens that align under IoU.
            words = text.strip().split()
            if len(words) <= 1:
                tokens.append({
                    "text": text.strip(),
                    "x0": max(0.0, x0 / w), "y0": max(0.0, y0 / h),
                    "x1": min(1.0, x1 / w), "y1": min(1.0, y1 / h),
                    "confidence": conf,
                })
                continue
            gap = 0.5 * (len(words) - 1)
            unit = (x1 - x0) / (sum(len(wd) for wd in words) + gap)
            cx = x0
            for wd in words:
                wx1 = cx + len(wd) * unit
                tokens.append({
                    "text": wd,
                    "x0": max(0.0, cx / w), "y0": max(0.0, y0 / h),
                    "x1": min(1.0, wx1 / w), "y1": min(1.0, y1 / h),
                    "confidence": conf,
                })
                cx = wx1 + 0.5 * unit
        return tokens
    except Exception:
        _log_worker_failure("rapidocr")
        raise


_TESSERACT_CANDIDATES = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
)


def _resolve_tesseract_cmd() -> str:
    """Locate tesseract.exe: PATH first, then the standard install dirs."""
    import shutil  # type: ignore

    found = shutil.which("tesseract")
    if found:
        return found
    for cand in _TESSERACT_CANDIDATES:
        if os.path.isfile(cand):
            return cand
    raise FileNotFoundError("tesseract binary not found on PATH or in standard locations")


def _worker_tesseract(img: np.ndarray) -> list[dict]:
    try:
        import shutil  # type: ignore
        import cv2  # type: ignore
        import pytesseract  # type: ignore
        if shutil.which(pytesseract.pytesseract.tesseract_cmd) is None:
            pytesseract.pytesseract.tesseract_cmd = _resolve_tesseract_cmd()
        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY) if img.ndim == 3 else img
        data = pytesseract.image_to_data(
            gray, output_type=pytesseract.Output.DICT, config="--psm 6"
        )
        h, w = gray.shape[:2]
        tokens: list[dict] = []
        for i in range(len(data["text"])):
            text = (data["text"][i] or "").strip()
            if not text:
                continue
            left, top = int(data["left"][i]), int(data["top"][i])
            bw, bh = int(data["width"][i]), int(data["height"][i])
            try:
                conf = float(data["conf"][i]) / 100.0
            except (TypeError, ValueError):
                conf = 0.0
            tokens.append({
                "text": text,
                "x0": max(0.0, left / w), "y0": max(0.0, top / h),
                "x1": min(1.0, (left + bw) / w), "y1": min(1.0, (top + bh) / h),
                "confidence": max(0.0, conf),
            })
        return tokens
    except Exception:
        _log_worker_failure("tesseract")
        raise


def _worker_easyocr(img: np.ndarray) -> list[dict]:
    try:
        # Worker entry point: Windows 'spawn' subprocesses do not inherit the
        # parent's runtime warnings filters, so re-apply them here before torch
        # is imported/used in this process.
        silence_easyocr_torch_warnings()
        if "easy" not in _MODEL_CACHE:
            import easyocr  # type: ignore
            _MODEL_CACHE["easy"] = easyocr.Reader(["en"], gpu=False, verbose=False)
        reader = _MODEL_CACHE["easy"]
        h, w = img.shape[:2]
        tokens: list[dict] = []
        for box, text, conf in reader.readtext(img):
            if not text or not text.strip():
                continue
            x0, y0, x1, y1 = _points_to_bbox(box)
            tokens.append({
                "text": text.strip(),
                "x0": max(0.0, x0 / w), "y0": max(0.0, y0 / h),
                "x1": min(1.0, x1 / w), "y1": min(1.0, y1 / h),
                "confidence": float(conf),
            })
        return tokens
    except Exception:
        _log_worker_failure("easyocr")
        raise


_ENGINE_FUNCS = (_worker_rapidocr, _worker_tesseract, _worker_easyocr)
_ENGINE_NAMES = ("rapidocr", "tesseract", "easyocr")

#: Public alias + console display names used by the progress tracker.
ENGINE_NAMES: tuple[str, ...] = _ENGINE_NAMES
_ENGINE_DISPLAY = {"rapidocr": "RapidOCR", "tesseract": "Tesseract", "easyocr": "EasyOCR"}


# ---------------------------------------------------------------------------
# Live per-engine OCR progress (console)
#
# Workers never write to the console.  They report completion exclusively by
# returning from their submitted callable; the main process observes that via
# ``concurrent.futures.as_completed`` and is the ONLY place that touches stdout.
# That single-writer design guarantees the status line can never interleave or
# garble across threads/processes.
# ---------------------------------------------------------------------------
def _write_status_line(line: str, prev_len: int) -> int:
    """Overwrite a single console line via carriage return; returns new length."""
    sys.stdout.write("\r" + line + " " * max(0, prev_len - len(line)))
    sys.stdout.flush()
    return len(line)


class OCRProgressTracker:
    """Track per-engine OCR completion across the pages of one document.

    Usage (main process only)::

        tracker = OCRProgressTracker(total_pages=page_count, label=file_name)
        ...  # for each page: submit one task per engine, and when each future
        ...  # completes call tracker.record(engine_name, elapsed_s, failed)
        tracker.finish()

    Rendering strategy:
      * ``rich`` installed **and** stdout is a TTY  -> live multi-bar display
        (one bar per engine).
      * plain terminal (TTY)                         -> single-line status
        overwritten with carriage returns, e.g.::

            [OCR 01001.pdf] RapidOCR: 12/12 (100%, 34s) | Tesseract: 9/12 (75%, 28s) | EasyOCR: 6/12 (50%, 19s)
      * redirected stdout (logs, CI)                 -> one full line per
        page where all engines finished, plus the final summary — no \r flood.
    """

    def __init__(
        self,
        total_pages: int,
        label: str = "",
        engine_names: Sequence[str] = _ENGINE_NAMES,
    ) -> None:
        self._lock = threading.Lock()
        self.total_pages = max(1, int(total_pages))
        self.label = label
        self.engine_names = tuple(engine_names)
        self._done = {n: 0 for n in self.engine_names}
        self._failed = {n: 0 for n in self.engine_names}
        self._elapsed = {n: 0.0 for n in self.engine_names}
        self._started_at = time.perf_counter()
        # fallback renderer state
        self._last_line_len = 0
        self._last_full_page = -1   # highest page index where ALL engines finished
        self._finished = False
        # rich renderer (lazy; only when usable)
        self._rich = None           # (progress, {engine: task_id})
        try:
            from rich.progress import (  # type: ignore
                BarColumn, Progress, TextColumn, TimeElapsedColumn,
            )
            if sys.stdout.isatty():
                progress = Progress(
                    TextColumn("[bold]{task.description}"),
                    BarColumn(),
                    "[progress.percentage]{task.percentage:>3.0f}%",
                    ", {task.completed}/{task.total} pg",
                    TimeElapsedColumn(),
                    console=None,
                )
                progress.start()
                tasks = {
                    n: progress.add_task(_ENGINE_DISPLAY.get(n, n), total=self.total_pages)
                    for n in self.engine_names
                }
                self._rich = (progress, tasks)
        except Exception:  # noqa: BLE001 - rich optional; fall back to \r lines
            self._rich = None

    @property
    def is_tty(self) -> bool:
        try:
            return sys.stdout.isatty()
        except Exception:  # noqa: BLE001
            return False

    def record(self, engine: str, elapsed_s: float, failed: bool = False) -> None:
        """Register one completed engine task (called from the main process)."""
        with self._lock:
            if engine not in self._done:
                return
            self._done[engine] += 1
            self._elapsed[engine] += max(0.0, float(elapsed_s))
            if failed:
                self._failed[engine] += 1
            min_done = min(self._done.values())
            all_finished = min_done == self.total_pages
            line = self._render_fallback()
        # render outside the lock: rich advances are thread-safe, and the \r
        # writer is only ever called from this process's main thread anyway.
        if self._rich is not None:
            progress, tasks = self._rich
            try:
                progress.advance(tasks[engine], advance=1)
            except Exception:  # noqa: BLE001 - display-only failure
                pass
        elif self.is_tty:
            self._last_line_len = _write_status_line(line, self._last_line_len)
        elif min_done > self._last_full_page:  # redirected: one line per page
            self._last_full_page = min_done
            print(line, flush=True)
        if all_finished:
            self.finish()

    def _render_fallback(self) -> str:
        """Build the single-line status string (caller holds the lock)."""
        parts = []
        for n in self.engine_names:
            d = self._done[n]
            pct = 100.0 * d / self.total_pages
            disp = _ENGINE_DISPLAY.get(n, n)
            extra = f", {self._elapsed[n]:.0f}s"
            parts.append(f"{disp}: {d}/{self.total_pages} ({pct:.0f}%{extra})")
        label = f"[OCR {self.label}] " if self.label else "[OCR] "
        return label + " | ".join(parts)

    def finish(self) -> None:
        """Stop the display and print a one-line per-engine summary (idempotent)."""
        with self._lock:
            finished = min(self._done.values()) == self.total_pages
            if self._finished:
                return  # already summarized
            if not finished:
                # Early call (exception path): still stop any live display.
                if self._rich is not None:
                    try:
                        self._rich[0].stop()
                    except Exception:  # noqa: BLE001
                        pass
                    self._rich = None
                return
            wall = time.perf_counter() - self._started_at
            parts = []
            for n in self.engine_names:
                d, e = self._done[n], self._elapsed[n]
                avg = e / d if d else 0.0
                mark = f", {self._failed[n]} failed" if self._failed[n] else ""
                parts.append(f"{_ENGINE_DISPLAY.get(n, n)}: {d}/{self.total_pages}, "
                             f"{e:.1f}s total (avg {avg:.2f}s/page{mark})")
            label = f"[OCR {self.label}] " if self.label else "[OCR] "
            summary = f"{label}done in {wall:.1f}s | " + " | ".join(parts)
            self._finished = True
        if self._rich is not None:
            try:
                self._rich[0].stop()
            except Exception:  # noqa: BLE001
                pass
            print(summary, flush=True)
        elif self.is_tty:
            sys.stdout.write("\n" + summary)
            sys.stdout.flush()
            self._last_line_len = 0
        else:
            print(summary, flush=True)


# ---------------------------------------------------------------------------
# Pre-flight engine verification.
#
# Run once in the main process *before* any ProcessPoolExecutor worker is
# spawned, so a missing dependency (package not installed, tesseract.exe not on
# PATH, corrupt model) fails fast with an actionable diagnostic table instead of
# surfacing as an opaque crash inside a detached worker process.
# ---------------------------------------------------------------------------
_VERIFY_CACHE: dict = {}


def verify_ocr_engines(strict: bool = False) -> dict[str, bool]:
    """Check that each OCR engine can actually run on this machine.

    Returns ``{engine_name: available_bool}`` for all three engines and prints a
    diagnostic table when the check fails.  Raises :class:`RuntimeError` when
    fewer than two engines are usable (spatial consensus needs a >=2/3 majority)
    or — when ``strict`` is set — when *any* engine is missing.

    Parameters
    ----------
    strict
        Require all three engines (full 3-engine consensus).  Default ``False``
        allows running with any two of the three.
    """
    status: dict[str, bool] = {}
    reasons: dict[str, str] = {}

    # --- RapidOCR -----------------------------------------------------------
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore
        RapidOCR()  # construct once to surface onnxruntime/model problems early
        status["rapidocr"] = True
        reasons["rapidocr"] = "ok"
    except Exception as exc:  # noqa: BLE001 - report any failure mode
        status["rapidocr"] = False
        reasons["rapidocr"] = f"{type(exc).__name__}: {exc}"

    # --- Tesseract ----------------------------------------------------------
    try:
        import shutil as _shutil
        import pytesseract  # type: ignore
        tesseract_cmd = _shutil.which("tesseract") or _resolve_tesseract_cmd()
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        pytesseract.get_tesseract_version()  # actually execute the binary
        status["tesseract"] = True
        reasons["tesseract"] = f"ok ({tesseract_cmd})"
    except FileNotFoundError:
        status["tesseract"] = False
        if os.name == "nt":
            reasons["tesseract"] = (
                "Tesseract binary not found on PATH. Install Tesseract OCR "
                "(e.g. winget install UB-Mannheim.TesseractOCR) and add its "
                "folder to PATH."
            )
        else:
            reasons["tesseract"] = (
                "Tesseract binary not found on PATH or in standard locations. "
                "Install it (e.g. 'sudo pacman -S tesseract' or "
                "'brew install tesseract')."
            )
    except Exception as exc:  # noqa: BLE001
        status["tesseract"] = False
        reasons["tesseract"] = f"{type(exc).__name__}: {exc}"

    # --- EasyOCR ------------------------------------------------------------
    try:
        import easyocr  # type: ignore
        easyocr.Reader(["en"], gpu=False, verbose=False)
        status["easyocr"] = True
        reasons["easyocr"] = "ok"
    except Exception as exc:  # noqa: BLE001
        status["easyocr"] = False
        reasons["easyocr"] = f"{type(exc).__name__}: {exc}"

    available = sum(1 for ok in status.values() if ok)
    fail = (available < 2) or (strict and available < len(status))

    if fail:
        name_w = max(len(n) for n in _ENGINE_NAMES) + 2
        reason_w = max(len(v) for v in reasons.values())
        bar = "-" * (name_w + 8 + reason_w)
        print("\n[ocr_consensus] OCR engine pre-flight check FAILED:", file=sys.stderr)
        print("  " + bar, file=sys.stderr)
        for name in _ENGINE_NAMES:
            mark = "OK  " if status.get(name) else "FAIL"
            print(f"  {name:<{name_w}} [{mark}] {reasons.get(name, 'unknown')}",
                  file=sys.stderr)
        print("  " + bar, file=sys.stderr)
        if available < 2:
            print(
                f"  Only {available}/3 OCR engines are available; spatial consensus "
                "needs at least 2. Fix the FAILing engine(s) above and re-run.",
                file=sys.stderr,
            )
        else:
            print(
                "  Strict 3-engine consensus was requested but an engine is missing. "
                "Fix it, or re-run without --strict to allow any 2 of 3.",
                file=sys.stderr,
            )
        raise RuntimeError(
            f"OCR pre-flight check failed: {available}/3 engines available "
            f"(need {'3' if strict else '>=2'}). See diagnostic table above."
        )

    return status


def _ensure_verified(strict: bool = False) -> dict[str, bool]:
    """Run :func:`verify_ocr_engines` at most once per process (memoized)."""
    if "status" not in _VERIFY_CACHE:
        _VERIFY_CACHE["status"] = verify_ocr_engines(strict=strict)
    return _VERIFY_CACHE["status"]


def run_ocr_engines(
    img: np.ndarray,
    max_workers: Optional[int] = None,
    progress: Optional["OCRProgressTracker"] = None,
) -> list[list[dict]]:
    """Run all three OCR engines on a normalized page image, in parallel.

    Uses a ``ProcessPoolExecutor`` sized for the CPU: one worker process per engine
    (capped by the core count).  Returns a list of token lists **in engine order**
    ``[rapidocr, tesseract, easyocr]``; an engine that fails yields ``[]`` so the
    remaining engines still produce a usable consensus.

    If a ``progress`` tracker is given, each engine's completion is recorded as
    soon as its future resolves (via ``as_completed``), giving live per-engine
    progress.  All console output happens here in the main process only — worker
    processes never write to stdout.
    """
    _ensure_verified()  # fail fast (with a diagnostic table) before spawning
    prewarm_easyocr_weights()  # cache EasyOCR weights once, in the main process

    workers = max_workers or min(len(_ENGINE_FUNCS), os.cpu_count() or 1)
    workers = max(1, workers)

    with ProcessPoolExecutor(max_workers=workers) as executor:
        t_submit = time.perf_counter()
        futures = {
            executor.submit(fn, img): name
            for fn, name in zip(_ENGINE_FUNCS, _ENGINE_NAMES)
        }
        results_by_name: dict[str, list[dict]] = {}
        for fut in as_completed(futures):
            name = futures[fut]
            elapsed = time.perf_counter() - t_submit
            try:
                results_by_name[name] = fut.result()
                failed = False
            except Exception as exc:  # per-engine failure: log loudly, degrade to []
                print(
                    f"[ocr_consensus] engine '{name}' failed on this page "
                    f"({type(exc).__name__}: {exc}); continuing with the other engines.",
                    file=sys.stderr,
                )
                results_by_name[name] = []
                failed = True
            if progress is not None:
                progress.record(name, elapsed, failed=failed)
    return [results_by_name[n] for n in _ENGINE_NAMES]


# ---------------------------------------------------------------------------
# Consensus: spatial alignment + majority voting
# ---------------------------------------------------------------------------
def compute_consensus(
    engine_results: list[list[dict]],
    iou_threshold: float = 0.45,
) -> dict:
    """Fuse the per-engine token lists into a single, verified page reading.

    Parameters
    ----------
    engine_results : list of token-lists (one per engine), in the order returned by
        :func:`run_ocr_engines`.  Missing/failed engines may be empty lists.
    iou_threshold : IoU cutoff for aligning boxes across engines.

    Returns a dict with:
      * ``text``            — clean reading-order text (multi-column aware),
      * ``lines``           — the same content split into display lines,
      * ``tokens``          — per-token detail in reading order (status, bbox, conf),
      * ``disputed_regions``— normalized boxes + candidate texts for the VLM to resolve,
      * ``stats``           — counts by status.
    """
    # Flatten all tokens, tagging each with its engine index.
    pool: list[dict] = []
    for eng_idx, toks in enumerate(engine_results or []):
        for t in toks or []:
            if not t.get("text"):
                continue
            pool.append({
                "text": t["text"],
                "box": [float(t["x0"]), float(t["y0"]), float(t["x1"]), float(t["y1"])],
                "conf": float(t.get("confidence", 0.0)),
                "engine": eng_idx,
            })

    if not pool:
        return {
            "text": "", "lines": [], "tokens": [], "disputed_regions": [],
            "stats": {"total_tokens": 0, "locked": 0, "disputed": 0, "single": 0},
        }

    clusters = _cluster_by_iou(pool, iou_threshold)
    resolved = [_resolve_cluster(c) for c in clusters]
    resolved = _reading_order(resolved)

    disputed_regions: list[dict] = []
    lines: list[str] = _group_lines(resolved)
    text = " ".join(l for l in lines if l).strip()

    for r in resolved:
        if r["status"] == "disputed":
            disputed_regions.append({
                "x0": r["box"][0], "y0": r["box"][1],
                "x1": r["box"][2], "y1": r["box"][3],
                "candidates": r["candidates"],
                "best_guess": r["text"],
                "reason": r["reason"],
                "has_digits": _has_digit(r["text"]),
            })

    stats = Counter(r["status"] for r in resolved)
    return {
        "text": text,
        "lines": lines,
        "tokens": [
            {"text": r["text"], "box": r["box"], "confidence": r["conf"],
             "status": r["status"], "engines": r["engines"]}
            for r in resolved
        ],
        "disputed_regions": disputed_regions,
        "stats": {
            "total_tokens": len(resolved),
            "locked": stats.get("locked", 0),
            "disputed": stats.get("disputed", 0),
            "single": stats.get("single", 0),
        },
    }


# --- clustering -------------------------------------------------------------
def _cluster_by_iou(pool: list[dict], iou_threshold: float) -> list[list[int]]:
    """Group spatially overlapping boxes *across engines* via IoU + union-find.

    Only cross-engine pairs are linked (two words from the same engine are already
    distinct), which is exactly the alignment we want.  Transitive links merge a
    connected set of boxes into one cluster.
    """
    n = len(pool)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(n):
        for j in range(i + 1, n):
            if pool[i]["engine"] == pool[j]["engine"]:
                continue
            if _iou(pool[i]["box"], pool[j]["box"]) >= iou_threshold:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return [[pool[i] for i in members] for members in groups.values()]


def _resolve_cluster(cluster: list[dict]) -> dict:
    """Vote on a spatial cluster -> one resolved token with a status + bbox."""
    boxes = [t["box"] for t in cluster]
    box = boxes[0]
    for b in boxes[1:]:
        box = _union(box, b)

    conf = float(np.mean([t["conf"] for t in cluster])) if cluster else 0.0
    engines = sorted({t["engine"] for t in cluster})
    n_engines = len(engines)

    votes: Counter[str] = Counter(_norm_text(t["text"]) for t in cluster)
    best_norm, top_count = votes.most_common(1)[0]
    # Representative display text = the raw text of a member that matches the winner.
    best_text = next(
        (t["text"] for t in cluster if _norm_text(t["text"]) == best_norm),
        cluster[0]["text"],
    )

    # Numeric disagreement is always safety-critical, even if a majority exists.
    digit_strings = {_digits_of(t["text"]) for t in cluster}
    numeric_disagreement = _has_digit(best_text) and len(digit_strings) > 1

    required = 2 / 3.0
    locked = (top_count >= 2) and (top_count / n_engines >= required - 1e-9)

    if locked and not numeric_disagreement:
        status, reason = "locked", ""
    elif numeric_disagreement:
        # A number the engines read differently is always safety-critical.
        status, reason = "disputed", "numeric_disagreement"
    elif n_engines >= 2:
        # Multiple engines saw the token but no 2/3 majority -> low agreement.
        status, reason = "disputed", "low_agreement"
    else:  # n_engines == 1: only one engine produced this token
        if _has_digit(best_text):
            status, reason = "disputed", "numeric_single_engine"
        else:
            status, reason = "single", ""

    return {
        "text": best_text,
        "box": box,
        "conf": conf,
        "engines": [_ENGINE_NAMES[e] for e in engines if e < len(_ENGINE_NAMES)],
        "status": status,
        "reason": reason,
        "candidates": sorted(votes.keys()),
    }


# --- reading order (multi-column aware) ------------------------------------
def _reading_order(resolved: list[dict]) -> list[dict]:
    """Order resolved tokens top-to-bottom, splitting multi-column pages cleanly."""
    if not resolved:
        return []

    split_x = _detect_column_split(resolved)
    if split_x is None:
        # Single column: read strictly by vertical then horizontal position.
        return sorted(resolved, key=lambda r: (r["box"][1], r["box"][0]))

    left = [r for r in resolved if (r["box"][0] + r["box"][2]) / 2.0 < split_x]
    right = [r for r in resolved if (r["box"][0] + r["box"][2]) / 2.0 >= split_x]
    left.sort(key=lambda r: (r["box"][1], r["box"][0]))
    right.sort(key=lambda r: (r["box"][1], r["box"][0]))
    return left + right


def _detect_column_split(resolved: list[dict]) -> Optional[float]:
    """Find a vertical gutter in the middle of the page, or ``None`` for 1 column.

    A valid split sits in the middle third and is crossed by very few token boxes
    (a true inter-column gutter), with content on both sides.
    """
    n = len(resolved)
    if n < 4:
        return None

    best_x, best_straddle = None, float("inf")
    for sx in np.linspace(0.35, 0.65, 31):
        straddle = sum(1 for r in resolved if r["box"][0] < sx < r["box"][2])
        left = sum(1 for r in resolved if (r["box"][0] + r["box"][2]) / 2.0 < sx)
        right = n - left
        if left < max(2, 0.1 * n) or right < max(2, 0.1 * n):
            continue  # not a real two-column split
        if straddle < best_straddle:
            best_x, best_straddle = float(sx), straddle

    # Require a genuinely empty-ish gutter: fewer than ~8% of boxes cross the line.
    if best_x is not None and best_straddle <= max(1, 0.08 * n):
        return best_x
    return None


def _group_lines(resolved: list[dict]) -> list[str]:
    """Group already-ordered tokens into display lines by vertical proximity."""
    if not resolved:
        return []
    heights = [(r["box"][3] - r["box"][1]) for r in resolved]
    median_h = float(np.median(heights)) or 0.02
    gap_threshold = 0.7 * median_h

    lines: list[str] = []
    current: list[str] = []
    prev_cy = None
    for r in resolved:
        cy = (r["box"][1] + r["box"][3]) / 2.0
        if prev_cy is not None and abs(cy - prev_cy) > gap_threshold:
            lines.append(" ".join(current))
            current = []
        current.append(r["text"])
        prev_cy = cy
    if current:
        lines.append(" ".join(current))
    return lines
