"""Puts `src/` on sys.path for an editable-less test run (mirrors
`backend/wrapper/tests/conftest.py`'s own approach, so both packages in
this repo are testable the same way without requiring `pip install -e`
first)."""
from __future__ import annotations

import sys
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parents[1]
_SRC = _PACKAGE_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))
