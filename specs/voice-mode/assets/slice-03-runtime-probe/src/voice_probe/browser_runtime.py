import base64
import binascii
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from playwright.async_api import Route, async_playwright

from voice_probe.clock_sync import ClockSyncSample
from voice_probe.telemetry import TelemetryEventName, TelemetryInbox


class BrowserPage(Protocol):
    async def evaluate(self, expression: str, argument: Any = None) -> Any: ...


@dataclass(frozen=True)
class BrowserWorkerProof:
    identity: str
    activation_instance_sha256: str


@dataclass(frozen=True)
class BrowserInputWindow:
    started_at_ms: float
    ends_at_ms: float


@dataclass(frozen=True)
class BrowserCandidateResponseProof:
    acknowledgement_first_signal_at_ms: float
    main_response_first_signal_at_ms: float
    main_result_captured_at_ns: int
    runtime_event_captured_at_ns: int
    caption_rendered_at_ms: float


@dataclass(frozen=True)
class BrowserInterruptionProof:
    pcm_s16le: bytes
    duration_ms: float
    sample_count: int
    sample_rate_hz: int
    first_signal_at_ms: float
    boundary_at_ms: float
    barge_in_started_at_ms: float
    playout_stopped_at_ms: float
    mute_latency_ms: float
    silence_proof_ms: int


class BrowserProbePage:
    def __init__(self, page: BrowserPage) -> None:
        self._page = page

    async def connect(
        self, *, livekit_url: str, participant_token: str, fixture: Path
    ) -> None:
        fixture_url = "data:audio/ogg;base64," + base64.b64encode(fixture.read_bytes()).decode()
        await self._page.evaluate(
            "options => window.voiceSlice03Probe.connect(options)",
            {
                "livekitUrl": livekit_url,
                "participantToken": participant_token,
                "fixtureUrl": fixture_url,
            },
        )

    async def wait_for_worker(self, expected_digest: str) -> BrowserWorkerProof:
        result = await self._page.evaluate(
            "digest => window.voiceSlice03Probe.waitForWorkerMetadata(digest)",
            expected_digest,
        )
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("workerIdentity"), str)
            or not isinstance(result.get("activationInstanceSha256"), str)
            or len(result["activationInstanceSha256"]) != 64
            or any(
                character not in "0123456789abcdef"
                for character in result["activationInstanceSha256"]
            )
        ):
            raise ValueError("browser worker proof does not match the probe contract")
        return BrowserWorkerProof(
            identity=result["workerIdentity"],
            activation_instance_sha256=result["activationInstanceSha256"],
        )

    async def collect_clock_samples(
        self, worker_identity: str, sample_id: str
    ) -> list[ClockSyncSample]:
        result = await self._page.evaluate(
            "([identity, sampleId]) => "
            "window.voiceSlice03Probe.collectClockSamples(identity, sampleId)",
            [worker_identity, sample_id],
        )
        if not isinstance(result, list):
            raise ValueError("browser clock samples must be a list")
        samples: list[ClockSyncSample] = []
        for raw in result:
            if not isinstance(raw, dict):
                raise ValueError("browser clock sample must be an object")
            browser_send_ms: object = raw.get("browserSendMs")
            worker_receive_ns: object = raw.get("workerReceiveNs")
            worker_send_ns: object = raw.get("workerSendNs")
            browser_receive_ms: object = raw.get("browserReceiveMs")
            if not isinstance(browser_send_ms, int | float) or isinstance(
                browser_send_ms, bool
            ):
                raise ValueError("browser clock sample timestamps must be numbers")
            if not isinstance(worker_receive_ns, int | float) or isinstance(
                worker_receive_ns, bool
            ):
                raise ValueError("browser clock sample timestamps must be numbers")
            if not isinstance(worker_send_ns, int | float) or isinstance(worker_send_ns, bool):
                raise ValueError("browser clock sample timestamps must be numbers")
            if not isinstance(browser_receive_ms, int | float) or isinstance(
                browser_receive_ms, bool
            ):
                raise ValueError("browser clock sample timestamps must be numbers")
            samples.append(
                ClockSyncSample(
                    browser_send_ms=float(browser_send_ms),
                    worker_receive_ns=int(worker_receive_ns),
                    worker_send_ns=int(worker_send_ns),
                    browser_receive_ms=float(browser_receive_ms),
                )
            )
        return samples

    async def start_input_fixture(self) -> BrowserInputWindow:
        result = await self._page.evaluate(
            "() => window.voiceSlice03Probe.startInputFixture()"
        )
        if not isinstance(result, dict):
            raise ValueError("browser input window must be an object")
        started_at_ms = _finite_number(result.get("startedAtMs"), "input start")
        ends_at_ms = _finite_number(result.get("endsAtMs"), "input end")
        if ends_at_ms <= started_at_ms:
            raise ValueError("browser input window must have positive duration")
        return BrowserInputWindow(started_at_ms=started_at_ms, ends_at_ms=ends_at_ms)

    async def wait_for_candidate_response(
        self, worker_identity: str, sample_id: str
    ) -> BrowserCandidateResponseProof:
        result = await self._page.evaluate(
            "([identity, sampleId]) => "
            "window.voiceSlice03Probe.waitForCandidateResponse(identity, sampleId)",
            [worker_identity, sample_id],
        )
        if not isinstance(result, dict):
            raise ValueError("browser candidate response proof must be an object")
        if result.get("audioContextState") != "running":
            raise ValueError("browser audio context was not running at first output")
        if result.get("outputTimestampSupported") is not True:
            raise ValueError("browser output timestamp was not available")

        raw_telemetry = result.get("telemetry")
        if not isinstance(raw_telemetry, list):
            raise ValueError("browser candidate telemetry must be a list")
        inbox = TelemetryInbox()
        packets: dict[TelemetryEventName, tuple[int, float]] = {}
        ordered_events: list[TelemetryEventName] = []
        for raw_item in raw_telemetry:
            if not isinstance(raw_item, dict) or not isinstance(raw_item.get("payload"), str):
                raise ValueError("browser candidate telemetry item must contain a payload")
            received_at_ms = _finite_number(
                raw_item.get("receivedAtMs"), "telemetry receipt time"
            )
            packet = inbox.accept(
                raw_item["payload"].encode(), received_at_ms=received_at_ms
            )
            if packet["event"] in packets:
                raise ValueError("browser candidate telemetry events must be unique")
            packets[packet["event"]] = (packet["captured_at_ns"], received_at_ms)
            ordered_events.append(packet["event"])

        required_events: tuple[TelemetryEventName, ...] = (
            "ready",
            "stt_final",
            "main_result",
            "runtime_event",
        )
        if any(event not in packets for event in required_events):
            raise ValueError("browser candidate telemetry is incomplete")
        if [ordered_events.index(event) for event in required_events] != sorted(
            ordered_events.index(event) for event in required_events
        ):
            raise ValueError("browser candidate telemetry milestones are out of order")

        caption_rendered_at_ms = _finite_number(
            result.get("captionRenderedAtMs"), "caption render time"
        )
        if caption_rendered_at_ms < packets["runtime_event"][1]:
            raise ValueError("browser caption rendered before receiving its runtime event")
        return BrowserCandidateResponseProof(
            acknowledgement_first_signal_at_ms=_finite_number(
                result.get("acknowledgementFirstSignalPerformanceTimeMs"),
                "acknowledgement first signal time",
            ),
            main_response_first_signal_at_ms=_finite_number(
                result.get("mainResponseFirstSignalPerformanceTimeMs"),
                "Main response first signal time",
            ),
            main_result_captured_at_ns=packets["main_result"][0],
            runtime_event_captured_at_ns=packets["runtime_event"][0],
            caption_rendered_at_ms=caption_rendered_at_ms,
        )

    async def interrupt_at_heard_boundary(
        self, worker_identity: str
    ) -> BrowserInterruptionProof:
        result = await self._page.evaluate(
            "identity => window.voiceSlice03Probe.interruptAtHeardBoundary(identity)",
            worker_identity,
        )
        if not isinstance(result, dict):
            raise ValueError("browser heard prefix must be an object")
        if result.get("audioContextState") != "running":
            raise ValueError("browser audio context was not running at heard-prefix boundary")
        if result.get("outputTimestampSupported") is not True:
            raise ValueError("browser output timestamp was not available")

        duration_ms = _finite_number(result.get("durationMs"), "heard-prefix duration")
        sample_count = _positive_int(result.get("sampleCount"), "heard-prefix sample count")
        sample_rate_hz = _positive_int(result.get("sampleRate"), "heard-prefix sample rate")
        if abs(duration_ms - sample_count * 1_000 / sample_rate_hz) > 0.000_001:
            raise ValueError("heard audio duration must preserve its exact sample count")
        first_signal_at_ms = _finite_number(
            result.get("firstSignalPerformanceTimeMs"), "first signal time"
        )
        boundary_at_ms = _finite_number(
            result.get("boundaryPerformanceTimeMs"), "heard-prefix boundary time"
        )
        if boundary_at_ms <= first_signal_at_ms:
            raise ValueError("heard-prefix boundary must follow the first signal")
        if abs((boundary_at_ms - first_signal_at_ms) - 1_200) > 1:
            raise ValueError("barge-in boundary must be 1.2 seconds after first signal")
        barge_in_started_at_ms = _finite_number(
            result.get("bargeInStartedPerformanceTimeMs"), "barge-in start"
        )
        playout_stopped_at_ms = _finite_number(
            result.get("playoutStoppedPerformanceTimeMs"), "playout stop"
        )
        mute_latency_ms = _finite_number(result.get("muteLatencyMs"), "mute latency")
        silence_proof_ms = _positive_int(result.get("silenceProofMs"), "silence proof")
        if playout_stopped_at_ms < barge_in_started_at_ms:
            raise ValueError("browser playout stop must follow barge-in")
        if abs((playout_stopped_at_ms - barge_in_started_at_ms) - mute_latency_ms) > 1:
            raise ValueError("browser mute latency does not match its timestamps")
        if abs((playout_stopped_at_ms - first_signal_at_ms) - duration_ms) > 1:
            raise ValueError("heard audio duration must end at measured playout stop")

        encoded = result.get("heardPcmBase64")
        if not isinstance(encoded, str):
            raise ValueError("browser heard prefix PCM must be base64")
        try:
            pcm_s16le = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("browser heard prefix PCM is invalid base64") from error
        expected_bytes = sample_count * 2
        if len(pcm_s16le) != expected_bytes:
            raise ValueError("browser heard prefix PCM length does not match its metadata")

        return BrowserInterruptionProof(
            pcm_s16le=pcm_s16le,
            duration_ms=duration_ms,
            sample_count=sample_count,
            sample_rate_hz=sample_rate_hz,
            first_signal_at_ms=first_signal_at_ms,
            boundary_at_ms=boundary_at_ms,
            barge_in_started_at_ms=barge_in_started_at_ms,
            playout_stopped_at_ms=playout_stopped_at_ms,
            mute_latency_ms=mute_latency_ms,
            silence_proof_ms=silence_proof_ms,
        )

    async def disconnect(self) -> None:
        await self._page.evaluate("() => window.voiceSlice03Probe.disconnect()")


def _finite_number(value: object, label: str) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError(f"browser {label} must be a finite number")
    return float(value)


def _positive_int(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"browser {label} must be a positive integer")
    return value


@asynccontextmanager
async def launch_browser_probe(
    *, executable: Path, bundle: Path
) -> AsyncIterator[BrowserProbePage]:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=str(executable),
            headless=False,
            ignore_default_args=["--mute-audio"],
            args=["--autoplay-policy=no-user-gesture-required"],
        )
        try:
            page = await browser.new_page()

            async def serve_probe(route: Route) -> None:
                await route.fulfill(
                    status=200,
                    content_type="text/html",
                    body="<!doctype html><html><title>Duet Voice probe</title></html>",
                )

            await page.route("https://voice-probe.invalid/**", serve_probe)
            await page.goto("https://voice-probe.invalid/")
            await page.add_script_tag(content=bundle.read_text())
            await page.wait_for_function("typeof window.voiceSlice03Probe === 'object'")
            yield BrowserProbePage(page)
        finally:
            await browser.close()
