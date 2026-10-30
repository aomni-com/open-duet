import math
import os
from collections import Counter
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast

from voice_probe.contract import ActivationState, BrowserFloor, Candidate, ProbeScenario
from voice_probe.measurements import MeasurementError, validate_sample

APPROVED_VOICE_ENVIRONMENT = "LIVEKIT_FISH_STOCK_VOICE_ID_3"


class ManifestError(ValueError):
    pass


@dataclass(frozen=True)
class ManifestCandidate:
    candidate_id: str
    candidate: Candidate


@dataclass(frozen=True)
class ManifestRun:
    scenario: ProbeScenario
    activation_state: ActivationState
    browser_floor: BrowserFloor
    samples: int


@dataclass(frozen=True)
class ProbeManifest:
    candidates: tuple[ManifestCandidate, ...]
    runs: tuple[ManifestRun, ...]
    cold_candidate_id: str


@dataclass(frozen=True)
class PlannedAttempt:
    attempt_id: str
    candidate_id: str
    candidate: Candidate
    scenario: ProbeScenario
    activation_state: ActivationState
    browser_floor: BrowserFloor


def parse_manifest(value: object, *, environment: Mapping[str, str] | None = None) -> ProbeManifest:
    root = _object(value, "manifest")
    _exact_keys(
        root,
        {"voices", "candidates", "runs", "cold_candidate_id"},
        "manifest",
    )
    voices = _parse_voices(root["voices"], os.environ if environment is None else environment)
    candidates = _parse_candidates(root["candidates"], voices)
    runs = _parse_runs(root["runs"])
    cold_candidate_id = _non_empty_string(root["cold_candidate_id"], "cold_candidate_id")
    if cold_candidate_id not in {candidate.candidate_id for candidate in candidates}:
        raise ManifestError("cold_candidate_id must reference a manifest candidate")
    _validate_candidate_coverage(candidates)
    return ProbeManifest(
        candidates=tuple(candidates),
        runs=tuple(runs),
        cold_candidate_id=cold_candidate_id,
    )


def planned_attempts(manifest: ProbeManifest) -> tuple[PlannedAttempt, ...]:
    attempts: list[PlannedAttempt] = []
    ordered_runs = sorted(manifest.runs, key=lambda run: run.activation_state == "cold")
    for run in ordered_runs:
        for manifest_candidate in manifest.candidates:
            if (
                run.activation_state == "cold"
                and manifest_candidate.candidate_id != manifest.cold_candidate_id
            ):
                continue
            for sample_number in range(1, run.samples + 1):
                attempt_id = ".".join(
                    (
                        manifest_candidate.candidate_id,
                        run.scenario,
                        run.browser_floor,
                        run.activation_state,
                        f"{sample_number:03d}",
                    )
                )
                attempts.append(
                    PlannedAttempt(
                        attempt_id=attempt_id,
                        candidate_id=manifest_candidate.candidate_id,
                        candidate=manifest_candidate.candidate,
                        scenario=run.scenario,
                        activation_state=run.activation_state,
                        browser_floor=run.browser_floor,
                    )
                )
    return tuple(attempts)


async def capture_attempt(
    attempt: PlannedAttempt,
    *,
    sample_id: str,
    run: Callable[[], Awaitable[Mapping[str, object]]],
) -> dict[str, object]:
    try:
        row = dict(await run())
        if row.get("sample_id") != sample_id:
            raise ValueError("sample result does not match its planned sample")
        if row.get("candidate_id") != attempt.candidate_id:
            raise ValueError("sample result does not match its planned candidate")
        if row.get("scenario") != attempt.scenario:
            raise ValueError("sample result does not match its planned scenario")
        if row.get("activation_state") != attempt.activation_state:
            raise ValueError("sample result does not match its planned activation")
        if row.get("browser_floor") != attempt.browser_floor:
            raise ValueError("sample result does not match its planned browser floor")
        row["attempt_id"] = attempt.attempt_id
        validate_sample(row)
        return row
    except Exception as error:
        return {
            "sample_id": sample_id,
            "attempt_id": attempt.attempt_id,
            "candidate_id": attempt.candidate_id,
            "activation_state": attempt.activation_state,
            "browser_floor": attempt.browser_floor,
            "scenario": attempt.scenario,
            "privacy": {"record_false": True, "cloud_absence_verified": False},
            "status": "attempt_failed",
            "reason_code": _reason_code(error),
        }


def closure_report(manifest: ProbeManifest, rows: Sequence[Mapping[str, Any]]) -> dict[str, object]:
    expected_attempts = {attempt.attempt_id: attempt for attempt in planned_attempts(manifest)}
    expected = set(expected_attempts)
    observed_ids: list[str] = []
    observed_sample_ids: list[str] = []
    clean_rows: list[Mapping[str, Any]] = []
    invalid_rows = 0
    for row in rows:
        try:
            validate_sample(row)
            attempt_id = row.get("attempt_id")
            if not isinstance(attempt_id, str) or not attempt_id:
                raise MeasurementError("attempt_id must be a non-empty string")
            sample_id = row.get("sample_id")
            if not isinstance(sample_id, str) or not sample_id:
                raise MeasurementError("sample_id must be a non-empty string")
            planned = expected_attempts.get(attempt_id)
            if planned is not None and (
                row.get("candidate_id") != planned.candidate_id
                or row.get("scenario") != planned.scenario
                or row.get("activation_state") != planned.activation_state
                or row.get("browser_floor") != planned.browser_floor
            ):
                raise MeasurementError("evidence row does not match its planned attempt")
        except MeasurementError:
            invalid_rows += 1
            continue
        observed_ids.append(attempt_id)
        observed_sample_ids.append(sample_id)
        clean_rows.append(row)

    counts = Counter(observed_ids)
    observed = set(observed_ids)
    sample_counts = Counter(observed_sample_ids)
    matrix_complete = (
        invalid_rows == 0
        and not (expected - observed)
        and not (observed - expected)
        and all(count == 1 for count in counts.values())
        and all(count == 1 for count in sample_counts.values())
    )
    all_succeeded = matrix_complete and all(
        _row_succeeded(row, expected_attempts[str(row["attempt_id"])]) for row in clean_rows
    )
    privacy_verified = matrix_complete and all(
        row.get("privacy") == {"record_false": True, "cloud_absence_verified": True}
        for row in clean_rows
    )
    activation_ids = [row.get("activation_instance_sha256") for row in clean_rows]
    activation_ids_valid = all(_is_sha256(value) for value in activation_ids)
    cold_activation_ids = (
        [
            cast(str, row["activation_instance_sha256"])
            for row in clean_rows
            if row.get("activation_state") == "cold"
        ]
        if activation_ids_valid
        else []
    )
    warm_activation_ids = (
        {
            cast(str, row["activation_instance_sha256"])
            for row in clean_rows
            if row.get("activation_state") == "warm"
        }
        if activation_ids_valid
        else set()
    )
    cold_activations_verified = (
        matrix_complete
        and activation_ids_valid
        and len(cold_activation_ids) > 0
        and len(set(cold_activation_ids)) == len(cold_activation_ids)
        and not (set(cold_activation_ids) & warm_activation_ids)
    )
    latency_budgets_met = matrix_complete and _latency_budgets_met(clean_rows)
    gates = {
        "attempt_matrix_complete": matrix_complete,
        "all_attempts_succeeded": all_succeeded,
        "provider_absence_verified": privacy_verified,
        "cold_activations_verified": cold_activations_verified,
        "latency_budgets_met": latency_budgets_met,
    }
    return {
        "verdict": "go" if all(gates.values()) else "no_go",
        "expected_attempts": len(expected),
        "observed_rows": len(rows),
        "invalid_rows": invalid_rows,
        "missing_attempts": len(expected - observed),
        "unexpected_attempts": len(observed - expected),
        "duplicate_attempts": sum(count - 1 for count in counts.values() if count > 1),
        "duplicate_samples": sum(count - 1 for count in sample_counts.values() if count > 1),
        "gates": gates,
    }


def _parse_voices(value: object, environment: Mapping[str, str]) -> dict[str, str]:
    entries = _array(value, "voices")
    voices: dict[str, str] = {}
    for index, raw_entry in enumerate(entries):
        entry = _object(raw_entry, f"voices[{index}]")
        if set(entry) == {"name", "voice_id"}:
            voice_id = _non_empty_string(entry["voice_id"], "voice_id")
        elif set(entry) == {"name", "environment"}:
            environment_name = _non_empty_string(entry["environment"], "environment")
            if environment_name != APPROVED_VOICE_ENVIRONMENT:
                raise ManifestError("voice must use the approved stock-voice environment name")
            voice_id = environment.get(environment_name, "")
            if not voice_id:
                raise ManifestError(f"missing manifest environment name: {environment_name}")
        else:
            raise ManifestError("voice must contain name and exactly one identifier source")
        name = _non_empty_string(entry["name"], "voice name")
        if name in voices:
            raise ManifestError("voice names must be unique")
        voices[name] = voice_id
    if len(voices) < 3 or len(set(voices.values())) < 3:
        raise ManifestError("manifest requires at least three distinct stock voices")
    return voices


def _parse_candidates(value: object, voices: Mapping[str, str]) -> list[ManifestCandidate]:
    entries = _array(value, "candidates")
    candidates: list[ManifestCandidate] = []
    for index, raw_entry in enumerate(entries):
        entry = _object(raw_entry, f"candidates[{index}]")
        _exact_keys(entry, {"candidate_id", "stt", "llm", "tts", "voice"}, "candidate")
        voice_name = _non_empty_string(entry["voice"], "candidate voice")
        if voice_name not in voices:
            raise ManifestError("candidate references an unknown voice")
        candidates.append(
            ManifestCandidate(
                candidate_id=_non_empty_string(entry["candidate_id"], "candidate_id"),
                candidate=Candidate(
                    stt=_non_empty_string(entry["stt"], "stt"),
                    llm=_non_empty_string(entry["llm"], "llm"),
                    tts=_non_empty_string(entry["tts"], "tts"),
                    voice=voices[voice_name],
                ),
            )
        )
    if len(candidates) < 3:
        raise ManifestError("manifest requires at least three candidates")
    if len({candidate.candidate_id for candidate in candidates}) != len(candidates):
        raise ManifestError("candidate_id values must be unique")
    return candidates


def _parse_runs(value: object) -> list[ManifestRun]:
    entries = _array(value, "runs")
    runs: list[ManifestRun] = []
    cells: set[tuple[ProbeScenario, ActivationState, BrowserFloor]] = set()
    for index, raw_entry in enumerate(entries):
        entry = _object(raw_entry, f"runs[{index}]")
        _exact_keys(
            entry,
            {"scenario", "activation_state", "browser_floor", "samples"},
            "run",
        )
        raw_scenario = entry["scenario"]
        raw_activation = entry["activation_state"]
        raw_floor = entry["browser_floor"]
        if raw_scenario == "candidate_response":
            scenario: ProbeScenario = "candidate_response"
        elif raw_scenario == "fixed_interruption":
            scenario = "fixed_interruption"
        else:
            raise ManifestError("run scenario is invalid")
        if raw_activation == "warm":
            activation: ActivationState = "warm"
        elif raw_activation == "cold":
            activation = "cold"
        else:
            raise ManifestError("run activation_state is invalid")
        if raw_floor == "chromium-desktop":
            browser_floor: BrowserFloor = "chromium-desktop"
        elif raw_floor == "ios-safari":
            browser_floor = "ios-safari"
        else:
            raise ManifestError("run browser_floor is invalid")
        samples = entry["samples"]
        if not isinstance(samples, int) or isinstance(samples, bool) or samples < 1:
            raise ManifestError("run samples must be a positive integer")
        if activation == "warm" and samples < 20:
            raise ManifestError("warm run requires at least 20 samples")
        if activation == "cold" and samples < 5:
            raise ManifestError("cold run requires at least 5 samples")
        cell = (scenario, activation, browser_floor)
        if cell in cells:
            raise ManifestError("run cells must be unique")
        cells.add(cell)
        runs.append(
            ManifestRun(
                scenario=scenario,
                activation_state=activation,
                browser_floor=browser_floor,
                samples=samples,
            )
        )
    required: set[tuple[ProbeScenario, ActivationState, BrowserFloor]] = {
        ("candidate_response", "warm", "chromium-desktop"),
        ("candidate_response", "cold", "chromium-desktop"),
        ("fixed_interruption", "warm", "chromium-desktop"),
        ("candidate_response", "warm", "ios-safari"),
        ("fixed_interruption", "warm", "ios-safari"),
    }
    if cells != required:
        raise ManifestError(
            "manifest requires warm runs for both browser floors and one desktop "
            "cold candidate-response run"
        )
    return runs


def _validate_candidate_coverage(candidates: Sequence[ManifestCandidate]) -> None:
    models = [candidate.candidate for candidate in candidates]
    if len({candidate.stt for candidate in models}) < 2:
        raise ManifestError("manifest requires at least two STT candidates")
    if len({candidate.llm for candidate in models}) < 2:
        raise ManifestError("manifest requires at least two Voice LLM candidates")
    if not {"fishaudio/s2.1-pro-free", "fishaudio/s2.1-pro"}.issubset(
        {candidate.tts for candidate in models}
    ):
        raise ManifestError("manifest requires free and production Fish candidates")
    if len({candidate.voice for candidate in models}) < 3:
        raise ManifestError("manifest candidates must exercise at least three voices")


def _row_succeeded(row: Mapping[str, Any], planned: PlannedAttempt) -> bool:
    scenario = row.get("scenario")
    status = row.get("status")
    if scenario == "candidate_response":
        return (
            status == "candidate_response_observed_only"
            and row.get("model_ids")
            == {
                "stt": planned.candidate.stt,
                "llm": planned.candidate.llm,
                "tts": planned.candidate.tts,
            }
            and row.get("voice_id") == planned.candidate.voice
        )
    if scenario != "fixed_interruption":
        return False
    codec = row.get("codec")
    if not isinstance(codec, Mapping):
        return False
    expected_codec_fields = {
        "container_mime",
        "capture_sample_rate_hz",
        "capture_duration_ms",
        "artifact_sample_rate_hz",
        "artifact_duration_ms",
        "heard_prefix_bytes",
        "heard_prefix_sha256",
        "full_response_bytes",
        "marked_prefix_similarity",
        "tail_absent",
        "complete_word_count",
        "silence_proof_ms",
    }
    if set(codec) != expected_codec_fields:
        return False
    capture_duration = codec.get("capture_duration_ms")
    artifact_duration = codec.get("artifact_duration_ms")
    similarity = codec.get("marked_prefix_similarity")
    prefix_bytes = codec.get("heard_prefix_bytes")
    full_bytes = codec.get("full_response_bytes")
    numbers = (capture_duration, artifact_duration, similarity, prefix_bytes, full_bytes)
    if any(
        not isinstance(value, int | float)
        or isinstance(value, bool)
        or not math.isfinite(float(value))
        or value <= 0
        for value in numbers
    ):
        return False
    checked_capture_duration = float(cast(int | float, capture_duration))
    checked_artifact_duration = float(cast(int | float, artifact_duration))
    checked_similarity = float(cast(int | float, similarity))
    checked_prefix_bytes = float(cast(int | float, prefix_bytes))
    checked_full_bytes = float(cast(int | float, full_bytes))
    return (
        status == "fixed_interruption_mute_observed_only"
        and row.get("model_ids") == {"stt": planned.candidate.stt}
        and "voice_id" not in row
        and codec.get("container_mime") == "audio/ogg;codecs=opus"
        and codec.get("capture_sample_rate_hz") == 48_000
        and codec.get("artifact_sample_rate_hz") == 48_000
        and _is_sha256(codec.get("heard_prefix_sha256"))
        and codec.get("tail_absent") is True
        and 0.98 <= checked_similarity <= 1
        and isinstance(prefix_bytes, int)
        and isinstance(full_bytes, int)
        and checked_prefix_bytes < checked_full_bytes
        and isinstance(codec.get("complete_word_count"), int)
        and not isinstance(codec.get("complete_word_count"), bool)
        and cast(int, codec.get("complete_word_count")) > 0
        and codec.get("silence_proof_ms") == 250
        and abs(checked_capture_duration - checked_artifact_duration) <= 0.02
    )


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _latency_budgets_met(rows: Sequence[Mapping[str, Any]]) -> bool:
    required_by_scenario = {
        "candidate_response": {
            "end_of_speech_to_acknowledgement": 800,
            "main_result_to_first_audio": 1_200,
            "runtime_event_to_caption_render": 150,
        },
        "fixed_interruption": {"barge_in_mute": 200},
    }
    values: dict[tuple[str, str, str, str, str], list[float]] = {}
    for row in rows:
        scenario = row.get("scenario")
        required = required_by_scenario.get(str(scenario))
        metrics = row.get("metrics_ms")
        if required is None or not isinstance(metrics, Mapping):
            return False
        candidate_id = row.get("candidate_id")
        activation_state = row.get("activation_state")
        browser_floor = row.get("browser_floor")
        if (
            not isinstance(candidate_id, str)
            or not isinstance(activation_state, str)
            or not isinstance(browser_floor, str)
        ):
            return False
        for metric_name in required:
            value = metrics.get(metric_name)
            if (
                not isinstance(value, int | float)
                or isinstance(value, bool)
                or value < 0
                or not math.isfinite(float(value))
            ):
                return False
            key = (
                candidate_id,
                str(scenario),
                activation_state,
                browser_floor,
                metric_name,
            )
            values.setdefault(key, []).append(float(value))
    for (_, scenario, _, _, metric_name), raw_samples in values.items():
        samples = sorted(raw_samples)
        index = max(0, (95 * len(samples) + 99) // 100 - 1)
        if samples[index] > required_by_scenario[scenario][metric_name]:
            return False
    return True


def _reason_code(
    error: Exception,
) -> Literal["probe_timeout", "evidence_invalid", "runtime_unavailable", "probe_failed"]:
    if isinstance(error, TimeoutError):
        return "probe_timeout"
    if isinstance(error, (ValueError, MeasurementError)):
        return "evidence_invalid"
    if isinstance(error, OSError):
        return "runtime_unavailable"
    return "probe_failed"


def _object(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise ManifestError(f"{label} must be an object")
    return cast(Mapping[str, object], value)


def _array(value: object, label: str) -> Sequence[object]:
    if not isinstance(value, list):
        raise ManifestError(f"{label} must be an array")
    return value


def _exact_keys(value: Mapping[str, object], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise ManifestError(f"{label} fields do not match the current contract")


def _non_empty_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ManifestError(f"{label} must be a non-empty string")
    return value
