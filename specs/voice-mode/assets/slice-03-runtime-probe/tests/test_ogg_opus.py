from pathlib import Path

from voice_probe.ogg_opus import (
    decode_duration_ms,
    decode_ogg_opus_pcm_s16le,
    encode_fixture_pair,
    encode_pcm_ogg_opus,
)


def test_four_second_fixture_retains_only_the_acknowledged_1_2_second_prefix(
    tmp_path: Path,
) -> None:
    full_path = tmp_path / "full.ogg"
    prefix_path = tmp_path / "prefix.ogg"
    source_path = Path(__file__).parents[1] / "fixtures" / "four-second-spoken.ogg"

    evidence = encode_fixture_pair(
        full_path=full_path,
        prefix_path=prefix_path,
        source_path=source_path,
    )

    assert abs(decode_duration_ms(full_path) - 4_000) <= 20
    assert abs(decode_duration_ms(prefix_path) - 1_200) <= 20
    assert prefix_path.stat().st_size < full_path.stat().st_size
    assert evidence["retained_transcript"] == "One two"


def test_fixture_encoding_is_byte_reproducible(tmp_path: Path) -> None:
    source_path = Path(__file__).parents[1] / "fixtures" / "four-second-spoken.ogg"
    first = tmp_path / "first"
    second = tmp_path / "second"

    first_evidence = encode_fixture_pair(
        full_path=first / "full.ogg",
        prefix_path=first / "prefix.ogg",
        source_path=source_path,
    )
    second_evidence = encode_fixture_pair(
        full_path=second / "full.ogg",
        prefix_path=second / "prefix.ogg",
        source_path=source_path,
    )

    assert first_evidence == second_evidence
    assert (first / "full.ogg").read_bytes() == (second / "full.ogg").read_bytes()
    assert (first / "prefix.ogg").read_bytes() == (second / "prefix.ogg").read_bytes()


def test_browser_prefix_encoding_normalizes_a_mobile_sample_rate_in_memory() -> None:
    pcm = bytes(44_100 * 1_200 // 1_000 * 2)

    encoded = encode_pcm_ogg_opus(pcm, sample_rate=44_100)

    decoded = decode_ogg_opus_pcm_s16le(encoded)
    assert len(decoded) * 1_000 / (48_000 * 2) == 1_200


def test_ogg_end_granule_preserves_an_arbitrary_measured_stop_sample() -> None:
    pcm = bytes(64_801 * 2)

    encoded = encode_pcm_ogg_opus(pcm, sample_rate=48_000)

    assert len(decode_ogg_opus_pcm_s16le(encoded)) == len(pcm)
