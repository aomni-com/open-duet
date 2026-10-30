import asyncio
import hashlib
import json
import math
from collections.abc import Mapping
from pathlib import Path

import pytest

from voice_probe.matrix import (
    ManifestError,
    capture_attempt,
    closure_report,
    parse_manifest,
    planned_attempts,
)


def test_manifest_is_the_single_owner_of_the_required_probe_matrix() -> None:
    manifest = parse_manifest(_manifest())

    attempts = planned_attempts(manifest)

    assert len(attempts) == 245
    assert attempts[0].attempt_id == "candidate-a.candidate_response.chromium-desktop.warm.001"
    assert attempts[-1].attempt_id == "candidate-a.candidate_response.chromium-desktop.cold.005"
    first_cold = next(
        index for index, attempt in enumerate(attempts) if attempt.activation_state == "cold"
    )
    assert all(attempt.activation_state == "warm" for attempt in attempts[:first_cold])
    assert all(attempt.activation_state == "cold" for attempt in attempts[first_cold:])
    assert {attempt.candidate_id for attempt in attempts if attempt.activation_state == "cold"} == {
        "candidate-a"
    }
    assert {attempt.candidate.stt for attempt in attempts} == {
        "assemblyai/universal-streaming",
        "deepgram/flux-general-en",
    }
    assert {attempt.candidate.voice for attempt in attempts} == {
        "voice-a",
        "voice-b",
        "voice-c",
    }
    assert {attempt.browser_floor for attempt in attempts} == {
        "chromium-desktop",
        "ios-safari",
    }


def test_checked_manifest_resolves_only_the_missing_third_stock_voice() -> None:
    value = json.loads((Path(__file__).parents[1] / "evidence" / "probe-manifest.json").read_text())

    manifest = parse_manifest(
        value,
        environment={"LIVEKIT_FISH_STOCK_VOICE_ID_3": "third-real-stock-id"},
    )

    assert manifest.candidates[-1].candidate.voice == "third-real-stock-id"
    assert any(
        attempt.candidate.voice == "third-real-stock-id"
        for attempt in planned_attempts(manifest)
    )


def test_manifest_rejects_environment_sources_other_than_the_approved_voice_name() -> None:
    value = _manifest()
    value["voices"][-1] = {
        "name": "voice-c",
        "environment": "LIVEKIT_API_SECRET",
    }

    with pytest.raises(ManifestError, match="approved stock-voice environment name"):
        parse_manifest(value, environment={"LIVEKIT_API_SECRET": "must-not-become-evidence"})


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda value: value["candidates"].pop(), "at least three candidates"),
        (
            lambda value: value["runs"].pop(),
            "warm runs for both browser floors and one desktop cold candidate-response run",
        ),
        (
            lambda value: value["runs"][0].update(samples=19),
            "warm run requires at least 20 samples",
        ),
    ],
)
def test_manifest_rejects_an_incomplete_matrix(mutation: object, message: str) -> None:
    value = _manifest()
    assert callable(mutation)
    mutation(value)

    with pytest.raises(ManifestError, match=message):
        parse_manifest(value)


async def test_attempt_failure_becomes_one_content_free_row() -> None:
    attempt = planned_attempts(parse_manifest(_manifest()))[0]

    async def fail() -> Mapping[str, object]:
        raise TimeoutError("secret provider response and transcript")

    row = await capture_attempt(
        attempt,
        sample_id="sample-safe-id",
        run=fail,
    )

    assert row == {
        "activation_state": "warm",
        "attempt_id": "candidate-a.candidate_response.chromium-desktop.warm.001",
        "browser_floor": "chromium-desktop",
        "candidate_id": "candidate-a",
        "privacy": {"cloud_absence_verified": False, "record_false": True},
        "reason_code": "probe_timeout",
        "sample_id": "sample-safe-id",
        "scenario": "candidate_response",
        "status": "attempt_failed",
    }


def test_closure_report_refuses_missing_failed_or_privacy_pending_attempts() -> None:
    manifest = parse_manifest(_manifest())
    attempts = planned_attempts(manifest)
    rows = [_passing_row(attempt) for attempt in attempts]

    assert closure_report(manifest, rows)["verdict"] == "go"

    missing = closure_report(manifest, rows[:-1])
    assert missing["verdict"] == "no_go"
    assert missing["gates"]["attempt_matrix_complete"] is False

    failed = rows.copy()
    failed[0] = asyncio.run(
        capture_attempt(
            attempts[0],
            sample_id="failed-safe-id",
            run=_timeout,
        )
    )
    failed_report = closure_report(manifest, failed)
    assert failed_report["verdict"] == "no_go"
    assert failed_report["gates"]["all_attempts_succeeded"] is False

    privacy_pending = rows.copy()
    privacy_pending[0] = rows[0] | {
        "privacy": {"record_false": True, "cloud_absence_verified": False}
    }
    privacy_report = closure_report(manifest, privacy_pending)
    assert privacy_report["verdict"] == "no_go"
    assert privacy_report["gates"]["provider_absence_verified"] is False

    repeated_cold_activation = [row.copy() for row in rows]
    for row in repeated_cold_activation:
        if row["activation_state"] == "cold":
            row["activation_instance_sha256"] = "a" * 64
    activation_report = closure_report(manifest, repeated_cold_activation)
    assert activation_report["verdict"] == "no_go"
    assert activation_report["gates"]["cold_activations_verified"] is False

    warm_collision = [row.copy() for row in rows]
    warm_fingerprint = warm_collision[0]["activation_instance_sha256"]
    for row in warm_collision:
        if row["activation_state"] == "cold":
            row["activation_instance_sha256"] = warm_fingerprint
            break
    collision_report = closure_report(manifest, warm_collision)
    assert collision_report["verdict"] == "no_go"
    assert collision_report["gates"]["cold_activations_verified"] is False

    malformed_activation = [row.copy() for row in rows]
    malformed_activation[0]["activation_instance_sha256"] = {}
    malformed_report = closure_report(manifest, malformed_activation)
    assert malformed_report["verdict"] == "no_go"
    assert malformed_report["gates"]["cold_activations_verified"] is False

    rebound = rows.copy()
    rebound[0] = rows[0] | {"candidate_id": "candidate-b"}
    rebound_report = closure_report(manifest, rebound)
    assert rebound_report["verdict"] == "no_go"
    assert rebound_report["gates"]["attempt_matrix_complete"] is False

    rebound_floor = rows.copy()
    rebound_floor[0] = rows[0] | {"browser_floor": "ios-safari"}
    floor_report = closure_report(manifest, rebound_floor)
    assert floor_report["verdict"] == "no_go"
    assert floor_report["gates"]["attempt_matrix_complete"] is False

    duplicated_sample = [row.copy() for row in rows]
    duplicated_sample[0] = rows[1] | {"attempt_id": rows[0]["attempt_id"]}
    duplicated_report = closure_report(manifest, duplicated_sample)
    assert duplicated_report["verdict"] == "no_go"
    assert duplicated_report["gates"]["attempt_matrix_complete"] is False

    missing_proof = [row.copy() for row in rows]
    missing_proof[0] = {key: value for key, value in missing_proof[0].items() if key != "model_ids"}
    proof_report = closure_report(manifest, missing_proof)
    assert proof_report["verdict"] == "no_go"
    assert proof_report["gates"]["all_attempts_succeeded"] is False

    missing_codec = [row.copy() for row in rows]
    fixed_index = next(
        index for index, row in enumerate(missing_codec) if row["scenario"] == "fixed_interruption"
    )
    missing_codec[fixed_index] = {
        key: value for key, value in missing_codec[fixed_index].items() if key != "codec"
    }
    codec_report = closure_report(manifest, missing_codec)
    assert codec_report["verdict"] == "no_go"
    assert codec_report["gates"]["all_attempts_succeeded"] is False

    impossible_codec = [row.copy() for row in rows]
    impossible_codec[fixed_index] = dict(impossible_codec[fixed_index])
    impossible_codec[fixed_index]["codec"] = dict(impossible_codec[fixed_index]["codec"]) | {
        "capture_duration_ms": -1,
        "artifact_duration_ms": -1,
        "heard_prefix_bytes": -2,
        "full_response_bytes": -1,
    }
    impossible_report = closure_report(manifest, impossible_codec)
    assert impossible_report["verdict"] == "no_go"
    assert impossible_report["gates"]["all_attempts_succeeded"] is False

    incomplete_codec = [row.copy() for row in rows]
    incomplete_codec[fixed_index] = dict(incomplete_codec[fixed_index])
    incomplete_codec[fixed_index]["codec"] = {
        key: value
        for key, value in incomplete_codec[fixed_index]["codec"].items()
        if key != "heard_prefix_sha256"
    }
    incomplete_report = closure_report(manifest, incomplete_codec)
    assert incomplete_report["verdict"] == "no_go"
    assert incomplete_report["gates"]["all_attempts_succeeded"] is False

    slow_candidate = [row.copy() for row in rows]
    changed = 0
    for row in slow_candidate:
        if (
            row["candidate_id"] == "candidate-b"
            and row["scenario"] == "candidate_response"
            and row["activation_state"] == "warm"
            and changed < 2
        ):
            row["metrics_ms"] = dict(row["metrics_ms"])
            row["metrics_ms"]["main_result_to_first_audio"] = 1_300
            changed += 1
    latency_report = closure_report(manifest, slow_candidate)
    assert latency_report["verdict"] == "no_go"
    assert latency_report["gates"]["latency_budgets_met"] is False

    not_finite = [row.copy() for row in rows]
    not_finite[0]["metrics_ms"] = dict(not_finite[0]["metrics_ms"])
    not_finite[0]["metrics_ms"]["main_result_to_first_audio"] = math.nan
    finite_report = closure_report(manifest, not_finite)
    assert finite_report["verdict"] == "no_go"
    assert finite_report["gates"]["latency_budgets_met"] is False


async def _timeout() -> Mapping[str, object]:
    raise TimeoutError


def _passing_row(attempt: object) -> dict[str, object]:
    candidate_attempt = attempt
    scenario = candidate_attempt.scenario
    metrics = {
        "dispatch_api": 20,
        "dispatch_to_metadata_proof": 100,
        "clock_uncertainty": 5,
    }
    status = "candidate_response_observed_only"
    if scenario == "candidate_response":
        metrics |= {
            "end_of_speech_to_acknowledgement": 500,
            "main_result_to_first_audio": 800,
            "runtime_event_to_caption_render": 100,
        }
        model_ids = {
            "stt": candidate_attempt.candidate.stt,
            "llm": candidate_attempt.candidate.llm,
            "tts": candidate_attempt.candidate.tts,
        }
    else:
        metrics["barge_in_mute"] = 150
        status = "fixed_interruption_mute_observed_only"
        model_ids = {"stt": candidate_attempt.candidate.stt}
    row: dict[str, object] = {
        "sample_id": f"sample-{candidate_attempt.attempt_id}",
        "attempt_id": candidate_attempt.attempt_id,
        "candidate_id": candidate_attempt.candidate_id,
        "activation_state": candidate_attempt.activation_state,
        "browser_floor": candidate_attempt.browser_floor,
        "activation_instance_sha256": hashlib.sha256(
            candidate_attempt.attempt_id.encode()
        ).hexdigest(),
        "scenario": scenario,
        "metrics_ms": metrics,
        "model_ids": model_ids,
        "privacy": {"record_false": True, "cloud_absence_verified": True},
        "status": status,
    }
    if scenario == "candidate_response":
        row["voice_id"] = candidate_attempt.candidate.voice
    else:
        row["codec"] = {
            "container_mime": "audio/ogg;codecs=opus",
            "capture_sample_rate_hz": 48_000,
            "capture_duration_ms": 1_350,
            "artifact_sample_rate_hz": 48_000,
            "artifact_duration_ms": 1_350,
            "heard_prefix_bytes": 5_000,
            "heard_prefix_sha256": "a" * 64,
            "full_response_bytes": 15_000,
            "marked_prefix_similarity": 0.99,
            "tail_absent": True,
            "complete_word_count": 2,
            "silence_proof_ms": 250,
        }
    return row


def _manifest() -> dict[str, object]:
    return {
        "cold_candidate_id": "candidate-a",
        "voices": [
            {"name": "voice-a", "voice_id": "voice-a"},
            {"name": "voice-b", "voice_id": "voice-b"},
            {"name": "voice-c", "voice_id": "voice-c"},
        ],
        "candidates": [
            {
                "candidate_id": "candidate-a",
                "stt": "deepgram/flux-general-en",
                "llm": "google/gemma-4-31b-it",
                "tts": "fishaudio/s2.1-pro-free",
                "voice": "voice-a",
            },
            {
                "candidate_id": "candidate-b",
                "stt": "assemblyai/universal-streaming",
                "llm": "google/gemini-3.1-flash-lite",
                "tts": "fishaudio/s2.1-pro",
                "voice": "voice-b",
            },
            {
                "candidate_id": "candidate-c",
                "stt": "deepgram/flux-general-en",
                "llm": "google/gemini-3.1-flash-lite",
                "tts": "fishaudio/s2.1-pro-free",
                "voice": "voice-c",
            },
        ],
        "runs": [
            {
                "scenario": "candidate_response",
                "activation_state": "warm",
                "browser_floor": "chromium-desktop",
                "samples": 20,
            },
            {
                "scenario": "candidate_response",
                "activation_state": "cold",
                "browser_floor": "chromium-desktop",
                "samples": 5,
            },
            {
                "scenario": "fixed_interruption",
                "activation_state": "warm",
                "browser_floor": "chromium-desktop",
                "samples": 20,
            },
            {
                "scenario": "candidate_response",
                "activation_state": "warm",
                "browser_floor": "ios-safari",
                "samples": 20,
            },
            {
                "scenario": "fixed_interruption",
                "activation_state": "warm",
                "browser_floor": "ios-safari",
                "samples": 20,
            },
        ],
    }
