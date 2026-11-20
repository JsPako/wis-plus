"""Pytest bootstrap: make the repo root importable so tests can ``import shared``.

The backend runs with cwd=backend, but pytest is run from the repo root; this
puts the root on sys.path once for every test module."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
