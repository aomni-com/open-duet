import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  assessChromeFreezeProbe,
  type ChromeFreezeProbeResult,
  type ChromeProcessSample,
} from './chrome-freeze-probe-result.ts'
import {
  probeReportUrl,
  probeTranscriptUrl,
  PROBE_REPORTS_DIR,
  PROBE_TRANSCRIPTS_DIR,
} from './probe-artifacts.ts'
import { cleanup, createVm, makeContext, ms, runOrThrow, vmName } from './probe-common.ts'

const imageRef = process.env.IMAGE_REF
if (!imageRef) throw new Error('IMAGE_REF is required')
if (!imageRef.includes('@sha256:')) {
  throw new Error('IMAGE_REF must be an immutable @sha256 digest, not a moving tag')
}

const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').toLowerCase()
const reportName = `agent-browser-windows-slice00-freeze-${runId}.md`
const transcriptName = `agent-browser-windows-slice00-freeze-${runId}.json`
const ctx = makeContext()
const name = vmName('chrome-freeze')
const remoteProbe = await readFile(
  new URL('./probe-chrome-freeze-remote.py', import.meta.url),
  'utf8',
)

let result: ChromeFreezeProbeResult | undefined
let createMs = 0
let sshReadyMs = 0
let failure = ''
let deleted: string[] = []
let noLeaks = false

try {
  await ctx.control.whoami()
  const created = await createVm(ctx, {
    name,
    image: imageRef,
    cpu: 2,
    memory: '8GB',
    tags: ['duet-probe'],
    comment: 'agent browser windows slice 00 Chrome freeze #duet-probe',
  })
  createMs = created.durationMs
  sshReadyMs = await ctx.ssh.waitUntilReady(created.value.ssh_dest, { timeoutMs: 300_000 })

  const encodedProbe = Buffer.from(remoteProbe).toString('base64')
  await runOrThrow(
    ctx.ssh,
    created.value.ssh_dest,
    `printf '%s' '${encodedProbe}' | base64 -d > /tmp/duet-chrome-freeze-probe.py`,
  )
  const output = await runOrThrow(
    ctx.ssh,
    created.value.ssh_dest,
    `set -euo pipefail
cleanup_probe() { rm -f /tmp/duet-chrome-freeze-probe.py; }
trap cleanup_probe EXIT
sudo -n systemctl stop duet-gateway.service
sudo -n systemctl start duet-desktop.target
for _ in {1..600}; do
  if curl -fsS 'http://127.0.0.1:9222/json/version' >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS 'http://127.0.0.1:9222/json/version' >/dev/null
IMAGE_REF=${JSON.stringify(imageRef)} DISPLAY=:1 python3 /tmp/duet-chrome-freeze-probe.py`,
    180_000,
  )
  const resultLine = output
    .split('\n')
    .reverse()
    .find(line => line.startsWith('{') && line.endsWith('}'))
  if (!resultLine) throw new Error(`freeze probe returned no JSON result:\n${output}`)
  result = JSON.parse(resultLine) as ChromeFreezeProbeResult
  const assessment = assessChromeFreezeProbe(result)
  if (!assessment.passed) throw new Error(assessment.failures.join('; '))
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  const cleaned = await cleanup(ctx)
  deleted = cleaned.deleted
  if (cleaned.deleteErrors.length > 0) {
    failure = `${failure}\n${cleaned.deleteErrors.join('\n')}`.trim()
  }
  try {
    noLeaks = !(await ctx.control.list()).some(vm => vm.vm_name === name)
    if (!noLeaks) failure = `${failure}\nprobe VM still exists after cleanup: ${name}`.trim()
  } catch (error) {
    failure = `${failure}\n${error instanceof Error ? error.message : String(error)}`.trim()
  }
}

await mkdir(fileURLToPath(PROBE_REPORTS_DIR), { recursive: true })
await mkdir(fileURLToPath(PROBE_TRANSCRIPTS_DIR), { recursive: true })
if (result) {
  await writeFile(
    fileURLToPath(probeTranscriptUrl(transcriptName)),
    `${JSON.stringify(result, null, 2)}\n`,
  )
}
await writeFile(
  fileURLToPath(probeReportUrl(reportName)),
  renderReport({ result, failure, vmName: name, imageRef, createMs, sshReadyMs, deleted, noLeaks }),
)

console.log(`wrote ${fileURLToPath(probeReportUrl(reportName))}`)
if (result) console.log(`wrote ${fileURLToPath(probeTranscriptUrl(transcriptName))}`)
if (failure) throw new Error(failure)

function renderSample(label: string, sample: ChromeProcessSample | undefined): string {
  if (!sample) return `| ${label} | unmeasured | unmeasured | unmeasured | unmeasured |`
  return `| ${label} | ${sample.rendererCpuCores.toFixed(3)} | ${sample.totalChromeCpuCores.toFixed(3)} | ${(sample.rendererRssBytes / 1024 / 1024).toFixed(1)} MiB | ${(sample.totalChromeRssBytes / 1024 / 1024).toFixed(1)} MiB |`
}

function renderReport(input: {
  result: ChromeFreezeProbeResult | undefined
  failure: string
  vmName: string
  imageRef: string
  createMs: number
  sshReadyMs: number
  deleted: string[]
  noLeaks: boolean
}): string {
  const assessment = input.result ? assessChromeFreezeProbe(input.result) : undefined
  const state = input.result?.state
  const boundaryRows = input.result
    ? Object.entries(input.result.boundaries)
        .map(([name, observation]) => `- **${name}:** ${observation}`)
        .join('\n')
    : '- Unmeasured.'
  const diagnostics = input.result?.diagnostics
  const failureDetail = input.failure
    ? `\n## Failure detail\n\n\`\`\`text\n${input.failure}\n\`\`\`\n`
    : ''
  return `# Chrome page freeze economics and safety probe

Date: ${new Date().toISOString()}

## Verdict

**${input.failure ? 'FAIL' : 'PASS'}**${input.failure ? ` — ${input.failure.split('\n')[0]}` : ' — the pinned image materially quieted page renderer CPU without reload or state loss, then explicitly thawed and drove the focused page in under one second.'}
${failureDetail}

## Exact environment

- VM: \`${input.vmName}\`
- Immutable image: \`${input.imageRef}\`
- Chrome: \`${input.result?.chromeVersion ?? 'unmeasured'}\`
- VM shape: 2 CPU / 8 GB
- Create: ${ms(input.createMs)}; boot to SSH: ${ms(input.sshReadyMs)}
- Workload: ${input.result?.workload.pageCount ?? 'unmeasured'} busy page targets in separate Chrome windows, including one popup; ${input.result?.workload.sampleDurationMs ?? 'unmeasured'} ms samples
- Confounder control: the existing gateway was stopped before the desktop target so its no-runner/no-viewer reaper could not close Chrome during the three CPU samples.

## CPU and RSS telemetry

| phase | renderer CPU cores | all Chrome CPU cores | renderer RSS | all Chrome RSS |
| --- | ---: | ---: | ---: | ---: |
${renderSample('active', input.result?.active)}
${renderSample('frozen', input.result?.frozen)}
${renderSample('thawed', input.result?.thawed)}

Renderer CPU reduction: ${assessment ? `${(assessment.rendererCpuReductionRatio * 100).toFixed(1)}%` : 'unmeasured'}. PASS requires an active control of at least 0.25 renderer CPU cores and both a 60% and 0.20-core reduction. RSS is deliberately telemetry, not a verdict.

## Safety and thaw evidence

- Timer count before freeze / immediately after thaw / after resume: ${state ? `${state.timerCountBeforeFreeze} / ${state.timerCountImmediatelyAfterThaw} / ${state.timerCountAfterResume}` : 'unmeasured'}
- DOM/JS marker survived: ${state ? state.markerBeforeFreeze === state.markerAfterThaw : 'unmeasured'}
- Navigation count before / after: ${state ? `${state.navigationCountBeforeFreeze} / ${state.navigationCountAfterThaw}` : 'unmeasured'}
- Native-X11-focus stimulus to explicit thaw and resumed timer: ${state ? `${state.thawLatencyMs.toFixed(1)} ms` : 'unmeasured'}
- Target discoverable after thaw: ${state?.targetDiscoverableAfterThaw ?? 'unmeasured'}
- Post-thaw DOM drive observed: ${state?.driveMutationObserved ?? 'unmeasured'}

The X11 focus action is only the stimulus for this gate; it is not proposed as the production focus owner. Slice 00 gate B independently proves the extension focus/event channel.

## Promise boundary observations

${boundaryRows}

The supported promise is page-target renderer quieting via \`Page.setWebLifecycleState\`. It does not suspend Chrome's browser process, service workers, audio/download services, open native dialogs, or an unenumerated popup. Every owned page target must be enumerated and frozen explicitly.

## Focus diagnostic matrix

| target condition | timer delta during 1 s freeze | visibility before / after | lifecycle events observed |
| --- | ---: | --- | --- |
| another Chrome window focused | ${diagnostics?.backgroundPage.timerDeltaDuringFreeze ?? 'unmeasured'} | ${diagnostics ? `${diagnostics.backgroundPage.visibilityBefore} / ${diagnostics.backgroundPage.visibilityAfter}` : 'unmeasured'} | ${diagnostics?.backgroundPage.lifecycleEvents.join(', ') || 'none'} |
| target's own Chrome window focused | ${diagnostics?.focusedPage.timerDeltaDuringFreeze ?? 'unmeasured'} | ${diagnostics ? `${diagnostics.focusedPage.visibilityBefore} / ${diagnostics.focusedPage.visibilityAfter}` : 'unmeasured'} | ${diagnostics?.focusedPage.lifecycleEvents.join(', ') || 'none'} |

This matrix is diagnosis, not an alternate PASS criterion. It distinguishes a focus-triggered auto-thaw from lifecycle freeze failing on a visible top-level page.

### Minimized-background fallback diagnostic

The foreground primary window stays active and is excluded. Three background
windows are minimized by exact Chrome \`windowId\`, measured, then page-frozen
while still minimized, measured again, explicitly activated/restored, and checked
for state/timer recovery.

| phase | renderer CPU cores (includes protected foreground) | all Chrome CPU cores | aggregate background timer delta |
| --- | ---: | ---: | ---: |
| minimized only | ${diagnostics?.minimizedBackground.minimizedOnly.rendererCpuCores.toFixed(3) ?? 'unmeasured'} | ${diagnostics?.minimizedBackground.minimizedOnly.totalChromeCpuCores.toFixed(3) ?? 'unmeasured'} | ${diagnostics?.minimizedBackground.timerDeltaMinimizedOnly ?? 'unmeasured'} |
| minimized + page frozen | ${diagnostics?.minimizedBackground.minimizedAndFrozen.rendererCpuCores.toFixed(3) ?? 'unmeasured'} | ${diagnostics?.minimizedBackground.minimizedAndFrozen.totalChromeCpuCores.toFixed(3) ?? 'unmeasured'} | ${diagnostics?.minimizedBackground.timerDeltaMinimizedAndFrozen ?? 'unmeasured'} |

- Visibility while minimized: ${diagnostics?.minimizedBackground.visibilityWhileMinimized.join(', ') || 'unmeasured'}
- Visibility after restore: ${diagnostics?.minimizedBackground.visibilityAfterRestore.join(', ') || 'unmeasured'}
- Chrome window states while minimized: ${diagnostics?.minimizedBackground.chromeWindowStatesWhileMinimized.join(', ') || 'unmeasured'}
- Chrome window states after restore: ${diagnostics?.minimizedBackground.chromeWindowStatesAfterRestore.join(', ') || 'unmeasured'}
- Lifecycle events: ${diagnostics?.minimizedBackground.lifecycleEvents.join(', ') || 'none'}
- Restore resumed timers: ${diagnostics?.minimizedBackground.restoreResumedTimers ?? 'unmeasured'}
- DOM/JS markers survived restore: ${diagnostics?.minimizedBackground.stateSurvivedRestore ?? 'unmeasured'}

This is fallback evidence only. The probe does not select minimize/restore as product policy.

## Cleanup

- Deleted: ${input.deleted.map(vm => `\`${vm}\``).join(', ') || 'none'}
- Leak check: ${input.noLeaks ? 'the exact probe VM no longer exists' : 'failed'}
`
}
