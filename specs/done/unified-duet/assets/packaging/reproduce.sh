#!/usr/bin/env bash
set -euo pipefail
source_repo=${1:?Usage: reproduce.sh SOURCE_REPO OUTPUT_DIRECTORY}
output=$(mkdir -p "${2:?Usage: reproduce.sh SOURCE_REPO OUTPUT_DIRECTORY}" && cd "$2" && pwd)
probe_dir=$(cd "$(dirname "$0")" && pwd)
reference=cad4c4ee7ab6ad822e11e9f64bf296cc2acd05b4
scratch=$(mktemp -d)
image="unified-duet-proof-$$"
trap 'docker image rm "$image" >/dev/null 2>&1 || true; rm -rf "$scratch"' EXIT
mkdir -p "$scratch/source" "$output/payload" "$output/source" "$output/candidate"
git -C "$source_repo" archive "$reference" | tar -x -C "$scratch/source"
docker run --rm --platform linux/amd64 -v "$scratch/source:/source" -v "$output:/out" -w /source -e HOME=/tmp/home oven/bun:1.3.14 sh -lc 'bun install --frozen-lockfile --ignore-scripts && bun -e '\''import {prepareDuetArtifact} from "./benchmarks/swebench/src/packaging.ts"; console.log(JSON.stringify(await prepareDuetArtifact({repoRoot:process.cwd(),outputDir:"/out/payload"}),null,2))'\'' && cp node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm /out/payload/' > "$output/build.log" 2>&1
# ripgrep is an OS prerequisite already present in Duet's VM image, not a registry runtime install.
docker build --platform linux/amd64 -t "$image" - > "$output/container-build.log" 2>&1 <<'DOCKERFILE'
FROM oven/bun:1.3.14
RUN apt-get update -qq && apt-get install -y -qq ripgrep >/dev/null && rm -rf /var/lib/apt/lists/*
DOCKERFILE
for mode in source candidate; do
  if [[ "$mode" == source ]]; then
    mounts=(-v "$scratch/source:/source:ro" -e 'PROBE_COMMAND=["bun","/source/src/cli-entry.ts"]')
  else
    mounts=(-v "$output/payload:/release:ro")
  fi
  docker run --rm --network none --platform linux/amd64 "${mounts[@]}" -v "$probe_dir/probe.ts:/probe.ts:ro" -v "$output/$mode:/evidence" "$image" timeout --signal=KILL 90s bun /probe.ts > "$output/$mode.log" 2>&1
  if [[ "$mode" == source ]]; then command='bun /source/src/cli-entry.ts'; else command='/release/duet-linux-x64'; fi
  docker run --rm --network none --platform linux/amd64 "${mounts[@]}" -v "$output/$mode:/evidence" "$image" sh -lc "mkdir -p /tmp/home; HOME=/tmp/home TERM=xterm-256color timeout --signal=INT 4s script -q -c 'stty rows 40 cols 120; $command --incognito --no-auto-upgrade --model duet:anthropic/claude-haiku-4-5' /evidence/tui.ansi >/dev/null 2>/evidence/tui.stderr; test \$? = 124"
done
python3 "$probe_dir/compare.py" --tui "$output/source/tui.ansi" "$output/candidate/tui.ansi" > "$output/tui.json"
for variant in missing corrupt; do
  mkdir -p "$scratch/broken"
  cp -R "$output/payload/." "$scratch/broken/"
  if [[ "$variant" == missing ]]; then
    rm "$scratch/broken/photon_rs_bg.wasm"
  else
    printf 'invalid-runtime-sidecar' > "$scratch/broken/photon_rs_bg.wasm"
  fi
  if docker run --rm --network none --platform linux/amd64 -v "$scratch/broken:/release:ro" -v "$probe_dir/probe.ts:/probe.ts:ro" "$image" timeout --signal=KILL 90s bun /probe.ts > "$output/photon-$variant.log" 2>&1; then
    printf 'FAIL: %s Photon sidecar unexpectedly passed image read\n' "$variant" >&2
    exit 1
  else
    status=$?
    test "$status" = 1
  fi
  python3 -c 'import pathlib,sys; assert "Image omitted: could not be resized" in pathlib.Path(sys.argv[1]).read_text()' "$output/photon-$variant.log"
  rm -rf "$scratch/broken"
done
python3 "$probe_dir/compare.py" "$output/source/runtime.json" "$output/candidate/runtime.json" > "$output/parity.json"
printf 'PASS: frozen source and complete relocated payload. Evidence: %s\n' "$output"
