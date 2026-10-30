#!/bin/sh
set -eu
printf '{"private":true,"dependencies":{"@duetso/agent":"0.3.29","@earendil-works/pi-ai":"0.85.1","@earendil-works/pi-agent-core":"0.85.1","typebox":"1.3.34"}}\n' > /work/package.json
bun install > /receipt/install.log 2>&1
bun /receipt/verify-package.mjs download
mkdir -p /tmp/expected
tar -xzf /receipt/agent-0.3.29.tgz -C /tmp/expected
bun /receipt/verify-package.mjs installed
falsify() {
  if FALSIFY="$1" bun test /receipt/capabilities.test.ts -t "$2" > "/receipt/red-$1.log" 2>&1; then
    echo "Falsification unexpectedly passed: $1"; exit 1
  fi
  grep -q '1 fail' "/receipt/red-$1.log"
}
falsify tools 'actor tool/image/effort wire: duet-gateway:openai/gpt-6-sol'
falsify vision 'actor tool/image/effort wire: duet-gateway:openai/gpt-6-sol'
falsify reasoning 'actor tool/image/effort wire: duet-gateway:openai/gpt-6-sol'
falsify result 'structured caller exact low reasoning and checked solution: duet-gateway:luna'
falsify coding 'ordinary Sol coding'
bun test /receipt/capabilities.test.ts > /receipt/final-green.log 2>&1
cat /receipt/final-green.log
