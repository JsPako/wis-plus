"""
WIS+  backend/theme_loader.py
==============================
Custom-theme registry for the WIS+ Theme Engine (Task 7.5).

Users extend the 8 built-in UI themes by dropping ``*.json`` files into the
project-root ``themes/`` directory — or by importing one from the Settings
screen, which is served back through ``POST /api/themes`` and persisted here.

Every file is validated against the canonical 11-color palette schema before
it is exposed to the API. A broken theme file must never crash the sidecar:
invalid files are logged and skipped, so the app always boots with at least
the built-in presets.

Schema (mirrored by ``ui/src/theme/ThemeContext.tsx``):

    {
      "id":          lowercase slug, unique, not a built-in id,
      "name":        display name (1-80 chars),
      "description": short blurb (<= 500 chars),
      "author":      theme author,
      "isDark":      true for dark palettes (drives derived colors),
      "colors":      all 11 keys, #RRGGBB or #RRGGBBAA hex
    }
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError, field_validator

log = logging.getLogger("wisplus.themes")

#: The 8 presets compiled into the UI. Custom themes may never shadow these ids.
BUILT_IN_THEME_IDS: frozenset[str] = frozenset({
    "workshop-dark",
    "daylight-garage",
    "mercedes-w201",
    "green-crt",
    "orange-crt",
    "blueprint-cad",
    "haynes-newsprint",
    "dtm-evo-silver",
})

#: The canonical palette — every theme (built-in or custom) must define all 11.
REQUIRED_COLOR_KEYS: tuple[str, ...] = (
    "bgPrimary",
    "bgSurface",
    "bgElevated",
    "borderSubtle",
    "accentPrimary",
    "accentSecondary",
    "verifyGreen",
    "dangerRed",
    "textPrimary",
    "textSecondary",
    "textMuted",
)

_HEX_RE = re.compile(r"^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
_ID_RE = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"


class ThemeColors(BaseModel):
    """The 11-color WIS+ palette. Every value must be #RRGGBB or #RRGGBBAA."""

    bgPrimary: str
    bgSurface: str
    bgElevated: str
    borderSubtle: str
    accentPrimary: str
    accentSecondary: str
    verifyGreen: str
    dangerRed: str
    textPrimary: str
    textSecondary: str
    textMuted: str

    @field_validator(*REQUIRED_COLOR_KEYS)
    @classmethod
    def _validate_hex(cls, value: str) -> str:
        if not _HEX_RE.fullmatch(value):
            raise ValueError(f"color must be #RRGGBB or #RRGGBBAA hex, got {value!r}")
        return value.upper()


class ThemeFile(BaseModel):
    """One custom theme as stored in ``themes/{id}.json``."""

    id: str = Field(min_length=2, max_length=64, pattern=_ID_RE)
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    author: str = Field(default="WIS+ user", max_length=80)
    isDark: bool = True
    colors: ThemeColors

    @field_validator("id")
    @classmethod
    def _not_a_builtin_id(cls, value: str) -> str:
        if value in BUILT_IN_THEME_IDS:
            raise ValueError(f"'{value}' is a built-in theme id and cannot be overridden")
        return value


# ---------------------------------------------------------------------------
# Directory I/O — the `themes/` folder is the user's local theme library.
# ---------------------------------------------------------------------------
def load_custom_themes(themes_dir: Path) -> list[ThemeFile]:
    """Scan ``themes_dir/*.json`` and return every *valid* custom theme.

    Invalid files (bad JSON, missing color keys, non-hex values, built-in id
    collisions) are logged at WARNING and skipped — they never surface to the
    UI and never raise."""
    if not themes_dir.is_dir():
        return []
    themes: list[ThemeFile] = []
    for path in sorted(themes_dir.glob("*.json")):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            theme = ThemeFile.model_validate(raw)
        except (OSError, json.JSONDecodeError, ValidationError) as exc:
            log.warning("skipping invalid theme file %s: %s", path.name, _first_line(exc))
            continue
        themes.append(theme)
    return themes


def save_custom_theme(theme: ThemeFile, themes_dir: Path) -> Path:
    """Persist a validated theme as ``themes/{id}.json`` (overwrite = update).

    Raises ValueError for built-in id collisions; OSError propagates on disk
    failures. The caller maps those to HTTP 409 / 500.
    """
    if theme.id in BUILT_IN_THEME_IDS:
        raise ValueError(f"'{theme.id}' is a built-in theme id and cannot be overridden")
    themes_dir.mkdir(parents=True, exist_ok=True)
    path = themes_dir / f"{theme.id}.json"
    path.write_text(
        json.dumps(theme.model_dump(), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    log.info("saved custom theme '%s' -> %s", theme.id, path)
    return path


def _first_line(exc: Exception) -> str:
    """Pydantic ValidationErrors are multi-line; keep the log tidy."""
    return str(exc).splitlines()[0] if str(exc) else exc.__class__.__name__
