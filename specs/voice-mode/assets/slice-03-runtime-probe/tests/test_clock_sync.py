from voice_probe.clock_sync import ClockSyncSample, calibrate_worker_clock


def test_clock_calibration_uses_minimum_network_round_trip_and_reports_uncertainty() -> None:
    calibration = calibrate_worker_clock(
        [
            ClockSyncSample(100.0, 1_050_000_000, 1_051_000_000, 132.0),
            ClockSyncSample(200.0, 1_140_000_000, 1_141_000_000, 212.0),
            ClockSyncSample(300.0, 1_230_000_000, 1_231_000_000, 340.0),
        ]
    )

    assert calibration.network_round_trip_ms == 11.0
    assert calibration.uncertainty_ms == 5.5
    assert calibration.worker_to_browser_ms(1_150_000_000) == 215.5
