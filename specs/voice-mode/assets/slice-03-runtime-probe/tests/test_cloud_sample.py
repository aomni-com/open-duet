import hashlib
import sys
from array import array
from pathlib import Path

import pytest
from livekit import api

import voice_probe.cloud_sample as cloud_sample_module
from voice_probe.browser_runtime import (
    BrowserCandidateResponseProof,
    BrowserInputWindow,
    BrowserInterruptionProof,
    BrowserWorkerProof,
)
from voice_probe.clock_sync import ClockCalibration, ClockSyncSample
from voice_probe.cloud_media import PROBE_RESPONSE_FIXTURE, load_probe_response_frames
from voice_probe.cloud_sample import (
    SampleSetup,
    build_candidate_response_sample,
    build_cloud_sample,
    build_metadata,
    build_probe_participant_token,
    orchestrate_cloud_sample,
    provider_room_name,
)
from voice_probe.contract import Candidate
from voice_probe.ogg_opus import encode_pcm_ogg_opus


def test_dispatch_metadata_is_opaque_and_worker_verifiable_without_logging_it() -> None:
    metadata = build_metadata(
        candidate_id="candidate-a",
        candidate=Candidate(
            stt="deepgram/flux-general-en",
            llm="google/gemma-4-31b-it",
            tts="fishaudio/s2.1-pro-free",
            voice="933563129e564b19a115bedd57b7406a",
        ),
        nonce="fixed-nonce",
        sample_id="sample-safe-id",
        scenario="fixed_interruption",
    )

    assert '"nonce":"fixed-nonce"' in metadata
    assert '"sample_id":"sample-safe-id"' in metadata
    assert '"scenario":"fixed_interruption"' in metadata
    assert '"candidate"' in metadata
    assert all(forbidden not in metadata.lower() for forbidden in ("secret", "ticket", "token"))


def test_provider_room_name_is_the_provider_visible_sample_identity() -> None:
    assert provider_room_name("0123456789abcdef") == "voice-s03-0123456789abcdef"
    with pytest.raises(ValueError, match="16 lowercase hex"):
        provider_room_name("local-only-label")


def test_probe_participant_token_can_publish_only_microphone_audio_and_data() -> None:
    token = build_probe_participant_token(
        key="probe-key",
        secret="probe-secret-value-is-long-enough",
        room_name="voice-s03-room",
        identity="probe-browser-fixed",
    )

    claims = api.TokenVerifier("probe-key", "probe-secret-value-is-long-enough").verify(token)
    assert claims.identity == "probe-browser-fixed"
    assert claims.video is not None
    assert claims.video.room == "voice-s03-room"
    assert claims.video.room_join is True
    assert claims.video.can_subscribe is True
    assert claims.video.can_publish_data is True
    assert claims.video.can_publish_sources == ["microphone"]


def test_cloud_sample_does_not_claim_provider_side_privacy() -> None:
    candidate = Candidate(
        stt="deepgram/flux-general-en",
        llm="google/gemma-4-31b-it",
        tts="fishaudio/s2.1-pro-free",
        voice="933563129e564b19a115bedd57b7406a",
    )

    proof = build_cloud_sample(
        sample_id="safe-id",
        candidate_id="candidate-a",
        activation_state="warm",
        browser_floor="chromium-desktop",
        candidate=candidate,
        dispatch_api_ms=42.5,
        dispatch_to_metadata_ms=250.0,
        clock_uncertainty_ms=5.5,
        input_window=BrowserInputWindow(started_at_ms=1_000, ends_at_ms=5_000),
        interruption=BrowserInterruptionProof(
            pcm_s16le=_marked_response_prefix_pcm(duration_ms=1_350),
            duration_ms=1_350,
            sample_count=64_800,
            sample_rate_hz=48_000,
            first_signal_at_ms=5_750,
            boundary_at_ms=6_950,
            barge_in_started_at_ms=6_950,
            playout_stopped_at_ms=7_100,
            mute_latency_ms=150,
            silence_proof_ms=250,
        ),
    )

    assert proof["status"] == "fixed_interruption_mute_observed_only"
    assert proof["scenario"] == "fixed_interruption"
    assert proof["browser_floor"] == "chromium-desktop"
    assert proof["model_ids"] == {"stt": "deepgram/flux-general-en"}
    assert "voice_id" not in proof
    assert proof["privacy"] == {"record_false": True, "cloud_absence_verified": False}
    codec = proof["codec"]
    assert codec["container_mime"] == "audio/ogg;codecs=opus"
    assert codec["capture_sample_rate_hz"] == 48_000
    assert codec["capture_duration_ms"] == 1_350
    assert codec["artifact_sample_rate_hz"] == 48_000
    assert codec["artifact_duration_ms"] == 1_350
    assert 0 < codec["heard_prefix_bytes"] < codec["full_response_bytes"]
    assert (
        codec["heard_prefix_sha256"]
        != hashlib.sha256(_marked_response_prefix_pcm(duration_ms=1_350)).hexdigest()
    )
    assert 0.98 < codec["marked_prefix_similarity"] < 1
    assert codec["tail_absent"] is True


def test_candidate_response_metrics_share_the_browser_output_and_calibrated_worker_clocks() -> None:
    sample = build_candidate_response_sample(
        sample_id="safe-id",
        candidate_id="candidate-a",
        activation_state="warm",
        browser_floor="chromium-desktop",
        candidate=_candidate(),
        dispatch_api_ms=40,
        dispatch_to_metadata_ms=250,
        input_window=BrowserInputWindow(started_at_ms=1_000, ends_at_ms=1_450),
        response=BrowserCandidateResponseProof(
            acknowledgement_first_signal_at_ms=1_600,
            main_response_first_signal_at_ms=2_150,
            main_result_captured_at_ns=1_700_000_000,
            runtime_event_captured_at_ns=1_900_000_000,
            caption_rendered_at_ms=1_975,
        ),
        calibration=ClockCalibration(offset_ms=50, network_round_trip_ms=10),
    )

    assert sample["metrics_ms"] == {
        "dispatch_api": 40,
        "dispatch_to_metadata_proof": 250,
        "clock_uncertainty": 5,
        "end_of_speech_to_acknowledgement": 150,
        "main_result_to_first_audio": 405,
        "runtime_event_to_caption_render": 30,
    }


def test_cloud_sample_rejects_silence_as_a_retained_response_prefix() -> None:
    with pytest.raises(ValueError, match="marked response beginning"):
        build_cloud_sample(
            sample_id="safe-id",
            candidate_id="candidate-a",
            activation_state="warm",
            browser_floor="chromium-desktop",
            candidate=_candidate(),
            dispatch_api_ms=42.5,
            dispatch_to_metadata_ms=250.0,
            clock_uncertainty_ms=5.5,
            input_window=BrowserInputWindow(started_at_ms=1_000, ends_at_ms=1_450),
            interruption=BrowserInterruptionProof(
                pcm_s16le=bytes(64_800 * 2),
                duration_ms=1_350,
                sample_count=64_800,
                sample_rate_hz=48_000,
                first_signal_at_ms=2_200,
                boundary_at_ms=3_400,
                barge_in_started_at_ms=3_400,
                playout_stopped_at_ms=3_550,
                mute_latency_ms=150,
                silence_proof_ms=250,
            ),
        )


def test_cloud_sample_rejects_a_shifted_response_segment_as_the_prefix() -> None:
    with pytest.raises(ValueError, match="marked response beginning"):
        build_cloud_sample(
            sample_id="safe-id",
            candidate_id="candidate-a",
            activation_state="warm",
            browser_floor="chromium-desktop",
            candidate=_candidate(),
            dispatch_api_ms=42.5,
            dispatch_to_metadata_ms=250.0,
            clock_uncertainty_ms=5.5,
            input_window=BrowserInputWindow(started_at_ms=1_000, ends_at_ms=1_450),
            interruption=BrowserInterruptionProof(
                pcm_s16le=_marked_response_prefix_pcm(start_ms=1_200, duration_ms=1_350),
                duration_ms=1_350,
                sample_count=64_800,
                sample_rate_hz=48_000,
                first_signal_at_ms=2_200,
                boundary_at_ms=3_400,
                barge_in_started_at_ms=3_400,
                playout_stopped_at_ms=3_550,
                mute_latency_ms=150,
                silence_proof_ms=250,
            ),
        )


def test_cloud_sample_rejects_an_encoded_artifact_with_shifted_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_encode = encode_pcm_ogg_opus
    encode_count = 0

    def encode_with_corrupted_prefix(pcm: bytes, *, sample_rate: int) -> bytes:
        nonlocal encode_count
        encode_count += 1
        if encode_count == 1:
            return original_encode(
                _marked_response_prefix_pcm(start_ms=1_200, duration_ms=1_350),
                sample_rate=48_000,
            )
        return original_encode(pcm, sample_rate=sample_rate)

    monkeypatch.setattr(cloud_sample_module, "encode_pcm_ogg_opus", encode_with_corrupted_prefix)

    with pytest.raises(ValueError, match="marked response beginning"):
        build_cloud_sample(
            sample_id="safe-id",
            candidate_id="candidate-a",
            activation_state="warm",
            browser_floor="chromium-desktop",
            candidate=_candidate(),
            dispatch_api_ms=42.5,
            dispatch_to_metadata_ms=250.0,
            clock_uncertainty_ms=5.5,
            input_window=BrowserInputWindow(started_at_ms=1_000, ends_at_ms=1_450),
            interruption=BrowserInterruptionProof(
                pcm_s16le=_marked_response_prefix_pcm(duration_ms=1_350),
                duration_ms=1_350,
                sample_count=64_800,
                sample_rate_hz=48_000,
                first_signal_at_ms=2_200,
                boundary_at_ms=3_400,
                barge_in_started_at_ms=3_400,
                playout_stopped_at_ms=3_550,
                mute_latency_ms=150,
                silence_proof_ms=250,
            ),
        )


def test_cloud_sample_rejects_tail_audio_mixed_into_the_heard_prefix() -> None:
    beginning = array("h")
    tail = array("h")
    beginning.frombytes(_marked_response_prefix_pcm(duration_ms=1_350))
    tail.frombytes(_marked_response_prefix_pcm(start_ms=2_500, duration_ms=1_350))
    if sys.byteorder != "little":
        beginning.byteswap()
        tail.byteswap()
    contaminated = array(
        "h",
        (
            max(-32_768, min(32_767, round(prefix + leaked * 0.25)))
            for prefix, leaked in zip(beginning, tail, strict=True)
        ),
    )
    if sys.byteorder != "little":
        contaminated.byteswap()

    with pytest.raises(ValueError, match="marked response beginning"):
        build_cloud_sample(
            sample_id="safe-id",
            candidate_id="candidate-a",
            activation_state="warm",
            browser_floor="chromium-desktop",
            candidate=_candidate(),
            dispatch_api_ms=42.5,
            dispatch_to_metadata_ms=250.0,
            clock_uncertainty_ms=5.5,
            input_window=BrowserInputWindow(started_at_ms=1_000, ends_at_ms=1_450),
            interruption=BrowserInterruptionProof(
                pcm_s16le=contaminated.tobytes(),
                duration_ms=1_350,
                sample_count=64_800,
                sample_rate_hz=48_000,
                first_signal_at_ms=2_200,
                boundary_at_ms=3_400,
                barge_in_started_at_ms=3_400,
                playout_stopped_at_ms=3_550,
                mute_latency_ms=150,
                silence_proof_ms=250,
            ),
        )


def test_cloud_sample_preserves_a_measured_mute_budget_failure() -> None:
    proof = build_cloud_sample(
        sample_id="safe-id",
        candidate_id="candidate-a",
        activation_state="warm",
        browser_floor="chromium-desktop",
        candidate=_candidate(),
        dispatch_api_ms=42.5,
        dispatch_to_metadata_ms=250.0,
        clock_uncertainty_ms=5.5,
        input_window=BrowserInputWindow(started_at_ms=1_000, ends_at_ms=1_450),
        interruption=BrowserInterruptionProof(
            pcm_s16le=_marked_response_prefix_pcm(duration_ms=1_450),
            duration_ms=1_450,
            sample_count=69_600,
            sample_rate_hz=48_000,
            first_signal_at_ms=2_200,
            boundary_at_ms=3_400,
            barge_in_started_at_ms=3_400,
            playout_stopped_at_ms=3_650,
            mute_latency_ms=250,
            silence_proof_ms=250,
        ),
    )

    assert proof["metrics_ms"]["barge_in_mute"] == 250
    assert proof["status"] == "fixed_interruption_budget_failed"


async def test_browser_owns_worker_proof_input_and_redacted_interruption() -> None:
    events: list[str] = []

    class Browser:
        async def connect(self, *, livekit_url: str, participant_token: str, fixture: Path) -> None:
            assert livekit_url == "wss://probe.invalid"
            assert participant_token == "room-token"
            assert fixture.name == "four-second-spoken.ogg"
            events.append("browser_connected_with_microphone")

        async def wait_for_worker(self, expected_digest: str) -> BrowserWorkerProof:
            assert len(expected_digest) == 64
            events.append("browser_proved_worker")
            return BrowserWorkerProof(identity="worker-fixed", activation_instance_sha256="c" * 64)

        async def collect_clock_samples(
            self, worker_identity: str, sample_id: str
        ) -> list[ClockSyncSample]:
            assert worker_identity == "worker-fixed"
            assert sample_id == "sample-safe-id"
            events.append("browser_calibrated_clock")
            return [
                ClockSyncSample(100.0, 1_050_000_000, 1_051_000_000, 132.0),
                ClockSyncSample(200.0, 1_140_000_000, 1_141_000_000, 212.0),
                ClockSyncSample(300.0, 1_230_000_000, 1_231_000_000, 340.0),
            ]

        async def start_input_fixture(self) -> BrowserInputWindow:
            events.append("browser_started_input")
            return BrowserInputWindow(started_at_ms=1_000, ends_at_ms=1_450)

        async def interrupt_at_heard_boundary(
            self, worker_identity: str
        ) -> BrowserInterruptionProof:
            assert worker_identity == "worker-fixed"
            events.append("browser_interrupted_worker")
            return BrowserInterruptionProof(
                pcm_s16le=_marked_response_prefix_pcm(duration_ms=1_350),
                duration_ms=1_350,
                sample_count=64_800,
                sample_rate_hz=48_000,
                first_signal_at_ms=2_200,
                boundary_at_ms=3_400,
                barge_in_started_at_ms=3_400,
                playout_stopped_at_ms=3_550,
                mute_latency_ms=150,
                silence_proof_ms=250,
            )

        async def disconnect(self) -> None:
            events.append("browser_disconnected")

    class Cloud:
        async def dispatch(self, room_name: str, metadata: str) -> None:
            assert events == ["browser_connected_with_microphone"]
            assert room_name == "voice-s03-room"
            assert '"sample_id":"sample-safe-id"' in metadata
            events.append("worker_dispatched")

        async def delete_room(self, room_name: str) -> None:
            assert room_name == "voice-s03-room"
            events.append("room_deleted")

    clock_values = iter((10.0, 10.04, 10.25))
    sample = await orchestrate_cloud_sample(
        browser=Browser(),
        cloud=Cloud(),
        setup=SampleSetup(
            livekit_url="wss://probe.invalid",
            participant_token="room-token",
            room_name="voice-s03-room",
            metadata=build_metadata(
                candidate_id="candidate-a",
                candidate=Candidate(
                    stt="deepgram/flux-general-en",
                    llm="google/gemma-4-31b-it",
                    tts="fishaudio/s2.1-pro-free",
                    voice="933563129e564b19a115bedd57b7406a",
                ),
                nonce="fixed-nonce",
                sample_id="sample-safe-id",
                scenario="fixed_interruption",
            ),
            fixture=Path(__file__).parents[1] / "fixtures" / "four-second-spoken.ogg",
        ),
        activation_state="warm",
        browser_floor="chromium-desktop",
        clock=lambda: next(clock_values),
    )

    assert events == [
        "browser_connected_with_microphone",
        "worker_dispatched",
        "browser_proved_worker",
        "browser_calibrated_clock",
        "browser_started_input",
        "browser_interrupted_worker",
        "browser_disconnected",
        "room_deleted",
    ]
    assert sample["metrics_ms"] == {
        "dispatch_api": 40,
        "dispatch_to_metadata_proof": 250,
        "clock_uncertainty": 5.5,
        "input_end_to_first_audio": 750,
        "barge_in_mute": 150,
    }
    assert sample["status"] == "fixed_interruption_mute_observed_only"
    assert sample["scenario"] == "fixed_interruption"
    assert sample["model_ids"] == {"stt": "deepgram/flux-general-en"}
    assert "voice_id" not in sample
    codec = sample["codec"]
    assert codec["container_mime"] == "audio/ogg;codecs=opus"
    assert codec["capture_sample_rate_hz"] == 48_000
    assert codec["capture_duration_ms"] == 1_350
    assert codec["artifact_sample_rate_hz"] == 48_000
    assert codec["artifact_duration_ms"] == 1_350
    assert 0 < codec["heard_prefix_bytes"] < codec["full_response_bytes"]
    assert len(codec["heard_prefix_sha256"]) == 64
    assert codec["tail_absent"] is True
    assert codec["complete_word_count"] == 2
    assert codec["silence_proof_ms"] == 250
    serialized = str(sample).lower()
    assert "worker-fixed" not in serialized
    assert "prefixpcm" not in serialized
    assert "pcm_s16le" not in sample


async def test_candidate_response_proves_ack_and_main_audio_as_separate_epochs() -> None:
    events: list[str] = []

    class Browser:
        async def connect(self, *, livekit_url: str, participant_token: str, fixture: Path) -> None:
            events.append("connected")

        async def wait_for_worker(self, expected_digest: str) -> BrowserWorkerProof:
            events.append("proved_worker")
            return BrowserWorkerProof(identity="worker-fixed", activation_instance_sha256="c" * 64)

        async def collect_clock_samples(
            self, worker_identity: str, sample_id: str
        ) -> list[ClockSyncSample]:
            events.append("calibrated")
            return [
                ClockSyncSample(100.0, 1_050_000_000, 1_051_000_000, 132.0),
                ClockSyncSample(200.0, 1_140_000_000, 1_141_000_000, 212.0),
                ClockSyncSample(300.0, 1_230_000_000, 1_231_000_000, 340.0),
            ]

        async def start_input_fixture(self) -> BrowserInputWindow:
            events.append("started_input")
            return BrowserInputWindow(started_at_ms=1_000, ends_at_ms=1_450)

        async def wait_for_candidate_response(
            self, worker_identity: str, sample_id: str
        ) -> BrowserCandidateResponseProof:
            assert worker_identity == "worker-fixed"
            assert sample_id == "sample-safe-id"
            events.append("proved_candidate_response")
            return BrowserCandidateResponseProof(
                acknowledgement_first_signal_at_ms=1_600,
                main_response_first_signal_at_ms=2_150,
                main_result_captured_at_ns=2_684_500_000,
                runtime_event_captured_at_ns=2_884_500_000,
                caption_rendered_at_ms=1_975,
            )

        async def interrupt_at_heard_boundary(
            self, worker_identity: str
        ) -> BrowserInterruptionProof:
            raise AssertionError("candidate response must not run the fixed interruption carrier")

        async def disconnect(self) -> None:
            events.append("disconnected")

    class Cloud:
        async def dispatch(self, room_name: str, metadata: str) -> None:
            assert '"scenario":"candidate_response"' in metadata
            events.append("dispatched")

        async def delete_room(self, room_name: str) -> None:
            events.append("deleted")

    sample = await orchestrate_cloud_sample(
        browser=Browser(),
        cloud=Cloud(),
        setup=SampleSetup(
            livekit_url="wss://probe.invalid",
            participant_token="room-token",
            room_name="voice-s03-room",
            metadata=build_metadata(
                candidate_id="candidate-a",
                candidate=_candidate(),
                nonce="fixed-nonce",
                sample_id="sample-safe-id",
                scenario="candidate_response",
            ),
            fixture=Path(__file__).parents[1] / "fixtures" / "four-second-spoken.ogg",
        ),
        activation_state="warm",
        browser_floor="chromium-desktop",
        clock=iter((10.0, 10.04, 10.25)).__next__,
    )

    assert events == [
        "connected",
        "dispatched",
        "proved_worker",
        "calibrated",
        "started_input",
        "proved_candidate_response",
        "disconnected",
        "deleted",
    ]
    assert sample == {
        "sample_id": "sample-safe-id",
        "candidate_id": "candidate-a",
        "activation_state": "warm",
        "browser_floor": "chromium-desktop",
        "activation_instance_sha256": "c" * 64,
        "scenario": "candidate_response",
        "metrics_ms": {
            "dispatch_api": 40,
            "dispatch_to_metadata_proof": 250,
            "clock_uncertainty": 5.5,
            "end_of_speech_to_acknowledgement": 150,
            "main_result_to_first_audio": 405.5,
            "runtime_event_to_caption_render": 30.5,
        },
        "model_ids": {
            "stt": "deepgram/flux-general-en",
            "llm": "google/gemma-4-31b-it",
            "tts": "fishaudio/s2.1-pro-free",
        },
        "voice_id": "933563129e564b19a115bedd57b7406a",
        "privacy": {"record_false": True, "cloud_absence_verified": False},
        "status": "candidate_response_observed_only",
    }


async def test_metadata_proof_failure_still_closes_browser_and_room() -> None:
    events: list[str] = []

    class Browser:
        async def connect(self, *, livekit_url: str, participant_token: str, fixture: Path) -> None:
            events.append("connected")

        async def wait_for_worker(self, expected_digest: str) -> BrowserWorkerProof:
            raise TimeoutError("metadata proof timed out")

        async def collect_clock_samples(
            self, worker_identity: str, sample_id: str
        ) -> list[ClockSyncSample]:
            raise AssertionError("clock calibration must follow worker proof")

        async def start_input_fixture(self) -> BrowserInputWindow:
            raise AssertionError("input must follow worker proof")

        async def interrupt_at_heard_boundary(
            self, worker_identity: str
        ) -> BrowserInterruptionProof:
            raise AssertionError("remote audio must follow worker proof")

        async def disconnect(self) -> None:
            events.append("disconnected")

    class Cloud:
        async def dispatch(self, room_name: str, metadata: str) -> None:
            events.append("dispatched")

        async def delete_room(self, room_name: str) -> None:
            events.append("deleted")

    with pytest.raises(TimeoutError, match="metadata proof"):
        await orchestrate_cloud_sample(
            browser=Browser(),
            cloud=Cloud(),
            setup=_dispatch_setup(),
            activation_state="warm",
            browser_floor="chromium-desktop",
        )

    assert events == ["connected", "dispatched", "disconnected", "deleted"]


async def test_interruption_failure_still_closes_browser_and_room() -> None:
    events: list[str] = []

    class Browser:
        async def connect(self, *, livekit_url: str, participant_token: str, fixture: Path) -> None:
            events.append("connected")

        async def wait_for_worker(self, expected_digest: str) -> BrowserWorkerProof:
            return BrowserWorkerProof(identity="worker-fixed", activation_instance_sha256="c" * 64)

        async def collect_clock_samples(
            self, worker_identity: str, sample_id: str
        ) -> list[ClockSyncSample]:
            return [
                ClockSyncSample(100.0, 1_050_000_000, 1_051_000_000, 132.0),
                ClockSyncSample(200.0, 1_140_000_000, 1_141_000_000, 212.0),
                ClockSyncSample(300.0, 1_230_000_000, 1_231_000_000, 340.0),
            ]

        async def start_input_fixture(self) -> BrowserInputWindow:
            return BrowserInputWindow(started_at_ms=1_000, ends_at_ms=5_000)

        async def interrupt_at_heard_boundary(
            self, worker_identity: str
        ) -> BrowserInterruptionProof:
            raise TimeoutError("remote interruption timed out")

        async def disconnect(self) -> None:
            events.append("disconnected")

    class Cloud:
        async def dispatch(self, room_name: str, metadata: str) -> None:
            events.append("dispatched")

        async def delete_room(self, room_name: str) -> None:
            events.append("deleted")

    with pytest.raises(TimeoutError, match="remote interruption"):
        await orchestrate_cloud_sample(
            browser=Browser(),
            cloud=Cloud(),
            setup=_dispatch_setup(),
            activation_state="warm",
            browser_floor="chromium-desktop",
        )

    assert events == ["connected", "dispatched", "disconnected", "deleted"]


def _candidate() -> Candidate:
    return Candidate(
        stt="deepgram/flux-general-en",
        llm="google/gemma-4-31b-it",
        tts="fishaudio/s2.1-pro-free",
        voice="933563129e564b19a115bedd57b7406a",
    )


def _marked_response_prefix_pcm(*, start_ms: int = 0, duration_ms: int = 1_200) -> bytes:
    full_pcm = b"".join(
        bytes(frame.data) for frame in load_probe_response_frames(PROBE_RESPONSE_FIXTURE)
    )
    start = 48_000 * start_ms // 1_000 * 2
    length = 48_000 * duration_ms // 1_000 * 2
    return full_pcm[start : start + length]


def _dispatch_setup() -> SampleSetup:
    return SampleSetup(
        livekit_url="wss://probe.invalid",
        participant_token="room-token",
        room_name="voice-s03-room",
        metadata=build_metadata(
            candidate_id="candidate-a",
            candidate=_candidate(),
            nonce="fixed-nonce",
            sample_id="sample-safe-id",
            scenario="fixed_interruption",
        ),
        fixture=Path(__file__).parents[1] / "fixtures" / "four-second-spoken.ogg",
    )
