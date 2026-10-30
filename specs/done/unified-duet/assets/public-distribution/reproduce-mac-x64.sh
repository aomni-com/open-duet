#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "${1:?Usage: reproduce-mac-x64.sh CHECKOUT X64_BUN INSTALLED_PACKAGE EVIDENCE}" && pwd)
bun_x64=${2:?X64_BUN is required}
installed=${3:?INSTALLED_PACKAGE is required}
mkdir -p "${4:?EVIDENCE is required}"
evidence=$(cd "$4" && pwd)
assets=$(cd "$(dirname "$0")" && pwd)
entry="$installed/dist/cli-entry.js"
"$bun_x64" -e 'import assert from "node:assert/strict"; assert.equal(process.arch,"x64"); assert.equal(process.platform,"darwin"); console.log(JSON.stringify({version:Bun.version,arch:process.arch,platform:process.platform,execPath:process.execPath}));' > "$evidence/process.json"
command=$("$bun_x64" -e 'console.log(JSON.stringify([process.execPath,process.argv[1]]))' "$entry")
PROBE_COMMAND="$command" PROBE_EVIDENCE="$evidence" "$bun_x64" \
  "$repo/specs/done/unified-duet/assets/packaging/probe.ts" > "$evidence/runtime.txt" 2>&1
python3 "$assets/probe-mac-tui.py" "$bun_x64" "$entry" "$evidence/tui.ansi"
"$bun_x64" -e 'import assert from "node:assert/strict"; const frame=Bun.stripANSI(await Bun.file(process.argv[1]).text()); for(const label of ["DUET AGENT","todos","relays","context"]) assert(frame.includes(label),label); assert(!/dlopen|ModuleNotFound|Fatal:|error:/i.test(frame)); console.log("PASS native x64 TUI initialization");' "$evidence/tui.ansi" > "$evidence/tui.txt"
printf 'PASS actual Darwin x64 external runtime; evidence: %s\n' "$evidence"
