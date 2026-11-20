-- =============================================================================
-- WIS+  shared/schema.sql
-- Single source of truth for the SQLite database produced by forge/ and consumed
-- by backend/. Idempotent: safe to re-run (uses DROP ... IF EXISTS + CREATE).
-- Target: Python 3.12 sqlite3 / any modern SQLite >= 3.43 (FTS5 required).
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- documents: one row per ingested manual file (a WIS chapter PDF or a Haynes book)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS documents;
CREATE TABLE documents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    filename        TEXT    NOT NULL UNIQUE,          -- e.g. 'WIS_01_General.pdf'
    source_type     TEXT    NOT NULL CHECK (source_type IN ('WIS', 'HAYNES')),
    wis_section     TEXT    NULL,                     -- nullable, e.g. '01' (chassis)
    wis_subsection  TEXT    NULL,                     -- nullable, e.g. '03' (suspension)
    page_count      INTEGER NOT NULL CHECK (page_count >= 0),
    ingested_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    checksum_sha256 TEXT    NULL,                     -- content hash for re-ingest detection
    region          TEXT    NULL,                     -- v3: geographic/edition tag, e.g. 'EU', 'US'
    rel_path        TEXT    NULL                      -- v3: path relative to pdfs/ root
);
CREATE INDEX idx_documents_source ON documents(source_type, wis_section, wis_subsection);
CREATE INDEX idx_documents_checksum ON documents(checksum_sha256);

-- -----------------------------------------------------------------------------
-- pages: one row per scanned page of a document
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS pages;
CREATE TABLE pages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number    INTEGER NOT NULL CHECK (page_number >= 1),
    orientation    TEXT    NOT NULL CHECK (orientation IN ('portrait', 'landscape')),
    norm_width     REAL    NOT NULL DEFAULT 1.0,      -- normalized reference width  (usually 1.0)
    norm_height    REAL    NOT NULL DEFAULT 1.0,      -- normalized reference height (usually 1.0)
    page_type      TEXT    NOT NULL CHECK (page_type IN
                        ('procedure', 'spec_table', 'diagram', 'boilerplate_skip')),
    raw_ocr_text   TEXT    NULL,                      -- full-page OCR dump (may be large)
    UNIQUE (document_id, page_number)
);
CREATE INDEX idx_pages_document ON pages(document_id, page_number);
CREATE INDEX idx_pages_type     ON pages(page_type);

-- -----------------------------------------------------------------------------
-- procedures: one row per extracted workshop procedure
--   JSON columns are stored as TEXT holding valid JSON (see shared/models.py).
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS procedures;
CREATE TABLE procedures (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id                 INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    category                TEXT    NOT NULL,         -- e.g. 'Suspension'
    subcategory             TEXT    NOT NULL,         -- e.g. 'Front Suspension'
    title                   TEXT    NOT NULL,         -- e.g. 'Replace front shock absorbers'
    engine_variants         TEXT    NOT NULL DEFAULT '[]',   -- JSON array: ["M102_1.8","M102_2.0"]
    transmission_variants   TEXT    NOT NULL DEFAULT '[]',   -- JSON array: ["AUTO_722.4","MANUAL_717.4"]
    review_flags            TEXT    NOT NULL DEFAULT '[]',   -- v3: JSON array of warning strings
    stages                  TEXT    NOT NULL DEFAULT '[]',   -- v3: JSON array of stage objects
    tools_required          TEXT    NOT NULL DEFAULT '[]',   -- JSON array of ToolItem
    removal_steps           TEXT    NOT NULL DEFAULT '[]',   -- JSON array of ProcedureStep
    installation_steps      TEXT    NOT NULL DEFAULT '[]',   -- JSON array of ProcedureStep
    general_tips            TEXT    NOT NULL DEFAULT '[]',   -- JSON array of strings
    search_text             TEXT    NOT NULL DEFAULT '',     -- denormalized: steps+tools+tips+synonyms (FTS source)
    embedding               BLOB    NULL,                     -- float32 little-endian vector
    embedding_dim           INTEGER NULL,                     -- len(embedding) as Python int
    ocr_confidence          REAL    NULL,                     -- mean OCR-consensus confidence of this procedure's source text
    is_duplicate            INTEGER NOT NULL DEFAULT 0 CHECK (is_duplicate IN (0,1)),
                                                                     -- 1 = secondary copy of a WIS procedure already covered by another source PDF (hidden from Spotlight Search)
    duplicate_of            INTEGER NULL REFERENCES procedures(id) ON DELETE SET NULL,
                                                                     -- canonical row id when is_duplicate = 1
    created_at              TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_procedures_page       ON procedures(page_id);
CREATE INDEX idx_procedures_category   ON procedures(category, subcategory);
CREATE INDEX idx_procedures_title      ON procedures(title);

-- -----------------------------------------------------------------------------
-- torque_specs: one row per extracted torque value (clickable -> original scan bbox)
--   All bboxes are NORMALIZED floats in [0.0, 1.0] relative to the page.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS torque_specs;
CREATE TABLE torque_specs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    procedure_id     INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
    page_id          INTEGER NOT NULL REFERENCES pages(id)      ON DELETE CASCADE,
    step_mode        TEXT    NOT NULL CHECK (step_mode IN ('removal', 'installation', 'general')),
    component_name   TEXT    NOT NULL,                -- e.g. 'Wheel hub nut'
    value_nm         REAL    NULL CHECK (value_nm IS NULL OR (value_nm >= 2.0 AND value_nm <= 400.0)),  -- v3: nullable
    value_ftlb       REAL    NULL,                    -- ft-lb (nullable)
    raw_text         TEXT    NOT NULL,                -- verbatim source text, e.g. '45 Nm (33 ft-lb)'
    bbox_x0          REAL    NOT NULL DEFAULT 0.0 CHECK (bbox_x0 >= 0.0 AND bbox_x0 <= 1.0),
    bbox_y0          REAL    NOT NULL DEFAULT 0.0 CHECK (bbox_y0 >= 0.0 AND bbox_y0 <= 1.0),
    bbox_x1          REAL    NOT NULL DEFAULT 1.0 CHECK (bbox_x1 >= 0.0 AND bbox_x1 <= 1.0),
    bbox_y1          REAL    NOT NULL DEFAULT 1.0 CHECK (bbox_y1 >= 0.0 AND bbox_y1 <= 1.0),
    bbox_exact       INTEGER NOT NULL DEFAULT 1 CHECK (bbox_exact IN (0,1)),  -- v3: 0 = approximate/estimated box
    angle_deg        REAL    NULL,                    -- v3: rotation of the text line in degrees (for rotated scans)
    CHECK (bbox_x0 < bbox_x1 AND bbox_y0 < bbox_y1)   -- v3: enforce ordering at DB level
);
CREATE INDEX idx_torque_procedure ON torque_specs(procedure_id, step_mode);
CREATE INDEX idx_torque_page      ON torque_specs(page_id);

-- -----------------------------------------------------------------------------
-- procedures_fts: FTS5 full-text index over the searchable procedure surface.
--   search_text = concatenated steps + tools + synonyms (built by forge/).
--   External-content table keyed on procedure_id.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS procedures_fts;
CREATE VIRTUAL TABLE procedures_fts USING fts5(
    title,
    category,
    subcategory,
    search_text,
    content='procedures',
    content_rowid='id',
    tokenize='porter unicode61'
);

-- FTS5 auxiliary sync triggers (keep the index in lockstep with procedures).
DROP TRIGGER IF EXISTS procedures_ai;
CREATE TRIGGER procedures_ai AFTER INSERT ON procedures BEGIN
    INSERT INTO procedures_fts(rowid, title, category, subcategory, search_text)
    VALUES (new.id, new.title, new.category, new.subcategory, COALESCE(new.search_text, ''));
END;

DROP TRIGGER IF EXISTS procedures_ad;
CREATE TRIGGER procedures_ad AFTER DELETE ON procedures BEGIN
    INSERT INTO procedures_fts(procedures_fts, rowid, title, category, subcategory, search_text)
    VALUES ('delete', old.id, old.title, old.category, old.subcategory, COALESCE(old.search_text, ''));
END;

DROP TRIGGER IF EXISTS procedures_au;
CREATE TRIGGER procedures_au AFTER UPDATE ON procedures BEGIN
    INSERT INTO procedures_fts(procedures_fts, rowid, title, category, subcategory, search_text)
    VALUES ('delete', old.id, old.title, old.category, old.subcategory, COALESCE(old.search_text, ''));
    INSERT INTO procedures_fts(rowid, title, category, subcategory, search_text)
    VALUES (new.id, new.title, new.category, new.subcategory, COALESCE(new.search_text, ''));
END;

-- -----------------------------------------------------------------------------
-- metadata: schema versioning for forward-compatible migrations.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS meta;
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- v3: review_flags / stages on procedures, nullable value_nm + bbox_exact + angle_deg
--      on torque_specs, documents.region / rel_path.
INSERT INTO meta(key, value) VALUES ('schema_version', '3');
INSERT INTO meta(key, value) VALUES ('created_at', datetime('now'));
INSERT INTO meta(key, value) VALUES ('source_pdf_count', '0');
