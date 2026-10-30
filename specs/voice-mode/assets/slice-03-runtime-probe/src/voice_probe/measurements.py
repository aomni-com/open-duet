import math
from collections import defaultdict
from collections.abc import Mapping, Sequence
from typing import Any, cast

from voice_probe.contract import BrowserFloor, ProbeScenario


class MeasurementError(ValueError):
    pass


FORBIDDEN_KEYS = {
    "authorization",
    "audio",
    "bearer",
    "prompt",
    "secret",
    "text",
    "ticket",
    "token",
    "transcript",
}

ALLOWED_TOP_LEVEL_KEYS = {
    "sample_id",
    "attempt_id",
    "candidate_id",
    "activation_state",
    "browser_floor",
    "activation_instance_sha256",
    "scenario",
    "metrics_ms",
    "model_ids",
    "voice_id",
    "status",
    "reason_code",
    "privacy",
    "codec",
}


def summarize(
    samples: Sequence[Mapping[str, Any]],
) -> dict[str, dict[ProbeScenario, dict[BrowserFloor, dict[str, Any]]]]:
    by_candidate: dict[str, dict[ProbeScenario, dict[BrowserFloor, list[Mapping[str, Any]]]]] = (
        defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    )
    for sample in samples:
        validate_sample(sample)
        candidate_id = sample.get("candidate_id")
        if not isinstance(candidate_id, str) or not candidate_id:
            raise MeasurementError("candidate_id must be a non-empty string")
        scenario = sample.get("scenario")
        if scenario not in ("candidate_response", "fixed_interruption"):
            raise MeasurementError("scenario must be a current probe scenario")
        browser_floor = sample.get("browser_floor")
        if browser_floor not in ("chromium-desktop", "ios-safari"):
            raise MeasurementError("browser_floor must be a current probe floor")
        by_candidate[candidate_id][scenario][browser_floor].append(sample)

    output: dict[str, dict[ProbeScenario, dict[BrowserFloor, dict[str, Any]]]] = {}
    for candidate_id, scenario_samples in sorted(by_candidate.items()):
        output[candidate_id] = {}
        for scenario, floor_samples in sorted(scenario_samples.items()):
            output[candidate_id][scenario] = {}
            for browser_floor, candidate_samples in sorted(floor_samples.items()):
                metric_values: dict[str, list[float]] = defaultdict(list)
                failed_samples = [
                    sample
                    for sample in candidate_samples
                    if sample.get("status") == "attempt_failed"
                ]
                successful_samples = [
                    sample
                    for sample in candidate_samples
                    if sample.get("status") != "attempt_failed"
                ]
                for sample in successful_samples:
                    metrics = cast(Mapping[str, int | float], sample.get("metrics_ms", {}))
                    for name, value in metrics.items():
                        metric_values[name].append(float(value))
                output[candidate_id][scenario][browser_floor] = {
                    "attempt_count": len(candidate_samples),
                    "failed_attempt_count": len(failed_samples),
                    "successful_sample_count": len(successful_samples),
                    "metrics_ms": {
                        name: {
                            "sample_count": len(values),
                            "p50": _percentile(values, 0.50),
                            "p95": _percentile(values, 0.95),
                        }
                        for name, values in sorted(metric_values.items())
                    },
                }
    return output


def validate_sample(sample: Mapping[str, Any]) -> None:
    _validate_no_content(sample)
    unknown = set(sample) - ALLOWED_TOP_LEVEL_KEYS
    if unknown:
        raise MeasurementError(f"unknown evidence key: {sorted(unknown)[0]}")
    if "metrics_ms" not in sample:
        return
    metrics = sample["metrics_ms"]
    if not isinstance(metrics, Mapping):
        raise MeasurementError("metrics_ms must be an object")
    for name, value in metrics.items():
        if (
            not isinstance(name, str)
            or not isinstance(value, int | float)
            or isinstance(value, bool)
            or value < 0
            or not math.isfinite(float(value))
        ):
            raise MeasurementError("metrics_ms values must be finite non-negative numbers")


def _validate_no_content(value: object) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str):
                raise MeasurementError("evidence keys must be strings")
            if key.lower() in FORBIDDEN_KEYS:
                raise MeasurementError(f"forbidden key: {key}")
            _validate_no_content(child)
    elif isinstance(value, list | tuple):
        for child in value:
            _validate_no_content(child)


def _percentile(values: Sequence[float], percentile: float) -> int | float:
    ordered = sorted(values)
    value = ordered[max(0, math.ceil(percentile * len(ordered)) - 1)]
    return int(value) if value.is_integer() else value
