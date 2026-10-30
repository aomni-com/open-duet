#!/usr/bin/env bash

set -euo pipefail

approval=0
if [[ "${1:-}" == "--approval" ]]; then
  approval=1
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "usage: $0 [--approval] --filter=<workspace> [--filter=<workspace> ...]" >&2
  exit 2
fi

filters=("$@")
joined=" ${filters[*]} "

bunx turbo run check-types lint "${filters[@]}" --concurrency=2

if [[ "$joined" == *" --filter=lander "* ]]; then
  bun --cwd=apps/lander run verify:visual-coverage
  bun --cwd=apps/lander run verify:public-content
fi
if [[ "$joined" == *" --filter=web "* ]]; then
  bun --cwd=apps/web run verify:visual-coverage
fi
if [[ "$joined" == *" --filter=docs "* ]]; then
  bun --cwd=apps/docs run verify:visual-coverage
fi
if [[ "$joined" == *" --filter=@repo/ui "* ]]; then
  bun --cwd=packages/ui run verify:visual-coverage
fi
if [[ "$joined" == *" --filter=@repo/official-agents-seed "* ]]; then
  if [[ $approval -eq 1 ]]; then
    bun --cwd=packages/official-agents-seed run visual:coverage:write
  else
    bun --cwd=packages/official-agents-seed run verify:visual-coverage
  fi
fi
[[ $approval -eq 0 ]] && bun visual:union
bun assets:verify

rm -rf \
  apps/lander/.next apps/lander/.turbo \
  apps/web/.next apps/web/.turbo \
  apps/docs/.next apps/docs/.turbo
bunx turbo run build "${filters[@]}" --concurrency=1

if [[ "$joined" == *" --filter=lander "* ]]; then
  bun --cwd=apps/lander run verify:build-output
fi
if [[ "$joined" == *" --filter=web "* ]]; then
  bun --cwd=apps/web run verify:build-output
fi
if [[ "$joined" == *" --filter=docs "* ]]; then
  bun --cwd=apps/docs run verify:build-output
fi
