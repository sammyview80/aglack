"""Unit tests for `tools/_browser_use_llm.py::resolve_browser_use_llm`.

All `hermes_cli` access is via the stub package `conftest.fake_hermes_cli`
installs into `sys.modules` before the function's lazy imports run; no
live container, network, or real Hermes install is involved.
"""
from __future__ import annotations

import os

import pytest

FAKE_SECRET = "sk-TOTALLY-FAKE-SECRET-VALUE-12345"


@pytest.fixture
def llm_module(load_tool):
    return load_tool("_browser_use_llm")


def _set_runtime(fake, **overrides):
    base = {
        "provider": "deepseek",
        "api_mode": "chat_completions",
        "base_url": "",
        "api_key": FAKE_SECRET,
        "source": "test",
        "requested_provider": "deepseek",
    }
    base.update(overrides)

    def resolve_runtime_provider():
        fake.calls.append(dict(os.environ))
        return dict(base)

    fake.runtime_provider.resolve_runtime_provider = resolve_runtime_provider


def test_chat_completions_deepseek_maps_to_chat_deepseek(llm_module, fake_hermes_cli, browser_use_classes):
    _set_runtime(fake_hermes_cli, provider="deepseek", base_url="")
    llm = llm_module.resolve_browser_use_llm("pm")
    assert isinstance(llm, browser_use_classes.ChatDeepSeek)
    assert llm.model == "deepseek-chat"
    assert llm.api_key == FAKE_SECRET
    assert llm.base_url == "https://api.deepseek.com/v1"


def test_chat_completions_unknown_provider_falls_back_to_chat_openai_with_base_url(
    llm_module, fake_hermes_cli, browser_use_classes
):
    _set_runtime(fake_hermes_cli, provider="fireworks", base_url="https://api.fireworks.ai/inference/v1")
    llm = llm_module.resolve_browser_use_llm("pm")
    assert isinstance(llm, browser_use_classes.ChatOpenAI)
    assert llm.model == "deepseek-chat"
    assert llm.api_key == FAKE_SECRET
    assert str(llm.base_url) == "https://api.fireworks.ai/inference/v1"


def test_chat_completions_custom_provider_uses_generic_openai_with_resolved_base_url(
    llm_module, fake_hermes_cli, browser_use_classes
):
    _set_runtime(fake_hermes_cli, provider="custom", base_url="http://127.0.0.1:11434/v1")
    llm = llm_module.resolve_browser_use_llm("pm")
    assert isinstance(llm, browser_use_classes.ChatOpenAI)
    assert str(llm.base_url) == "http://127.0.0.1:11434/v1"


def test_anthropic_messages_maps_to_chat_anthropic(llm_module, fake_hermes_cli, browser_use_classes):
    _set_runtime(fake_hermes_cli, provider="anthropic", api_mode="anthropic_messages", base_url="")
    llm = llm_module.resolve_browser_use_llm("pm")
    assert isinstance(llm, browser_use_classes.ChatAnthropic)
    assert llm.model == "deepseek-chat"
    assert llm.api_key == FAKE_SECRET
    assert llm.base_url is None


@pytest.mark.parametrize("api_mode", ["bedrock_converse", "codex_responses", "something_new"])
def test_unsupported_api_mode_fails_closed(llm_module, fake_hermes_cli, browser_use_classes, api_mode):
    _set_runtime(fake_hermes_cli, provider="bedrock", api_mode=api_mode)
    with pytest.raises(llm_module.BrowserUseLLMResolutionError) as excinfo:
        llm_module.resolve_browser_use_llm("pm")
    assert api_mode in str(excinfo.value)
    assert "unsupported api_mode" in str(excinfo.value)
    assert FAKE_SECRET not in str(excinfo.value)


def test_empty_model_error_never_leaks_api_key(llm_module, fake_hermes_cli, browser_use_classes):
    """REDACTION: a real raised exception, downstream of a successful
    resolve_runtime_provider() that returned a distinctive fake key."""
    _set_runtime(fake_hermes_cli)
    fake_hermes_cli.config.load_config = lambda: {"model": {"default": ""}}
    with pytest.raises(llm_module.BrowserUseLLMResolutionError) as excinfo:
        llm_module.resolve_browser_use_llm("pm")
    text = str(excinfo.value)
    assert "no model configured" in text
    assert FAKE_SECRET not in text


def test_constructor_failure_error_scrubs_api_key(llm_module, fake_hermes_cli, browser_use_classes, monkeypatch):
    """REDACTION, second path: the LLM constructor itself raises with the
    key embedded in its message; the re-raised error must not carry it."""
    _set_runtime(fake_hermes_cli, provider="deepseek")

    def exploding(**kwargs):
        raise TypeError(f"bad args: {kwargs}")

    monkeypatch.setattr(browser_use_classes, "ChatDeepSeek", exploding)
    with pytest.raises(llm_module.BrowserUseLLMResolutionError) as excinfo:
        llm_module.resolve_browser_use_llm("pm")
    text = str(excinfo.value)
    assert "could not construct browser-use LLM" in text
    assert FAKE_SECRET not in text
    assert excinfo.value.__cause__ is None  # no chained exception carrying the key


def test_unknown_agent_id_never_calls_resolve_runtime_provider(llm_module, fake_hermes_cli, browser_use_classes):
    _set_runtime(fake_hermes_cli)
    with pytest.raises(llm_module.BrowserUseLLMResolutionError) as excinfo:
        llm_module.resolve_browser_use_llm("ghost")
    assert "unknown agent id 'ghost'" in str(excinfo.value)
    assert fake_hermes_cli.calls == []


def test_malformed_agent_id_is_wrapped_and_never_resolves(llm_module, fake_hermes_cli, browser_use_classes):
    _set_runtime(fake_hermes_cli)
    with pytest.raises(llm_module.BrowserUseLLMResolutionError) as excinfo:
        llm_module.resolve_browser_use_llm("../Evil")
    assert "invalid agent id" in str(excinfo.value)
    assert fake_hermes_cli.calls == []


def test_default_agent_id_is_accepted(llm_module, fake_hermes_cli, browser_use_classes):
    _set_runtime(fake_hermes_cli)
    llm = llm_module.resolve_browser_use_llm("default")
    assert isinstance(llm, browser_use_classes.ChatDeepSeek)


def test_provider_value_error_and_auth_error_are_wrapped(llm_module, fake_hermes_cli, browser_use_classes):
    def disabled():
        raise ValueError("provider 'deepseek' is disabled in config")

    fake_hermes_cli.runtime_provider.resolve_runtime_provider = disabled
    with pytest.raises(llm_module.BrowserUseLLMResolutionError) as excinfo:
        llm_module.resolve_browser_use_llm("pm")
    assert "is disabled in config" in str(excinfo.value)

    def no_cred():
        raise fake_hermes_cli.auth.AuthError("no credential for provider deepseek (set DEEPSEEK_API_KEY)")

    fake_hermes_cli.runtime_provider.resolve_runtime_provider = no_cred
    with pytest.raises(llm_module.BrowserUseLLMResolutionError) as excinfo:
        llm_module.resolve_browser_use_llm("pm")
    assert "DEEPSEEK_API_KEY" in str(excinfo.value)


def test_hermes_home_is_scoped_during_resolution_and_restored_on_success(
    llm_module, fake_hermes_cli, browser_use_classes, monkeypatch
):
    monkeypatch.setenv("HERMES_HOME", "/sentinel/prior-home")
    _set_runtime(fake_hermes_cli)
    llm_module.resolve_browser_use_llm("pm")
    # During the call, HERMES_HOME pointed at pm's own resolved home ...
    assert fake_hermes_cli.calls[0]["HERMES_HOME"] == str(fake_hermes_cli.profiles.get_profile_dir("pm"))
    # ... and afterwards it is exactly what it was before.
    assert os.environ.get("HERMES_HOME") == "/sentinel/prior-home"


def test_hermes_home_is_restored_when_resolution_raises(llm_module, fake_hermes_cli, browser_use_classes, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", "/sentinel/prior-home")
    seen = {}

    def boom():
        seen["during"] = os.environ.get("HERMES_HOME")
        raise fake_hermes_cli.auth.AuthError("no credential")

    fake_hermes_cli.runtime_provider.resolve_runtime_provider = boom
    with pytest.raises(llm_module.BrowserUseLLMResolutionError):
        llm_module.resolve_browser_use_llm("pm")
    assert seen["during"] == str(fake_hermes_cli.profiles.get_profile_dir("pm"))
    assert os.environ.get("HERMES_HOME") == "/sentinel/prior-home"


def test_hermes_home_is_removed_again_when_it_was_unset_before(llm_module, fake_hermes_cli, browser_use_classes, monkeypatch):
    monkeypatch.delenv("HERMES_HOME", raising=False)
    _set_runtime(fake_hermes_cli)
    llm_module.resolve_browser_use_llm("pm")
    assert "HERMES_HOME" not in os.environ
