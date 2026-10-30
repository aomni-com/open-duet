import base64

import pytest

from voice_probe.browser_runtime import BrowserProbePage
from voice_probe.telemetry import encode_telemetry


class ProbePage:
    def __init__(self, result: object) -> None:
        self.result = result
        self.calls: list[tuple[str, object | None]] = []

    async def evaluate(self, expression: str, argument: object | None = None) -> object:
        self.calls.append((expression, argument))
        return self.result


async def test_worker_proof_requires_the_process_activation_fingerprint() -> None:
    page = ProbePage(
        {
            "workerIdentity": "worker-proved",
            "activationInstanceSha256": "c" * 64,
        }
    )

    proof = await BrowserProbePage(page).wait_for_worker("a" * 64)

    assert proof.identity == "worker-proved"
    assert proof.activation_instance_sha256 == "c" * 64


async def test_candidate_response_requires_audible_ack_main_result_and_painted_caption() -> None:
    event_names = ["ready", "stt_final", "main_result", "runtime_event"]
    page = ProbePage(
        {
            "acknowledgementFirstSignalPerformanceTimeMs": 1_600,
            "mainResponseFirstSignalPerformanceTimeMs": 2_150,
            "audioContextState": "running",
            "outputTimestampSupported": True,
            "captionRenderedAtMs": 1_975,
            "telemetry": [
                {
                    "payload": encode_telemetry(
                        event,
                        sequence=sequence,
                        captured_at_ns=(1_500 + sequence * 100) * 1_000_000,
                        metrics_ms={},
                    ).decode(),
                    "receivedAtMs": 1_510 + sequence * 100,
                }
                for sequence, event in enumerate(event_names)
            ],
        }
    )

    result = await BrowserProbePage(page).wait_for_candidate_response(
        "worker-proved", "sample-safe-id"
    )

    assert result.acknowledgement_first_signal_at_ms == 1_600
    assert result.main_response_first_signal_at_ms == 2_150
    assert result.main_result_captured_at_ns == 1_700_000_000
    assert result.runtime_event_captured_at_ns == 1_800_000_000
    assert result.caption_rendered_at_ms == 1_975
    assert page.calls == [
        (
            "([identity, sampleId]) => "
            "window.voiceSlice03Probe.waitForCandidateResponse(identity, sampleId)",
            ["worker-proved", "sample-safe-id"],
        )
    ]


@pytest.mark.parametrize(
    ("event_names", "error"),
    [
        (["ready", "stt_final", "main_result"], "incomplete"),
        (
            ["ready", "stt_final", "main_result", "main_result", "runtime_event"],
            "unique",
        ),
        (["ready", "main_result", "stt_final", "runtime_event"], "out of order"),
    ],
)
async def test_candidate_response_rejects_ambiguous_telemetry(
    event_names: list[str], error: str
) -> None:
    page = ProbePage(
        {
            "acknowledgementFirstSignalPerformanceTimeMs": 1_600,
            "mainResponseFirstSignalPerformanceTimeMs": 2_150,
            "audioContextState": "running",
            "outputTimestampSupported": True,
            "captionRenderedAtMs": 2_200,
            "telemetry": [
                {
                    "payload": encode_telemetry(
                        event,
                        sequence=sequence,
                        captured_at_ns=(1_500 + sequence * 100) * 1_000_000,
                        metrics_ms={},
                    ).decode(),
                    "receivedAtMs": 1_510 + sequence * 100,
                }
                for sequence, event in enumerate(event_names)
            ],
        }
    )

    with pytest.raises(ValueError, match=error):
        await BrowserProbePage(page).wait_for_candidate_response(
            "worker-proved", "sample-safe-id"
        )


async def test_interruption_is_decoded_in_memory_and_bound_to_worker_identity() -> None:
    raw_pcm = b"\x01\x02" * 64_800
    page = ProbePage(
        {
            "durationMs": 1_350,
            "sampleCount": 64_800,
            "sampleRate": 48_000,
            "firstSignalPerformanceTimeMs": 5_750,
            "boundaryPerformanceTimeMs": 6_950,
            "bargeInStartedPerformanceTimeMs": 6_950,
            "playoutStoppedPerformanceTimeMs": 7_100,
            "muteLatencyMs": 150,
            "silenceProofMs": 250,
            "heardPcmBase64": base64.b64encode(raw_pcm).decode(),
            "audioContextState": "running",
            "outputTimestampSupported": True,
        }
    )
    probe = BrowserProbePage(page)

    result = await probe.interrupt_at_heard_boundary("worker-proved")

    assert result.pcm_s16le == raw_pcm
    assert result.sample_count == 64_800
    assert result.mute_latency_ms == 150
    assert page.calls == [
        (
            "identity => window.voiceSlice03Probe.interruptAtHeardBoundary(identity)",
            "worker-proved",
        )
    ]


async def test_heard_prefix_rejects_bytes_that_do_not_match_audio_metadata() -> None:
    page = ProbePage(
        {
            "durationMs": 1_350,
            "sampleCount": 64_800,
            "sampleRate": 48_000,
            "firstSignalPerformanceTimeMs": 5_750,
            "boundaryPerformanceTimeMs": 6_950,
            "bargeInStartedPerformanceTimeMs": 6_950,
            "playoutStoppedPerformanceTimeMs": 7_100,
            "muteLatencyMs": 150,
            "silenceProofMs": 250,
            "heardPcmBase64": base64.b64encode(b"too-short").decode(),
            "audioContextState": "running",
            "outputTimestampSupported": True,
        }
    )
    probe = BrowserProbePage(page)

    with pytest.raises(ValueError, match="PCM length"):
        await probe.interrupt_at_heard_boundary("worker-proved")


async def test_interruption_preserves_a_non_millisecond_aligned_stop_sample() -> None:
    sample_count = 64_801
    duration_ms = sample_count * 1_000 / 48_000
    first_signal_at_ms = 5_750
    page = ProbePage(
        {
            "durationMs": duration_ms,
            "sampleCount": sample_count,
            "sampleRate": 48_000,
            "firstSignalPerformanceTimeMs": first_signal_at_ms,
            "boundaryPerformanceTimeMs": first_signal_at_ms + 1_200,
            "bargeInStartedPerformanceTimeMs": first_signal_at_ms + 1_200,
            "playoutStoppedPerformanceTimeMs": first_signal_at_ms + duration_ms,
            "muteLatencyMs": duration_ms - 1_200,
            "silenceProofMs": 250,
            "heardPcmBase64": base64.b64encode(bytes(sample_count * 2)).decode(),
            "audioContextState": "running",
            "outputTimestampSupported": True,
        }
    )

    result = await BrowserProbePage(page).interrupt_at_heard_boundary("worker-proved")

    assert result.sample_count == sample_count
    assert len(result.pcm_s16le) == sample_count * 2
