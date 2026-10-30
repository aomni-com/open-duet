#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/../../../../scripts/agent-tests.sh" agent --swebench "$@"
