import json
from typing import cast

import pytest

from voice_probe.telemetry import (
    TelemetryEventName,
    TelemetryInbox,
    decode_telemetry,
    encode_telemetry,
)


def test_worker_telemetry_is_content_free_and_closed_to_unknown_events() -> None:
    payload = encode_telemetry(
        "stt_final",
        sequence=3,
        captured_at_ns=9_000_123,
        metrics_ms={"provider_latency": 187.4},
    )

    assert decode_telemetry(payload) == {
        "event": "stt_final",
        "sequence": 3,
        "captured_at_ns": 9_000_123,
        "metrics_ms": {"provider_latency": 187.4},
    }
    assert not ({"text", "transcript", "audio", "prompt"} & set(json.loads(payload)))

    with pytest.raises(ValueError, match="unknown telemetry event"):
        encode_telemetry(
            cast(TelemetryEventName, "transcript"),
            sequence=4,
            captured_at_ns=9_000_124,
            metrics_ms={},
        )


def test_telemetry_inbox_rejects_duplicate_or_out_of_order_worker_packets() -> None:
    inbox = TelemetryInbox()
    inbox.accept(
        encode_telemetry("ready", sequence=0, captured_at_ns=1, metrics_ms={}),
        received_at_ms=100,
    )
    inbox.accept(
        encode_telemetry("stt_final", sequence=1, captured_at_ns=2, metrics_ms={}),
        received_at_ms=250,
    )

    assert inbox.received_at_ms("ready") == 100
    assert inbox.received_at_ms("stt_final") == 250
    with pytest.raises(ValueError, match="strictly increasing"):
        inbox.accept(
            encode_telemetry("stt_final", sequence=1, captured_at_ns=3, metrics_ms={}),
            received_at_ms=260,
        )
