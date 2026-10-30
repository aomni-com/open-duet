import hashlib
import io
import math
from array import array
from fractions import Fraction
from pathlib import Path
from typing import Any, TypedDict, cast

import av

from voice_probe.heard_prefix import FIXED_RESPONSE_TRANSCRIPT_CUES, HeardPrefixLedger

SAMPLE_RATE = 48_000
FRAME_DURATION_MS = 20


class FixtureEvidence(TypedDict):
    container_mime: str
    full_duration_ms: int
    full_bytes: int
    full_sha256: str
    prefix_duration_ms: int
    prefix_bytes: int
    prefix_sha256: str
    retained_transcript: str


def encode_fixture_pair(
    *, full_path: Path, prefix_path: Path, source_path: Path | None = None
) -> FixtureEvidence:
    full_pcm = (
        _decode_pcm(source_path)
        if source_path is not None
        else _spoken_surrogate_pcm(duration_ms=4_000)
    )
    ledger = HeardPrefixLedger(
        sample_rate=SAMPLE_RATE,
        frame_duration_ms=FRAME_DURATION_MS,
        transcript_cues=FIXED_RESPONSE_TRANSCRIPT_CUES,
    )
    ledger.capture_pcm(full_pcm)
    ledger.acknowledge_playout(1_200)
    retained = ledger.finalize()

    _encode_ogg_opus(full_path, full_pcm)
    _encode_ogg_opus(prefix_path, retained.pcm)

    return FixtureEvidence(
        container_mime="audio/ogg;codecs=opus",
        full_duration_ms=decode_duration_ms(full_path),
        full_bytes=full_path.stat().st_size,
        full_sha256=_sha256(full_path),
        prefix_duration_ms=decode_duration_ms(prefix_path),
        prefix_bytes=prefix_path.stat().st_size,
        prefix_sha256=_sha256(prefix_path),
        retained_transcript=retained.transcript,
    )


def normalize_spoken_source(*, input_path: Path, output_path: Path) -> None:
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    pcm_parts: list[bytes] = []
    with av.open(str(input_path)) as container:
        for decoded in container.decode(audio=0):
            for frame in resampler.resample(decoded):
                pcm_parts.append(bytes(frame.planes[0])[: frame.samples * 2])
        for frame in resampler.resample(None):
            pcm_parts.append(bytes(frame.planes[0])[: frame.samples * 2])
    target_bytes = SAMPLE_RATE * 4 * 2
    pcm = b"".join(pcm_parts)[:target_bytes].ljust(target_bytes, b"\0")
    _encode_ogg_opus(output_path, pcm)


def decode_duration_ms(path: Path) -> int:
    with av.open(str(path)) as container:
        return _decoded_duration_ms(container)


def decode_ogg_opus_pcm_s16le(encoded: bytes) -> bytes:
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    output: list[bytes] = []
    with av.open(io.BytesIO(encoded)) as container:
        input_container = cast(av.container.InputContainer, container)
        for decoded in input_container.decode(audio=0):
            for frame in resampler.resample(decoded):
                output.append(bytes(frame.planes[0])[: frame.samples * 2])
        for frame in resampler.resample(None):
            output.append(bytes(frame.planes[0])[: frame.samples * 2])
    return b"".join(output)


def encode_pcm_ogg_opus(pcm: bytes, *, sample_rate: int) -> bytes:
    samples_per_input_frame, input_frame_bytes = _validated_pcm_shape(pcm, sample_rate)

    output = io.BytesIO()
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    packets: list[av.Packet[Any]] = []
    with av.open(output, mode="w", format="ogg") as container:
        container.flags |= cast(int, av.container.Flags.bitexact.value)
        stream = container.add_stream("libopus", rate=SAMPLE_RATE)
        stream.layout = "mono"
        stream.bit_rate = 32_000
        for frame_index, offset in enumerate(range(0, len(pcm), input_frame_bytes)):
            frame = av.AudioFrame(
                format="s16", layout="mono", samples=samples_per_input_frame
            )
            frame.sample_rate = sample_rate
            frame.pts = frame_index * samples_per_input_frame
            frame.time_base = Fraction(1, sample_rate)
            frame.planes[0].update(
                pcm[offset : offset + input_frame_bytes].ljust(input_frame_bytes, b"\0")
            )
            for resampled in resampler.resample(frame):
                packets.extend(stream.encode(resampled))
        for resampled in resampler.resample(None):
            packets.extend(stream.encode(resampled))
        packets.extend(stream.encode(None))
        last_duration = packets[-1].duration if packets else None
        if last_duration is None or last_duration <= 0:
            raise ValueError("Opus encoder did not expose an end-trimmable packet")
        target_samples = round((len(pcm) // 2) * SAMPLE_RATE / sample_rate)
        packets[-1].pts = target_samples - last_duration
        packets[-1].dts = packets[-1].pts
        for packet in packets:
            container.mux(packet)
    return output.getvalue()


def _spoken_surrogate_pcm(*, duration_ms: int) -> bytes:
    samples = array("h")
    sample_count = SAMPLE_RATE * duration_ms // 1_000
    for index in range(sample_count):
        word = index // (SAMPLE_RATE // 2)
        frequency = 180 + word * 30
        envelope = min(1.0, (index % (SAMPLE_RATE // 2)) / (SAMPLE_RATE * 0.02))
        samples.append(
            round(8_000 * envelope * math.sin(2 * math.pi * frequency * index / SAMPLE_RATE))
        )
    return samples.tobytes()


def _decode_pcm(path: Path) -> bytes:
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    pcm_parts: list[bytes] = []
    with av.open(str(path)) as container:
        for decoded in container.decode(audio=0):
            for frame in resampler.resample(decoded):
                pcm_parts.append(bytes(frame.planes[0])[: frame.samples * 2])
        for frame in resampler.resample(None):
            pcm_parts.append(bytes(frame.planes[0])[: frame.samples * 2])
    target_bytes = SAMPLE_RATE * 4 * 2
    return b"".join(pcm_parts)[:target_bytes].ljust(target_bytes, b"\0")


def _encode_ogg_opus(path: Path, pcm: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode_pcm_ogg_opus(pcm, sample_rate=SAMPLE_RATE))


def _validated_pcm_shape(pcm: bytes, sample_rate: int) -> tuple[int, int]:
    if sample_rate <= 0 or sample_rate % (1_000 // FRAME_DURATION_MS):
        raise ValueError("PCM sample rate must contain whole 20 ms frames")
    samples_per_input_frame = sample_rate * FRAME_DURATION_MS // 1_000
    input_frame_bytes = samples_per_input_frame * 2
    if not pcm or len(pcm) % 2:
        raise ValueError("PCM must contain non-empty signed 16-bit samples")
    return samples_per_input_frame, input_frame_bytes


def _decoded_duration_ms(container: av.container.InputContainer) -> int:
    duration_ms = 0.0
    for frame in container.decode(audio=0):
        if not frame.sample_rate:
            raise ValueError("decoded audio frame has no sample rate")
        duration_ms += frame.samples * 1_000 / frame.sample_rate
    return round(duration_ms)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
