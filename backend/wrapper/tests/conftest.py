"""Isolated test environment. Sets wrapper src path and temporary state
directories, and disables the runtime-parity layer, BEFORE any test module
imports hermes_webui_wrapper.app (which would otherwise bootstrap upstream
against real state)."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

_WRAPPER_ROOT = Path(__file__).resolve().parents[1]
_SRC = _WRAPPER_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

_TMP_HOME = Path(tempfile.mkdtemp(prefix="hermes-webui-wrapper-test-home-"))
os.environ["HOME"] = str(_TMP_HOME)
os.environ["HERMES_HOME"] = str(_TMP_HOME / "hermes-home")
os.environ["HERMES_WEBUI_STATE_DIR"] = str(_TMP_HOME / "state")
os.environ["HERMES_WEBUI_SESSION_DIR"] = str(_TMP_HOME / "state" / "sessions")
os.environ["HERMES_WEBUI_DEFAULT_WORKSPACE"] = str(_TMP_HOME / "workspace")
os.environ["HERMES_WRAPPER_RUNTIME_ENABLED"] = "false"

import pytest  # noqa: E402

UPSTREAM_ROOT = (_WRAPPER_ROOT.parent / "upstream").resolve()


@pytest.fixture(scope="session")
def upstream_root() -> Path:
    return UPSTREAM_ROOT
