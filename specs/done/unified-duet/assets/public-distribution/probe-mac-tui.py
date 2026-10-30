"""Capture the installed CLI in a private PTY without taking desktop focus."""
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

bun, entry, output = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
chunks = []
with tempfile.TemporaryDirectory(prefix="duet-mac-tui-") as home:
    proc = subprocess.Popen(
        [bun, entry, "--incognito", "--no-auto-upgrade", "--model", "duet:anthropic/claude-haiku-4-5"],
        stdin=slave, stdout=slave, stderr=slave, cwd=home,
        env={"PATH": os.environ["PATH"], "HOME": home, "TERM": "xterm-256color"},
        start_new_session=True,
    )
    os.close(slave)
    deadline = time.monotonic() + 4
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGINT)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        os.close(master)
Path(output).write_bytes(b"".join(chunks))
