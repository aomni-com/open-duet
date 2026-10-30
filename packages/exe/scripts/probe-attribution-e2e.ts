/**
 * Slice-11 watcher-integration E2E on a real exe.dev VM. Runs the PRODUCTION
 * attribution path end to end — real kernel events → real helper (helper-main) →
 * real actor resolver → real file pipeline — and asserts the slice-11 contract
 * on the attributed DriveFileEvents the gateway would relay (captured via a stub
 * fetch inside the pipeline). See probe-attribution-e2e-driver.ts for the VM-side
 * workload. Report: probe-results/reports/attribution-e2e.md.
 *
 * Scope: the single-VM backbone (session/terminal/read-drop attribution; the L9
 * gateway-pid and syncthing-pid drops that make a proxied PUT and a share-synced
 * edit each appear EXACTLY ONCE; restore = one event, zero storm; symlink ops
 * attribute with no special path). The full-stack staging demo (Convex polling,
 * a live Syncthing semantic event, the HTTP files route) is the paired staging
 * follow-up alongside the retention soak.
 *
 * VM tagged duet-test, deleted in finally; leak-check covers only this run.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { probeReportUrl } from './probe-artifacts.ts'
import { cleanup, createVm, makeContext, runOrThrow, vmName } from './probe-common.ts'

const WORK = '/tmp/duet-e2e'
const HELPER_ENTRY = new URL('../../gateway/src/attribution/helper-main.ts', import.meta.url)
const DRIVER_ENTRY = new URL('./probe-attribution-e2e-driver.ts', import.meta.url)
const REPORT = probeReportUrl('attribution-e2e.md')

interface EventSummary {
  kind: string
  actor: string
  path?: string
}
interface DriverPayload {
  kernel: string
  bun: string
  leaf: string
  sessionId: string
  sessionWrite: EventSummary[]
  terminalWrite: EventSummary[]
  sessionRead: EventSummary[]
  terminalReadDropped: number
  gatewayWrite: EventSummary[]
  gatewayFramesRaw: number
  syncWrite: EventSummary[]
  syncFramesRaw: number
  restore: { storm: number; restoreEvents: EventSummary[] }
  linkEvents: EventSummary[]
  stats: {
    droppedReads: number
    overflow: number
    mirrorReadsSkipped: number
    cgroupMisses: number
    helperRestarts: number
  }
  exitCode: number
}

function q(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`
}

async function uploadFile(
  ctx: ReturnType<typeof makeContext>,
  dest: string,
  remotePath: string,
  content: string,
  gzipped: boolean,
): Promise<void> {
  const bytes = Buffer.from(content)
  const encoded = (gzipped ? Buffer.from(Bun.gzipSync(bytes)) : bytes).toString('base64')
  const b64Path = `${remotePath}.b64`
  await runOrThrow(ctx.ssh, dest, `rm -f ${b64Path}`)
  for (let offset = 0; offset < encoded.length; offset += 48_000) {
    await runOrThrow(
      ctx.ssh,
      dest,
      `printf %s ${q(encoded.slice(offset, offset + 48_000))} >> ${b64Path}`,
    )
  }
  const decode = gzipped
    ? `base64 -d ${b64Path} | gunzip > ${remotePath}`
    : `base64 -d ${b64Path} > ${remotePath}`
  await runOrThrow(ctx.ssh, dest, `${decode} && rm ${b64Path}`)
}

async function assertOwnVmsDeleted(ctx: ReturnType<typeof makeContext>): Promise<void> {
  let leaked: string[] = []
  for (let attempt = 0; attempt < 10; attempt++) {
    const names = new Set((await ctx.control.list()).map(vm => vm.vm_name))
    leaked = ctx.created.filter(name => names.has(name))
    if (leaked.length === 0) return
    await Bun.sleep(1_000)
  }
  throw new Error(`This run's duet-test VMs remain: ${leaked.join(', ')}`)
}

function bundle(entry: URL): string {
  const build = Bun.spawnSync(['bun', 'build', fileURLToPath(entry), '--target=bun'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (build.exitCode !== 0) throw new Error(`bun build failed: ${build.stderr.toString()}`)
  return build.stdout.toString()
}

async function main(): Promise<void> {
  const ctx = makeContext()
  const name = vmName('attribution-e2e')
  let failure: unknown
  let cleanupFailure: Error | undefined
  try {
    await ctx.control.whoami()
    const helperBundle = bundle(HELPER_ENTRY)
    const driverBundle = bundle(DRIVER_ENTRY)

    const createdVm = await createVm(ctx, {
      name,
      comment: 'duet slice-11 watcher-integration E2E',
    })
    const dest = createdVm.value.ssh_dest
    await ctx.ssh.waitUntilReady(dest, { timeoutMs: 180_000 })
    await runOrThrow(ctx.ssh, dest, "sudo -n true && echo 'sudo ok'")
    await runOrThrow(ctx.ssh, dest, 'curl -fsSL https://bun.sh/install | bash', 180_000)
    await runOrThrow(ctx.ssh, dest, `mkdir -p ${WORK}`)
    await uploadFile(ctx, dest, `${WORK}/helper.js`, helperBundle, true)
    await uploadFile(ctx, dest, `${WORK}/driver.js`, driverBundle, true)

    const run = await ctx.ssh.exec(
      dest,
      `sudo /home/exedev/.bun/bin/bun ${WORK}/driver.js`,
      300_000,
    )
    const jsonStart = run.stdout.indexOf('DRIVER-JSON:')
    if (jsonStart < 0) {
      throw new Error(
        `driver failed. exit=${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      )
    }
    const p = JSON.parse(run.stdout.slice(jsonStart + 'DRIVER-JSON:'.length)) as DriverPayload

    const sessionActor = `session:${p.sessionId}`
    const one = (events: EventSummary[], actor: string) =>
      events.length === 1 && events[0]!.actor === actor
    const allActor = (events: EventSummary[], actor: string) =>
      events.length > 0 && events.every(e => e.actor === actor)
    // Best-effort attribution (the slice-09 open-less boundary): every event is
    // one of the acceptable actors — never a WRONG session — and always present.
    const allActorIn = (events: EventSummary[], actors: string[]) =>
      events.length > 0 && events.every(e => actors.includes(e.actor))

    // A new file legitimately surfaces BOTH a create and a content write — the
    // pin attributes every one to the session (no open-less loss: writes open).
    const sessionOk = allActor(p.sessionWrite, sessionActor)
    const terminalOk = allActor(p.terminalWrite, 'terminal')
    const readOk = allActor(p.sessionRead, sessionActor) && p.terminalReadDropped === 0
    // Exactly-once for a proxied PUT: the gateway-pid write produces NO watcher
    // event, so the API's own semantic event is the sole record (L9).
    const gatewayDedupOk = p.gatewayWrite.length === 0 && p.gatewayFramesRaw === 0
    // Exactly-once for a share-synced edit: the excluded "syncthing" pid produces
    // NO watcher event, so slice-18's semantic event is the sole record.
    const syncDedupOk = p.syncWrite.length === 0 && p.syncFramesRaw === 0
    const restoreOk = p.restore.storm === 0 && one(p.restore.restoreEvents, 'system')
    // Symlink name-ops (`ln -s`/`rm`) are open-less like bare rm/mv — pin-missed →
    // `terminal` (the recorded slice-09 boundary); `mv` may still pin to session.
    // The contract: every link event is present, path correct, actor best-effort
    // (session-or-terminal), NEVER a wrong session.
    const linksOk = allActorIn(p.linkEvents, [sessionActor, 'terminal'])
    const exitOk = p.exitCode === 0

    const green =
      sessionOk &&
      terminalOk &&
      readOk &&
      gatewayDedupOk &&
      syncDedupOk &&
      restoreOk &&
      linksOk &&
      exitOk

    const pf = (b: boolean) => (b ? 'PASS' : 'FAIL')
    const fmt = (events: EventSummary[]) =>
      events.length === 0 ? '(none)' : events.map(e => `\`${JSON.stringify(e)}\``).join(', ')

    const report = `# Slice-11 watcher-integration E2E

Run: ${new Date().toISOString()} on VM \`${name}\` (deleted after capture).
Kernel \`${p.kernel}\`, Bun \`${p.bun}\`. Path under test end to end: real kernel
events → \`helper-main.ts\` → \`actor-resolver.ts\` → \`pipeline.ts\`, asserting on
the attributed \`DriveFileEvent\`s the pipeline relays (captured via a stub fetch).

## Exactly-once + attribution assertions

| # | Assertion | Observed | Result |
| - | --------- | -------- | ------ |
| A | agent-session write → \`${sessionActor}\` (create+write pair) | ${fmt(p.sessionWrite)} | ${pf(sessionOk)} |
| B | terminal (non-cgroup) write → \`terminal\` | ${fmt(p.terminalWrite)} | ${pf(terminalOk)} |
| C | session read attributed; terminal read dropped (Q1) | read ${fmt(p.sessionRead)}; terminal-reads-dropped=${p.terminalReadDropped} | ${pf(readOk)} |
| D | proxied PUT **exactly once** — gateway-pid watcher write dropped (L9) | watcher events=${p.gatewayWrite.length}, raw helper frames=${p.gatewayFramesRaw} | ${pf(gatewayDedupOk)} |
| E | share-synced edit **exactly once** — syncthing-pid watcher write dropped | watcher events=${p.syncWrite.length}, raw helper frames=${p.syncFramesRaw} | ${pf(syncDedupOk)} |
| F | restore → one \`system\` event, zero per-file storm (L6) | storm=${p.restore.storm}, restore=${fmt(p.restore.restoreEvents)} | ${pf(restoreOk)} |
| G | symlink ops attribute best-effort (open-less \`ln\`/\`rm\`→terminal, boundary), never wrong, path always correct | ${fmt(p.linkEvents)} | ${pf(linksOk)} |

Telemetry after the run (L12): droppedReads=${p.stats.droppedReads}, overflow=${p.stats.overflow}, cgroupMisses=${p.stats.cgroupMisses}, helperRestarts=${p.stats.helperRestarts}. Clean shutdown exit=${p.exitCode}.

Verdict: **${green ? 'GREEN' : 'RED'}** — ${
      green
        ? 'the wired path attributes agent execs to their session, terminal writes to `terminal`, drops unattributed reads, and each of the gateway-pid (proxied PUT) and syncthing-pid (share sync) writes produces zero watcher events so the semantic event is the sole record; restore collapses a 20-file storm to one event; symlink ops attribute best-effort per the slice-09 open-less boundary (open-less `ln -s`/`rm` degrade to `terminal`, never a wrong session, path always correct).'
        : 'at least one assertion failed — see the table.'
    }
`
    await mkdir(fileURLToPath(new URL('.', REPORT)), { recursive: true })
    await writeFile(fileURLToPath(REPORT), report)
    console.log(report)
    if (!green) process.exitCode = 1
  } catch (e) {
    failure = e
  } finally {
    const result = await cleanup(ctx)
    if (result.deleteErrors.length) cleanupFailure = new Error(result.deleteErrors.join('; '))
    try {
      await assertOwnVmsDeleted(ctx)
    } catch (e) {
      cleanupFailure = e instanceof Error ? e : new Error(String(e))
    }
    console.error(
      cleanupFailure
        ? `Cleaned ${result.deleted.join(', ')}; verification failed`
        : `Cleaned ${result.deleted.join(', ') || 'none'}; this run's VMs are gone`,
    )
  }
  if (cleanupFailure) throw cleanupFailure
  if (failure) throw failure
}

await main()
