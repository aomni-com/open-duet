import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Syncthing consumers wait until hardening and mount projection both succeed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-syncthing-init-'))
  const script = `
  import { createGatewayRuntime } from ${JSON.stringify(resolve(import.meta.dir, 'http.ts'))}
  const checkpoints = []
  let configReads = 0
  let diskEventPolls = 0
  const requests: string[] = []
  const resumeRetries: Array<() => void> = []
  let retryCount = 0
  const never = new Promise<Response>(() => undefined)

  const runtime = createGatewayRuntime({
    stateDir: ${JSON.stringify(join(root, 'state'))},
    driveDir: ${JSON.stringify(join(root, 'drive'))},
    syncthingApiUrl: 'http://syncthing.test',
    syncthingApiKey: 'test-key',
    syncthingRetryDelay: async () => {
      retryCount += 1
      await new Promise<void>(resolve => {
        resumeRetries.push(resolve)
      })
    },
    fetch: async (input, init) => {
      const url = String(input)
      requests.push(url)
      if (url === 'http://syncthing.test/rest/config') {
        if (init?.method === 'PUT') return new Response(null, { status: 204 })
        configReads += 1
        if (configReads === 1 || configReads === 3) {
          return new Response(null, { status: 503 })
        }
        return Response.json({ devices: [], folders: [] })
      }
      if (url.includes('/rest/events/disk')) {
        diskEventPolls += 1
        return never
      }
      if (url.includes('/rest/events?')) return never
      throw new Error("unexpected Syncthing request: " + url)
    },
  })

  runtime.startSyncthingIntegrationLoop()
  runtime.startSyncthingIntegrationLoop()
  await waitFor(
    () => retryCount === 1,
    () => requests.join(', '),
  )
  checkpoints.push(diskEventPolls)

  resumeRetries.shift()?.()
  await waitFor(
    () => retryCount === 2,
    () => requests.join(', '),
  )
  checkpoints.push(diskEventPolls)

  resumeRetries.shift()?.()
  await waitFor(() => diskEventPolls === 1)
  checkpoints.push(diskEventPolls)
  console.log(JSON.stringify(checkpoints))
  process.exit(0)
async function waitFor(predicate: () => boolean, detail: () => string = () => ''): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition: " + detail())
    await Bun.sleep(5)
  }
}

  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  })
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual([0, 0, 1])
  } finally {
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
})
