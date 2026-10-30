from voice_probe.heard_prefix import HeardPrefixLedger, TranscriptCue


def test_duplicate_acknowledgement_retains_only_completed_heard_prefix() -> None:
    ledger = HeardPrefixLedger(
        sample_rate=48_000,
        frame_duration_ms=20,
        transcript_cues=(
            TranscriptCue(text="One", ends_at_ms=500),
            TranscriptCue(text="two", ends_at_ms=1_000),
            TranscriptCue(text="three", ends_at_ms=1_500),
            TranscriptCue(text="four", ends_at_ms=4_000),
        ),
    )
    ledger.capture_silence(duration_ms=4_000)

    ledger.acknowledge_playout(1_200)
    ledger.acknowledge_playout(1_200)

    retained = ledger.finalize()
    assert retained.duration_ms == 1_200
    assert retained.transcript == "One two"
    assert len(retained.pcm) < len(ledger.full_pcm)


def test_mid_word_disconnect_keeps_the_last_complete_word_and_never_grows() -> None:
    ledger = HeardPrefixLedger(
        sample_rate=48_000,
        frame_duration_ms=20,
        transcript_cues=(
            TranscriptCue(text="One", ends_at_ms=500),
            TranscriptCue(text="two", ends_at_ms=1_000),
            TranscriptCue(text="three", ends_at_ms=1_800),
        ),
    )
    ledger.capture_silence(duration_ms=4_000)

    ledger.acknowledge_playout(1_550)
    ledger.acknowledge_playout(1_100)

    retained = ledger.finalize()
    assert retained.duration_ms == 1_540
    assert retained.transcript == "One two"
