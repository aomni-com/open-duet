import pytest

from voice_probe.retention_commit import commit_retained_prefix


def test_upload_failure_never_commits_an_event_and_retry_can_succeed() -> None:
    events: list[str] = []
    attempts = 0

    def upload(_: bytes) -> str:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("synthetic upload failure")
        return "media-safe-id"

    with pytest.raises(OSError, match="synthetic upload failure"):
        commit_retained_prefix(b"heard", upload=upload, append_event=events.append)

    assert events == []
    assert commit_retained_prefix(b"heard", upload=upload, append_event=events.append) == (
        "media-safe-id"
    )
    assert events == ["media-safe-id"]
