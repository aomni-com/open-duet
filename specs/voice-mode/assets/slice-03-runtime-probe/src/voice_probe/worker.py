import asyncio
import hashlib
import json
import os
import time
from collections import deque
from collections.abc import AsyncIterable, Awaitable, Callable, Mapping, Sequence
from typing import Protocol, TypedDict

from livekit import agents, rtc
from livekit.agents import Agent, AgentServer, AgentSession, TurnHandlingOptions, inference, llm
from livekit.agents.voice.events import UserInputTranscribedEvent

from voice_probe.cloud_media import PROBE_RESPONSE_FIXTURE, load_probe_response_frames
from voice_probe.contract import Candidate, ProbeJob, ProbeScenario
from voice_probe.telemetry import TELEMETRY_TOPIC, TelemetryEventName, encode_telemetry


def activation_instance_sha256() -> str:
    nonce = os.environ.get("VOICE_PROBE_ACTIVATION_NONCE", "")
    if not nonce:
        raise RuntimeError("voice probe must start through the activation launcher")
    return hashlib.sha256(nonce.encode()).hexdigest()


class SessionStartOptions(TypedDict):
    record: bool


def session_start_options() -> SessionStartOptions:
    return {"record": False}


class RpcInvocation(Protocol):
    caller_identity: str
    payload: str


class MainResultSession(Protocol):
    async def wait_for_idle(self) -> object: ...

    def generate_reply(
        self, *, instructions: str, allow_interruptions: bool
    ) -> object: ...


def build_clock_rpc_handler(
    *, sample_id: str, clock_ns: Callable[[], int] = time.perf_counter_ns
) -> Callable[[RpcInvocation], Awaitable[str]]:
    async def handle(invocation: RpcInvocation) -> str:
        worker_receive_ns = clock_ns()
        if not invocation.caller_identity.startswith("probe-browser-"):
            raise ValueError("clock caller is not the probe browser")
        payload = json.loads(invocation.payload)
        if not isinstance(payload, dict) or set(payload) != {"sample_id", "browser_send_ms"}:
            raise ValueError("clock payload does not match the probe contract")
        if payload["sample_id"] != sample_id:
            raise ValueError("clock sample binding mismatch")
        browser_send_ms = payload["browser_send_ms"]
        if (
            not isinstance(browser_send_ms, int | float)
            or isinstance(browser_send_ms, bool)
            or browser_send_ms < 0
        ):
            raise ValueError("clock browser timestamp is invalid")
        worker_send_ns = clock_ns()
        return json.dumps(
            {
                "sample_id": sample_id,
                "worker_receive_ns": worker_receive_ns,
                "worker_send_ns": worker_send_ns,
            },
            separators=(",", ":"),
            sort_keys=True,
        )

    return handle


def build_main_result_rpc_handler(
    *,
    job: ProbeJob,
    session: MainResultSession,
    telemetry: "WorkerTelemetry",
) -> Callable[[RpcInvocation], Awaitable[str]]:
    if job.scenario != "candidate_response":
        raise ValueError("Main result RPC requires the candidate-response scenario")
    accepted = False

    async def handle(invocation: RpcInvocation) -> str:
        nonlocal accepted
        if not invocation.caller_identity.startswith("probe-browser-"):
            raise ValueError("Main result caller is not the probe browser")
        payload = json.loads(invocation.payload)
        if not isinstance(payload, dict) or set(payload) != {"sample_id"}:
            raise ValueError("Main result payload does not match the probe contract")
        if payload["sample_id"] != job.sample_id:
            raise ValueError("Main result sample binding mismatch")
        if accepted:
            raise ValueError("Main result may be accepted only once")
        accepted = True
        await session.wait_for_idle()
        main_result = telemetry.schedule("main_result")
        runtime_event = telemetry.schedule("runtime_event")
        session.generate_reply(
            instructions=(
                "Paraphrase this checked Main result in at most six words: "
                "The runtime probe is ready."
            ),
            allow_interruptions=False,
        )
        await asyncio.gather(main_result, runtime_event)
        return json.dumps(
            {"accepted": True, "sample_id": job.sample_id},
            separators=(",", ":"),
            sort_keys=True,
        )

    return handle


class WorkerTelemetry:
    def __init__(
        self,
        publish: Callable[[bytes], Awaitable[None]],
        *,
        clock_ns: Callable[[], int] = time.perf_counter_ns,
    ) -> None:
        self._publish = publish
        self._clock_ns = clock_ns
        self._sequence = 0
        self._queue: deque[tuple[bytes, asyncio.Future[None]]] = deque()
        self._drain_task: asyncio.Task[None] | None = None

    def schedule(
        self,
        event: TelemetryEventName,
        *,
        metrics_ms: Mapping[str, int | float] | None = None,
    ) -> asyncio.Future[None]:
        payload = encode_telemetry(
            event,
            sequence=self._sequence,
            captured_at_ns=self._clock_ns(),
            metrics_ms=metrics_ms or {},
        )
        self._sequence += 1
        completion = asyncio.get_running_loop().create_future()
        self._queue.append((payload, completion))
        if self._drain_task is None or self._drain_task.done():
            self._drain_task = asyncio.create_task(self._drain())
        return completion

    async def emit(
        self,
        event: TelemetryEventName,
        *,
        metrics_ms: Mapping[str, int | float] | None = None,
    ) -> None:
        await self.schedule(event, metrics_ms=metrics_ms)

    async def _drain(self) -> None:
        while self._queue:
            payload, completion = self._queue.popleft()
            try:
                await self._publish(payload)
            except Exception as error:
                completion.set_exception(error)
            else:
                completion.set_result(None)


def attach_session_telemetry(session: AgentSession[None], telemetry: WorkerTelemetry) -> None:
    pending: set[asyncio.Future[None]] = set()

    def schedule(
        event: TelemetryEventName, metrics_ms: Mapping[str, int | float] | None = None
    ) -> None:
        completion = telemetry.schedule(event, metrics_ms=metrics_ms)
        pending.add(completion)

        def report_failure(future: asyncio.Future[None]) -> None:
            pending.discard(future)
            try:
                future.result()
            except Exception as error:
                asyncio.get_running_loop().call_exception_handler(
                    {"message": "voice probe telemetry publish failed", "exception": error}
                )

        completion.add_done_callback(report_failure)

    @session.on("user_input_transcribed")
    def user_input_transcribed(event: UserInputTranscribedEvent) -> None:
        if event.is_final:
            schedule("stt_final")


def build_session(candidate: Candidate) -> AgentSession[None]:
    return AgentSession(
        stt=inference.STT(model=candidate.stt, language="en"),
        llm=inference.LLM(
            model=candidate.llm,
            extra_kwargs={"temperature": 0, "max_completion_tokens": 40},
        ),
        tts=inference.TTS(
            model=candidate.tts,
            voice=candidate.voice,
            language="en",
            extra_kwargs={"latency": "low", "temperature": 0.2},
        ),
        vad=inference.VAD(model="silero", activation_threshold=0.4),
        turn_handling=TurnHandlingOptions(
            turn_detection="stt",
            endpointing={"mode": "fixed", "min_delay": 0.1, "max_delay": 0.8},
            interruption={"enabled": True, "mode": "vad", "min_duration": 0.05},
        ),
    )


class ResponseSession(Protocol):
    def say(
        self,
        text: str,
        *,
        audio: AsyncIterable[rtc.AudioFrame],
        allow_interruptions: bool,
        add_to_chat_ctx: bool,
    ) -> object: ...


class AcknowledgementSession(Protocol):
    def say(
        self,
        text: str,
        *,
        allow_interruptions: bool,
        add_to_chat_ctx: bool,
    ) -> object: ...


async def _response_audio(frames: Sequence[rtc.AudioFrame]) -> AsyncIterable[rtc.AudioFrame]:
    for frame in frames:
        yield frame


class FixedResponseController:
    def __init__(self, frames: Sequence[rtc.AudioFrame]) -> None:
        if not frames:
            raise ValueError("fixed response requires audio frames")
        self._frames = tuple(frames)
        self._started = False

    def begin(self, session: ResponseSession) -> None:
        if not self._started:
            self._started = True
            session.say(
                "Deterministic four-second probe response.",
                audio=_response_audio(self._frames),
                allow_interruptions=True,
                add_to_chat_ctx=False,
            )
        raise agents.StopResponse()


class AcknowledgementController:
    def __init__(self) -> None:
        self._started = False

    def begin(self, session: AcknowledgementSession) -> None:
        if not self._started:
            self._started = True
            session.say(
                "Okay.",
                allow_interruptions=False,
                add_to_chat_ctx=False,
            )
        raise agents.StopResponse()


class ProbeAgent(Agent):
    def __init__(
        self, response: FixedResponseController | AcknowledgementController
    ) -> None:
        self._response = response
        super().__init__(
            instructions=(
                "This is a latency probe. Reply in at most six plain words "
                "and do not repeat user text."
            )
        )

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        del turn_ctx, new_message
        self._response.begin(self.session)


def build_probe_agent(scenario: ProbeScenario) -> Agent:
    if scenario == "fixed_interruption":
        return ProbeAgent(
            FixedResponseController(load_probe_response_frames(PROBE_RESPONSE_FIXTURE))
        )
    return ProbeAgent(AcknowledgementController())


server = AgentServer()


@server.rtc_session(agent_name="duet-voice-slice03-probe")
async def probe_session(ctx: agents.JobContext) -> None:
    job = ProbeJob.from_metadata(ctx.job.metadata)
    session = build_session(job.candidate)
    ctx.room.local_participant.register_rpc_method(
        "probe.clock", build_clock_rpc_handler(sample_id=job.sample_id)
    )

    async def publish_telemetry(payload: bytes) -> None:
        await ctx.room.local_participant.publish_data(payload, topic=TELEMETRY_TOPIC)

    telemetry = WorkerTelemetry(publish_telemetry)
    attach_session_telemetry(session, telemetry)
    if job.scenario == "candidate_response":
        ctx.room.local_participant.register_rpc_method(
            "probe.main_result",
            build_main_result_rpc_handler(job=job, session=session, telemetry=telemetry),
        )
    await session.start(
        room=ctx.room, agent=build_probe_agent(job.scenario), **session_start_options()
    )
    metadata_digest = hashlib.sha256(ctx.job.metadata.encode()).hexdigest()
    await ctx.room.local_participant.set_attributes(
        {
            "probe.metadata_sha256": metadata_digest,
            "probe.activation_sha256": activation_instance_sha256(),
        }
    )
    await telemetry.emit("ready")


if __name__ == "__main__":
    agents.cli.run_app(server)
