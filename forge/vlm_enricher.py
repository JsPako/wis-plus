"""
WIS+  forge/vlm_enricher.py
============================
Structured VLM enrichment for the WIS+ ingestion pipeline.

Talks to a local ``llama.cpp`` llama-server exposing the OpenAI-compatible
vision endpoint (default ``http://127.0.0.1:8080/v1/chat/completions``) hosting
**Qwen3.8-27B**.  For every normalized page image it receives:

* the base64 JPEG of the normalized scan (downscaled to 1280px, quality 82),
* the consensus OCR text from ``forge.ocr_consensus.compute_consensus``, and
* the list of ``disputed_regions`` (normalized boxes where the three OCR
  engines disagreed) so the VLM can visually resolve numbers it must not guess.

The model is forced into deterministic structured output
(``response_format={"type": "json_object"}``, low temperature,
``chat_template_kwargs={"enable_thinking": False}``) and returns one JSON
object per page describing the
page type, the workshop procedure (Removal / Installation separated even when
both sit on the same scanned page), required tools (spanner/socket sizes and
Mercedes-Benz special-tool numbers), every torque value with its verbatim raw
text, and engine/transmission variant tags for the 190E.

Robustness:

* **Retries** — exponential backoff with jitter on transport errors, 429s,
  5xx responses, and malformed JSON (a hiccup of a 27B model is not fatal).
* **Checkpoint cache** — every completed page is written to
  ``forge/.cache/{doc_hash}_page_{num}.json`` (atomic replace).  An interrupted
  run over a 700-page Haynes book resumes instantly: completed pages are read
  from disk and never re-sent to the model.
* **Deterministic bbox matching** — :func:`match_torque_bbox` / 
  :func:`match_step_bbox` locate the exact normalized ``[x0, y0, x1, y1]`` box
  of a torque value (or a step) inside the consensus OCR token list, so the UI
  can scroll to and highlight the precise spot on the original scan when the
  user clicks e.g. ``100 Nm``.
* **Torque sanitization** — :func:`sanitize_torque_spec` rejects implausible
  extremes (OCR/VLM hallucinations such as ``4500 Nm``) and reconciles the
  Nm / ft-lb pair, trusting Nm (the primary WIS unit) when they disagree.

All geometry obeys the **Normalized Geometry Rule** from Task 2: boxes are
floats in the unit square ``[0.0, 1.0]``, origin top-left — no pixel
coordinates anywhere.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Optional

import httpx
import numpy as np

# ---------------------------------------------------------------------------
# shared/ is a sibling namespace package at the repo root; make sure it is
# importable no matter where forge/ is launched from.
# ---------------------------------------------------------------------------
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.models import NormalizedBBox  # noqa: E402


# ---------------------------------------------------------------------------
# Locked domain vocabulary (must mirror the CHECK constraints / UI badges)
# ---------------------------------------------------------------------------
ALLOWED_PAGE_TYPES = {"procedure", "spec_table", "diagram", "boilerplate_skip"}

# Sourced from shared/variants.json — the single source of truth (task 2.1/2.2).
# _REPO_ROOT is already on sys.path (see above), so this import always resolves.
from shared.variants import engine_ids as _engine_ids, gearbox_ids as _gearbox_ids  # noqa: E402
import logging  # noqa: E402

log = logging.getLogger("wisplus.forge")

ALLOWED_ENGINE_VARIANTS: frozenset[str] = _engine_ids()
ALLOWED_TRANSMISSION_VARIANTS: frozenset[str] = _gearbox_ids()
# ALL_TAG is no longer stored in the DB (task 2.2); kept only for legacy reads.
ALL_TAG = "ALL"

STEP_MODES = {"removal", "installation", "general"}

# Plausibility window for a W201 workshop torque value in Nm.
# Real range on the 190E: ~5 Nm (small electrical screws) up to ~180 Nm
# (wheel hub nut).  Anything outside [2, 400] is an OCR/VLM hallucination or a
# misread and is dropped rather than trusted.
TORQUE_NM_MIN = 2.0
TORQUE_NM_MAX = 400.0

# Unit conversion: 1 ft-lb = 1.3558179483 Nm (exact).
NM_PER_FTLB = 1.3558179483

# Mercedes-Benz special-tool part numbers look like '201 589', 'X 250 480',
# or the long X-codes 'X 250 480 09 10 0300'.
_MERCEDES_SPECIAL_RE = re.compile(
    r"(?:\bX\s?\d{3}\b|\b\d{3}\s+\d{3}(?:\s+\d{1,4}){0,5}\b)"
)

CACHE_VERSION = 1
DEFAULT_LLM_URL = "http://127.0.0.1:8080/v1/chat/completions"
DEFAULT_MODEL_NAME = "Qwen3.8-27B"   # llama.cpp ignores the name by default
JPEG_QUALITY = 82                    # VLM payload JPEG quality (downscaled image)
# The VLM sees a smaller render than OCR (OCR keeps its 2200px pages): capping
# the long edge at 1280px keeps dense workshop pages inside the vision context
# so llama-server does not reset the socket (WinError 10054) mid-request.
VLM_MAX_LONG_EDGE = 1280


class VLMError(RuntimeError):
    """Raised when a page cannot be enriched after all retries."""


class VisionProjectorDisabled(VLMError):
    """llama-server rejected an image payload: no ``--mmproj`` projector loaded."""


# llama.cpp's 400 body when a vision model is served without its projector.
_VISION_DISABLED_RE = re.compile(r"mmproj|multimodal|vision", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Image encoding (downscaled base64 JPEG for the VLM payload)
# ---------------------------------------------------------------------------
def encode_page_jpeg_b64(
    img: np.ndarray,
    max_long_edge: int = VLM_MAX_LONG_EDGE,
    quality: int = JPEG_QUALITY,
) -> str:
    """Encode a page image as a base64 JPEG string for the VLM payload.

    The long edge is downscaled to ``max_long_edge`` (1280px by default; the
    OCR pass keeps its 2200px renders) before encoding, so a dense scanned
    page cannot overflow the model's vision context and make llama-server
    reset the connection (WinError 10054).  Pillow is used (already a hard
    dependency via the OCR stack); the result goes into the OpenAI-style
    ``image_url`` data URI.
    """
    from PIL import Image  # local import: keeps module load light for CLI use

    if img.ndim == 2:
        img = np.stack([img] * 3, axis=-1)
    pil_img = Image.fromarray(img)
    h, w = pil_img.height, pil_img.width
    scale = max_long_edge / float(max(h, w))
    if scale < 1.0:
        new_w = max(1, int(round(w * scale)))
        new_h = max(1, int(round(h * scale)))
        resample = getattr(Image, "Resampling", Image).LANCZOS
        pil_img = pil_img.resize((new_w, new_h), resample)
    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ---------------------------------------------------------------------------
# Torque sanitization (extreme values + Nm/ft-lb reconciliation)
# ---------------------------------------------------------------------------
def sanitize_torque_spec(spec: dict) -> Optional[dict]:
    """Validate and normalize one VLM torque spec. Returns ``None`` to drop it.

    Rules:
      * exactly one of value_nm / value_ftlb may be missing — the other is
        converted (Nm is the stored primary unit per shared/schema.sql);
      * values outside [TORQUE_NM_MIN, TORQUE_NM_MAX] are rejected as extreme
        (e.g. a misread '45' -> '4500', or a bolt grade printed beside the value);
      * when both units are present but inconsistent beyond rounding tolerance,
        Nm wins and ft-lb is recomputed from it.
    """
    try:
        nm = spec.get("value_nm")
        ftlb = spec.get("value_ftlb")
        nm_f = float(nm) if nm is not None else None
        ftlb_f = float(ftlb) if ftlb is not None else None
    except (TypeError, ValueError):
        return None

    if nm_f is None and ftlb_f is None:
        return None
    if nm_f is None:
        nm_f = ftlb_f * NM_PER_FTLB
    if ftlb_f is None:
        ftlb_f = nm_f / NM_PER_FTLB

    if not (TORQUE_NM_MIN <= nm_f <= TORQUE_NM_MAX):
        return None  # extreme / implausible — drop rather than trust

    expected_ftlb = nm_f / NM_PER_FTLB
    tol = max(2.0, 0.06 * expected_ftlb)   # printed values are rounded to ints
    if abs(ftlb_f - expected_ftlb) > tol:
        ftlb_f = expected_ftlb             # Nm is the WIS primary unit: trust it

    raw_text = str(spec.get("raw_text") or "").strip()
    if not raw_text:
        parts = [f"{nm_f:g} Nm"]
        if ftlb_f is not None:
            parts.append(f"({ftlb_f:.0f} ft-lb)")
        raw_text = " ".join(parts)

    component = str(spec.get("component_name") or "Unspecified").strip() or "Unspecified"
    step_mode = str(spec.get("step_mode") or "general").strip().casefold()
    if step_mode not in STEP_MODES:
        step_mode = "general"

    return {
        "component_name": component,
        "value_nm": round(nm_f, 2),
        "value_ftlb": round(ftlb_f, 1) if ftlb_f is not None else None,
        "raw_text": raw_text,
        "step_mode": step_mode,
    }


# ---------------------------------------------------------------------------
# Deterministic bounding-box matching (torque values + steps -> OCR tokens)
# ---------------------------------------------------------------------------
def _canon_word(w: str) -> str:
    """Canonical token form for matching: casefolded alphanumerics only.

    Makes 'Nm' == 'nm', 'ft-lb' == 'ft.-lb.' == 'FT LB' -> 'ftlb', and
    '(33' == '33'.  Purely deterministic — no model, no randomness.
    """
    return re.sub(r"[^0-9a-z]", "", (w or "").casefold())


def _token_box(tok: dict) -> list[float]:
    """Accept both token shapes in the wild: {'box': [...]} (consensus output)
    and {'x0','y0','x1','y1'} (per-engine / pdf_normalizer tokens)."""
    box = tok.get("box")
    if isinstance(box, (list, tuple)) and len(box) == 4:
        return [float(v) for v in box]
    return [
        float(tok.get("x0", 0.0)), float(tok.get("y0", 0.0)),
        float(tok.get("x1", 1.0)), float(tok.get("y1", 1.0)),
    ]


def _token_conf(tok: dict) -> float:
    try:
        return float(tok.get("confidence", 0.0))
    except (TypeError, ValueError):
        return 0.0


def _words_match(raw_word: str, tok_text: str) -> bool:
    """True if a raw-text word matches an OCR token's text.

    Canonical equality first; then numeric tolerance so '45.' == '45' and
    '100,' == '100' (scans love stray punctuation glued to numbers).
    """
    a, b = _canon_word(raw_word), _canon_word(tok_text)
    if not a or not b:
        return False
    if a == b:
        return True
    try:
        fa = float(raw_word.strip(" .,;:()[]"))
        fb = float(str(tok_text).strip(" .,;:()[]"))
        return abs(fa - fb) < 1e-9
    except ValueError:
        return False


def _union_boxes(boxes: list[list[float]]) -> list[float]:
    boxes = list(boxes)  # callers may pass one-shot generators
    if not boxes:
        raise ValueError("_union_boxes called with no boxes")
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
    return [x0, y0, x1, y1]


def _make_bbox(box: list[float]) -> NormalizedBBox:
    """Build a NormalizedBBox via kwargs (Pydantic v2 rejects positional args)."""
    return NormalizedBBox(x0=box[0], y0=box[1], x1=box[2], y1=box[3])


def _pad_box(box: list[float], pad_frac: float = 0.04, min_pad: float = 0.003) -> list[float]:
    """Grow a box slightly (so the UI highlight covers the whole glyph incl.
    ascenders/descenders), clamp to the unit square, and guarantee strict
    x0<x1 / y0<y1 as required by shared.models.NormalizedBBox."""
    px = max(min_pad, pad_frac * (box[2] - box[0]))
    py = max(min_pad, pad_frac * (box[3] - box[1]))
    x0 = max(0.0, box[0] - px); y0 = max(0.0, box[1] - py)
    x1 = min(1.0, box[2] + px); y1 = min(1.0, box[3] + py)
    if x1 - x0 < 1e-6:
        x1 = min(1.0, x0 + 1e-4)
    if y1 - y0 < 1e-6:
        y1 = min(1.0, y0 + 1e-4)
    return [x0, y0, x1, y1]


def _best_contiguous_run(
    ocr_tokens: list[dict], raw_words: list[str]
) -> Optional[tuple[int, int]]:
    """Find the best contiguous run of OCR tokens matching all raw words.

    Scans every start position in reading order; a candidate must match the
    ENTIRE raw word sequence contiguously.  Ties break on higher summed token
    confidence, then earlier position (deterministic).  Returns ``(i, j)``
    half-open index range into ``ocr_tokens``, or ``None``.
    """
    n, m = len(ocr_tokens), len(raw_words)
    if not raw_words or not ocr_tokens:
        return None
    best: Optional[tuple[float, int, int]] = None
    for i in range(n):
        j = 0
        while j < m and i + j < n and _words_match(raw_words[j], ocr_tokens[i + j]["text"]):
            j += 1
        if j == m:
            score = sum(_token_conf(t) for t in ocr_tokens[i:i + m])
            if best is None or score > best[0] + 1e-9:
                best = (score, i, i + j)
    return (best[1], best[2]) if best else None


def match_torque_bbox(torque_raw: str, ocr_tokens: list[dict]) -> NormalizedBBox:
    """Locate the exact normalized box on the page for a torque spec's raw text.

    Deterministic fallback ladder (first hit wins):
      1. **full run** — all words of ``torque_raw`` (e.g. '45 Nm (33 ft-lb)')
         matched contiguously against the reading-order OCR tokens;
      2. **value+unit** — the primary numeric word adjacent (±1 token) to a
         unit token ('Nm' / 'ft-lb');
      3. **any number hit** — any single token matching the primary number;
      4. **full page** — [0,0,1,1] so the UI can still jump to the page.
    """
    raw_words = (torque_raw or "").split()

    # -- (1) full contiguous run --------------------------------------------
    if ocr_tokens:
        run = _best_contiguous_run(ocr_tokens, raw_words)
        if run is not None:
            box = _union_boxes(_token_box(t) for t in ocr_tokens[run[0]:run[1]])
            return _make_bbox(_pad_box(box))

    # -- (2)/(3) number-based fallbacks -------------------------------------
    num_word = next((w for w in raw_words if any(c.isdigit() for c in w)), None)
    unit_canons = {_canon_word(w) for w in raw_words if not any(c.isdigit() for c in w)}

    if ocr_tokens and num_word:
        # (2) number adjacent to a unit token
        for i, tok in enumerate(ocr_tokens):
            if not _words_match(num_word, tok["text"]):
                continue
            for k in (i - 1, i + 1):
                if 0 <= k < len(ocr_tokens) and _canon_word(ocr_tokens[k]["text"]) in unit_canons:
                    box = _union_boxes([_token_box(tok), _token_box(ocr_tokens[k])])
                    return _make_bbox(_pad_box(box))
        # (3) any token carrying the number
        hits = [_token_box(t) for t in ocr_tokens if _words_match(num_word, t["text"])]
        if hits:
            return _make_bbox(_pad_box(_union_boxes(hits)))

    # -- (4) whole page ------------------------------------------------------
    return NormalizedBBox(x0=0.0, y0=0.0, x1=1.0, y1=1.0)


def match_step_bbox(step_text: str, ocr_tokens: list[dict]) -> Optional[NormalizedBBox]:
    """Anchor a procedure step to its location on the page.

    Matches the step's opening words (capped at 8 — enough to be unique without
    over-matching wrapped lines) against the OCR token stream.  Returns ``None``
    when no confident anchor exists; ``ProcedureStep.bbox`` is optional, and a
    missing anchor must never produce a misleading highlight.
    """
    if not ocr_tokens or not (step_text or "").strip():
        return None
    words = step_text.split()[:8]
    for cut in (len(words), 3, 1):
        probe = words[:cut]
        if not probe or len(_canon_word(probe[0])) < 2:
            continue
        run = _best_contiguous_run(ocr_tokens, probe)
        if run is not None and (cut == 1 or run[1] - run[0] >= min(2, cut)):
            box = _union_boxes(_token_box(t) for t in ocr_tokens[run[0]:run[1]])
            return _make_bbox(_pad_box(box, pad_frac=0.02))
    return None


# ---------------------------------------------------------------------------
# Prompt construction (structured JSON schema, locked domain rules)
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT = """You are the structuring engine of WIS+, a local knowledge base for the Mercedes-Benz 190E (W201, 1983-1993) workshop manuals: WIS+ chapter PDFs and Haynes scans.

You receive ONE scanned page as an image, plus consensus OCR text from three engines and a JSON list of disputed regions where those engines disagreed. The IMAGE is ground truth; the OCR text is only for orientation. For every disputed region, read the correct value directly off the image.

Respond with ONE JSON object — no prose, no markdown fences — with exactly these keys:

{{
  "page_type": "procedure" | "spec_table" | "diagram" | "boilerplate_skip",
  "skip_reason": null | "cover_page" | "table_of_contents" | "index" | "blank_or_placeholder",
  "category": "string or null",            // e.g. 'Suspension', 'Engine'
  "subcategory": "string or null",          // e.g. 'Front Suspension'
  "title": "string or null",                // procedure title, e.g. 'Replace front shock absorbers'
  "engine_variants": ["M102_1.8" | "M102_2.0" | "M102_2.3" | "M102_16V" | "M103_2.6" | "OM601_602" | "ALL"],
  "transmission_variants": ["AUTO_722.4" | "MANUAL_716.2" | "MANUAL_717.4" | "ALL"],
  "tools_required": [{{"name": "string", "size_or_code": "string or null", "is_mercedes_special": true|false}}],
  "removal_steps": [{{"step_num": 1, "text": "string", "tip": "string or null"}}],
  "installation_steps": [{{"step_num": 1, "text": "string", "tip": "string or null"}}],
  "general_tips": ["string"],
  "torque_specs": [{{"component_name": "string", "value_nm": number, "value_ftlb": number|null, "raw_text": "string", "step_mode": "removal"|"installation"|"general"}}],
  "disputed_resolutions": [{{"region_index": 0, "resolved_text": "string"}}]
}}

Rules:
1. page_type: cover pages, tables of contents, index pages and blank/placeholder pages are "boilerplate_skip" (set skip_reason). Spec/data tables without step text are "spec_table"; exploded diagrams with captions only are "diagram".
2. Separate REMOVAL steps from INSTALLATION steps even when WIS prints both on the same scanned page — follow the 'Removal' / 'Installation' headings (Haynes: numbered sub-lists). Steps that belong to neither section go into general_tips. Renumber step_num from 1 within each list.
3. tools_required: capture every spanner/socket size in size_or_code (e.g. "17 mm", "T30 Torx"). Mercedes-Benz special tools are part numbers such as '201 589' or 'X 250 480 09 10 0300' — put the full number in size_or_code and set is_mercedes_special=true.
4. torque_specs: extract EVERY torque value printed on the page. value_nm is required; value_ftlb is null when not printed. raw_text must be the VERBATIM string exactly as printed (e.g. "45 Nm (33 ft-lb)") — it is used to locate the exact spot on the scan, so do not reformat it. step_mode is the section the value appears under.
5. engine_variants / transmission_variants: list only the variants explicitly named on the page; use ["ALL"] when the procedure applies to all or none are named. Never invent variants.
6. disputed_resolutions: one entry per disputed region (region_index = its position in the provided list) with the corrected reading taken from the image.
7. If the page has no workshop procedure, leave title/category/subcategory null and all step/tool/torque arrays empty."""


def _build_user_content(
    img_b64: Optional[str],
    consensus_text: str,
    disputed_regions: list[dict],
) -> list[dict]:
    """Assemble the OpenAI-style user message: image first, then OCR context.

    ``img_b64=None`` produces a text-only message (no ``image_url`` part) — the
    fallback used when llama-server was started without a vision projector
    (``--mmproj``) and rejects image payloads with 400 Bad Request.
    """
    text_parts = [f"Consensus OCR text for this page:\n---\n{consensus_text or '(empty)'}\n---"]
    if disputed_regions:
        # Trim to the fields the model needs; keep boxes so it can locate them.
        slim = [
            {"region_index": i,
             "box": [round(r.get("x0", 0.0), 3), round(r.get("y0", 0.0), 3),
                     round(r.get("x1", 1.0), 3), round(r.get("y1", 1.0), 3)],
             "candidates": r.get("candidates", []),
             "best_guess": r.get("best_guess", ""),
             "reason": r.get("reason", "")}
            for i, r in enumerate(disputed_regions)
        ]
        text_parts.append(
            "Disputed OCR regions (normalized [x0,y0,x1,y1] on this page) — resolve each from the image:\n"
            + json.dumps(slim, ensure_ascii=False)
        )
    text_parts.append("Return the single JSON object now.")

    content: list[dict] = []
    if img_b64 is not None:
        content.append(
            {"type": "image_url",
             "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}}
        )
    content.append({"type": "text", "text": "\n\n".join(text_parts)})
    return content


# ---------------------------------------------------------------------------
# Payload normalization (VLM JSON -> clean, schema-conformant dict)
# ---------------------------------------------------------------------------
def _clean_steps(raw_steps) -> list[dict]:
    steps: list[dict] = []
    if not isinstance(raw_steps, list):
        return steps
    for i, s in enumerate(raw_steps, start=1):
        if not isinstance(s, dict):
            continue
        text = str(s.get("text") or "").strip()
        if not text:
            continue
        try:
            num = int(s.get("step_num", i))
        except (TypeError, ValueError):
            num = i
        steps.append({
            "step_num": max(1, num),
            "text": text,
            "tip": (str(s["tip"]).strip() if s.get("tip") else None),
        })
    return steps


def _clean_tools(raw_tools) -> list[dict]:
    tools: list[dict] = []
    if not isinstance(raw_tools, list):
        return tools
    for t in raw_tools:
        if not isinstance(t, dict):
            continue
        name = str(t.get("name") or "").strip()
        if not name:
            continue
        code = str(t.get("size_or_code") or "").strip() or None
        special = bool(t.get("is_mercedes_special", False))
        # Deterministic backstop: multi-group numeric part numbers are Mercedes
        # special tools even if the model forgot to flag them.
        haystack = f"{name} {code or ''}".strip()
        if not special and _MERCEDES_SPECIAL_RE.search(haystack):
            special = True
        tools.append({"name": name, "size_or_code": code, "is_mercedes_special": special})
    return tools


def _clean_variants(raw, allowed: frozenset) -> tuple[list[str], list[str]]:
    """Return (clean_variant_list, review_flags).

    * Recognised tokens (in ``allowed``) are kept.
    * Unrecognised non-empty tokens are flagged as ``unknown_variant:<tag>``
      and **not** stored in the variant list.
    * The legacy ``ALL`` token is silently dropped (absence means "all").
    * If nothing survives, the list is ``[]`` (never ``["ALL"]``) and a
      ``variant_unspecified`` flag is emitted so downstream can surface it.
    """
    flags: list[str] = []
    if not isinstance(raw, list):
        raw = [raw] if raw else []
    out: list[str] = []
    for v in raw:
        t = str(v).strip()
        if not t or t == ALL_TAG:
            continue
        if t in allowed:
            if t not in out:
                out.append(t)
        else:
            flag = f"unknown_variant:{t}"
            log.warning("variant %r not in locked vocabulary -> flagged", t)
            flags.append(flag)
    if not out:
        flags.append("variant_unspecified")
    return out, flags


def normalize_vlm_payload(raw: dict) -> dict:
    """Coerce the model's JSON into a clean, schema-conformant page payload.

    Invalid page types are inferred from content (steps/torques present ->
    'procedure'), extreme torque values are dropped, and variant lists are
    clamped to the locked 190E vocabulary with an ['ALL'] default.
    """
    if not isinstance(raw, dict):
        raw = {}

    page_type = str(raw.get("page_type") or "").strip().casefold()
    steps_present = bool(
        (isinstance(raw.get("removal_steps"), list) and raw["removal_steps"]) or
        (isinstance(raw.get("installation_steps"), list) and raw["installation_steps"])
    )
    if page_type not in ALLOWED_PAGE_TYPES:
        page_type = "procedure" if steps_present else "diagram"

    torques = []
    for t in (raw.get("torque_specs") or []):
        if isinstance(t, dict):
            cleaned = sanitize_torque_spec(t)
            if cleaned is not None:
                torques.append(cleaned)

    tips = [str(t).strip() for t in (raw.get("general_tips") or [])
            if str(t).strip()] if isinstance(raw.get("general_tips"), list) else []

    eng_variants, eng_flags = _clean_variants(raw.get("engine_variants"), ALLOWED_ENGINE_VARIANTS)
    trans_variants, trans_flags = _clean_variants(raw.get("transmission_variants"), ALLOWED_TRANSMISSION_VARIANTS)

    return {
        "page_type": page_type,
        "skip_reason": raw.get("skip_reason") if page_type == "boilerplate_skip" else None,
        "category": (str(raw["category"]).strip() if raw.get("category") else None),
        "subcategory": (str(raw["subcategory"]).strip() if raw.get("subcategory") else None),
        "title": (str(raw["title"]).strip() if raw.get("title") else None),
        "engine_variants": eng_variants,
        "transmission_variants": trans_variants,
        "review_flags": eng_flags + trans_flags,
        "tools_required": _clean_tools(raw.get("tools_required")),
        "removal_steps": _clean_steps(raw.get("removal_steps")),
        "installation_steps": _clean_steps(raw.get("installation_steps")),
        "general_tips": tips,
        "torque_specs": torques,
        "disputed_resolutions": raw.get("disputed_resolutions") or [],
    }


# ---------------------------------------------------------------------------
# Checkpoint cache (forge/.cache/vlm/{doc_stem}_p{NNNN}.json)
# ---------------------------------------------------------------------------
class _CheckpointCache:
    """Per-page VLM checkpoints: ``forge/.cache/vlm/{doc_stem}_p{NNNN}.json``."""

    def __init__(self, cache_dir: Path):
        self.dir = Path(cache_dir) / "vlm"
        self.dir.mkdir(parents=True, exist_ok=True)

    def path_for(self, doc_key: str, page_number: int) -> Path:
        return self.dir / f"{doc_key}_p{page_number:04d}.json"

    def load(self, doc_key: str, page_number: int,
             expect_model: str) -> Optional[dict]:
        p = self.path_for(doc_key, page_number)
        if not p.exists():
            return None
        try:
            with open(p, "r", encoding="utf-8") as f:
                blob = json.load(f)
            if blob.get("cache_version") != CACHE_VERSION:
                return None
            if blob.get("model") != expect_model:
                return None  # model changed -> results not comparable
            payload = blob.get("payload")
            return payload if isinstance(payload, dict) else None
        except (json.JSONDecodeError, OSError):
            return None  # corrupt checkpoint: reprocess

    def save(self, doc_key: str, page_number: int,
             model: str, payload: dict) -> None:
        p = self.path_for(doc_key, page_number)
        blob = {
            "cache_version": CACHE_VERSION,
            "model": model,
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "payload": payload,
        }
        tmp = p.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(blob, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)  # atomic on Windows (NTFS) and POSIX


# ---------------------------------------------------------------------------
# The VLM client
# ---------------------------------------------------------------------------
class VLMEnricher:
    """Async httpx client for the local llama.cpp vision endpoint.

    Usage::

        async with VLMEnricher(llama_url) as vlm:
            payload = await vlm.enrich_page(doc_hash, 12, img, consensus)
    """

    @staticmethod
    def _normalize_llama_url(llama_url: str) -> str:
        """Normalize any base URL to ``{root}/v1/chat/completions``.

        Strips trailing slashes, guarantees the ``/v1`` segment appears exactly
        once after the host root, and always posts to the OpenAI-compatible
        chat endpoint — llama.cpp answers a bare ``/chat/completions`` (no
        ``/v1``) with 400 Bad Request.
        """
        base = (llama_url or DEFAULT_LLM_URL).strip().rstrip("/")
        if base.endswith("/chat/completions"):
            base = base[: -len("/chat/completions")].rstrip("/")
        if not base.endswith("/v1"):
            root = "/".join(base.split("/", 3)[:3])  # scheme://host:port
            base = root + "/v1"
        return base + "/chat/completions"

    def __init__(
        self,
        llama_url: str = DEFAULT_LLM_URL,
        model: str = DEFAULT_MODEL_NAME,
        cache_dir: Optional[Path] = None,
        max_retries: int = 5,
        base_backoff_s: float = 2.0,
        max_backoff_s: float = 60.0,
        timeout_s: float = 300.0,
        max_tokens: int = 4096,
        temperature: float = 0.1,
    ):
        self.url = self._normalize_llama_url(llama_url)
        self.model = model
        self.cache = _CheckpointCache(
            Path(cache_dir) if cache_dir else Path(__file__).resolve().parent / ".cache"
        )
        self.max_retries = max(1, int(max_retries))
        self.base_backoff_s = base_backoff_s
        self.max_backoff_s = max_backoff_s
        self.timeout_s = timeout_s
        self.max_tokens = max_tokens
        self.temperature = temperature
        self._vision_disabled = False  # sticky text-only fallback flag
        self._client: Optional[httpx.AsyncClient] = None

    # -- lifecycle -----------------------------------------------------------
    async def __aenter__(self) -> "VLMEnricher":
        await self.open()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    async def open(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout_s))

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # -- single HTTP round-trip ----------------------------------------------
    def _payload(self, img_b64: Optional[str], consensus_text: str,
                 disputed_regions: list[dict]) -> dict:
        return {
            "model": self.model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user",
                 "content": _build_user_content(img_b64, consensus_text, disputed_regions)},
            ],
            "temperature": self.temperature,
            "top_p": 1.0,
            "max_tokens": self.max_tokens,
            "stream": False,
            # Locked contract: structured JSON out, minimal reasoning for speed.
            # llama.cpp does not understand OpenAI's "reasoning_effort" (it 400s
            # on unknown params); the chat-template kwarg is the supported knob.
            "response_format": {"type": "json_object"},
            "chat_template_kwargs": {"enable_thinking": False},
        }

    @staticmethod
    def _parse_json(content: str) -> dict:
        content = (content or "").strip()
        # Defensive: strip markdown fences if the model added them anyway.
        if content.startswith("```"):
            content = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", content)
        return json.loads(content)

    async def _request_with_retries(self, img_b64: Optional[str], consensus_text: str,
                                    disputed_regions: list[dict]) -> dict:
        assert self._client is not None, "call open() first (or use 'async with')"
        payload = self._payload(img_b64, consensus_text, disputed_regions)
        last_err: Optional[Exception] = None

        for attempt in range(self.max_retries):
            try:
                resp = await self._client.post(self.url, json=payload)
                if resp.status_code == 429 or resp.status_code >= 500:
                    raise httpx.HTTPStatusError(
                        f"HTTP {resp.status_code}", request=resp.request,
                        response=resp,
                    )
                # Log the exact status + body before touching resp.json() so a
                # bad payload or a missing --mmproj is diagnosable from logs.
                if resp.status_code >= 400 or not (resp.text or ""):
                    print(
                        f"[vlm] HTTP {resp.status_code} from {self.url} "
                        f"(attempt {attempt + 1}/{self.max_retries}): "
                        f"{(resp.text or '')[:500]!r}",
                        file=sys.stderr, flush=True,
                    )
                if img_b64 is not None and resp.status_code == 400 and \
                        _VISION_DISABLED_RE.search(resp.text or ""):
                    raise VisionProjectorDisabled(self.url)
                if resp.status_code >= 400 and resp.status_code < 500:
                    # Other client errors (bad params etc.) are not retryable.
                    raise VLMError(
                        f"VLM endpoint {self.url} returned HTTP "
                        f"{resp.status_code}: {(resp.text or '')[:500]!r}"
                    ) from None
                body = resp.json()
                content = body["choices"][0]["message"]["content"]
                return self._parse_json(content)
            except VisionProjectorDisabled:
                raise  # caller switches to text-only; never retry the image
            except (httpx.TransportError, httpx.HTTPStatusError,
                    json.JSONDecodeError, KeyError, IndexError, TypeError) as e:
                last_err = e
                if attempt < self.max_retries - 1:
                    delay = min(self.max_backoff_s,
                                self.base_backoff_s * (2 ** attempt))
                    delay += random.uniform(0.0, 0.5)   # jitter: de-sync retries
                    await asyncio.sleep(delay)

        raise VLMError(
            f"VLM endpoint {self.url} failed after {self.max_retries} attempts: {last_err}"
        ) from last_err

    # -- public API ------------------------------------------------------------
    async def enrich_page(
        self,
        doc_key: str,
        page_number: int,
        img: np.ndarray,
        consensus: dict,
    ) -> dict:
        """Enrich one page. Cache-first, retry-protected, schema-normalized.

        ``doc_key`` (the PDF file stem) together with ``page_number`` forms the
        checkpoint key so interrupted runs resume without re-querying the model
        for completed pages.  If llama-server answers 400 because no vision
        projector (``--mmproj``) is loaded, the page is structured from the
        consensus OCR text alone and the fallback stays on for the run.
        """
        cached = self.cache.load(doc_key, page_number, self.model)
        if cached is not None:
            return cached

        consensus_text = str(consensus.get("text") or "")
        disputed_regions = list(consensus.get("disputed_regions") or [])
        img_b64 = None if self._vision_disabled else encode_page_jpeg_b64(img)
        try:
            raw = await self._request_with_retries(
                img_b64, consensus_text, disputed_regions)
        except VisionProjectorDisabled:
            if not self._vision_disabled:
                self._vision_disabled = True
                print(
                    "[vlm] llama-server returned 400 for an image payload — "
                    "no --mmproj vision projector loaded. Falling back to "
                    "text-only OCR structuring for the rest of this run.",
                    file=sys.stderr, flush=True,
                )
            raw = await self._request_with_retries(
                None, consensus_text, disputed_regions)
        payload = normalize_vlm_payload(raw)
        self.cache.save(doc_key, page_number, self.model, payload)
        return payload

    async def enrich_pages(
        self,
        doc_hash: str,
        pages: list[tuple[int, np.ndarray, dict]],
        max_concurrency: int = 1,
    ) -> list[dict]:
        """Enrich a batch of ``(page_number, img, consensus)`` tuples.

        ``max_concurrency`` defaults to 1: llama.cpp serves one stream at a time
        for a 27B model, so parallel posts only queue on the server.  Raises
        :class:`VLMError` on the first page that fails after all retries —
        completed pages are already checkpointed, so re-running resumes.
        """
        sem = asyncio.Semaphore(max(1, max_concurrency))

        async def _one(item: tuple[int, np.ndarray, dict]) -> dict:
            page_number, img, consensus = item
            async with sem:
                return await self.enrich_page(doc_hash, page_number, img, consensus)

        return list(await asyncio.gather(*(_one(p) for p in pages)))
