import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DUET_APP_SLUG_HEADER, type GatewayAppConfig } from '@repo/contract'

import { AppSupervisor } from '../routes/apps'
import { trackAppProcesses } from '../testing/app-processes.test-helper'
import { cleanUpTestTimeouts } from '../testing/timeouts.test-helper'

const appProcesses = trackAppProcesses()
const scratchDirs: string[] = []
const supervisors: AppSupervisor[] = []
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) supervisor.stop()
  await appProcesses.stopChildren()
  await Promise.all(scratchDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
cleanUpTestTimeouts()

test('aborting a proxied app stream reaches the app request signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duet-app-proxy-cancel-'))
  scratchDirs.push(root)
  const driveDir = join(root, 'drive')
  const appDir = join(driveDir, 'apps', 'streaming')
  const port = await freePort()
  const app: GatewayAppConfig = {
    slug: 'streaming',
    command: 'bun server.ts',
    port,
    anchorPath: 'apps/streaming',
    appId: 'fixture-app',
    apiScopes: [],
  }
  await mkdir(appDir, { recursive: true })
  await writeFile(
    join(appDir, 'server.ts'),
    [
      "import { appendFileSync } from 'node:fs'",
      'Bun.serve({',
      "  hostname: '127.0.0.1',",
      '  port: Number(process.env.PORT),',
      '  idleTimeout: 255,',
      '  fetch(request) {',
      "    if (new URL(request.url).pathname !== '/events') return new Response('ready')",
      '    let streamController: ReadableStreamDefaultController<Uint8Array>',
      "    request.signal.addEventListener('abort', () => {",
      "      appendFileSync('closed.txt', 'closed\\n')",
      '      streamController.close()',
      '    }, { once: true })',
      '    return new Response(new ReadableStream({',
      '      start(controller) {',
      '        streamController = controller',
      "        controller.enqueue(new TextEncoder().encode('id: 1\\ndata: ready\\n\\n'))",
      '      },',
      "    }), { headers: { 'content-type': 'text/event-stream' } })",
      '  },',
      '})',
      'await new Promise(() => {})',
    ].join('\n'),
  )

  const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 10 })
  supervisors.push(supervisor)
  const downstream = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    await supervisor.reconcile([app])
    const response = await supervisor.handleProxy(
      new Request('http://gateway/public/app/events', {
        headers: { [DUET_APP_SLUG_HEADER]: app.slug, accept: 'text/event-stream' },
        signal: downstream.signal,
      }),
    )
    reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('id: 1\ndata: ready\n\n')

    downstream.abort()

    expect(await waitForFile(join(appDir, 'closed.txt'))).toBe('closed\n')
  } finally {
    downstream.abort()
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
})

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await Bun.sleep(20)
    }
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('port allocation failed')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}
