# WIS+ — Local-First Workshop Manual for the Mercedes-Benz 190E (W201)

> **Vibe-coded, local-first engineering tool.**
>
> WIS+ is a *vibe-coded* desktop application built to help you actually work on a
> **Mercedes-Benz 190E (W201)**. It ingests the factory **WIS** workshop manual and
> **Haynes** service manual, extracts procedures and torque values offline, and serves
> them through a fast local search + PDF sidecar. Everything runs on your machine.
> There is **no cloud, no telemetry, and no runtime LLM chat** — the app is strictly
> offline-first by design.
>
> *Vibe-coded* means this project was built in an exploratory, iterative, human-in-the-loop
> style: structure and conventions are documented here so future sessions (human or AI) can
> pick up the thread cleanly. Treat this README as the contract of intent.

---

## ⚠️ Safety Disclaimer — read before trusting any number

WIS+ uses **automated OCR / Vision-Language-Model extraction** to pull text and torque
values out of scanned manual pages. **Automated extraction CAN MISREAD NUMBERS.** A
misread `"45 Nm"` vs `"40 Nm"`, or an off-by-one digit, can damage your car or — worse —
put you in danger.

**Always click a torque value to open the embedded original PDF scan and verify it by eye
against the printed page before you tighten anything.** The extracted number is a *convenience
pointer*, never a substitute for the source document. This holds true for every clearance,
angle, gap, and specification shown in the UI.

- Verify **every** torque value against the original scan.
- Confirm the **engine variant** (e.g. M102 1.8 vs M103 2.6) matches your car.
- When in doubt, trust the printed manual over the app.

---

## Architecture (3 layers)

WIS+ is a monorepo split into three clearly separated layers plus shared contracts and assets.

```
WIS+
├── shared/      # Contracts shared by all layers: schema.sql, models.py, synonyms.json
├── forge/       # LAYER 1 — offline ingestion (Windows only)
├── backend/     # LAYER 2 — lightweight Python search / PDF sidecar
├── ui/          # LAYER 3 — React Native + Tauri v2 desktop app
└── assets/      # Icons, branding, bundled reference data
```

### Layer 1 — `forge/` (offline Windows ingestion)
- Runs on the **Windows 11** build machine (Ryzen 9 7900X / RX 9070 XT) where the GPU and
  CPU headroom make heavy OCR + VLM extraction practical.
- Reads raw scans from `pdfs/`, classifies each page (`procedure`, `spec_table`, `diagram`,
  `boilerplate_skip`), extracts procedures/tools/torque values, and computes float32
  embeddings for semantic search.
- Writes the finished SQLite database into `data/`. **This is the only layer that touches
  raw PDFs or runs heavy models, and it is intentionally Windows-only.**

### Layer 2 — `backend/` (lightweight Python sidecar)
- A small, dependency-light Python service that opens the read-only SQLite database produced
  by `forge/`, serves **FTS5 + vector** search results, and streams the relevant page image / PDF
  region for a given bbox.
- Designed to run comfortably on the **Arch Linux** deployment target (i5-1135G7, 8 GB RAM):
  no GPU, no heavy models at runtime — just SQLite FTS5 and cheap cosine similarity over
  precomputed embeddings.

### Layer 3 — `ui/` (React Native + Tauri v2 desktop app)
- A **Tauri v2** desktop shell hosting a **React Native (Web)** interface.
- Talks to the `backend/` sidecar over localhost. Renders procedures, torque tables, and the
  clickable embedded PDF scan for verification (see safety disclaimer).
- Ships as a native-feeling desktop app on both Windows and Linux.

### Data flow
```
 pdfs/*.pdf  ──►  forge/ (Windows, offline OCR/VLM + embeddings)
                        │
                        ▼
                 data/*.sqlite   (shared/schema.sql)
                        │
                        ▼
              backend/ sidecar  (FTS5 + vector search + PDF region streaming)
                        │
                        ▼
                  ui/ (Tauri v2 desktop app)
```

---

## Repository layout

| Path | Purpose |
|------|---------|
| `shared/schema.sql` | Single source of truth for the SQLite schema. |
| `shared/models.py`  | Pydantic v2 models mirroring the schema (Python 3.12). |
| `shared/synonyms.json` | WIS/Haynes → modern English terminology map used by search. |
| `forge/`            | Offline Windows ingestion pipeline. |
| `backend/`          | Lightweight Python search / PDF sidecar. |
| `ui/`               | React Native + Tauri v2 desktop frontend. |
| `assets/`           | Icons, branding, small bundled reference data. |
| `data/`             | Generated SQLite DBs (ignored; `.gitkeep` tracked). |
| `pdfs/`             | Raw manual scans (ignored; `.gitkeep` tracked). |

---

## Quickstart

### Windows 11 (build + ingestion machine)

```powershell
# 0) Prereqs: Python 3.12, Node 20 LTS, Rust stable + Tauri v2 deps (WebView2 is built-in on Win11)
#    See https://tauri.app/prerequisites/windows for the Visual Studio Build Tools step.

git clone <your-repo-url> wis-plus
cd wis-plus

# --- shared / backend Python env ---
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt

# --- forge ingestion (Windows-only heavy step) ---
pip install -r forge/requirements.txt
# Drop your WIS + Haynes scans into ./pdfs/
python -m forge.run --input pdfs --output data/wisplus.sqlite

# --- ui (Tauri v2 desktop app) ---
cd ui
npm install
npm run dev          # runs the Tauri desktop shell against the local backend
```

### Arch Linux (deployment / runtime machine)

```bash
# 0) Prereqs: Python 3.12, Node 20 LTS, Rust stable + Tauri v2 system deps.
sudo pacman -S --needed python python-pip nodejs npm rust webkit2gtk libsoup3 libappindicator-gtk3
cargo install tauri-cli --version '^2'

# --- clone the repo (the DB is produced on Windows and copied over) ---
git clone <your-repo-url> wis-plus
cd wis-plus
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

# Copy the finished database from the Windows build machine into ./data/
# (e.g. scp or a synced volume) -> data/wisplus.sqlite

# --- start the sidecar, then the desktop app ---
python -m backend.run --db data/wisplus.sqlite &
cd ui
npm install
npm run dev
```

> On the Linux target you do **not** run `forge/` — you consume the database it produces on
> Windows. The runtime stack is intentionally light enough for 8 GB RAM / no GPU.

---

## Conventions & project ethos
- **Offline-first.** No network calls at runtime. No LLM chat in the shipped app.
- **Cleanly committable.** Generated artifacts, raw PDFs, and user config are git-ignored;
  `data/.gitkeep` and `pdfs/.gitkeep` keep the folders tracked.
- **Verify against source.** Every extracted value links back to its original scan bbox.
- **Vibe-coded.** Expect rapid iteration; keep this README updated as intent changes.

## License
For personal workshop use. The underlying WIS/Haynes content remains the property of its
respective publishers — you are responsible for holding legitimate copies of the source manuals.
