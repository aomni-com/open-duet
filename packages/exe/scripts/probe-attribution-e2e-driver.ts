/**
 * VM-side driver for the slice-11 watcher-integration E2E (bundled + uploaded by
 * probe-attribution-e2e.ts; runs as root on a real exe.dev VM). Unlike the
 * slice-09 helper probe (which reads raw helper frames), this exercises the FULL
 * slice-11 attribution path end to end with the PRODUCTION code:
 *
 *   real kernel events → real helper (helper-main) → real actor resolver
 *   (actor-resolver) → real file pipeline (pipeline) → captured outbound batches
 *
 * so every assertion is on the attributed DriveFileEvents the gateway WOULD
 * relay, not on probe-side reconstruction. The stub `fetch` records each batch;
 * the driver emits one DRIVER-JSON blob the orchestrator turns into a verdict.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

import type { DriveFileEvent, FileEventBatch } from '../../contract/src/index.ts'
import { createActorResolver } from '../../gateway/src/attribution/actor-resolver.ts'
import {
  encodeHelperCommand,
  parseHelperLine,
  type HelperEvent,
} from '../../gateway/src/attribution/helper-protocol.ts'
import { createFileEventPipeline } from '../../gateway/src/attribution/pipeline.ts'

const DRIVE = '/home/exedev/drive'
const RUN = '/dev/shm/duet-e2e'
const WORK = '/tmp/duet-e2e'
const BUN = process.execPath
const HELPER = `${WORK}/helper.js`
const RUNNERS = '/sys/fs/cgroup/runners'
const LEAF = 'session-e2e1'
const SESSION_ID = 'e2e1'

mkdirSync(RUN, { recursive: true })
mkdirSync(`${DRIVE}/e2e`, { recursive: true })
mkdirSync(`${RUNNERS}/${LEAF}`, { recursive: true })

// ── The captured relay: every event the pipeline admits and flushes lands here.
const delivered: DriveFileEvent[] = []
const pipeline = createFileEventPipeline({
  apiUrl: 'http://stub-api',
  getVmToken: async () => 'vm-token',
  fetch: async (_url, init) => {
    const batch = JSON.parse(String(init?.body)) as FileEventBatch
    delivered.push(...batch.events)
    return new Response('{}', { status: 200 })
  },
  now: () => Date.now(),
  flushMs: 50,
})

// ── A fake gateway pid (dropped in-helper AND defensively in the resolver) and a
// fake "syncthing" pid (dropped in-helper via exclude-pids — the L9 sync path).
function bg(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(['bash'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' })
}
function member(leaf: string | null): ReturnType<typeof Bun.spawn> {
  const p = bg()
  if (leaf !== null) writeFileSync(`${RUNNERS}/${leaf}/cgroup.procs`, String(p.pid))
  return p
}
let seq = 0
async function run(p: ReturnType<typeof bg>, cmd: string, timeoutMs = 20_000): Promise<void> {
  const marker = `${RUN}/done-${seq++}`
  p.stdin.write(`${cmd}\necho ok > ${marker}\n`)
  p.stdin.flush()
  const end = Date.now() + timeoutMs
  while (!existsSync(marker)) {
    if (Date.now() > end) throw new Error(`cmd timeout: ${cmd}`)
    await Bun.sleep(20)
  }
}

const gw = member(null) // the "gateway" process (L9 self-write drop)
const st = member(null) // the "syncthing" daemon (exclude-pids drop)
const term = member(null) // a plain terminal/SSH process (no cgroup → terminal)
const sess = member(LEAF) // an agent session (cgroup leaf → session:<id>)

// ── The real actor resolver (the ONE OS-event → actor policy owner).
const resolver = createActorResolver({ gatewayPid: gw.pid })

// ── Spawn the production helper; pump its frames through resolver → pipeline.
const frames: HelperEvent[] = []
const helper = Bun.spawn([BUN, HELPER, DRIVE, String(gw.pid)], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
})
const helperErr = new Response(helper.stderr).text()
void (async () => {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of helper.stdout) {
    buf += dec.decode(chunk, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line) continue
      const event = parseHelperLine(line)
      if (event === null) continue
      frames.push(event)
      if (event.t === 'fs') {
        const resolved = resolver.resolve(event)
        if (resolved !== null) pipeline.emit(resolved)
      } else if (event.t === 'stats') {
        pipeline.mergeHelperStats({ overflow: event.overflow, cgroupMisses: event.cgroupMisses })
      }
    }
  }
})()

async function waitReady(): Promise<HelperEvent | null> {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    const r = frames.find(f => f.t === 'ready')
    if (r) return r
    await Bun.sleep(25)
  }
  return null
}
const ready = await waitReady()
if (!ready || ready.t !== 'ready') throw new Error(`helper never ready: ${await helperErr}`)

// Drop the fake syncthing pid in-helper exactly like gateway-pid (the L9 rule).
helper.stdin.write(encodeHelperCommand({ t: 'exclude-pids', pids: [st.pid] }))
helper.stdin.flush()
await Bun.sleep(300)

async function settle(): Promise<void> {
  await Bun.sleep(800)
  await pipeline.flush()
}
const eventsFor = (path: string): DriveFileEvent[] =>
  delivered.filter(e => 'path' in e && e.path === path)

// ── A: agent-session write → session:<id> ───────────────────────────────────
await run(sess, `printf hi > ${DRIVE}/e2e/sess.txt`)
await settle()
const sessionWrite = eventsFor('e2e/sess.txt')

// ── B: terminal (non-cgroup) write → terminal ───────────────────────────────
await run(term, `printf hi > ${DRIVE}/e2e/term.txt`)
await settle()
const terminalWrite = eventsFor('e2e/term.txt')

// ── C: session read attributed; a terminal read is dropped (Q1) ─────────────
await run(sess, `cat ${DRIVE}/e2e/sess.txt > /dev/null`)
await run(term, `cat ${DRIVE}/e2e/term.txt > /dev/null`)
await settle()
const sessionRead = delivered.filter(e => e.kind === 'read' && e.path === 'e2e/sess.txt')
const terminalReadDropped = delivered.filter(e => e.kind === 'read' && e.path === 'e2e/term.txt')

// ── D: gateway-pid write → dropped in-helper (L9 exactly-once for a proxied
//      write: the API's semantic event would be the sole record) ─────────────
await run(gw, `printf hi > ${DRIVE}/e2e/gw.txt`)
await settle()
const gatewayWrite = eventsFor('e2e/gw.txt')
const gatewayFramesRaw = frames.filter(f => f.t === 'fs' && f.path === 'e2e/gw.txt')

// ── E: excluded "syncthing" pid write → dropped in-helper (exactly-once for a
//      share-synced edit: slice-18's semantic event is the sole record) ──────
await run(st, `printf hi > ${DRIVE}/e2e/sync.txt`)
await settle()
const syncWrite = eventsFor('e2e/sync.txt')
const syncFramesRaw = frames.filter(f => f.t === 'fs' && f.path === 'e2e/sync.txt')

// ── F: restore → one event, zero per-file storm (L6) ────────────────────────
const beforeRestore = delivered.length
pipeline.suppress(true)
helper.stdin.write(encodeHelperCommand({ t: 'suppress', on: true }))
helper.stdin.flush()
await Bun.sleep(200)
await run(sess, `for i in $(seq 0 19); do printf x > ${DRIVE}/e2e/restore-$i.txt; done`)
await Bun.sleep(600)
pipeline.suppress(false)
helper.stdin.write(encodeHelperCommand({ t: 'suppress', on: false }))
helper.stdin.flush()
pipeline.emit({ kind: 'restore', actor: 'system', at: Date.now() })
await pipeline.flush()
const restoreEvents = delivered.slice(beforeRestore)
const restoreStorm = restoreEvents.filter(e => 'path' in e && e.path.startsWith('e2e/restore-'))
const restoreOnly = restoreEvents.filter(e => e.kind === 'restore')

// ── G: symlink create/delete/rename in a session → attributed, no special path
await run(sess, `ln -s ${DRIVE}/e2e/sess.txt ${DRIVE}/e2e/link1`)
await run(sess, `mv ${DRIVE}/e2e/link1 ${DRIVE}/e2e/link2`)
await run(sess, `rm ${DRIVE}/e2e/link2`)
await settle()
const linkEvents = delivered.filter(
  e => 'path' in e && (e.path === 'e2e/link1' || e.path === 'e2e/link2'),
)

// ── Clean shutdown; capture final telemetry.
helper.stdin.write(encodeHelperCommand({ t: 'shutdown' }))
helper.stdin.flush()
const exitCode = await Promise.race([helper.exited, Bun.sleep(5000).then(() => -1)])
for (const p of [gw, st, term, sess]) {
  try {
    p.kill('SIGKILL')
  } catch {
    // best effort
  }
}

const summarize = (events: DriveFileEvent[]) =>
  events.map(e => ({ kind: e.kind, actor: e.actor, ...('path' in e ? { path: e.path } : {}) }))

console.log(
  `DRIVER-JSON:${JSON.stringify({
    kernel: (await Bun.file('/proc/sys/kernel/osrelease').text()).trim(),
    bun: Bun.version,
    leaf: LEAF,
    sessionId: SESSION_ID,
    sessionWrite: summarize(sessionWrite),
    terminalWrite: summarize(terminalWrite),
    sessionRead: summarize(sessionRead),
    terminalReadDropped: terminalReadDropped.length,
    gatewayWrite: summarize(gatewayWrite),
    gatewayFramesRaw: gatewayFramesRaw.length,
    syncWrite: summarize(syncWrite),
    syncFramesRaw: syncFramesRaw.length,
    restore: { storm: restoreStorm.length, restoreEvents: summarize(restoreOnly) },
    linkEvents: summarize(linkEvents),
    stats: pipeline.stats(),
    exitCode,
  })}`,
)
process.exit(0)
