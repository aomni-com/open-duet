#!/usr/bin/env bash
set -euo pipefail

exec /usr/bin/google-chrome-stable \
  --class=duet-browser \
  --user-data-dir=/home/exedev/.duet/chrome \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --window-size=1296,720 \
  --window-position=72,48 \
  --no-first-run \
  --no-default-browser-check
