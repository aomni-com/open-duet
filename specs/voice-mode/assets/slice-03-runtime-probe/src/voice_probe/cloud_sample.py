import hashlib
import json
import math
import os
import secrets
import sys
import time
from array import array
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any, Protocol

from livekit import api

from voice_probe.browser_runtime import (
    BrowserCandidateResponseProof,
    BrowserInputWindow,
    BrowserInterruptionProof,
    BrowserWorkerProof,
    launch_browser_probe,
)
from voice_probe.clock_sync import ClockCalibration, ClockSyncSample, calibrate_worker_clock
from voice_probe.cloud_media import PROBE_RESPONSE_FIXTURE, load_probe_response_frames
from voice_probe.contract import BrowserFloor, Candidate, ProbeJob, ProbeScenario
from voice_probe.heard_prefix import FIXED_RESPONSE_TRANSCRIPT_CUES
from voice_probe.ogg_opus import (
    decode_ogg_opus_pcm_s16le,
    encode_pcm_ogg_opus,
)

AGENT_NAME = "duet-voice-slice03-probe"


@dataclass(frozen=True)
class SampleSetup:
    livekit_url: str
    participant_token: str
    room_name: str
    metadata: str
    fixture: Path


class ProbeBrowser(Protocol):
    async def connect(self, *, livekit_url: str, participant_token: str, fixture: Path) -> None: ...

    async def wait_for_worker(self, expected_digest: str) -> BrowserWorkerProof: ...

    async def collect_clock_samples(
        self, worker_identity: str, sample_id: str
    ) -> list[ClockSyncSample]: ...

    async def start_input_fixture(self) -> BrowserInputWindow: ...

    async def wait_for_candidate_response(
        self, worker_identity: str, sample_id: str
    ) -> BrowserCandidateResponseProof: ...

    async def interrupt_at_heard_boundary(
        self, worker_identity: str
    ) -> BrowserInterruptionProof: ...

    async def disconnect(self) -> None: ...


class CloudControl(Protocol):
    async def dispatch(self, room_name: str, metadata: str) -> None: ...

    async def delete_room(self, room_name: str) -> None: ...


def provider_room_name(sample_id: str) -> str:
    if len(sample_id) != 16 or any(character not in "0123456789abcdef" for character in sample_id):
        raise ValueError("sample_id must be 16 lowercase hex characters")
    return f"voice-s03-{sample_id}"


def build_metadata(
    *,
    candidate_id: str,
    candidate: Candidate,
    nonce: str,
    sample_id: str,
    scenario: ProbeScenario,
) -> str:
    return json.dumps(
        {
            "candidate_id": candidate_id,
            "candidate": asdict(candidate),
            "nonce": nonce,
            "sample_id": sample_id,
            "scenario": scenario,
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def build_probe_participant_token(*, key: str, secret: str, room_name: str, identity: str) -> str:
    return (
        api.AccessToken(key, secret)
        .with_identity(identity)
        .with_ttl(timedelta(minutes=5))
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish_sources=["microphone"],
                can_subscribe=True,
                can_publish_data=True,
            )
        )
        .to_jwt()
    )


def build_cloud_sample(
    *,
    sample_id: str,
    candidate_id: str,
    activation_state: str,
    browser_floor: BrowserFloor,
    candidate: Candidate,
    dispatch_api_ms: float,
    dispatch_to_metadata_ms: float,
    clock_uncertainty_ms: float,
    input_window: BrowserInputWindow,
    interruption: BrowserInterruptionProof,
) -> dict[str, Any]:
    input_end_to_first_audio_ms = round(
        interruption.first_signal_at_ms - input_window.ends_at_ms, 1
    )
    if input_end_to_first_audio_ms < 0:
        raise ValueError("remote audio began before the input fixture ended")
    artifact = _fixed_interruption_artifact(interruption)
    return {
        "sample_id": sample_id,
        "candidate_id": candidate_id,
        "activation_state": activation_state,
        "browser_floor": browser_floor,
        "metrics_ms": {
            "dispatch_api": dispatch_api_ms,
            "dispatch_to_metadata_proof": dispatch_to_metadata_ms,
            "clock_uncertainty": clock_uncertainty_ms,
            "input_end_to_first_audio": input_end_to_first_audio_ms,
            "barge_in_mute": round(interruption.mute_latency_ms, 1),
        },
        "scenario": "fixed_interruption",
        "model_ids": {"stt": candidate.stt},
        "privacy": {"record_false": True, "cloud_absence_verified": False},
        "codec": {
            "container_mime": "audio/ogg;codecs=opus",
            "capture_sample_rate_hz": interruption.sample_rate_hz,
            "capture_duration_ms": interruption.duration_ms,
            "artifact_sample_rate_hz": 48_000,
            "artifact_duration_ms": artifact["prefix_duration_ms"],
            "heard_prefix_bytes": artifact["prefix_bytes"],
            "heard_prefix_sha256": artifact["prefix_sha256"],
            "full_response_bytes": artifact["full_bytes"],
            "marked_prefix_similarity": artifact["marked_prefix_similarity"],
            "tail_absent": artifact["tail_absent"],
            "complete_word_count": artifact["complete_word_count"],
            "silence_proof_ms": interruption.silence_proof_ms,
        },
        "status": (
            "fixed_interruption_mute_observed_only"
            if interruption.mute_latency_ms <= 200
            else "fixed_interruption_budget_failed"
        ),
    }


def build_candidate_response_sample(
    *,
    sample_id: str,
    candidate_id: str,
    activation_state: str,
    browser_floor: BrowserFloor,
    candidate: Candidate,
    dispatch_api_ms: float,
    dispatch_to_metadata_ms: float,
    input_window: BrowserInputWindow,
    response: BrowserCandidateResponseProof,
    calibration: ClockCalibration,
) -> dict[str, Any]:
    end_of_speech_to_acknowledgement_ms = round(
        response.acknowledgement_first_signal_at_ms - input_window.ends_at_ms, 1
    )
    main_result_to_first_audio_ms = round(
        response.main_response_first_signal_at_ms
        - calibration.worker_to_browser_ms(response.main_result_captured_at_ns)
        + calibration.uncertainty_ms,
        1,
    )
    runtime_event_to_caption_render_ms = round(
        response.caption_rendered_at_ms
        - calibration.worker_to_browser_ms(response.runtime_event_captured_at_ns)
        + calibration.uncertainty_ms,
        1,
    )
    if end_of_speech_to_acknowledgement_ms < 0:
        raise ValueError("remote audio began before the input fixture ended")
    if main_result_to_first_audio_ms < 0:
        raise ValueError("remote audio began before the Main result")
    if runtime_event_to_caption_render_ms < 0:
        raise ValueError("caption rendered before its runtime event")
    return {
        "sample_id": sample_id,
        "candidate_id": candidate_id,
        "activation_state": activation_state,
        "browser_floor": browser_floor,
        "scenario": "candidate_response",
        "metrics_ms": {
            "dispatch_api": dispatch_api_ms,
            "dispatch_to_metadata_proof": dispatch_to_metadata_ms,
            "clock_uncertainty": calibration.uncertainty_ms,
            "end_of_speech_to_acknowledgement": end_of_speech_to_acknowledgement_ms,
            "main_result_to_first_audio": main_result_to_first_audio_ms,
            "runtime_event_to_caption_render": runtime_event_to_caption_render_ms,
        },
        "model_ids": {
            "stt": candidate.stt,
            "llm": candidate.llm,
            "tts": candidate.tts,
        },
        "voice_id": candidate.voice,
        "privacy": {"record_false": True, "cloud_absence_verified": False},
        "status": "candidate_response_observed_only",
    }


def _fixed_interruption_artifact(
    interruption: BrowserInterruptionProof,
) -> dict[str, int | float | bool | str]:
    if len(interruption.pcm_s16le) != interruption.sample_count * 2:
        raise ValueError("heard capture bytes must match its exact sample count")
    prefix = encode_pcm_ogg_opus(interruption.pcm_s16le, sample_rate=interruption.sample_rate_hz)
    full_pcm = b"".join(
        bytes(frame.data) for frame in load_probe_response_frames(PROBE_RESPONSE_FIXTURE)
    )
    full = encode_pcm_ogg_opus(full_pcm, sample_rate=48_000)
    decoded_prefix = decode_ogg_opus_pcm_s16le(prefix)
    prefix_duration_ms = len(decoded_prefix) * 1_000 / (48_000 * 2)
    expected_heard_ms = 1_200 + interruption.mute_latency_ms
    if abs(interruption.duration_ms - expected_heard_ms) > 1:
        raise ValueError("heard capture must extend through measured playout stop")
    if abs(prefix_duration_ms - interruption.duration_ms) > 0.02:
        raise ValueError("retained artifact duration must match heard capture")
    if len(prefix) >= len(full):
        raise ValueError("retained prefix must be strictly shorter than full synthesis")
    # Compare both artifacts after the same lossy codec. The raw carrier
    # contains harmonics Opus legitimately drops even for an intact prefix.
    expected_prefix = decode_ogg_opus_pcm_s16le(full)[: len(decoded_prefix)]
    similarity = _pcm_cosine_similarity(decoded_prefix, expected_prefix)
    if similarity < 0.98:
        raise ValueError("retained prefix does not match the marked response beginning")

    complete_word_count = sum(
        cue.ends_at_ms <= interruption.duration_ms for cue in FIXED_RESPONSE_TRANSCRIPT_CUES
    )
    return {
        "prefix_duration_ms": prefix_duration_ms,
        "prefix_bytes": len(prefix),
        "prefix_sha256": hashlib.sha256(prefix).hexdigest(),
        "full_bytes": len(full),
        "marked_prefix_similarity": round(similarity, 4),
        "tail_absent": complete_word_count < len(FIXED_RESPONSE_TRANSCRIPT_CUES),
        "complete_word_count": complete_word_count,
    }


def _pcm_cosine_similarity(actual: bytes, expected: bytes) -> float:
    if len(actual) != len(expected) or len(actual) % 2:
        raise ValueError("retained prefix cannot be compared with the marked response")
    actual_samples = array("h")
    expected_samples = array("h")
    actual_samples.frombytes(actual)
    expected_samples.frombytes(expected)
    if sys.byteorder != "little":
        actual_samples.byteswap()
        expected_samples.byteswap()
    dot = sum(left * right for left, right in zip(actual_samples, expected_samples, strict=True))
    actual_energy = sum(sample * sample for sample in actual_samples)
    expected_energy = sum(sample * sample for sample in expected_samples)
    if actual_energy == 0 or expected_energy == 0:
        return 0.0
    return dot / math.sqrt(actual_energy * expected_energy)


async def run_chromium_cloud_sample(
    *,
    sample_id: str,
    candidate_id: str,
    candidate: Candidate,
    activation_state: str,
    browser_floor: BrowserFloor,
    chrome: Path,
    browser_bundle: Path,
    fixture: Path,
    scenario: ProbeScenario,
) -> dict[str, Any]:
    if browser_floor != "chromium-desktop":
        raise ValueError("Chromium samples must use the desktop browser floor")
    async with launch_browser_probe(executable=chrome, bundle=browser_bundle) as browser:
        return await run_cloud_sample_with_browser(
            browser=browser,
            sample_id=sample_id,
            candidate_id=candidate_id,
            candidate=candidate,
            activation_state=activation_state,
            browser_floor=browser_floor,
            fixture=fixture,
            scenario=scenario,
        )


async def run_cloud_sample_with_browser(
    *,
    browser: ProbeBrowser,
    sample_id: str,
    candidate_id: str,
    candidate: Candidate,
    activation_state: str,
    browser_floor: BrowserFloor,
    fixture: Path,
    scenario: ProbeScenario,
) -> dict[str, Any]:
    url, key, secret = required_credentials()
    room_name = provider_room_name(sample_id)
    metadata = build_metadata(
        candidate_id=candidate_id,
        candidate=candidate,
        nonce=secrets.token_hex(16),
        sample_id=sample_id,
        scenario=scenario,
    )
    participant_token = build_probe_participant_token(
        key=key,
        secret=secret,
        room_name=room_name,
        identity=f"probe-browser-{secrets.token_hex(6)}",
    )

    livekit_api = api.LiveKitAPI(url, key, secret)
    cloud = LiveKitCloudControl(livekit_api)
    try:
        return await orchestrate_cloud_sample(
            browser=browser,
            cloud=cloud,
            setup=SampleSetup(
                livekit_url=url,
                participant_token=participant_token,
                room_name=room_name,
                metadata=metadata,
                fixture=fixture,
            ),
            activation_state=activation_state,
            browser_floor=browser_floor,
        )
    finally:
        await livekit_api.aclose()


class LiveKitCloudControl:
    def __init__(self, client: api.LiveKitAPI) -> None:
        self._client = client

    async def dispatch(self, room_name: str, metadata: str) -> None:
        await self._client.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=AGENT_NAME,
                room=room_name,
                metadata=metadata,
            )
        )

    async def delete_room(self, room_name: str) -> None:
        await self._client.room.delete_room(api.DeleteRoomRequest(room=room_name))


async def orchestrate_cloud_sample(
    *,
    browser: ProbeBrowser,
    cloud: CloudControl,
    setup: SampleSetup,
    activation_state: str,
    browser_floor: BrowserFloor,
    clock: Callable[[], float] = time.perf_counter,
) -> dict[str, Any]:
    expected_digest = hashlib.sha256(setup.metadata.encode()).hexdigest()
    job = ProbeJob.from_metadata(setup.metadata)
    try:
        await browser.connect(
            livekit_url=setup.livekit_url,
            participant_token=setup.participant_token,
            fixture=setup.fixture,
        )
        dispatch_started = clock()
        await cloud.dispatch(setup.room_name, setup.metadata)
        dispatch_ms = round((clock() - dispatch_started) * 1_000, 1)
        worker = await browser.wait_for_worker(expected_digest)
        dispatch_to_metadata_ms = round((clock() - dispatch_started) * 1_000, 1)
        calibration = calibrate_worker_clock(
            await browser.collect_clock_samples(worker.identity, job.sample_id)
        )
        input_window = await browser.start_input_fixture()
        if job.scenario == "candidate_response":
            sample = build_candidate_response_sample(
                sample_id=job.sample_id,
                candidate_id=job.candidate_id,
                activation_state=activation_state,
                browser_floor=browser_floor,
                candidate=job.candidate,
                dispatch_api_ms=dispatch_ms,
                dispatch_to_metadata_ms=dispatch_to_metadata_ms,
                input_window=input_window,
                response=await browser.wait_for_candidate_response(worker.identity, job.sample_id),
                calibration=calibration,
            )
        else:
            interruption = await browser.interrupt_at_heard_boundary(worker.identity)
            sample = build_cloud_sample(
                sample_id=job.sample_id,
                candidate_id=job.candidate_id,
                activation_state=activation_state,
                browser_floor=browser_floor,
                candidate=job.candidate,
                dispatch_api_ms=dispatch_ms,
                dispatch_to_metadata_ms=dispatch_to_metadata_ms,
                clock_uncertainty_ms=calibration.uncertainty_ms,
                input_window=input_window,
                interruption=interruption,
            )
        sample["activation_instance_sha256"] = worker.activation_instance_sha256
        return sample
    finally:
        try:
            await browser.disconnect()
        finally:
            await cloud.delete_room(setup.room_name)


def required_credentials() -> tuple[str, str, str]:
    names = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")
    url, key, secret = (os.environ.get(name, "") for name in names)
    values = (url, key, secret)
    missing = [name for name, value in zip(names, values, strict=True) if not value]
    if missing:
        raise RuntimeError("missing required environment names: " + ", ".join(missing))
    return url, key, secret
