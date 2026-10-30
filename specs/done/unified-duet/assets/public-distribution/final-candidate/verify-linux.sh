#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "${1:?CHECKOUT required}" && pwd)
out=$(cd "${2:?ARTIFACT_DIRECTORY required}" && pwd)
image=${3:?PINNED_AGENT_TEST_IMAGE_ID required}
installed=$(cd "${4:?INSTALLED_PACKAGE_ROOT required}" && pwd)
assets="$repo/specs/done/unified-duet/assets"
mkdir -p "$out/linux"
docker run --rm --network none --platform linux/amd64 \
  -v "$installed:/installed:ro" -v "$out/linux:/evidence" \
  -v "$assets/packaging/probe.ts:/native.ts:ro" \
  -v "$assets/public-distribution/final-candidate/probe.ts:/journey.ts:ro" \
  -v "$repo/packages/duet/test/fixtures/public-oauth-preload.ts:/preload.ts:ro" \
  -e 'PROBE_COMMAND=["/usr/bin/env","DUET_NO_AUTO_UPGRADE=1","bun","/installed/node_modules/@duetso/agent/dist/cli-entry.js"]' \
  -e DUET_NO_AUTO_UPGRADE=1 \
  -e PROBE_EVIDENCE=/evidence -e HOME=/tmp/home \
  "$image" bash -c '
    set -euo pipefail
    entry=/installed/node_modules/@duetso/agent/dist/cli-entry.js
    bun /journey.ts "$entry" /evidence
    timeout --signal=KILL 90s bun /native.ts
    HOME=/tmp/oauth PUBLIC_PATCH_REQUESTS=/evidence/oauth.ndjson \
      DUET_CODEX_ORIGINATOR=public-package-fixture \
      bun --no-install --preload /preload.ts "$entry" connect chatgpt --json --no-browser > /evidence/oauth.txt
    tui_status=0
    HOME=/tmp/tui TERM=xterm-256color timeout --signal=INT 4s script -q -c \
      "stty rows 40 cols 120; bun --no-install $entry --incognito --no-auto-upgrade --model duet:anthropic/claude-haiku-4-5" \
      /evidence/tui.ansi >/dev/null 2>/evidence/tui.stderr || tui_status=$?
    test "$tui_status" = 124
    bun -e '\''import assert from "node:assert/strict"; const frame=Bun.stripANSI(await Bun.file("/evidence/tui.ansi").text()); for(const label of ["DUET AGENT","todos","relays","context"]) assert(frame.includes(label),label); assert(!/dlopen|ModuleNotFound|Fatal:|error:/i.test(frame)); const requests=(await Bun.file("/evidence/oauth.ndjson").text()).trim().split("\n").map(JSON.parse); assert.equal(requests.find(r=>r.url.endsWith("/responses")).headers.originator,"public-package-fixture"); assert((await Bun.file("/evidence/oauth.txt").text()).includes("plan_ineligible")); console.log("PASS native TUI and frozen Pi OAuth originator fixture");'\''
  '
