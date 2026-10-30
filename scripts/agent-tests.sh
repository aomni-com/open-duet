#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="${1:?Expected agent or duet}"
shift
case "$package" in agent|duet) ;; *) exit 64 ;; esac
mode=test
if [[ "${1:-}" == --eval ]]; then mode=eval; shift; fi
if [[ "${1:-}" == --swebench ]]; then mode=swebench; shift; fi
if [[ "${1:-}" == -- ]]; then shift; fi
docker_args=(--rm)
if [[ "$mode" == eval ]]; then
  evidence="$root/packages/agent/tmp/eval-artifacts"
  mkdir -p "$evidence"
  docker_args+=(-v "$evidence:/evidence" -e EVAL_ARTIFACT_DIR=/evidence)
  for name in DUET_API_KEY AI_GATEWAY_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY EVAL_MODEL EVAL_CANDIDATE_REVISION EVAL_ADVISOR_THINKING JUDGE_MODEL COVERAGE_THRESHOLD; do
    docker_args+=(-e "$name")
  done
fi
image="$(docker build --quiet - < "$root/scripts/agent-tests.Dockerfile")"
docker run "${docker_args[@]}" \
  -v "$root:/src:ro" -v duet-agent-bun-cache:/tmp/home/.bun/install/cache \
  -w /work -e HOME=/tmp/home -e DUET_TEST_IN_DOCKER=1 \
  "$image" bash -c '
    set -euo pipefail
    package="$1"; mode="$2"; shift 2
    tar -C /src --exclude=.git --exclude=node_modules --exclude=dist \
      --exclude=.next --exclude=.turbo --exclude=".env*" -cf - . | tar -xf -
    bun install --frozen-lockfile --filter @repo/agent --filter @duetso/agent
    bun run --cwd packages/agent build
    if [[ "$package" == duet ]]; then bun run --cwd packages/duet build; fi
    cd "packages/$package"
    if [[ "$#" -gt 0 ]]; then exec bun test "$@"; fi
    case "$mode" in
      test)
        # Bun 1.3.14 can stall subprocess streams after an OpenTUI test. Its
        # --parallel loader also fails on OpenTUI native asset imports,
        # so give each file a plain process while keeping one container/install.
        test_roots=(test)
        if [[ "$package" == duet ]]; then test_roots+=(src); fi
        status=0
        count=0
        while IFS= read -r -d "" file; do
          [[ "$file" =~ [._](test|spec)\.(js|jsx|ts|tsx|mjs|mts|cjs|cts)$ ]] || continue
          count=$((count + 1))
          if ! bun test --timeout 60000 "./$file" < /dev/null; then status=1; fi
        done < <(find "${test_roots[@]}" -type f -print0)
        if [[ "$count" == 0 ]]; then
          printf "No test files found for %s\\n" "$package" >&2
          exit 1
        fi
        exit "$status" ;;
      eval) exec bun test --timeout 60000 evals/*.eval.ts ;;
      swebench) exec bun test --timeout 60000 benchmarks/swebench/test/*.test.ts ;;
    esac
  ' bash "$package" "$mode" "$@"
