from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class ClockSyncSample:
    browser_send_ms: float
    worker_receive_ns: int
    worker_send_ns: int
    browser_receive_ms: float

    @property
    def network_round_trip_ms(self) -> float:
        browser_round_trip = self.browser_receive_ms - self.browser_send_ms
        worker_processing = (self.worker_send_ns - self.worker_receive_ns) / 1_000_000
        return browser_round_trip - worker_processing

    @property
    def worker_to_browser_offset_ms(self) -> float:
        browser_midpoint = (self.browser_send_ms + self.browser_receive_ms) / 2
        worker_midpoint = (self.worker_receive_ns + self.worker_send_ns) / 2_000_000
        return browser_midpoint - worker_midpoint


@dataclass(frozen=True)
class ClockCalibration:
    offset_ms: float
    network_round_trip_ms: float

    @property
    def uncertainty_ms(self) -> float:
        return self.network_round_trip_ms / 2

    def worker_to_browser_ms(self, captured_at_ns: int) -> float:
        return captured_at_ns / 1_000_000 + self.offset_ms


def calibrate_worker_clock(samples: Sequence[ClockSyncSample]) -> ClockCalibration:
    if len(samples) < 3:
        raise ValueError("clock calibration requires at least three samples")
    if any(sample.network_round_trip_ms < 0 for sample in samples):
        raise ValueError("clock sample has an impossible negative network round trip")
    selected = min(samples, key=lambda sample: sample.network_round_trip_ms)
    return ClockCalibration(
        offset_ms=selected.worker_to_browser_offset_ms,
        network_round_trip_ms=selected.network_round_trip_ms,
    )
