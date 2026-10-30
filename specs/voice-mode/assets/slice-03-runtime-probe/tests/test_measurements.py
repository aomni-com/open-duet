import math

import pytest

from voice_probe.measurements import MeasurementError, summarize


def test_summary_uses_raw_samples_and_rejects_content_bearing_fields() -> None:
    samples = [
        {
            "sample_id": f"warm-{index:02d}",
            "attempt_id": f"candidate-a.fixed_interruption.warm.{index:03d}",
            "candidate_id": "candidate-a",
            "activation_state": "warm",
            "browser_floor": "chromium-desktop",
            "scenario": "fixed_interruption",
            "metrics_ms": {"barge_in_mute": value},
            "status": "fixed_interruption_mute_observed_only",
        }
        for index, value in enumerate(range(101, 121), start=1)
    ]
    samples.append(
        {
            "sample_id": "candidate-response-01",
            "attempt_id": "candidate-a.candidate_response.warm.001",
            "candidate_id": "candidate-a",
            "activation_state": "warm",
            "browser_floor": "ios-safari",
            "scenario": "candidate_response",
            "metrics_ms": {"input_end_to_first_audio": 700},
            "status": "candidate_response_observed_only",
        }
    )

    assert summarize(samples) == {
        "candidate-a": {
            "candidate_response": {
                "ios-safari": {
                    "attempt_count": 1,
                    "failed_attempt_count": 0,
                    "successful_sample_count": 1,
                    "metrics_ms": {
                        "input_end_to_first_audio": {
                            "sample_count": 1,
                            "p50": 700,
                            "p95": 700,
                        }
                    },
                }
            },
            "fixed_interruption": {
                "chromium-desktop": {
                    "attempt_count": 20,
                    "failed_attempt_count": 0,
                    "successful_sample_count": 20,
                    "metrics_ms": {
                        "barge_in_mute": {
                            "sample_count": 20,
                            "p50": 110,
                            "p95": 119,
                        }
                    },
                }
            },
        }
    }

    with pytest.raises(MeasurementError, match="forbidden key: transcript"):
        summarize([samples[0] | {"transcript": "must never enter evidence"}])


def test_summary_separates_failed_attempts_and_rejects_non_finite_metrics() -> None:
    success = {
        "sample_id": "safe-success",
        "attempt_id": "candidate-a.candidate_response.warm.001",
        "candidate_id": "candidate-a",
        "activation_state": "warm",
        "browser_floor": "ios-safari",
        "scenario": "candidate_response",
        "metrics_ms": {"main_result_to_first_audio": 700},
        "status": "candidate_response_observed_only",
    }
    failure = {
        "sample_id": "safe-failure",
        "attempt_id": "candidate-a.candidate_response.warm.002",
        "candidate_id": "candidate-a",
        "activation_state": "warm",
        "browser_floor": "ios-safari",
        "scenario": "candidate_response",
        "status": "attempt_failed",
        "reason_code": "probe_timeout",
    }

    assert summarize([success, failure]) == {
        "candidate-a": {
            "candidate_response": {
                "ios-safari": {
                    "attempt_count": 2,
                    "failed_attempt_count": 1,
                    "successful_sample_count": 1,
                    "metrics_ms": {
                        "main_result_to_first_audio": {
                            "sample_count": 1,
                            "p50": 700,
                            "p95": 700,
                        }
                    },
                }
            }
        }
    }

    with pytest.raises(MeasurementError, match="finite"):
        summarize([success | {"metrics_ms": {"main_result_to_first_audio": math.nan}}])

    with pytest.raises(MeasurementError, match="metrics_ms must be an object"):
        summarize([success | {"metrics_ms": None}])
