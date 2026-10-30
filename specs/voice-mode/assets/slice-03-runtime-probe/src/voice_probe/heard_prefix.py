from dataclasses import dataclass


@dataclass(frozen=True)
class TranscriptCue:
    text: str
    ends_at_ms: int


FIXED_RESPONSE_TRANSCRIPT_CUES = (
    TranscriptCue(text="One", ends_at_ms=500),
    TranscriptCue(text="two", ends_at_ms=1_000),
    TranscriptCue(text="three", ends_at_ms=1_500),
    TranscriptCue(text="four", ends_at_ms=4_000),
    TranscriptCue(text="This", ends_at_ms=4_000),
    TranscriptCue(text="tail", ends_at_ms=4_000),
    TranscriptCue(text="is", ends_at_ms=4_000),
    TranscriptCue(text="not", ends_at_ms=4_000),
    TranscriptCue(text="heard", ends_at_ms=4_000),
)


@dataclass(frozen=True)
class RetainedPrefix:
    pcm: bytes
    duration_ms: int
    transcript: str


class HeardPrefixLedger:
    """Retain captured PCM only through the last browser-acknowledged frame."""

    def __init__(
        self,
        *,
        sample_rate: int,
        frame_duration_ms: int,
        transcript_cues: tuple[TranscriptCue, ...],
    ) -> None:
        if 1_000 % frame_duration_ms:
            raise ValueError("frame duration must divide one second")
        self.sample_rate = sample_rate
        self.frame_duration_ms = frame_duration_ms
        self.transcript_cues = transcript_cues
        self.full_pcm = b""
        self._acknowledged_ms = 0

    def capture_silence(self, *, duration_ms: int) -> None:
        sample_count = self.sample_rate * duration_ms // 1_000
        self.full_pcm = bytes(sample_count * 2)

    def capture_pcm(self, pcm: bytes) -> None:
        frame_bytes = self.sample_rate * self.frame_duration_ms // 1_000 * 2
        if len(pcm) % frame_bytes:
            raise ValueError("PCM must contain whole frames")
        self.full_pcm = pcm

    def acknowledge_playout(self, position_ms: int) -> None:
        bounded_ms = min(position_ms, self._captured_duration_ms())
        frame_aligned_ms = bounded_ms - (bounded_ms % self.frame_duration_ms)
        self._acknowledged_ms = max(self._acknowledged_ms, frame_aligned_ms)

    def finalize(self) -> RetainedPrefix:
        retained_samples = self.sample_rate * self._acknowledged_ms // 1_000
        transcript = " ".join(
            cue.text for cue in self.transcript_cues if cue.ends_at_ms <= self._acknowledged_ms
        )
        return RetainedPrefix(
            pcm=self.full_pcm[: retained_samples * 2],
            duration_ms=self._acknowledged_ms,
            transcript=transcript,
        )

    def _captured_duration_ms(self) -> int:
        return len(self.full_pcm) * 1_000 // (self.sample_rate * 2)
