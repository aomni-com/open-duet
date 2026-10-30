#!/usr/bin/env bash

set -euo pipefail

# Closeout files share the existing repository mount; no host credentials or
# extra filesystem mounts are needed by the unified journey.
container_path() {
  if [[ "$1" == /work/* ]]; then
    printf '%s' "$1"
    return
  fi
  local canonical repository_path
  repository_path="$(pwd -P)"
  canonical="$(realpath "$1")"
  case "$canonical" in
    "$repository_path"/*) printf '/work/%s' "${canonical#"$repository_path"/}" ;;
    *) echo 'Staging journey inputs must live under the repository /work mount' >&2; return 1 ;;
  esac
}

if [[ -n "${DUET_E2E_UNIFIED_EVIDENCE:-}" ]]; then
  normalized_evidence="$(container_path "$DUET_E2E_UNIFIED_EVIDENCE")"
  export DUET_E2E_UNIFIED_EVIDENCE="$normalized_evidence"
fi
if [[ -n "${DUET_SYNCTHING_BIN:-}" ]]; then
  normalized_syncthing="$(container_path "$DUET_SYNCTHING_BIN")"
  export DUET_SYNCTHING_BIN="$normalized_syncthing"
fi

exec docker run --rm \
  -v "$PWD:/work" -w /work \
  -v /work/node_modules \
  -v duet-bun-cache:/root/.bun/install/cache \
  -v duet-npm-cache:/root/.npm \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e DOTENV_PRIVATE_KEY_STAGING \
  -e DUET_E2E_AGENTMAIL_INBOX_ADDRESS \
  -e DUET_E2E_ALLOW_GOOGLE_OAUTH_SKIP \
  -e DUET_E2E_ARTIFACT_DIR \
  -e DUET_E2E_HEADLESS \
  -e DUET_E2E_UNIFIED_EVIDENCE \
  -e DUET_SYNCTHING_BIN \
  mcr.microsoft.com/playwright:v1.61.0-jammy \
  sh -lc 'npm install -g bun@1.3.14 >/dev/null 2>&1 && \
    bun install --frozen-lockfile && \
    bunx dotenvx run -f .env.staging -- bun packages/test-harness/scripts/staging-live.ts "$@"' \
  sh "$@"
