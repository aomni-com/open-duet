import sys
from pathlib import Path
from typing import cast

import pytest

import voice_probe.cli as cli_module
from voice_probe.browser_runtime import BrowserProbePage
from voice_probe.cli import _confirm_provider_absence, _run_cloud_attempt, main
from voice_probe.contract import Candidate
from voice_probe.matrix import PlannedAttempt


def test_cloud_matrix_is_the_only_cloud_capture_command(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(sys, "argv", ["voice-runtime-probe", "cloud-matrix", "--help"])
    with pytest.raises(SystemExit) as current:
        main()
    assert current.value.code == 0
    help_text = capsys.readouterr().out
    assert "--manifest MANIFEST" in help_text
    assert "--output OUTPUT" in help_text
    assert "--report REPORT" in help_text
    assert "--cold-activation-script COLD_ACTIVATION_SCRIPT" in help_text
    assert "--cloudflared CLOUDFLARED" in help_text
    assert "--candidate-id" not in help_text
    assert "--scenario" not in help_text
    assert "--activation-state" not in help_text

    monkeypatch.setattr(sys, "argv", ["voice-runtime-probe", "cloud-sample", "--help"])
    with pytest.raises(SystemExit) as removed:
        main()
    assert removed.value.code == 2


async def test_cloud_matrix_routes_each_manifest_floor_to_its_only_browser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    candidate = Candidate(stt="stt", llm="llm", tts="tts", voice="voice")
    calls: list[tuple[str, object]] = []

    async def chromium(**arguments: object) -> dict[str, object]:
        calls.append(("chromium", arguments["browser_floor"]))
        return {"browser_floor": arguments["browser_floor"]}

    async def mobile(**arguments: object) -> dict[str, object]:
        calls.append(("mobile", arguments["browser"]))
        return {"browser_floor": arguments["browser_floor"]}

    monkeypatch.setattr(cli_module, "run_chromium_cloud_sample", chromium)
    monkeypatch.setattr(cli_module, "run_cloud_sample_with_browser", mobile)
    mobile_browser = cast(BrowserProbePage, object())
    common = {
        "sample_id": "safe-id",
        "cold_activation_script": Path("unused"),
        "chrome": Path("chrome"),
        "browser_bundle": Path("probe.js"),
        "fixture": Path("fixture.ogg"),
        "mobile_browser": mobile_browser,
    }

    desktop = PlannedAttempt(
        attempt_id="desktop",
        candidate_id="candidate-a",
        candidate=candidate,
        scenario="candidate_response",
        activation_state="warm",
        browser_floor="chromium-desktop",
    )
    ios = PlannedAttempt(
        attempt_id="ios",
        candidate_id="candidate-a",
        candidate=candidate,
        scenario="candidate_response",
        activation_state="warm",
        browser_floor="ios-safari",
    )

    assert await _run_cloud_attempt(attempt=desktop, **common) == {
        "browser_floor": "chromium-desktop"
    }
    assert await _run_cloud_attempt(attempt=ios, **common) == {"browser_floor": "ios-safari"}
    assert calls == [("chromium", "chromium-desktop"), ("mobile", mobile_browser)]


def test_provider_absence_confirmation_is_exactly_bound_to_one_attempt() -> None:
    prompts: list[str] = []

    def confirm(prompt: str) -> str:
        prompts.append(prompt)
        return (
            "voice-s03-0123456789abcdef "
            "candidate-a.candidate_response.ios-safari.warm.001"
        )

    assert (
        _confirm_provider_absence(
            "candidate-a.candidate_response.ios-safari.warm.001",
            "voice-s03-0123456789abcdef",
            read=confirm,
        )
        is True
    )
    assert "audio, transcript, trace, or log" in prompts[0]
    assert "provider-visible room voice-s03-0123456789abcdef" in prompts[0]

    assert (
        _confirm_provider_absence(
            "candidate-a.candidate_response.ios-safari.warm.002",
            "voice-s03-0123456789abcdef",
            read=lambda _: "candidate-a.candidate_response.ios-safari.warm.001",
        )
        is False
    )

    def end_of_input(_: str) -> str:
        raise EOFError

    assert (
        _confirm_provider_absence(
            "attempt-without-operator",
            "voice-s03-fedcba9876543210",
            read=end_of_input,
        )
        is False
    )
