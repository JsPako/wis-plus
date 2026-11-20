"""Task 2.1 — one source of truth for variants.

Two guard tests required by the task, plus a sanity check that the file loads
and canonical ids round-trip through normalisation."""
import os
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SKIP_DIRS = {'.git', '.venv', 'node_modules', 'pdfs', 'data', 'dist',
             'build', '__pycache__', 'npm-cache'}
TEXT_EXT = {'.py', '.ts', '.tsx', '.md', '.json', '.txt', '.sql'}


def _text_files():
    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name.startswith('_'):      # project scratch convention (_tmp_*, _g.txt, ...)
                continue
            p = Path(root) / name
            if p.suffix.lower() in TEXT_EXT:
                yield p


# The phantom engine's name is built by concatenation so this test file does
# not itself contain the literal text it hunts for.
_PHANTOM_A = 'M103' + ' 2.3'
_PHANTOM_B = 'M103' + '_2.3'


def test_no_phantom_m103_2_3_anywhere_in_repo():
    """The phantom 2.3-litre M103 does not exist (owner confirmed). Fail if the
    text reappears in any tracked source/doc file."""
    bad = []
    for p in _text_files():
        try:
            text = p.read_text(encoding='utf-8', errors='ignore')
        except OSError:
            continue
        if _PHANTOM_A in text or _PHANTOM_B in text:
            bad.append(str(p.relative_to(REPO)))
    assert not bad, f"phantom engine reference(s): {bad}"


def test_variants_json_loads_and_canonical_ids_roundtrip():
    from shared import variants
    data = variants.all_variants()
    ids = [v.id for v in data]
    assert len(ids) == len(set(ids)), "duplicate variant ids in shared/variants.json"
    assert all(v.kind in ('engine', 'gearbox') for v in data)
    # canonical ids must map to themselves
    for token in ['M102_16V', 'OM601_602', 'M103_2.6', 'MANUAL_717.4']:
        assert variants.normalize_variant(token) == token, token
    # a legacy alias must resolve to its canonical id
    assert variants.normalize_variant('M102_2.3_16V') == 'M102_16V'
    assert variants.normalize_variant('OM601_OM602') == 'OM601_602'
    # unknown tokens must NOT be widened to all
    assert variants.normalize_variant('NO_SUCH_ENGINE') is None


def test_every_ui_option_value_is_a_known_variant():
    """Any variant id the UI offers must exist in shared/variants.json (as an id
    or an alias), so the picker can never reference a build the DB doesn't know."""
    from shared import variants
    api = (REPO / 'ui' / 'src' / 'types' / 'api.ts').read_text(encoding='utf-8')
    values = re.findall(r"value:\s*'([^']+)'", api)
    assert values, "no option values found in ui/src/types/api.ts"
    missing = [v for v in set(values) if v != 'ALL' and variants.normalize_variant(v) is None]
    assert not missing, f"UI option value(s) missing from shared/variants.json: {missing}"
