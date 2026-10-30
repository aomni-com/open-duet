import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, TypedDict, cast, get_args

TelemetryEventName = Literal[
    "ready",
    "stt_final",
    "main_result",
    "playout_stopped",
    "runtime_event",
    "llm_metrics",
    "tts_metrics",
    "eou_metrics",
]

TELEMETRY_TOPIC = "duet.voice.slice03.telemetry"

EVENT_NAMES: frozenset[str] = frozenset(get_args(TelemetryEventName))


class TelemetryPacket(TypedDict):
    event: TelemetryEventName
    sequence: int
    captured_at_ns: int
    metrics_ms: dict[str, float]


@dataclass
class TelemetryInbox:
    _next_sequence: int = 0
    _received: dict[TelemetryEventName, list[float]] = field(default_factory=dict)

    def accept(self, payload: bytes, *, received_at_ms: float) -> TelemetryPacket:
        packet = decode_telemetry(payload)
        if packet["sequence"] != self._next_sequence:
            raise ValueError("telemetry sequence must be strictly increasing without gaps")
        self._next_sequence += 1
        self._received.setdefault(packet["event"], []).append(received_at_ms)
        return packet

    def received_at_ms(self, event: TelemetryEventName) -> float:
        observations = self._received.get(event)
        if not observations:
            raise KeyError(event)
        return observations[-1]


def encode_telemetry(
    event: TelemetryEventName,
    *,
    sequence: int,
    captured_at_ns: int,
    metrics_ms: Mapping[str, int | float],
) -> bytes:
    packet = _validate_packet(
        {
            "event": event,
            "sequence": sequence,
            "captured_at_ns": captured_at_ns,
            "metrics_ms": dict(metrics_ms),
        }
    )
    return json.dumps(packet, separators=(",", ":"), sort_keys=True).encode()


def decode_telemetry(payload: bytes) -> TelemetryPacket:
    try:
        decoded = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("invalid telemetry JSON") from error
    if not isinstance(decoded, dict):
        raise ValueError("telemetry must be a JSON object")
    return _validate_packet(decoded)


def _validate_packet(packet: Mapping[str, object]) -> TelemetryPacket:
    if set(packet) != {"event", "sequence", "captured_at_ns", "metrics_ms"}:
        raise ValueError("telemetry fields do not match the probe contract")
    event = packet["event"]
    if not isinstance(event, str) or event not in EVENT_NAMES:
        raise ValueError("unknown telemetry event")
    sequence = packet["sequence"]
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
        raise ValueError("telemetry sequence must be a non-negative integer")
    captured_at_ns = packet["captured_at_ns"]
    if (
        not isinstance(captured_at_ns, int)
        or isinstance(captured_at_ns, bool)
        or captured_at_ns < 0
    ):
        raise ValueError("telemetry capture clock must be a non-negative integer")
    metrics = packet["metrics_ms"]
    if not isinstance(metrics, Mapping):
        raise ValueError("telemetry metrics must be an object")
    clean_metrics: dict[str, float] = {}
    for name, value in metrics.items():
        if (
            not isinstance(name, str)
            or not name
            or not isinstance(value, int | float)
            or isinstance(value, bool)
            or value < 0
        ):
            raise ValueError("telemetry metrics must be named non-negative numbers")
        clean_metrics[name] = float(value)
    return TelemetryPacket(
        event=cast(TelemetryEventName, event),
        sequence=sequence,
        captured_at_ns=captured_at_ns,
        metrics_ms=clean_metrics,
    )
