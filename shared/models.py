"""
WIS+  shared/models.py
=======================
Pydantic v2 models that mirror ``shared/schema.sql``.

These are the canonical, typed representations of every row and payload in the
WIS+ database. They are used by:

* ``forge/``   — to build records before writing to SQLite,
* ``backend/`` — to hydrate rows out of SQLite for the API layer,
* ``ui/``      — as the JSON contract (via ``model_dump_json``) over localhost.

Target runtime: **Python 3.12**, **Pydantic v2**.

JSON columns in the DB are stored as TEXT holding valid JSON; the Pydantic models
below use real typed fields and serialize/deserialize to/from that JSON via the
``json_*`` helpers at the bottom of this module.
"""

from __future__ import annotations

import json
import struct
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Enums (mirror the CHECK constraints in schema.sql)
# ---------------------------------------------------------------------------
class SourceType(str, Enum):
    WIS = "WIS"
    HAYNES = "HAYNES"


class PageOrientation(str, Enum):
    PORTRAIT = "portrait"
    LANDSCAPE = "landscape"


class PageType(str, Enum):
    PROCEDURE = "procedure"
    SPEC_TABLE = "spec_table"
    DIAGRAM = "diagram"
    BOILERPLATE_SKIP = "boilerplate_skip"


class StepMode(str, Enum):
    REMOVAL = "removal"
    INSTALLATION = "installation"
    GENERAL = "general"


# ---------------------------------------------------------------------------
# NormalizedBBox — a bounding box in normalized [0.0, 1.0] page coordinates.
# x0 < x1 and y0 < y1, all within the unit square.
# ---------------------------------------------------------------------------
class NormalizedBBox(BaseModel):
    """Axis-aligned box normalized to the page (origin top-left, +x right, +y down)."""

    x0: float = Field(..., ge=0.0, le=1.0)
    y0: float = Field(..., ge=0.0, le=1.0)
    x1: float = Field(..., ge=0.0, le=1.0)
    y1: float = Field(..., ge=0.0, le=1.0)

    @model_validator(mode="after")
    def _check_order(self) -> "NormalizedBBox":
        if self.x0 >= self.x1 or self.y0 >= self.y1:
            raise ValueError("bbox must satisfy x0 < x1 and y0 < y1")
        return self

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0)


# ---------------------------------------------------------------------------
# ToolItem — an element of procedures.tools_required.
# ---------------------------------------------------------------------------
class ToolItem(BaseModel):
    """A single required tool. ``size_or_code`` may be a size ('17 mm') or a
    Mercedes special-tool code (e.g. 'X 250 480 09 10 0300')."""

    name: str = Field(..., min_length=1)
    size_or_code: Optional[str] = None
    is_mercedes_special: bool = False


# ---------------------------------------------------------------------------
# ProcedureStep — an element of procedures.removal_steps / installation_steps.
# ``bbox`` (optional) points at the step's location on the source page so the UI
# can highlight it; torque values referenced by a step live in torque_specs.
# ---------------------------------------------------------------------------
class ProcedureStep(BaseModel):
    step_num: int = Field(..., ge=1)
    text: str = Field(..., min_length=1)
    tip: Optional[str] = None
    bbox: Optional[NormalizedBBox] = None


# ---------------------------------------------------------------------------
# TorqueSpec — mirrors the torque_specs table (one row per extracted value).
# ---------------------------------------------------------------------------
class TorqueSpec(BaseModel):
    id: Optional[int] = None
    procedure_id: int
    page_id: int
    step_mode: StepMode
    component_name: str = Field(..., min_length=1)
    value_nm: Optional[float] = Field(default=None, gt=2.0, le=400.0)  # v3: nullable
    value_ftlb: Optional[float] = Field(default=None, gt=0.0)
    raw_text: str = Field(..., min_length=1)
    bbox: NormalizedBBox
    bbox_exact: bool = True   # v3: False = approximate/estimated box
    angle_deg: Optional[float] = None  # v3: rotation in degrees


class TorqueSpecRow(BaseModel):
    """Flat row shape as it physically lives in the ``torque_specs`` table
    (bbox stored as four columns), with a converter to the nested form."""

    id: Optional[int] = None
    procedure_id: int
    page_id: int
    step_mode: StepMode
    component_name: str
    value_nm: Optional[float] = None  # v3: nullable
    value_ftlb: Optional[float] = None
    raw_text: str
    bbox_x0: float
    bbox_y0: float
    bbox_x1: float
    bbox_y1: float
    bbox_exact: bool = True   # v3
    angle_deg: Optional[float] = None  # v3

    def to_nested(self) -> TorqueSpec:
        return TorqueSpec(
            id=self.id,
            procedure_id=self.procedure_id,
            page_id=self.page_id,
            step_mode=self.step_mode,
            component_name=self.component_name,
            value_nm=self.value_nm,
            value_ftlb=self.value_ftlb,
            raw_text=self.raw_text,
            bbox=NormalizedBBox(
                x0=self.bbox_x0, y0=self.bbox_y0, x1=self.bbox_x1, y1=self.bbox_y1
            ),
            bbox_exact=self.bbox_exact,
            angle_deg=self.angle_deg,
        )


# ---------------------------------------------------------------------------
# ProcedureRecord — mirrors the procedures table (with JSON columns typed).
# ---------------------------------------------------------------------------
class ProcedureRecord(BaseModel):
    id: Optional[int] = None
    page_id: int
    category: str = Field(..., min_length=1)          # e.g. 'Suspension'
    subcategory: str = Field(..., min_length=1)       # e.g. 'Front Suspension'
    title: str = Field(..., min_length=1)
    engine_variants: list[str] = Field(default_factory=list)
    transmission_variants: list[str] = Field(default_factory=list)
    review_flags: list[str] = Field(default_factory=list)   # v3
    stages: list[dict] = Field(default_factory=list)        # v3
    tools_required: list[ToolItem] = Field(default_factory=list)
    removal_steps: list[ProcedureStep] = Field(default_factory=list)
    installation_steps: list[ProcedureStep] = Field(default_factory=list)
    general_tips: list[str] = Field(default_factory=list)
    search_text: str = ""  # denormalized FTS surface (steps+tools+tips+synonyms)
    embedding: Optional[list[float]] = None

    @field_validator("engine_variants", "transmission_variants", "review_flags", "stages", mode="before")
    @classmethod
    def _coerce_json_str(cls, v):
        """Allow the raw JSON-array-string form coming straight out of SQLite."""
        if isinstance(v, str):
            return json.loads(v) if v.strip() else []
        return v

    # -- embedding <-> BLOB (float32 little-endian) helpers ------------------
    def embedding_to_blob(self) -> Optional[bytes]:
        if self.embedding is None:
            return None
        return struct.pack(f"<{len(self.embedding)}f", *self.embedding)

    @classmethod
    def blob_to_embedding(cls, blob: Optional[bytes]) -> Optional[list[float]]:
        if blob is None or len(blob) == 0:
            return None
        n = len(blob) // 4
        return list(struct.unpack(f"<{n}f", blob))

    @property
    def embedding_dim(self) -> Optional[int]:
        return None if self.embedding is None else len(self.embedding)


# ---------------------------------------------------------------------------
# VehicleProfile — the specific W201 build the user is working on.
# Used to filter procedures by engine/transmission and to badge torque values.
# ---------------------------------------------------------------------------
class VehicleProfile(BaseModel):
    model: str = "Mercedes-Benz 190E (W201)"
    vin_suffix: Optional[str] = None
    year: Optional[int] = Field(default=None, ge=1983, le=1993)
    engine_variant: Optional[str] = None        # e.g. 'M102_1.8', 'M103_2.6'
    transmission_variant: Optional[str] = None  # e.g. 'MANUAL_717.4', 'AUTO_722.4'
    market: Optional[str] = None                # e.g. 'US', 'EU', 'DZ'


# ---------------------------------------------------------------------------
# SearchResultItem — one hit returned by the backend search API to the UI.
# ---------------------------------------------------------------------------
class SearchResultItem(BaseModel):
    procedure_id: int
    title: str
    category: str
    subcategory: str
    snippet: Optional[str] = None          # short FTS excerpt for display
    fts_rank: float = 0.0                  # lower is better (FTS5 bm25)
    vector_score: Optional[float] = None   # cosine similarity in [0.0, 1.0]
    combined_score: float = 0.0            # fused score used for ranking
    engine_variants: list[str] = Field(default_factory=list)
    transmission_variants: list[str] = Field(default_factory=list)
    page_id: Optional[int] = None          # primary source page (for the scan link)
    torque_count: int = 0                  # how many torque specs this procedure has


# ---------------------------------------------------------------------------
# JSON column helpers — bridge between typed models and SQLite TEXT columns.
# ---------------------------------------------------------------------------
def dump_json(value) -> str:
    """Serialize a model/list to the compact JSON string stored in the DB."""
    if isinstance(value, BaseModel):
        return value.model_dump_json()
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def load_json(text: Optional[str], default=None):
    """Parse a JSON TEXT column back into Python; tolerate NULL/empty."""
    if text is None or (isinstance(text, str) and not text.strip()):
        return default if default is not None else []
    if isinstance(text, bytes):
        text = text.decode("utf-8")
    return json.loads(text)
