"""
WIS+  forge/pdf_normalizer.py
=============================
Page geometry + preprocessing for the WIS+ ingestion pipeline.

Everything in this module obeys the **Normalized Geometry Rule**:

* Pages are rasterized by scaling their *longest edge* to a fixed target
  (``2200 px`` by default) so that a low-DPI WIS scan and a very high-DPI
  Haynes scan both come out at the same working resolution.
* Every bounding box is stored as normalized floats ``[x0, y0, x1, y1]`` in the
  unit square ``[0.0, 1.0]`` (origin top-left, +x right, +y down).

There are **no hardcoded pixel coordinates** anywhere in this file — only ratios.
"""

from __future__ import annotations

import re
from collections import Counter
import cv2
import numpy as np

try:  # Modern PyMuPDF (>= 1.24): import as ``pymupdf`` (legacy ``fitz`` alias emits FutureWarning).
    import pymupdf  # type: ignore
except ImportError:  # pragma: no cover - pymupdf is a hard dependency
    pymupdf = None  # type: ignore


# ---------------------------------------------------------------------------
# Filename parsing (WIS numbering convention)
# ---------------------------------------------------------------------------
def parse_wis_filename(filename: str) -> tuple[str | None, str | None]:
    """Parse a WIS workshop-manual filename into ``(section, subsection)``.

    The Mercedes WIS+ files are named after their chapter code as a bare number,
    e.g. ``10003.pdf`` -> Section **01**, Subsection **03**.

    Conventions handled cleanly:

    * **5-digit** codes such as ``10003`` encode the hierarchy with trailing-zero
      groups: ``1 | 00 | 03``.  The leading group is the section, the last two
      digits are always the subsection.  Trailing zeros in the leading group are
      stripped (``100`` -> ``1``) before zero-padding to two places.
    * **4-digit** codes such as ``5134`` split into a two-place section and a
      two-place subsection: ``51 | 34``.  A code like ``1003`` (``10 | 03``) is
      treated the same way — trailing zeros in the section are stripped, giving
      ``("01", "03")``.

    Returns ``(None, None)`` for anything that is *not* a clean WIS numeric code —
    in particular Haynes scans (e.g. ``Haynes_190E_W201.pdf``), which contain
    letters and therefore never match the pure 4/5-digit pattern.
    """
    if not filename:
        return (None, None)

    stem = filename.rsplit(".", 1)[0].strip()
    # Any letter disqualifies it as a WIS code (Haynes / descriptive names).
    if re.search(r"[A-Za-z]", stem):
        return (None, None)

    digits = re.sub(r"\D", "", stem)  # drop any stray separators (spaces, dashes)
    if len(digits) not in (4, 5):
        return (None, None)

    subsection = digits[-2:]                 # last two digits are always the subsection
    section_raw = digits[:-2]                # leading group (may carry trailing-zero levels)
    section_core = section_raw.rstrip("0") or "0"
    section = section_core.zfill(2)

    return (section, subsection)


# ---------------------------------------------------------------------------
# Normalized page rasterization
# ---------------------------------------------------------------------------
def render_normalized_page(
    doc: "pymupdf.Document",
    page_index: int,
    target_long_edge: int = 2200,
) -> tuple[np.ndarray, dict]:
    """Rasterize one PDF page so its longest edge is exactly ``target_long_edge`` px.

    Respects both ``page.rect`` (MediaBox) and ``page.rotation`` (/Rotate flag).
    PyMuPDF's ``get_pixmap`` applies the /Rotate automatically, so a portrait page
    saved with ``/Rotate 90`` comes out as a correctly-oriented landscape image;
    because ``max(w, h)`` is rotation-invariant, the zoom factor computed from the
    raw rect is always exact and ``max(pix_w, pix_h) == target_long_edge``.

    Returns
    -------
    (img, meta)
        img  : RGB ``uint8`` numpy array of shape ``(H, W, 3)``.
        meta : dict with at least
               ``{orientation, norm_width, norm_height, scale_factor}`` plus the
               pixel dimensions and source rotation for downstream coordinate math.
    """
    if pymupdf is None:  # pragma: no cover
        raise RuntimeError("pymupdf is not installed")

    page = doc[page_index]
    rect = page.rect
    if rect.width <= 0 or rect.height <= 0:
        raise ValueError(f"page {page_index} has a degenerate rect: {rect}")

    # Exact zoom so the longest edge lands on target. max() is symmetric, so this
    # stays correct whether the page is portrait, landscape, or rotated.
    scale_factor = float(target_long_edge) / float(max(rect.width, rect.height))
    matrix = pymupdf.Matrix(scale_factor, scale_factor)

    pix = page.get_pixmap(matrix=matrix, alpha=False, colorspace=pymupdf.csRGB)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n != 3:  # defensive: force RGB
        img = cv2.cvtColor(img, cv2.COLOR_RGBA2RGB) if pix.n == 4 else img[:, :, :3]
    img = np.ascontiguousarray(img)

    rotation = int(page.rotation % 360)
    orientation = "portrait" if pix.height >= pix.width else "landscape"

    meta = {
        # Required by the contract:
        "orientation": orientation,          # 'portrait' | 'landscape' (as displayed)
        "norm_width": 1.0,                   # normalized reference width  (unit square)
        "norm_height": 1.0,                  # normalized reference height (unit square)
        "scale_factor": scale_factor,        # PDF points -> output pixels
        # Extra context for downstream coordinate mapping / storage:
        "pixel_width": int(pix.width),
        "pixel_height": int(pix.height),
        "page_rotation": rotation,
        "target_long_edge": int(target_long_edge),
    }
    return img, meta


# ---------------------------------------------------------------------------
# Scan preprocessing for OCR
# ---------------------------------------------------------------------------
def preprocess_scan_for_ocr(img: np.ndarray) -> np.ndarray:
    """Prepare a rendered page image for OCR on faded 1980s scans.

    Pipeline (all gentle, all edge-preserving so thin glyphs survive):

    1. Grayscale conversion.
    2. **CLAHE** (Contrast-Limited Adaptive Histogram Equalization) to lift local
       contrast in the flat, low-ink regions typical of old photocopies/scans.
    3. A light **bilateral filter** for denoising.  Unlike a median or box blur,
       the bilateral filter is edge-preserving: it smooths flat noise while keeping
       sharp transitions intact, so hairline strokes (a ``1`` vs a ``7``, decimal
       points, thin rule lines) are not erased.

    Returns a single-channel ``uint8`` grayscale image of the same shape as input.
    """
    if img.ndim == 2:
        gray = img.astype(np.uint8)
    else:
        # Accept BGR or RGB; channel order is irrelevant for grayscale + CLAHE.
        gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY) if img.shape[2] >= 3 else img[:, :, 0]
        gray = gray.astype(np.uint8)

    # 1+2 — adaptive local contrast (clipLimit kept modest to avoid amplifying noise).
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    # 3 — light edge-preserving denoise. Small sigmas => gentle.
    denoised = cv2.bilateralFilter(enhanced, d=5, sigmaColor=40, sigmaSpace=40)

    return denoised.astype(np.uint8)


# ---------------------------------------------------------------------------
# Repeating header/footer detection + boilerplate filtering
# ---------------------------------------------------------------------------
def _norm_text(text: str) -> str:
    """Canonical form used for token identity (case/space-insensitive)."""
    return re.sub(r"\s+", " ", (text or "")).strip().casefold()


def detect_repeating_margins(all_pages_tokens: list[list[dict]]) -> set[str]:
    """Find boilerplate that repeats in the page headers/footers.

    ``all_pages_tokens`` is a list (one entry per page) of token dicts, each with
    at least ``{text, x0, y0, x1, y1}`` in normalized coordinates.  Only tokens in
    the top margin (``y0 < 0.08``) or bottom margin (``y1 > 0.92``) are considered.

    A normalized token is flagged as repeating if it appears (in a margin) on **more
    than 30% of the pages**.  Returns the set of normalized text strings that are
    header/footer boilerplate.
    """
    n_pages = len(all_pages_tokens)
    if n_pages == 0:
        return set()

    top_hits: Counter[str] = Counter()      # token -> number of DISTINCT pages it appears on
    bottom_hits: Counter[str] = Counter()

    for tokens in all_pages_tokens:
        seen_top: set[str] = set()
        seen_bottom: set[str] = set()
        for tok in tokens or []:
            text = _norm_text(tok.get("text", ""))
            if not text:
                continue
            y0 = float(tok.get("y0", 0.0))
            y1 = float(tok.get("y1", 0.0))
            if y0 < 0.08:
                seen_top.add(text)
            elif y1 > 0.92:
                seen_bottom.add(text)
        top_hits.update(seen_top)
        bottom_hits.update(seen_bottom)

    threshold = 0.30 * n_pages
    repeating: set[str] = set()
    for text, count in top_hits.items():
        if count > threshold:
            repeating.add(text)
    for text, count in bottom_hits.items():
        if count > threshold:
            repeating.add(text)
    return repeating


def _boxes_intersect(a: list[float], b: list[float]) -> bool:
    """True if two normalized ``[x0,y0,x1,y1]`` boxes overlap (area > 0)."""
    return not (
        a[2] <= b[0]
        or b[2] <= a[0]
        or a[3] <= b[1]
        or b[3] <= a[1]
    )


_EDGE_BUTTONS = {"exit", "quit", "index"}
_PAD = 0.01


def filter_boilerplate_tokens(
    tokens: list[dict],
    repeating_margins: set[str],
) -> list[dict]:
    """Strip header/footer boilerplate and on-screen UI buttons from a page's tokens.

    Two removals happen:

    1. **Repeating margin tokens** — any token whose normalized text is in
       ``repeating_margins`` *and* that sits in the top (``y0 < 0.08``) or bottom
       (``y1 > 0.92``) margin is dropped.  Body text that merely happens to match a
       header word is left untouched.
    2. **UI chrome buttons** — any token reading ``EXIT`` / ``QUIT`` / ``INDEX``
       (case-insensitive) located near an outer edge (``x0 > 0.80`` or
       ``y0 < 0.12`` or ``y1 > 0.88``) is removed, and its exclusion box is inflated
       by ``0.01`` normalized padding on every side; any other token intersecting
       that padded box is removed too (catches a stray glyph/icon next to the button).
    """
    if not tokens:
        return []

    # --- Build padded exclusion boxes for edge UI buttons --------------------
    exclusion_boxes: list[list[float]] = []
    for tok in tokens:
        text = _norm_text(tok.get("text", ""))
        x0, y0 = float(tok.get("x0", 0.0)), float(tok.get("y0", 0.0))
        x1, y1 = float(tok.get("x1", 0.0)), float(tok.get("y1", 0.0))
        near_edge = (x0 > 0.80) or (y0 < 0.12) or (y1 > 0.88)
        if text in _EDGE_BUTTONS and near_edge:
            box = [max(0.0, x0 - _PAD), max(0.0, y0 - _PAD),
                   min(1.0, x1 + _PAD), min(1.0, y1 + _PAD)]
            exclusion_boxes.append(box)

    kept: list[dict] = []
    for tok in tokens:
        text = _norm_text(tok.get("text", ""))
        x0, y0 = float(tok.get("x0", 0.0)), float(tok.get("y0", 0.0))
        x1, y1 = float(tok.get("x1", 0.0)), float(tok.get("y1", 0.0))

        # (1) repeating header/footer boilerplate
        in_margin = (y0 < 0.08) or (y1 > 0.92)
        if text and in_margin and text in repeating_margins:
            continue

        # (2) UI button itself, or anything inside a button's padded exclusion box
        is_button = text in _EDGE_BUTTONS
        collides = any(_boxes_intersect([x0, y0, x1, y1], eb) for eb in exclusion_boxes)
        if is_button or collides:
            continue

        kept.append(tok)
    return kept
