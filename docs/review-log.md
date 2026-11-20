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

## Phase 0.5 — secure the WIP, clean the ground

| Task | Status | Commit | Notes |
|------|--------|--------|-------|
| 0.5.2 .gitignore scratch patterns | done | e5328e7 | Added `_tmp_*`, `_smoke_*`, `_run_*.py`, `_u.txt`, `_audit*`, `_baseline*`, `_phase0_*`, `npm-cache/` plus `pdfs/EU/` + `pdfs/US/` (proprietary scans, never commit). scripts/preview_ocr.py and forge/tests_smoke_01001.py deliberately left untracked pending decision. No `git add -A/.` used anywhere; only explicit paths staged. |
| 0.5.3 preserve WIP on wip/prior-audit | done | 833d1b9 (on wip/prior-audit) | `git switch -c wip/prior-audit d663472` → `git stash pop` applied CLEANLY (no conflicts). Staged forge/build_db.py + forge/ocr_consensus.py by name only; commit `wip: prior audit session changes (unreviewed)` (258+/135−). NOT pushed. Switched back to release/review-fixes. |
| 0.5.4 WIP vs task list comparison | blocked | — | **Task list not available**: no document with tasks 1.5/3.4/3.5/3.11(a–e)/3.12/6.5 exists in the repo, git history, or this conversation (searched tracked files, scratch files, all branches). Refusing to guess what those tasks require — see table below; needs the task list pasted/provided to complete. Sub-items 0.5.4a–c below are done regardless. |
| 0.5.4a name inventory in WIP | done | (with 0.5.3) | Present in wip/prior-audit: `_compare_key` (forge/ocr_consensus.py:83), `_is_noise_token` (:626), `_as_token` (:733), `normalize_tokens` (:783, used by build_db), `normalize_consensus` (:802, used by build_db). ABSENT: `OcrToken`, `ConsensusPage` (WIP still uses plain dicts, no dataclasses). |
| 0.5.4b pyflakes on wip/prior-audit | done | (with 0.5.3) | 8 findings (full list _phase05_pyflakes_wip.txt): backend/main.py:25 unused threading; backend/search_engine.py:306 undefined SearchResultItem; forge/build_db.py:424/449/514 undefined 'np' (×3); forge/ocr_consensus.py:25 unused math; forge/pdf_normalizer.py:21 unused Optional; forge/vlm_enricher.py:390 f-string w/o placeholders. vs the 12-finding baseline: WIP fixes 4 (build_db unused run_ocr_engines import; ocr_consensus unused re, redefinition of re, redefinition of _has_digit); introduces none. |
| 0.5.4c existing tests on wip/prior-audit | done | (with 0.5.3) | **No test suite exists in the repo** — no tests/ dir, no pytest files, no vitest specs (git ls-files + ui/src scan). Only executable check: untracked smoke script forge/tests_smoke_01001.py, which PASSED against byte-identical WIP content during Phase 0 (_smoke_run4.txt). |
| 0.5.5 pillow in backend/requirements.txt | done | 7105570 | Repro: fresh py3.13 venv + backend/requirements.txt → PIL import only works because fastembed pulls pillow transitively (`pip show pillow` → Required-by: fastembed); not declared for a direct import (backend/main.py:39). Fix: added `pillow>=10.0` (same floor as forge). Verify: fresh venv reinstall + `import backend.main` OK. |
| 0.5.6 requirements on 3.12 AND 3.13 | done | (with 0.5.7) | **3.12 (CI target): PASS.** Fresh venv (py -3.12, 3.12.10): backend reqs install + `import backend.main` OK; forge reqs FULL fresh install OK — torch 2.15.0+cpu, easyocr, rapidocr-onnxruntime 1.4.4, pymupdf 1.28.2 all import. One upstream pip warning: pymupdf-layout 2.1 (pulled via dep chain) wants pymupdf==2.1 vs our <2.0 pin — harmless for forge imports, recorded. **3.13 (local .venv): backend PASS, forge FAILS** — `rapidocr-onnxruntime>=1.3` has NO distribution supporting 3.13 (all releases cap at Requires-Python <3.13). Existing .venv only works because it holds legacy rapidocr 1.2.3 installed outside the current pin. **Conclusion: CI must stay on 3.12; forge cannot be installed fresh on 3.13.** Evidence logs: _phase0_forge_dry312/313.txt, _phase0_forge_install312.txt; venvs kept at _phase0_venv312/_phase0_venv313 (git-ignored). |
| 0.5.7 docs update | done | (this commit) | This section + phase 0.5 rows. |

### 0.5.4 WIP-vs-task-list table (BLOCKED — task list not provided)

| Task | WIP contains the fix? | Evidence / reason |
|------|----------------------|-------------------|
| 1.5 | cannot evaluate | Task text not available in repo or conversation — no guess made (safety rule: never imply verified). |
| 3.4 | cannot evaluate | Same. |
| 3.5 | cannot evaluate | Same. |
| 3.11 a–e | cannot evaluate | Same. |
| 3.12 | cannot evaluate | Same. |
| 6.5 | cannot evaluate | Same. |

Objective WIP facts that may help map tasks once the list is provided: WIP adds `_compare_key`/`_token_box` pairing helpers, `_is_noise_token`, `normalize_tokens`/`normalize_consensus` public API (ocr_consensus.py:83–802), retunes dispute thresholds (DISPUTE_MIN_ALNUM_CHARS / DISPUTE_MIN_TOKEN_PX replace CONF/MIN_WORDS), and adds worker-pool reuse in build_db (`_make_engine_pools`, Stage-1 fast-only OCR). Still broken in WIP per pyflakes: undefined `np` at build_db.py:424/449/514. |

