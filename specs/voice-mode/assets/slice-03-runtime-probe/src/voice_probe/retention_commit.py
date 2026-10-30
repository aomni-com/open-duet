from collections.abc import Callable


def commit_retained_prefix(
    prefix: bytes,
    *,
    upload: Callable[[bytes], str],
    append_event: Callable[[str], None],
) -> str:
    media_id = upload(prefix)
    append_event(media_id)
    return media_id
