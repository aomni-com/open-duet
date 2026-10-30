import sys
from array import array
from collections.abc import Iterable
from pathlib import Path

import av
from livekit import rtc

SAMPLE_RATE = 48_000
NUM_CHANNELS = 1
FRAME_DURATION_MS = 20
SAMPLES_PER_FRAME = SAMPLE_RATE * FRAME_DURATION_MS // 1_000
BYTES_PER_FRAME = SAMPLES_PER_FRAME * NUM_CHANNELS * 2
CARRIER_AMPLITUDE = 640
CARRIER_HALF_PERIOD_SAMPLES = 7
PROBE_RESPONSE_FIXTURE = Path(__file__).parents[2] / "fixtures" / "four-second-spoken.ogg"


def load_ogg_opus_frames(path: Path) -> list[rtc.AudioFrame]:
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    pcm_parts: list[bytes] = []
    with av.open(str(path)) as container:
        for decoded in container.decode(audio=0):
            for frame in resampler.resample(decoded):
                pcm_parts.append(bytes(frame.planes[0])[: frame.samples * 2])
        for frame in resampler.resample(None):
            pcm_parts.append(bytes(frame.planes[0])[: frame.samples * 2])

    pcm = b"".join(pcm_parts)
    if len(pcm) % BYTES_PER_FRAME:
        raise ValueError("fixture must contain whole 20 ms frames")
    return [
        rtc.AudioFrame(
            data=pcm[offset : offset + BYTES_PER_FRAME],
            sample_rate=SAMPLE_RATE,
            num_channels=NUM_CHANNELS,
            samples_per_channel=SAMPLES_PER_FRAME,
        )
        for offset in range(0, len(pcm), BYTES_PER_FRAME)
    ]


def add_probe_carrier(frames: Iterable[rtc.AudioFrame]) -> list[rtc.AudioFrame]:
    marked: list[rtc.AudioFrame] = []
    sample_offset = 0
    for frame in frames:
        if frame.sample_rate != SAMPLE_RATE or frame.num_channels != NUM_CHANNELS:
            raise ValueError("probe response frames must be 48 kHz mono")
        samples = array("h")
        samples.frombytes(bytes(frame.data))
        if sys.byteorder != "little":
            samples.byteswap()
        for index, sample in enumerate(samples):
            phase = (sample_offset + index) // CARRIER_HALF_PERIOD_SAMPLES
            carrier = CARRIER_AMPLITUDE if phase % 2 == 0 else -CARRIER_AMPLITUDE
            samples[index] = max(-32_768, min(32_767, sample + carrier))
        sample_offset += len(samples)
        if sys.byteorder != "little":
            samples.byteswap()
        marked.append(
            rtc.AudioFrame(
                data=samples.tobytes(),
                sample_rate=frame.sample_rate,
                num_channels=frame.num_channels,
                samples_per_channel=frame.samples_per_channel,
            )
        )
    return marked


def load_probe_response_frames(path: Path) -> list[rtc.AudioFrame]:
    frames = add_probe_carrier(load_ogg_opus_frames(path))
    if sum(frame.duration for frame in frames) != 4.0:
        raise ValueError("probe response fixture must be exactly four seconds")
    return frames
