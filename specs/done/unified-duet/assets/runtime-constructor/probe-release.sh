#!/usr/bin/env bash
set -euo pipefail

# Recheck an already constructed release; this is not another runtime builder.
release=$(cd "${1:?Pass the constructed runtime-release directory}" && pwd)
evidence=${2:?Pass an empty evidence output directory}
mkdir -p "$evidence"
evidence=$(cd "$evidence" && pwd)
asset_dir=$(cd "$(dirname "$0")" && pwd)
image="duet-runtime-probe:$(date +%s)-$$"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"; docker image rm "$image" >/dev/null 2>&1 || true' EXIT

# ripgrep is an OS prerequisite in the VM image, rather than an embedded asset.
docker build --platform linux/amd64 --tag "$image" - <<'DOCKER'
FROM oven/bun:1.3.14
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*
DOCKER

run_probe() {
  docker run --rm --platform linux/amd64 --network none \
    --mount "type=bind,src=$1,dst=/release,readonly" \
    --mount "type=bind,src=$asset_dir/probe.ts,dst=/probe.ts,readonly" \
    --mount "type=bind,src=$evidence,dst=/evidence" \
    "$image" sh -c "$2"
}
# Separate guest paths avoid Docker Desktop retaining the inode of a host-renamed receipt.
run_probe "$release" 'PROBE_EVIDENCE=/evidence/physical timeout 150s bun /probe.ts' >"$evidence/native.log" 2>&1
run_probe "$release" 'ln -s /release /tmp/current; BUN_BE_BUN=1 /tmp/current/duet -e '\''console.log(JSON.stringify({execPath:process.execPath}))'\''' >"$evidence/execpath.log" 2>&1
grep -Fx '{"execPath":"/release/duet"}' "$evidence/execpath.log"
run_probe "$release" 'ln -s /release /tmp/current; PROBE_COMMAND='\''["/tmp/current/duet"]'\'' PROBE_EVIDENCE=/evidence/symlink timeout 150s bun /probe.ts' >"$evidence/symlink-native.log" 2>&1

for kind in missing corrupt; do
  cp -R "$release" "$scratch/$kind"
  if [ "$kind" = missing ]; then
    rm "$scratch/$kind/photon_rs_bg.wasm"
  else
    printf 'invalid-runtime-sidecar' >"$scratch/$kind/photon_rs_bg.wasm"
  fi
  set +e
  run_probe "$scratch/$kind" 'PROBE_RPC_ONLY=1 timeout 150s bun /probe.ts' >"$evidence/photon-$kind.log" 2>&1
  code=$?
  set -e
  [ "$code" = 1 ]
  grep -Fq 'PHOTON_INLINE_IMAGE_REQUIRED' "$evidence/photon-$kind.log"
  grep -Fq 'Image omitted: could not be resized' "$evidence/photon-$kind.log"
done

set +e
run_probe "$release" 'HOME=/tmp TERM=xterm-256color timeout 8s script -q -c '\''stty cols 120 rows 40; /release/duet --incognito --no-auto-upgrade --model duet:anthropic/claude-haiku-4-5'\'' /evidence/tui.ansi' >"$evidence/tui.stdout" 2>"$evidence/tui.stderr"
code=$?
set -e
[ "$code" = 124 ]
python3 "$asset_dir/../packaging/compare.py" --tui "$evidence/tui.ansi" >"$evidence/tui.json"
printf 'PASS physical and current/duet native probes, Photon failure controls, TUI content\n'
