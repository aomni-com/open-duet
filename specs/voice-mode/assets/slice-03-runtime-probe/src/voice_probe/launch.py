import os
import secrets
import sys


def main() -> None:
    os.environ["VOICE_PROBE_ACTIVATION_NONCE"] = secrets.token_hex(32)
    os.execv(
        sys.executable,
        [sys.executable, "-m", "voice_probe.worker", *sys.argv[1:]],
    )


if __name__ == "__main__":
    main()
