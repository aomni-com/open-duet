#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "${1:?Usage: reproduce.sh CHECKOUT OUTPUT_DIRECTORY}" && pwd)
mkdir -p "${2:?Usage: reproduce.sh CHECKOUT OUTPUT_DIRECTORY}"
out=$(cd "$2" && pwd)
assets=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out/evidence"
bun "$repo/packages/duet/scripts/build-public-package.ts" "$out/package"
(cd "$out/package" && npm pack --json --pack-destination "$out") > "$out/evidence/pack.json"
tarball=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text())[0].filename)' "$out/evidence/pack.json")
docker run --rm --platform linux/amd64 -v "$out:/out" oven/bun:1.3.14 cp /usr/local/bin/bun /out/bun-linux-x64
docker run --rm --platform linux/amd64 -v "$out:/out" -e HOME=/tmp/home node:24-bookworm \
  npm install --prefix /out/installed "/out/$tarball" > "$out/evidence/npm-install.txt" 2>&1
docker run --rm --network none --platform linux/amd64 \
  -v "$out/bun-linux-x64:/usr/local/bin/bun:ro" -v "$out/installed:/installed:ro" \
  -v "$assets/../packaging/probe.ts:/probe.ts:ro" \
  -v "$repo/packages/duet/test/fixtures/public-oauth-preload.ts:/preload.ts:ro" \
  -v "$out/evidence:/evidence" \
  -e 'PROBE_COMMAND=["bun","/installed/node_modules/@duetso/agent/dist/cli-entry.js"]' \
  node:24-bookworm bash -c '
    set -euo pipefail
    timeout --signal=KILL 90s bun /probe.ts
    HOME=/tmp/oauth-home PUBLIC_PATCH_REQUESTS=/evidence/oauth-requests.ndjson \
      DUET_CODEX_ORIGINATOR=public-package-fixture timeout --signal=KILL 30s \
      bun --preload /preload.ts /installed/node_modules/@duetso/agent/dist/cli-entry.js \
      connect chatgpt --json --no-browser > /evidence/oauth.txt
    tui_status=0
    HOME=/tmp/tui-home TERM=xterm-256color timeout --signal=INT 4s script -q -c \
      "stty rows 40 cols 120; bun /installed/node_modules/@duetso/agent/dist/cli-entry.js --incognito --no-auto-upgrade --model duet:anthropic/claude-haiku-4-5" \
      /evidence/tui.ansi >/dev/null 2>/evidence/tui.stderr || tui_status=$?
    test "$tui_status" = 124
    bun -e '\''import assert from "node:assert/strict"; const frame=Bun.stripANSI(await Bun.file("/evidence/tui.ansi").text()); for(const label of ["DUET AGENT","todos","relays","context"]) assert(frame.includes(label),label); assert(!/dlopen|ModuleNotFound|Fatal:|error:/i.test(frame)); console.log("PASS native TUI initialization");'\''
  ' > "$out/evidence/runtime.txt" 2>&1
printf 'PASS external npm package; evidence: %s\n' "$out/evidence"
