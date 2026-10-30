import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { serializeMemoryFile } from '@repo/agent/memory-store'

import { createGatewayRuntime } from '../src/runtime/http'
import { createTrainJobLedger } from '../src/train/job-ledger'

const [stateDir, driveDir, scenario] = process.argv.slice(2)
await mkdir(stateDir!, { recursive: true })
await mkdir(driveDir!, { recursive: true })
await writeFile(join(stateDir!, 'vm-token'), 'fixture-token\n')
if (scenario === 'lost-response') {
  const ledger = createTrainJobLedger({ stateDir: stateDir!, now: Date.now })
  ledger.start('previous-job', 'previous-user')
  ledger.setPhase('previous-job', 'snapshotting')
  ledger.setPhase('previous-job', 'training')
}
let responseLost = false
let trainAttempts = 0
let finish: () => void = () => {}
const completed = new Promise<void>(resolve => {
  finish = resolve
})
const emit = (value: unknown) => console.log(JSON.stringify(value))
const runtime = createGatewayRuntime({
  stateDir,
  driveDir,
  apiUrl: 'https://ctl.test',
  syncthingApiKey: 'fixture-key',
  duetRunner: async () => {
    throw new Error('No native CLI in this fixture')
  },
  connectedProviderRunCommand: () => ({
    stdout: new Blob(['[]']).stream(),
    stderr: new Blob([]).stream(),
    exited: Promise.resolve(0),
    kill: () => {},
  }),
  fetch: async (input, init) => {
    if (String(input).endsWith('/v1/vm/sync')) {
      const body = JSON.parse(String(init?.body))
      const path = join(stateDir!, 'train/job-ledger-v3.json')
      const persisted = await readFile(path, 'utf8')
        .then(JSON.parse)
        .catch(() => ({ outbox: [] }))
      emit({ type: 'sync', reports: body.trainReports, persistedReports: persisted.outbox })
      if (
        scenario === 'lost-response' &&
        !responseLost &&
        body.trainReports.some(
          (report: { jobId: string; phase: string }) =>
            report.jobId !== 'previous-job' && report.phase === 'training',
        )
      ) {
        responseLost = true
        throw new Error('Response lost after accepting reports')
      }
      return Response.json({
        pollAfterMs: 300_000,
        anchors: [],
        mirrorMachineIds: [],
        updates: { paused: true },
        acceptedTrainReportGenerations: body.trainReports.map(
          (report: { generation: string }) => report.generation,
        ),
      })
    }
    return Response.json({
      myID: 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY',
    })
  },
  trainRunner: async input => {
    trainAttempts += 1
    await completed
    if (scenario === 'failed' && trainAttempts === 1) throw new Error('Training fixture failed')
    await mkdir(input.storeDir, { recursive: true })
    await writeFile(
      join(input.storeDir, `${input.slug}.md`),
      serializeMemoryFile({
        version: 1,
        id: 'fixture-memory',
        kind: 'train',
        createdAt: Date.now(),
        content: 'Training fixture.\n',
      }),
    )
    return { record: null, stdout: '', stderr: '' }
  },
})
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: runtime.app.fetch })
runtime.startSyncLoop()
emit({ type: 'ready', url: `http://127.0.0.1:${server.port}` })
for await (const chunk of Bun.stdin.stream()) {
  if (new TextDecoder().decode(chunk).includes('finish')) finish()
}
