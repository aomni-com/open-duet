/**
 * Kill-gate probe for the per-tier storage ladder.
 *
 * This deliberately uses one real-image VM for all five verdicts so the
 * resize/restart is also the reboot used to test public-share survival.
 * Run through `bun run probe:tier-disk`; never run it against a local env.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { workspaceVmCapsForPlan } from '@repo/contract'

import {
  assertNoDuetTestVms,
  cleanup,
  createVm,
  fenced,
  makeContext,
  ms,
  runOrThrow,
  time,
  vmName,
} from './probe-common.ts'

const START_DISK = '28GB'
const GROWN_DISK = '58GB'
const ADVERTISED_BYTES = 20_000_000_000
const RESERVE_BYTES = 1024 ** 3
const TARGET_BYTES = 100_000_000_000
const LARGE_FILE_COUNT = 5
const LARGE_FILE_BYTES = 1_000_000_000
const LARGE_FILE_BLOCK_BYTES = 1_000_000
const SMALL_FILE_COUNT = 100_000
const SMALL_FILE_BYTES = 50_000
const GATEWAY_PORT = 3000
const DRIVE = '/home/exedev/drive'
// Probe scripts must not hardcode spec paths (they rot when the spec
// archives — probe-artifacts.test.ts pins this). The owning spec's runbook
// passes its research path explicitly.
const REPORT_URL = new URL(
  process.env.TIER_DISK_REPORT_PATH ?? '../probe-report-tier-disk.md',
  import.meta.url,
)

type CommandName = 'new' | 'ls' | 'share set-public' | 'resize' | 'restart' | 'rm'
type ControlStatus = 'accepted' | 'refused'
type HealthPath = 'public https_url' | 'in-VM localhost:3000'

interface ControlAttempt {
  command: CommandName
  status: ControlStatus
  detail: string
}

interface DfReading {
  bytes: string
  human: string
  sizeBytes: number
  availBytes: number
}

interface DuRun {
  bytes: number
  /** Wall time of the whole SSH exec — includes ~seconds of transport setup. */
  durationMs: number
  /** Wall time of `du` alone, measured inside the VM — the number to extrapolate. */
  inVmMs: number
  output: string
}

interface DuState {
  label: string
  fileCount: number
  runs: [DuRun, DuRun, DuRun]
}

interface HealthAttempt {
  ok: boolean
  detail: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeDetail(value: unknown): string {
  if (value === undefined) return 'command returned successfully'
  return JSON.stringify(value, null, 2)
}

async function controlCall<T>(
  attempts: ControlAttempt[],
  command: CommandName,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    const value = await fn()
    attempts.push({ command, status: 'accepted', detail: safeDetail(value) })
    return value
  } catch (error) {
    attempts.push({ command, status: 'refused', detail: errorMessage(error) })
    return undefined
  }
}

function parseDf(output: string): { sizeBytes: number; availBytes: number } {
  const line = output.trim().split('\n').at(-1)
  const fields = line?.trim().split(/\s+/)
  const sizeBytes = Number(fields?.[1])
  const availBytes = Number(fields?.[3])
  if (!Number.isFinite(sizeBytes) || !Number.isFinite(availBytes)) {
    throw new Error(`Could not parse df -B1 output:\n${output}`)
  }
  return { sizeBytes, availBytes }
}

async function readDf(
  ssh: ReturnType<typeof makeContext>['ssh'],
  dest: string,
): Promise<DfReading> {
  const bytes = await runOrThrow(ssh, dest, `df -B1 ${DRIVE}`)
  const human = await runOrThrow(ssh, dest, `df -h ${DRIVE}`)
  return { bytes, human, ...parseDf(bytes) }
}

async function measureDu(
  ssh: ReturnType<typeof makeContext>['ssh'],
  dest: string,
  label: string,
  fileCount: number,
): Promise<DuState> {
  const runs: DuRun[] = []
  for (let index = 0; index < 3; index += 1) {
    const measured = await time(() =>
      runOrThrow(
        ssh,
        dest,
        `t0=$(date +%s%N); du -sb ${DRIVE}; t1=$(date +%s%N); echo "invm_ns=$((t1 - t0))"`,
        600_000,
      ),
    )
    const bytes = Number(measured.value.trim().split(/\s+/)[0])
    const inVmNs = Number(measured.value.match(/invm_ns=(\d+)/)?.[1])
    if (!Number.isFinite(bytes) || !Number.isFinite(inVmNs)) {
      throw new Error(`Could not parse du output for ${label}: ${measured.value}`)
    }
    runs.push({
      bytes,
      durationMs: measured.durationMs,
      inVmMs: inVmNs / 1_000_000,
      output: measured.value,
    })
  }
  return { label, fileCount, runs: runs as [DuRun, DuRun, DuRun] }
}

function duSummary(state: DuState): string {
  const [cold, ...warm] = state.runs
  const warmMinMs = Math.min(...warm.map(run => run.inVmMs))
  return [
    `${state.label}: ${state.fileCount.toLocaleString('en-US')} files`,
    `cold (in-VM): ${ms(cold.inVmMs)} (${cold.bytes.toLocaleString('en-US')} bytes)`,
    `warm min of runs 2-3 (in-VM): ${ms(warmMinMs)}`,
    ...state.runs.map(
      (run, index) =>
        `run ${index + 1}: in-VM ${run.inVmMs.toFixed(1)} ms (exec incl. SSH ${run.durationMs.toFixed(0)} ms); output: ${run.output.replace(/\n/g, ' | ')}`,
    ),
  ].join('\n')
}

async function publicHealth(url: string): Promise<HealthAttempt> {
  try {
    const response = await fetch(`${url.replace(/\/+$/g, '')}/healthz`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    })
    const body = await response.text()
    return {
      ok: response.status === 200 && body.trim() === 'ok',
      detail: `HTTP ${response.status}; body=${JSON.stringify(body)}`,
    }
  } catch (error) {
    return { ok: false, detail: `request failed: ${errorMessage(error)}` }
  }
}

async function localHealth(
  ssh: ReturnType<typeof makeContext>['ssh'],
  dest: string,
): Promise<HealthAttempt> {
  const result = await ssh.exec(dest, `curl -sf http://localhost:${GATEWAY_PORT}/healthz`, 15_000)
  const body = result.stdout.trim()
  return {
    ok: result.exitCode === 0 && body === 'ok',
    detail: `exit ${result.exitCode}; stdout=${JSON.stringify(body)}; stderr=${JSON.stringify(result.stderr.trim())}`,
  }
}

async function waitForHealth(
  check: () => Promise<HealthAttempt>,
  timeoutMs: number,
): Promise<{ elapsedMs: number; attempts: number; last: HealthAttempt }> {
  const start = performance.now()
  let attempts = 0
  let last: HealthAttempt = { ok: false, detail: 'not attempted' }
  while (performance.now() - start < timeoutMs) {
    const attemptStart = performance.now()
    attempts += 1
    last = await check()
    if (last.ok) return { elapsedMs: performance.now() - start, attempts, last }
    await Bun.sleep(Math.max(0, 500 - (performance.now() - attemptStart)))
  }
  throw new Error(
    `Health check did not become ready within ${timeoutMs}ms after ${attempts} attempts (${last.detail})`,
  )
}

function signedBytes(bytes: number): string {
  const sign = bytes >= 0 ? '+' : '-'
  const magnitude = Math.abs(bytes)
  return `${sign}${magnitude.toLocaleString('en-US')} bytes (${sign}${(magnitude / 1_000_000_000).toFixed(3)} GB; ${sign}${(magnitude / 1024 ** 3).toFixed(3)} GiB)`
}

function controlVerdict(attempts: ControlAttempt[]): { pass: boolean; text: string } {
  const commands: CommandName[] = ['new', 'ls', 'share set-public', 'resize', 'restart', 'rm']
  const lines = commands.map(command => {
    const matching = attempts.filter(attempt => attempt.command === command)
    if (matching.length === 0) return `${command}: NOT REACHED`
    return `${command}: ${matching.map(attempt => attempt.status.toUpperCase()).join(', ')}`
  })
  const pass = commands.every(command => {
    const matching = attempts.filter(attempt => attempt.command === command)
    return matching.length > 0 && matching.every(attempt => attempt.status === 'accepted')
  })
  return { pass, text: lines.join('\n') }
}

async function writeProbeReport(report: string): Promise<void> {
  await mkdir(fileURLToPath(new URL('.', REPORT_URL)), { recursive: true })
  await writeFile(fileURLToPath(REPORT_URL), report)
}

async function main(): Promise<void> {
  const imageRef = process.env.DUET_VM_IMAGE_REF
  if (!imageRef) {
    throw new Error(
      'DUET_VM_IMAGE_REF is required; run this probe through `bun run probe:tier-disk` with the staging environment.',
    )
  }
  if (!process.env.EXE_TOKEN) {
    throw new Error(
      'EXE_TOKEN is required because token-scope verdicts must use the staging HTTPS control plane.',
    )
  }

  const ctx = makeContext()
  const name = vmName('tier-disk')
  const attempts: ControlAttempt[] = []
  const unexpected: string[] = []
  const raw: string[] = []
  let cleanupSummary = 'cleanup not attempted'
  let cleanupFailed = false
  let headroom: DfReading | undefined
  let afterGrow: DfReading | undefined
  let duStates: DuState[] | undefined
  let httpsUrl: string | undefined
  let listedHttpsUrl: string | undefined
  let publicBefore: HealthAttempt | undefined
  let publicAfter: HealthAttempt | undefined
  let healthPath: HealthPath | undefined
  let preResizeHealthReady = false
  let postRestartHealth: HealthAttempt | undefined
  let blipMs: number | undefined
  let resizeReturnedMs: number | undefined
  let restartReturnedMs: number | undefined
  let sshReadyMarkMs: number | undefined
  let healthReadyMarkMs: number | undefined
  const vmCaps = workspaceVmCapsForPlan(undefined)

  try {
    const created = await controlCall(attempts, 'new', () =>
      createVm(ctx, {
        name,
        image: imageRef,
        disk: START_DISK,
        cpu: vmCaps.cpu,
        memory: vmCaps.memory,
      }),
    )
    if (!created) throw new Error('VM creation was refused; VM-dependent verdicts are unreachable')

    const dest = created.value.ssh_dest
    httpsUrl = created.value.https_url
    raw.push(`create response:\n${safeDetail(created.value)}`)
    try {
      const initialSshReadyMs = await ctx.ssh.waitUntilReady(dest, { timeoutMs: 300_000 })
      raw.push(`initial SSH ready: ${ms(initialSshReadyMs)}`)

      await runOrThrow(ctx.ssh, dest, `mkdir -p ${DRIVE}`)
      headroom = await readDf(ctx.ssh, dest)

      duStates = []
      duStates.push(await measureDu(ctx.ssh, dest, 'empty drive', 0))
      await runOrThrow(
        ctx.ssh,
        dest,
        `i=1; while [ "$i" -le ${LARGE_FILE_COUNT} ]; do dd if=/dev/zero of=${DRIVE}/large-$i.bin bs=${LARGE_FILE_BLOCK_BYTES} count=${LARGE_FILE_BYTES / LARGE_FILE_BLOCK_BYTES} status=none; i=$((i + 1)); done`,
        900_000,
      )
      duStates.push(await measureDu(ctx.ssh, dest, 'five 1GB files', LARGE_FILE_COUNT))
      await runOrThrow(
        ctx.ssh,
        dest,
        `mkdir -p ${DRIVE}/small; dd if=/dev/zero of=/tmp/duet-probe-50kb bs=${SMALL_FILE_BYTES} count=1 status=none; i=1; while [ "$i" -le ${SMALL_FILE_COUNT} ]; do cp /tmp/duet-probe-50kb ${DRIVE}/small/file-$i; i=$((i + 1)); done; rm /tmp/duet-probe-50kb`,
        1_800_000,
      )
      duStates.push(
        await measureDu(
          ctx.ssh,
          dest,
          'five 1GB files plus 100k 50KB files',
          LARGE_FILE_COUNT + SMALL_FILE_COUNT,
        ),
      )
    } catch (error) {
      unexpected.push(`pre-resize disk measurement: ${errorMessage(error)}`)
    }

    await controlCall(attempts, 'share set-public', () => ctx.control.setSharePublic(name))
    if (httpsUrl) {
      try {
        const ready = await waitForHealth(() => publicHealth(httpsUrl!), 120_000)
        publicBefore = ready.last
        raw.push(`public health before resize: ${ready.attempts} attempts; ${ready.last.detail}`)
        healthPath = 'public https_url'
        preResizeHealthReady = true
      } catch (error) {
        publicBefore = await publicHealth(httpsUrl)
        raw.push(`public health before resize never became ready: ${errorMessage(error)}`)
        if (publicBefore.ok) {
          healthPath = 'public https_url'
          preResizeHealthReady = true
        }
      }
    } else {
      publicBefore = { ok: false, detail: 'create response omitted https_url' }
    }
    if (healthPath === undefined) {
      healthPath = 'in-VM localhost:3000'
      try {
        const ready = await waitForHealth(() => localHealth(ctx.ssh, dest), 120_000)
        preResizeHealthReady = true
        raw.push(
          `fallback health before resize: ${ready.attempts} attempts; ${ready.last.detail}; gateway port 3000 from packages/gateway/src/runtime/http.ts`,
        )
      } catch (error) {
        unexpected.push(`pre-resize fallback health: ${errorMessage(error)}`)
      }
    }

    const blipStart = performance.now()
    const resized = await controlCall(attempts, 'resize', () =>
      ctx.control.resize(name, { disk: GROWN_DISK }),
    )
    if (resized !== undefined) resizeReturnedMs = performance.now() - blipStart

    await controlCall(attempts, 'restart', () => ctx.control.restart(name))
    const restartAccepted = attempts.at(-1)?.status === 'accepted'
    if (restartAccepted) restartReturnedMs = performance.now() - blipStart

    if (restartAccepted) {
      const healthCheck =
        healthPath === 'public https_url'
          ? () => publicHealth(httpsUrl!)
          : () => localHealth(ctx.ssh, dest)
      const readiness = await Promise.allSettled([
        ctx.ssh.waitUntilReady(dest, { timeoutMs: 300_000, intervalMs: 500 }).then(() => {
          sshReadyMarkMs = performance.now() - blipStart
        }),
        waitForHealth(healthCheck, 300_000).then(result => {
          healthReadyMarkMs = performance.now() - blipStart
          postRestartHealth = result.last
          raw.push(
            `post-restart ${healthPath} health: ${result.attempts} attempts; ${result.last.detail}`,
          )
        }),
      ])
      for (const result of readiness) {
        if (result.status === 'rejected') {
          unexpected.push(`post-restart readiness: ${errorMessage(result.reason)}`)
        }
      }
      blipMs = healthReadyMarkMs
    } else {
      unexpected.push('restart was refused; post-reboot measurements are unreachable')
    }

    // Record only the probe VM's row: the full listing would serialize every
    // VM on the staging account into the retained report.
    const listed = await controlCall(attempts, 'ls', () =>
      ctx.control.list().then(vms => vms.filter(vm => vm.vm_name === name)),
    )
    listedHttpsUrl = listed?.find(vm => vm.vm_name === name)?.https_url
    if (httpsUrl) {
      publicAfter =
        healthPath === 'public https_url' && postRestartHealth
          ? postRestartHealth
          : await publicHealth(httpsUrl)
    }
    if (restartAccepted) {
      try {
        afterGrow = await readDf(ctx.ssh, dest)
      } catch (error) {
        unexpected.push(`post-restart df: ${errorMessage(error)}`)
      }
    }
  } catch (error) {
    unexpected.push(errorMessage(error))
  } finally {
    if (!attempts.some(attempt => attempt.command === 'ls')) {
      await controlCall(attempts, 'ls', () =>
        ctx.control.list().then(vms => ({ vmCount: vms.length })),
      )
    }
    const cleanupResult = await cleanup(ctx)
    for (const deleted of cleanupResult.deleted) {
      attempts.push({ command: 'rm', status: 'accepted', detail: `deleted ${deleted}` })
    }
    for (const failure of cleanupResult.deleteErrors) {
      attempts.push({ command: 'rm', status: 'refused', detail: failure })
    }
    cleanupSummary = [
      `deleted: ${cleanupResult.deleted.join(', ') || 'none'}`,
      `delete errors: ${cleanupResult.deleteErrors.join('; ') || 'none'}`,
    ].join('\n')
    if (cleanupResult.deleteErrors.length > 0) cleanupFailed = true
    try {
      await assertNoDuetTestVms(ctx.control)
      cleanupSummary += '\nassertNoDuetTestVms: PASS'
    } catch (error) {
      cleanupFailed = true
      cleanupSummary += `\nassertNoDuetTestVms: FAIL — ${errorMessage(error)}`
    }
  }

  const scope = controlVerdict(attempts)
  const scopeRaw = [
    scope.text,
    '',
    ...attempts.map(
      (attempt, index) =>
        `attempt ${index + 1} — ${attempt.command} — ${attempt.status}\n${attempt.detail}`,
    ),
  ].join('\n')

  const rebootPass =
    publicBefore?.ok === true &&
    publicAfter?.ok === true &&
    httpsUrl !== undefined &&
    listedHttpsUrl === httpsUrl
  const rebootRaw = [
    `One resize/restart supplies both verdict 2 and verdict 5.`,
    `before URL: ${httpsUrl ?? 'missing'}`,
    `ls URL after restart: ${listedHttpsUrl ?? 'missing'}`,
    `before unauthenticated GET: ${publicBefore?.detail ?? 'not measured'}`,
    `after unauthenticated GET: ${publicAfter?.detail ?? 'not measured'}`,
  ].join('\n')

  const headroomRaw = headroom
    ? [
        headroom.bytes,
        '',
        headroom.human,
        '',
        `available: ${headroom.availBytes.toLocaleString('en-US')} bytes (${(headroom.availBytes / 1_000_000_000).toFixed(3)} GB; ${(headroom.availBytes / 1024 ** 3).toFixed(3)} GiB)`,
        `delta vs advertised decimal 20GB: ${signedBytes(headroom.availBytes - ADVERTISED_BYTES)}`,
        `available after 1GiB reserve: ${(headroom.availBytes - RESERVE_BYTES).toLocaleString('en-US')} bytes`,
        `delta vs advertised decimal 20GB after reserve: ${signedBytes(headroom.availBytes - RESERVE_BYTES - ADVERTISED_BYTES)}`,
      ].join('\n')
    : 'not measured'

  let duRaw = 'not measured'
  let duVerdict = 'NOT MEASURED'
  if (duStates?.length === 3) {
    const largest = duStates.at(-1)!
    const cold = largest.runs[0]
    const warmMinMs = Math.min(largest.runs[1].inVmMs, largest.runs[2].inVmMs)
    const bytesFactor = TARGET_BYTES / cold.bytes
    const targetSmallFiles = TARGET_BYTES / SMALL_FILE_BYTES
    const fileFactor = targetSmallFiles / largest.fileCount
    duVerdict = `cold ${ms(cold.inVmMs)}; warm ${ms(warmMinMs)} in-VM at ${cold.bytes.toLocaleString('en-US')} bytes / ${largest.fileCount.toLocaleString('en-US')} files`
    duRaw = [
      ...duStates.map(duSummary),
      '',
      `Extrapolations use in-VM du time only (SSH transport excluded).`,
      `100GB byte-linear extrapolation from the final state (${cold.bytes.toLocaleString('en-US')} measured bytes; factor ${bytesFactor.toFixed(3)}): cold ${ms(cold.inVmMs * bytesFactor)}, warm ${ms(warmMinMs * bytesFactor)}.`,
      `100GB file-linear extrapolation assumes 50KB files (${targetSmallFiles.toLocaleString('en-US')} target files) from the final state's ${largest.fileCount.toLocaleString('en-US')} files (factor ${fileFactor.toFixed(3)}): cold ${ms(cold.inVmMs * fileFactor)}, warm ${ms(warmMinMs * fileFactor)}.`,
    ].join('\n\n')
  }

  const resizedAccepted = attempts.some(
    attempt => attempt.command === 'resize' && attempt.status === 'accepted',
  )
  const restartedAccepted = attempts.some(
    attempt => attempt.command === 'restart' && attempt.status === 'accepted',
  )
  const grew =
    headroom !== undefined &&
    afterGrow !== undefined &&
    afterGrow.sizeBytes > headroom.sizeBytes &&
    afterGrow.sizeBytes >= 50_000_000_000
  const blipTimingMeasured =
    blipMs !== undefined &&
    preResizeHealthReady &&
    resizeReturnedMs !== undefined &&
    restartReturnedMs !== undefined &&
    sshReadyMarkMs !== undefined &&
    healthReadyMarkMs !== undefined
  const blipMeasured = blipTimingMeasured && grew
  const blipRaw = [
    `health path: ${healthPath ?? 'not selected'}`,
    `resize returned: ${resizeReturnedMs === undefined ? 'not measured' : ms(resizeReturnedMs)}`,
    `restart returned: ${restartReturnedMs === undefined ? 'not measured' : ms(restartReturnedMs)}`,
    `ssh-ready: ${sshReadyMarkMs === undefined ? 'not measured' : ms(sshReadyMarkMs)}`,
    `healthz-ok: ${healthReadyMarkMs === undefined ? 'not measured' : ms(healthReadyMarkMs)}`,
    `total resize-to-healthz: ${blipMs === undefined ? 'not measured' : ms(blipMs)}`,
    '',
    `post-reboot df grew: ${grew ? 'yes' : 'no / not measured'}`,
    `post-reboot filesystem size: ${afterGrow?.sizeBytes.toLocaleString('en-US') ?? 'not measured'} bytes (58GB requested)`,
    afterGrow?.bytes ?? 'df -B1 not measured',
  ].join('\n')

  const measured = [scope.text, rebootRaw, headroomRaw, duRaw, blipRaw]
  const report = [
    '# Per-tier storage rail probe',
    '',
    `- Date: ${new Date().toISOString()}`,
    `- VM: ${name}`,
    `- Image: ${imageRef}`,
    '',
    '## Verdict 1 — staging token scope',
    '',
    `**VERDICT:** ${scope.pass ? 'PASS' : 'FAIL'}`,
    '',
    fenced(scopeRaw),
    '',
    '## Verdict 2 — public share and reboot survival',
    '',
    `**VERDICT:** ${rebootPass ? 'PASS' : 'FAIL'}`,
    '',
    fenced(rebootRaw),
    '',
    '## Verdict 3 — empty-drive headroom',
    '',
    `**VERDICT:** ${headroom ? `${headroom.availBytes.toLocaleString('en-US')} available bytes` : 'NOT MEASURED'}`,
    '',
    fenced(headroomRaw),
    '',
    '## Verdict 4 — `du` cost',
    '',
    `**VERDICT:** ${duVerdict}`,
    '',
    fenced(duRaw),
    '',
    '## Verdict 5 — resize/restart blip',
    '',
    `**VERDICT:** ${blipMeasured ? ms(blipMs!) : blipTimingMeasured ? `FAIL — ${ms(blipMs!)} blip measured, but the filesystem did not grow to the requested size` : 'NOT MEASURED'}`,
    '',
    fenced(blipRaw),
    '',
    '## Cleanup and unexpected errors',
    '',
    fenced(
      [
        cleanupSummary,
        `unexpected errors: ${unexpected.join(' | ') || 'none'}`,
        `raw probe notes:\n${raw.join('\n\n') || 'none'}`,
      ].join('\n'),
    ),
    '',
  ].join('\n')

  await writeProbeReport(report)
  process.stdout.write(`${report}\n`)

  const anyVerdictUnmeasured = measured.some(value => value.includes('not measured'))
  const resizeOrRestartRefused = !resizedAccepted || !restartedAccepted
  if (
    !scope.pass ||
    resizeOrRestartRefused ||
    cleanupFailed ||
    unexpected.length > 0 ||
    anyVerdictUnmeasured ||
    !grew
  ) {
    process.exitCode = 1
  }
}

await main()
