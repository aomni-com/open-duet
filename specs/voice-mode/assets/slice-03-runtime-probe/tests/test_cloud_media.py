from pathlib import Path

from livekit import rtc

from voice_probe.cloud_media import (
    add_probe_carrier,
    load_ogg_opus_frames,
    load_probe_response_frames,
)


def test_checked_fixture_becomes_exact_twenty_millisecond_livekit_frames() -> None:
    fixture = Path(__file__).parents[1] / "fixtures" / "four-second-spoken.ogg"

    frames = load_ogg_opus_frames(fixture)

    assert sum(frame.duration for frame in frames) == 4.0
    assert {frame.sample_rate for frame in frames} == {48_000}
    assert {frame.num_channels for frame in frames} == {1}
    assert {frame.samples_per_channel for frame in frames} == {960}
    assert any(any(bytes(frame.data)) for frame in frames)


def test_probe_response_keeps_a_measurable_carrier_through_spoken_pauses() -> None:
    silence = rtc.AudioFrame(
        data=bytes(960 * 2),
        sample_rate=48_000,
        num_channels=1,
        samples_per_channel=960,
    )

    marked = add_probe_carrier([silence, silence])

    assert len(marked) == 2
    assert all(len(bytes(frame.data)) == 960 * 2 for frame in marked)
    assert all(any(bytes(frame.data)) for frame in marked)
    assert bytes(marked[0].data) != bytes(marked[1].data)


def test_checked_probe_response_remains_exactly_four_seconds() -> None:
    fixture = Path(__file__).parents[1] / "fixtures" / "four-second-spoken.ogg"

    frames = load_probe_response_frames(fixture)

    assert sum(frame.duration for frame in frames) == 4.0
    assert len(frames) == 200
