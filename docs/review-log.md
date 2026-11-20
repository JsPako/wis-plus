# WIS+ release review log

Branch: `release/review-fixes` (cut from `master` @ d663472).
One line per task. Status: done / skipped (reason) / blocked.

| Task | Status | Commit | Notes |
|------|--------|--------|-------|
| 0.1 git status / log, clean tree check | done | (this commit) | Real clone (origin/master). Tree was NOT clean at start: uncommitted WIP in forge/build_db.py + forge/ocr_consensus.py from a prior audit session — stashed as "phase0: pre-existing WIP...", diffs saved to _phase0_diff_builddb.txt / _phase0_diff_ocr.txt. Untracked local artifacts left in place (never delete): pdfs/EU, pdfs/US scans; _audit*, _smoke*, _tmp* scratch files; scripts/preview_ocr.py; forge/tests_smoke_01001.py. |
| 0.2 create release/review-fixes | done | (this commit) | Cut from master @ d663472. |
| 0.3 docs: review-log.md + decisions.md (D1–D6) | done | (this commit) | All six decisions recorded with their defaults. |
| 0.4a baseline ui: npm ci / tsc / vite build | done | (this commit) | npm ci OK (550 pkgs, node v26.13.1 via C:\Program Files\nodejs — not on sandbox PATH). `tsc --noEmit` PASS. `vite build` FAILS as expected: Rollup cannot resolve "react-native-web/dist/cjs/exports/defaults" from src/main.tsx (logs: _baseline_vite.txt). |
| 0.4b baseline pyflakes backend forge shared | done | (this commit) | 12 findings, full list in _baseline_pyflakes.txt: backend/main.py:25 unused 'threading'; backend/search_engine.py:306 undefined 'SearchResultItem'; forge/build_db.py:79 unused run_ocr_engines import; forge/build_db.py:426/451/516 undefined 'np' (no numpy import); forge/ocr_consensus.py:25/28 unused math/re, :71 redefinition of 're', :660 redefinition of '_has_digit'; forge/pdf_normalizer.py:21 unused typing.Optional; forge/vlm_enricher.py:390 f-string without placeholders. |
| 0.4c baseline backend: venv + run + /api/health | done | (this commit) | Reused existing .venv (Python 3.13.18, all of backend/requirements.txt installed; added pyflakes for this check). NOTE: backend/main.py imports PIL but Pillow is NOT in backend/requirements.txt — latent gap, flag for later task. Server up via uvicorn on 127.0.0.1:8321 (in-process, _baseline_health_run.py); GET /api/health → 200 {"status":"ok","db_loaded":true,"procedure_count":0}. data/w201_kb.sqlite present but empty (0 procedures). |

