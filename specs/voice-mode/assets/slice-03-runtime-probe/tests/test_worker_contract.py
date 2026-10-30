import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from livekit import agents, rtc
from livekit.agents import inference
from livekit.agents.voice.events import UserInputTranscribedEvent
from pytest import MonkeyPatch

from voice_probe.contract import Candidate, ProbeJob
from voice_probe.telemetry import decode_telemetry
from voice_probe.worker import (
    AcknowledgementController,
    FixedResponseController,
    ProbeAgent,
    WorkerTelemetry,
    activation_instance_sha256,
    attach_session_telemetry,
    build_clock_rpc_handler,
    build_main_result_rpc_handler,
    build_probe_agent,
    build_session,
    session_start_options,
)


class _SpeechHandle:
    pass


class _ResponseSession:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def say(
        self,
        text: str,
        *,
        audio: Any,
        allow_interruptions: bool,
        add_to_chat_ctx: bool,
    ) -> _SpeechHandle:
        self.calls.append(
            {
                "text": text,
                "audio": audio,
                "allow_interruptions": allow_interruptions,
                "add_to_chat_ctx": add_to_chat_ctx,
            }
        )
        return _SpeechHandle()


class _AcknowledgementSession:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def say(
        self,
        text: str,
        *,
        allow_interruptions: bool,
        add_to_chat_ctx: bool,
    ) -> _SpeechHandle:
        self.calls.append(
            {
                "text": text,
                "allow_interruptions": allow_interruptions,
                "add_to_chat_ctx": add_to_chat_ctx,
            }
        )
        return _SpeechHandle()


async def test_worker_uses_supplied_models_and_disables_observability_upload(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("LIVEKIT_URL", "wss://probe.invalid")
    monkeypatch.setenv("LIVEKIT_API_KEY", "probe-public-key")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "probe-secret-value-is-never-sent-000")
    session = build_session(
        Candidate(
            stt="deepgram/flux-general-en",
            llm="google/gemma-4-31b-it",
            tts="fishaudio/s2.1-pro-free",
            voice="933563129e564b19a115bedd57b7406a",
        )
    )

    assert isinstance(session.stt, inference.STT)
    assert isinstance(session.llm, inference.LLM)
    assert isinstance(session.tts, inference.TTS)
    assert session.stt.model == "deepgram/flux-general-en"
    assert session.llm.model == "google/gemma-4-31b-it"
    assert session.tts.model == "fishaudio/s2.1-pro-free"
    assert session_start_options() == {"record": False}


def test_activation_fingerprint_is_inherited_from_the_deployment_launcher(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("VOICE_PROBE_ACTIVATION_NONCE", "activation-a")
    first = activation_instance_sha256()

    assert activation_instance_sha256() == first

    monkeypatch.setenv("VOICE_PROBE_ACTIVATION_NONCE", "activation-b")
    assert activation_instance_sha256() != first

    monkeypatch.delenv("VOICE_PROBE_ACTIVATION_NONCE")
    with pytest.raises(RuntimeError, match="launcher"):
        activation_instance_sha256()


def test_container_starts_through_the_deployment_activation_launcher() -> None:
    dockerfile = (Path(__file__).parents[1] / "Dockerfile").read_text()

    assert 'CMD ["uv", "run", "python", "-m", "voice_probe.launch", "start"]' in dockerfile


def test_job_scenario_hard_cut_selects_real_or_deterministic_response_path() -> None:
    fixed_metadata = _job_metadata("fixed_interruption")
    candidate_metadata = _job_metadata("candidate_response")

    assert ProbeJob.from_metadata(fixed_metadata).scenario == "fixed_interruption"
    assert ProbeJob.from_metadata(candidate_metadata).scenario == "candidate_response"
    with pytest.raises(ValueError, match="scenario"):
        ProbeJob.from_metadata(_job_metadata("provider"))

    assert isinstance(build_probe_agent("fixed_interruption"), ProbeAgent)
    assert isinstance(build_probe_agent("candidate_response"), ProbeAgent)


def _job_metadata(scenario: str) -> str:
    return json.dumps(
        {
            "candidate_id": "candidate-a",
            "candidate": {
                "stt": "deepgram/flux-general-en",
                "llm": "google/gemma-4-31b-it",
                "tts": "fishaudio/s2.1-pro-free",
                "voice": "933563129e564b19a115bedd57b7406a",
            },
            "nonce": "safe-nonce",
            "sample_id": "sample-safe-id",
            "scenario": scenario,
        }
    )


async def test_worker_telemetry_publishes_only_sequenced_content_free_milestones() -> None:
    published: list[bytes] = []

    async def publish(payload: bytes) -> None:
        published.append(payload)

    clock_values = iter((1_000, 2_000))
    telemetry = WorkerTelemetry(publish, clock_ns=lambda: next(clock_values))
    await telemetry.emit("ready")
    await telemetry.emit("stt_final", metrics_ms={"provider_latency": 183})

    assert [decode_telemetry(payload) for payload in published] == [
        {
            "event": "ready",
            "sequence": 0,
            "captured_at_ns": 1_000,
            "metrics_ms": {},
        },
        {
            "event": "stt_final",
            "sequence": 1,
            "captured_at_ns": 2_000,
            "metrics_ms": {"provider_latency": 183.0},
        },
    ]


async def test_worker_telemetry_serializes_concurrent_publishes() -> None:
    first_publish_started = asyncio.Event()
    release_first_publish = asyncio.Event()
    published_sequences: list[int] = []

    async def publish(payload: bytes) -> None:
        sequence = decode_telemetry(payload)["sequence"]
        if sequence == 0:
            first_publish_started.set()
            await release_first_publish.wait()
        published_sequences.append(sequence)

    telemetry = WorkerTelemetry(publish, clock_ns=lambda: 1_000)
    tasks = [asyncio.create_task(telemetry.emit("ready"))]
    try:
        # A generous watchdog bounds defects that never reach the publish edge.
        await asyncio.wait_for(first_publish_started.wait(), timeout=5)
        tasks.append(asyncio.create_task(telemetry.emit("stt_final")))
        await asyncio.sleep(0)
        assert published_sequences == []
    finally:
        release_first_publish.set()
        await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)
    assert published_sequences == [0, 1]


async def test_session_telemetry_ignores_interim_text_and_never_publishes_transcript(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("LIVEKIT_URL", "wss://probe.invalid")
    monkeypatch.setenv("LIVEKIT_API_KEY", "probe-public-key")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "probe-secret-value-is-never-sent-000")
    session = build_session(
        Candidate(
            stt="deepgram/flux-general-en",
            llm="google/gemma-4-31b-it",
            tts="fishaudio/s2.1-pro-free",
            voice="933563129e564b19a115bedd57b7406a",
        )
    )
    published: list[bytes] = []

    async def publish(payload: bytes) -> None:
        published.append(payload)

    attach_session_telemetry(session, WorkerTelemetry(publish))
    session.emit(
        "user_input_transcribed",
        UserInputTranscribedEvent(transcript="interim private words", is_final=False),
    )
    session.emit(
        "user_input_transcribed",
        UserInputTranscribedEvent(transcript="final private words", is_final=True),
    )
    await asyncio.sleep(0)

    assert [decode_telemetry(payload)["event"] for payload in published] == ["stt_final"]
    assert all(b"private" not in payload for payload in published)


async def test_clock_rpc_is_bound_to_probe_participant_and_sample() -> None:
    clock_values = iter((10_000, 11_000))
    handler = build_clock_rpc_handler(
        sample_id="sample-safe-id", clock_ns=lambda: next(clock_values)
    )

    response = await handler(
        SimpleNamespace(
            caller_identity="probe-browser-fixed",
            payload=json.dumps({"sample_id": "sample-safe-id", "browser_send_ms": 125.5}),
        )
    )

    assert json.loads(response) == {
        "sample_id": "sample-safe-id",
        "worker_receive_ns": 10_000,
        "worker_send_ns": 11_000,
    }


async def test_fixed_response_controller_schedules_one_interruptible_fixture() -> None:
    frames = [
        rtc.AudioFrame(
            data=bytes(960 * 2),
            sample_rate=48_000,
            num_channels=1,
            samples_per_channel=960,
        )
    ]
    controller = FixedResponseController(frames)
    session = _ResponseSession()

    with pytest.raises(agents.StopResponse):
        controller.begin(session)
    with pytest.raises(agents.StopResponse):
        controller.begin(session)

    assert len(session.calls) == 1
    call = session.calls[0]
    assert call["text"] == "Deterministic four-second probe response."
    assert call["allow_interruptions"] is True
    assert call["add_to_chat_ctx"] is False
    assert [frame async for frame in call["audio"]] == frames


def test_candidate_response_speaks_one_fish_ack_and_suppresses_the_default_reply() -> None:
    controller = AcknowledgementController()
    session = _AcknowledgementSession()

    with pytest.raises(agents.StopResponse):
        controller.begin(session)
    with pytest.raises(agents.StopResponse):
        controller.begin(session)

    assert session.calls == [
        {
            "text": "Okay.",
            "allow_interruptions": False,
            "add_to_chat_ctx": False,
        }
    ]


async def test_main_result_rpc_waits_for_idle_then_starts_the_measured_reply() -> None:
    events: list[str] = []
    published: list[bytes] = []

    class Session:
        async def wait_for_idle(self) -> None:
            events.append("idle")

        def generate_reply(
            self, *, instructions: str, allow_interruptions: bool
        ) -> _SpeechHandle:
            assert "runtime probe is ready" in instructions
            assert allow_interruptions is False
            events.append("generated")
            return _SpeechHandle()

    async def publish(payload: bytes) -> None:
        published.append(payload)

    clock_values = iter((1_000, 2_000))

    def clock() -> int:
        events.append("captured")
        return next(clock_values)

    handler = build_main_result_rpc_handler(
        job=ProbeJob.from_metadata(_job_metadata("candidate_response")),
        session=Session(),
        telemetry=WorkerTelemetry(publish, clock_ns=clock),
    )

    response = await handler(
        SimpleNamespace(
            caller_identity="probe-browser-fixed",
            payload=json.dumps({"sample_id": "sample-safe-id"}),
        )
    )

    assert json.loads(response) == {"accepted": True, "sample_id": "sample-safe-id"}
    assert events == ["idle", "captured", "captured", "generated"]
    assert [decode_telemetry(payload)["event"] for payload in published] == [
        "main_result",
        "runtime_event",
    ]


async def test_main_result_rpc_is_browser_sample_bound_and_single_use() -> None:
    class Session:
        async def wait_for_idle(self) -> None:
            pass

        def generate_reply(
            self, *, instructions: str, allow_interruptions: bool
        ) -> _SpeechHandle:
            return _SpeechHandle()

    async def publish(payload: bytes) -> None:
        pass

    handler = build_main_result_rpc_handler(
        job=ProbeJob.from_metadata(_job_metadata("candidate_response")),
        session=Session(),
        telemetry=WorkerTelemetry(publish, clock_ns=lambda: 1_000),
    )

    with pytest.raises(ValueError, match="caller"):
        await handler(
            SimpleNamespace(
                caller_identity="unrelated",
                payload=json.dumps({"sample_id": "sample-safe-id"}),
            )
        )
    with pytest.raises(ValueError, match="sample binding"):
        await handler(
            SimpleNamespace(
                caller_identity="probe-browser-fixed",
                payload=json.dumps({"sample_id": "other-sample"}),
            )
        )
    invocation = SimpleNamespace(
        caller_identity="probe-browser-fixed",
        payload=json.dumps({"sample_id": "sample-safe-id"}),
    )
    await handler(invocation)
    with pytest.raises(ValueError, match="only once"):
        await handler(invocation)

    with pytest.raises(ValueError, match="candidate-response"):
        build_main_result_rpc_handler(
            job=ProbeJob.from_metadata(_job_metadata("fixed_interruption")),
            session=Session(),
            telemetry=WorkerTelemetry(publish),
        )
