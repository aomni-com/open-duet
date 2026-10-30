import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { DESKTOP_CDP_PORT, DESKTOP_CHROME_VERSION } from '@repo/contract'

import {
  PROBE_REPORTS_DIR,
  PROBE_TRANSCRIPTS_DIR,
  probeReportUrl,
  probeTranscriptUrl,
} from './probe-artifacts.ts'
import { cleanup, createVm, makeContext, ms, runOrThrow, vmName } from './probe-common.ts'

const imageRef = process.env.IMAGE_REF
if (!imageRef) throw new Error('IMAGE_REF is required')

const reportUrl = probeReportUrl('agent-browser-slice00-cdp-proxy.md')
const transcriptUrl = probeTranscriptUrl('agent-browser-slice00-cdp-proxy.json')
const relayUrl = new URL('./probe-cdp-proxy-relay.ts', import.meta.url)
const runnerUrl = new URL('./probe-cdp-proxy-native-runner.ts', import.meta.url)
const playwrightUrl = new URL('./probe-cdp-proxy-playwright.py', import.meta.url)
const ctx = makeContext()
const name = vmName('cdp-proxy')
const evidence = {
  date: new Date().toISOString(),
  vmName: name,
  imageRef,
  createMs: 0,
  sshReadyMs: 0,
  chromeVersion: '',
  chromeBrowser: '',
  playwright: undefined as Record<string, unknown> | undefined,
  disconnected: false,
  methods: [] as Array<Record<string, string>>,
  deleted: [] as string[],
  exactVmAbsent: false,
  failure: '',
}

function marker(output: string, name: string): string {
  const value = output.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]
  if (value === undefined) throw new Error(`CDP proxy probe omitted ${name}`)
  return value
}

try {
  await ctx.control.whoami()
  const created = await createVm(ctx, {
    name,
    image: imageRef,
    cpu: 1,
    memory: '4GB',
    tags: ['duet-probe'],
    comment: 'agent-browser slice 00 CDP proxy #duet-probe',
  })
  evidence.createMs = created.durationMs
  evidence.sshReadyMs = await ctx.ssh.waitUntilReady(created.value.ssh_dest, {
    timeoutMs: 300_000,
  })

  const fixtures = await Promise.all(
    [relayUrl, runnerUrl, playwrightUrl].map(async url => ({
      name: fileURLToPath(url).split('/').at(-1)!,
      body: (await readFile(url)).toString('base64'),
    })),
  )
  const fixtureInstall = fixtures
    .map(
      fixture => `printf %s '${fixture.body}' | base64 -d > '/tmp/duet-cdp-proxy/${fixture.name}'`,
    )
    .join('\n')
  const output = await runOrThrow(
    ctx.ssh,
    created.value.ssh_dest,
    `set -euo pipefail
stage=desktop-start
proxy_pid=''
cleanup_remote() {
  if [[ -n "$proxy_pid" ]]; then kill "$proxy_pid" >/dev/null 2>&1 || true; fi
}
on_error() {
  rc=$?
  echo "FAILED_STAGE=$stage" >&2
  cat /tmp/duet-cdp-proxy/proxy.log >&2 2>/dev/null || true
  systemctl status --no-pager duet-desktop.target duet-desktop-browser.service >&2 || true
  exit "$rc"
}
trap on_error ERR
trap cleanup_remote EXIT
mkdir -p /tmp/duet-cdp-proxy
${fixtureInstall}
sudo -n systemctl start duet-desktop.target
for _ in {1..600}; do
  cdp="$(curl -fsS 'http://127.0.0.1:${DESKTOP_CDP_PORT}/json/version' 2>/dev/null || true)"
  if jq -e '.webSocketDebuggerUrl' <<<"$cdp" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
upstream_ws="$(jq -er .webSocketDebuggerUrl <<<"$cdp")"
stage=proxy-start
UPSTREAM_WS="$upstream_ws" \
PROXY_READY_FILE=/tmp/duet-cdp-proxy/ready \
PROXY_METHODS_FILE=/tmp/duet-cdp-proxy/methods.ndjson \
/home/exedev/.bun/bin/bun run /tmp/duet-cdp-proxy/probe-cdp-proxy-native-runner.ts \
  >/tmp/duet-cdp-proxy/proxy.log 2>&1 &
proxy_pid=$!
for _ in {1..100}; do
  if test -s /tmp/duet-cdp-proxy/ready; then break; fi
  kill -0 "$proxy_pid"
  sleep 0.1
done
proxy_ws="$(tr -d '\n' </tmp/duet-cdp-proxy/ready)"
stage=playwright
PROXY_WS="$proxy_ws" python3 /tmp/duet-cdp-proxy/probe-cdp-proxy-playwright.py
stage=disconnect
kill -0 "$proxy_pid"
sleep 1
kill -0 "$proxy_pid"
echo 'METHODS_BEGIN'
cat /tmp/duet-cdp-proxy/methods.ndjson
echo 'METHODS_END'
echo "CHROME_VERSION=$(dpkg-query -W -f='\${Version}' google-chrome-stable)"
echo "CHROME_BROWSER=$(jq -r .Browser <<<"$cdp")"`,
    180_000,
  )

  evidence.chromeVersion = marker(output, 'CHROME_VERSION')
  evidence.chromeBrowser = marker(output, 'CHROME_BROWSER')
  evidence.playwright = JSON.parse(marker(output, 'PLAYWRIGHT_PROOF')) as Record<string, unknown>
  evidence.disconnected = marker(output, 'DISCONNECTED') === 'true'
  const methods = output.match(/METHODS_BEGIN\n([\s\S]*?)\nMETHODS_END/)?.[1] ?? ''
  evidence.methods = methods
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, string>)
  if (!evidence.methods.some(item => item.actuator === 'Target.createTarget')) {
    throw new Error('Target.createTarget did not cross the actuator seam')
  }
  if (evidence.chromeVersion !== DESKTOP_CHROME_VERSION) {
    throw new Error(
      `Chrome version ${evidence.chromeVersion} does not match pinned ${DESKTOP_CHROME_VERSION}`,
    )
  }
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error)
} finally {
  const cleaned = await cleanup(ctx)
  evidence.deleted = cleaned.deleted
  if (cleaned.deleteErrors.length > 0) {
    evidence.failure = `${evidence.failure}\n${cleaned.deleteErrors.join('\n')}`.trim()
  }
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const stillPresent = (await ctx.control.list()).some(vm => vm.vm_name === name)
      if (!stillPresent) break
      await ctx.control.remove(name)
      if (!evidence.deleted.includes(name)) evidence.deleted.push(name)
      await Bun.sleep(1_000)
    }
    const stillPresent = (await ctx.control.list()).some(vm => vm.vm_name === name)
    if (stillPresent) {
      evidence.failure = `${evidence.failure}\nprobe VM still exists: ${name}`.trim()
    } else {
      evidence.exactVmAbsent = true
    }
  } catch (error) {
    evidence.failure =
      `${evidence.failure}\n${error instanceof Error ? error.message : String(error)}`.trim()
  }
}

await mkdir(fileURLToPath(PROBE_TRANSCRIPTS_DIR), { recursive: true })
await writeFile(fileURLToPath(transcriptUrl), `${JSON.stringify(evidence, null, 2)}\n`)
await mkdir(fileURLToPath(PROBE_REPORTS_DIR), { recursive: true })
await writeFile(
  fileURLToPath(reportUrl),
  `# Agent browser Slice 00 — CDP proxy gate D

Date: ${evidence.date}

## Verdict

${evidence.failure ? `Failed: ${evidence.failure.split('\n')[0]}` : 'Passed: the pinned native Chrome remained fully visible through a browser-level relay while Playwright new-page placement was synthesized by a separate actuator connection.'}

## Exact environment

- VM: \`${evidence.vmName}\`
- Image: \`${evidence.imageRef}\`
- Chrome package: \`${evidence.chromeVersion || 'unmeasured'}\`
- CDP browser: \`${evidence.chromeBrowser || 'unmeasured'}\`
- Control-plane create: ${ms(evidence.createMs)}
- Boot to SSH: ${ms(evidence.sshReadyMs)}

## Browser proof

\`\`\`json
${JSON.stringify(evidence.playwright ?? { unmeasured: true }, null, 2)}
\`\`\`

This Gate D runner deliberately uses a separate raw-CDP connection behind the
actuator seam to create the real target. It proves relay transparency and target-id
synthesis, not exact-window placement; the Slice 00 extension gate must supply and
verify the final exact-window actuator before production work starts.

- Relay survived Playwright disconnect: ${evidence.disconnected ? 'yes' : 'no'}
- Intercepted actuator calls: ${evidence.methods.filter(item => item.actuator).length}
- Observed relay CDP methods: ${new Set(evidence.methods.flatMap(item => item.relay ?? [])).size}
- Deleted: ${evidence.deleted.map(vm => `\`${vm}\``).join(', ') || 'none'}
- Exact cleanup: ${evidence.exactVmAbsent ? `\`${evidence.vmName}\` is absent` : 'failed'}
- Transcript: \`${fileURLToPath(transcriptUrl)}\`
`,
)

console.log(`wrote ${fileURLToPath(reportUrl)}`)
console.log(`wrote ${fileURLToPath(transcriptUrl)}`)
if (evidence.failure) throw new Error(evidence.failure)
