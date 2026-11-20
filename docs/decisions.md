# WIS+ release review — decisions

Open questions raised during the pre-release review, with their decided
defaults. If a task depends on an unanswered decision, use the safe default,
mark the code `TODO(owner)` and carry on.

| ID | Question | Decision |
|----|----------|----------|
| D1 | Supported engines and gearboxes | Decided: M103 exists only as the 2.6 (the 2.3 is an M102, not an M103); otherwise the union of the UI and forge lists. Single source of truth: shared/variants.json (task 2.1). |
| D2 | Packaging | Decided: bundle the Python backend as a Tauri sidecar, model included, data in the app data folder. |
| D3 | Torque limits | Decided: 1–500 Nm, 0.7–370 ft-lb, 0–720 degrees per stage; out-of-range values are kept and flagged (never dropped); angle and multi-stage tightening is stored and displayed. |
| D4 | Duplicate hiding | Decided: Europe scans are primary, a very close US copy is hidden, differing torque keeps both labelled by region. |
| D5 | Licence | Decided: open source — MIT with PyMuPDF replaced by pypdfium2, or AGPL-3.0 if PyMuPDF stays. |
| D6 | Model Qwen3.8-27B | Decided: confirmed. |
