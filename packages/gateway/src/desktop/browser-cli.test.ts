import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runDesktopBrowserCli } from './browser-cli'

test('duet-browser reads runner identity plus VM authority and prints its exact target handle', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-cli-'))
  const lines: string[] = []
  const requests: Request[] = []
  try {
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-secret\n', { mode: 0o600 })
    await runDesktopBrowserCli({
      env: { DUET_SESSION_ID: 'session-a', DUET_STATE_DIR: stateDir },
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return Response.json({
          batchId: 'batch-a',
          owner: { kind: 'root' },
          targetId: 'target-a',
          webSocketDebuggerUrl: 'ws://127.0.0.1:3000/v1/desktop/browser/cdp/grant-a.token-a',
        })
      },
      writeLine: line => lines.push(line),
    })

    expect(lines).toEqual([
      JSON.stringify({
        targetId: 'target-a',
        webSocketDebuggerUrl: 'ws://127.0.0.1:3000/v1/desktop/browser/cdp/grant-a.token-a',
      }),
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('http://127.0.0.1:3000/v1/desktop/browser/batches')
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer vm-secret')
    expect(await requests[0]!.json()).toEqual({ sessionId: 'session-a' })
    expect(lines.join('')).not.toContain('vm-secret')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('duet-browser refuses to act without a runner session id', async () => {
  await expect(
    runDesktopBrowserCli({
      env: {},
      fetch: async () => {
        throw new Error('must not fetch')
      },
      writeLine() {},
    }),
  ).rejects.toThrow('DUET_SESSION_ID')
})

test('duet-browser preserves retryable capacity details for the calling agent', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-cli-capacity-'))
  try {
    await writeFile(join(stateDir, 'vm-token'), 'vm-secret\n', { mode: 0o600 })
    await expect(
      runDesktopBrowserCli({
        env: { DUET_SESSION_ID: 'session-a', DUET_STATE_DIR: stateDir },
        fetch: async () =>
          Response.json(
            { error: 'browser_capacity', retryable: true, retryAfterMs: 60_000 },
            { status: 429 },
          ),
        writeLine() {},
      }),
    ).rejects.toMatchObject({
      code: 'browser_capacity',
      retryable: true,
      retryAfterMs: 60_000,
    })
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('duet-browser rejects a raw Chrome CDP address from the gateway', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'duet-browser-cli-raw-cdp-'))
  try {
    await writeFile(join(stateDir, 'vm-token'), 'vm-secret\n', { mode: 0o600 })
    await expect(
      runDesktopBrowserCli({
        env: { DUET_SESSION_ID: 'session-a', DUET_STATE_DIR: stateDir },
        fetch: async () =>
          Response.json({
            targetId: 'target-a',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/raw',
          }),
        writeLine() {},
      }),
    ).rejects.toThrow('invalid target')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})
