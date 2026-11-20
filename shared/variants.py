"""Single source of truth for the W201 engine / gearbox variant vocabulary.

Every layer that names a variant reads from ``shared/variants.json`` so there is
exactly one place to change an id, a label or add an alias:

* forge's allowed sets and the VLM prompt text (``forge/vlm_enricher.py``),
* backend profile validation and the ``GET /api/variants`` endpoint,
* the UI option lists (fetched at runtime, with a built-in offline fallback).

A variant is either an **engine** or a **gearbox**.  Each has one canonical
``id`` — the token stored in the database — a human ``label``, and zero or more
``aliases``: legacy tokens that must resolve to the same canonical id so old
profiles keep matching (e.g. the UI once offered ``M102_2.3_16V`` while forge
stored ``M102_16V``).

Safety note: :func:`normalize_variant` returns ``None`` for an unknown token.
Callers must treat that as *unrecognised* — never widen it to "all" (see task 2.2).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_VARIANTS_PATH = Path(__file__).resolve().parent / "variants.json"


@dataclass(frozen=True)
class Variant:
    id: str
    label: str
    kind: str  # 'engine' | 'gearbox'
    aliases: tuple[str, ...] = field(default_factory=tuple)


def _load() -> list[Variant]:
    with open(_VARIANTS_PATH, encoding="utf-8") as f:
        raw: dict[str, Any] = json.load(f)
    out: list[Variant] = []
    for kind_key, kind in (("engines", "engine"), ("gearboxes", "gearbox")):
        for rec in raw.get(kind_key, []):
            out.append(
                Variant(
                    id=str(rec["id"]),
                    label=str(rec["label"]),
                    kind=kind,
                    aliases=tuple(str(a) for a in rec.get("aliases", [])),
                )
            )
    return out


_CACHE: list[Variant] | None = None


def _all() -> list[Variant]:
    global _CACHE
    if _CACHE is None:
        _CACHE = _load()
    return _CACHE


def all_variants() -> list[Variant]:
    """Every variant, in file order (engines then gearboxes)."""
    return list(_all())


def engines() -> list[Variant]:
    return [v for v in _all() if v.kind == "engine"]


def gearboxes() -> list[Variant]:
    return [v for v in _all() if v.kind == "gearbox"]


def engine_ids() -> frozenset[str]:
    """Canonical engine ids — the tokens forge is allowed to emit/store."""
    return frozenset(v.id for v in engines())


def gearbox_ids() -> frozenset[str]:
    """Canonical gearbox ids — the tokens forge is allowed to emit/store."""
    return frozenset(v.id for v in gearboxes())


def _token_to_canonical() -> dict[str, str]:
    m: dict[str, str] = {}
    for v in _all():
        m[v.id] = v.id
        for a in v.aliases:
            m[a] = v.id
    return m


def normalize_variant(token: str | None) -> str | None:
    """Map a variant token (canonical id or alias) to its canonical id.

    Returns ``None`` when the token is unknown — callers must treat that as
    *unrecognised*, never as "applies to all".
    """
    if not token:
        return None
    t = str(token).strip()
    if not t:
        return None
    return _token_to_canonical().get(t)


def options(kind: str) -> list[dict[str, str]]:
    """``[{label, value}]`` for the UI / ``GET /api/variants`` (value = id)."""
    pool = engines() if kind == "engine" else gearboxes()
    return [{"label": v.label, "value": v.id} for v in pool]
