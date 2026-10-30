#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
shift || true

force=0
filtered=()
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    *) filtered+=("$arg") ;;
  esac
done
if [[ ${#filtered[@]} -gt 0 ]]; then
  set -- "${filtered[@]}"
else
  set --
fi

case "$mode" in
  check)
    if [[ $force -eq 1 ]]; then
      echo "error: --force only applies to approve" >&2
      exit 2
    fi
    task="visual"
    ;;
  approve)
    task="visual:approve"
    [[ $force -eq 1 ]] && task="visual:approve:force"
    ;;
  *)
    echo "usage: $0 check|approve [--force] <id> [id ...] | --all" >&2
    exit 2
    ;;
esac

if [[ $# -eq 0 ]]; then
  echo "error: pass one or more fixture IDs, --official-apps, or --all" >&2
  exit 2
fi

filter_suffix=""
workspace_filters="--filter=lander --filter=web --filter=docs --filter=@repo/official-agents-seed"
if [[ "$1" == "--all" ]]; then
  if [[ $# -ne 1 ]]; then
    echo "error: --all does not accept fixture IDs" >&2
    exit 2
  fi
elif [[ "$1" == "--official-apps" ]]; then
  if [[ $# -ne 1 ]]; then
    echo "error: --official-apps does not accept fixture IDs" >&2
    exit 2
  fi
  workspace_filters="--filter=@repo/official-agents-seed"
  filter_suffix="-- -g 'official-apps/'"
else
  joined="$(IFS='|'; echo "$*")"
  filter_suffix="-- -g '(playground|docs|auth|lander|official-apps)/($joined)' --pass-with-no-tests"
  workspace_filters=""
  needs_lander=0
  needs_docs=0
  needs_official_apps=0
  needs_web=0
  for id in "$@"; do
    case "$id" in
      lander-*) needs_lander=1 ;;
      docs-*) needs_docs=1 ;;
      agent-app-*) needs_official_apps=1 ;;
      *) needs_web=1 ;;
    esac
  done
  [[ $needs_lander -eq 1 ]] && workspace_filters="$workspace_filters --filter=lander"
  [[ $needs_docs -eq 1 ]] && workspace_filters="$workspace_filters --filter=docs"
  [[ $needs_official_apps -eq 1 ]] && workspace_filters="$workspace_filters --filter=@repo/official-agents-seed"
  [[ $needs_web -eq 1 ]] && workspace_filters="$workspace_filters --filter=web"
fi
preflight_filters="$workspace_filters --filter=@repo/ui"
preflight_mode=""
post_capture=""
if [[ "$mode" == "approve" ]]; then
  preflight_mode="--approval"
  post_capture="&& bun visual:union:write && bun visual:union"
fi

# Public DNS: lander captures fetch ik.imagekit.io, and host VPN/filtering
# resolvers can NXDOMAIN it, failing lander-public-root on browser errors.
exec docker run --rm --dns 8.8.8.8 \
  -v "$PWD:/work" -w /work \
  -v /work/node_modules \
  -v duet-bun-cache:/root/.bun/install/cache \
  -v duet-npm-cache:/root/.npm \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e PLAYWRIGHT_MAX_FAILURES \
  -e PUBLIC_VISUAL_SHARD_COUNT \
  -e PUBLIC_VISUAL_SHARD_INDEX \
  -e PUBLIC_VISUAL_ROUTE_PATTERN \
  -e VISUAL_PREBUILT=1 \
  -e NEXT_PUBLIC_CONVEX_URL=https://visual-fixture.convex.cloud \
  mcr.microsoft.com/playwright:v1.61.0-jammy \
  sh -lc "npm install -g bun@1.3.14 >/dev/null 2>&1 && \
    bun install --frozen-lockfile && \
    rm -rf .turbo && \
    bash scripts/ui-visual-preflight.sh $preflight_mode $preflight_filters && \
    bunx turbo run $task $workspace_filters --concurrency=1 $filter_suffix \
    $post_capture"
