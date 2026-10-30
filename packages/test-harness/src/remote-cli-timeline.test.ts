import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConvexHttpClient } from 'convex/browser'

import type { SessionTimelineEntry } from '@repo/contract'

import { createSessionEventStream } from '../../../apps/api/src/session-event-stream'
import type { CliRuntime, CliResult } from '../../duet/src/cli-support'
import { configPathForHome, saveConfig } from '../../duet/src/config'

test('agent run consumes the API timeline through compact terminal markers in JSON and human modes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'duet-remote-timeline-'))
  const closeStreams: Array<() => Promise<void>> = []
  try {
    await saveConfig(
      { apiKey: 'duet_test_key', defaultWorkspace: 'demo', apiUrl: 'https://api.example' },
      configPathForHome(home),
    )
    const cliPath = new URL('../../duet/src/cli.ts', import.meta.url).pathname
    const { runCli } = (await import(cliPath)) as {
      runCli: (args: string[], runtime: CliRuntime) => Promise<CliResult>
    }
    const events: SessionTimelineEntry[] = [
      {
        seq: 1,
        createdAt: 1,
        event: { type: 'session_created', prompt: 'hello', createdAt: '2026-10-04T00:00:00.000Z' },
      },
      {
        seq: 2,
        createdAt: 2,
        event: {
          type: 'prompt_submitted',
          prompt: 'hello',
          inputKind: 'initial',
          behavior: 'steer',
          sender: { kind: 'user', userId: 'user-1' },
        },
      },
      { seq: 3, createdAt: 3, event: { type: 'turn_started' } },
      {
        seq: 4,
        createdAt: 4,
        event: { type: 'future_timeline_event', detail: 'retain opaque JSON' },
      },
      { seq: 5, createdAt: 5, event: { type: 'complete', status: 'completed', result: 'done' } },
      {
        seq: 6,
        createdAt: 6,
        event: { type: 'step', step: { type: 'text', text: 'after terminal' } },
      },
    ]
    const created = { session: { sessionId: 'session-1', status: 'running', lastEventSeq: 2 } }
    for (const json of [true, false]) {
      const stdout: string[] = []
      const stderr: string[] = []
      let streamCancelled = false
      const result = await runCli([...(json ? ['--json'] : []), 'agent', 'run', 'hello'], {
        home,
        env: {},
        io: {
          stdout: { write: chunk => (stdout.push(String(chunk)), true) },
          stderr: { write: chunk => (stderr.push(String(chunk)), true) },
        },
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname
          if (path === '/v1/ws/demo/agent/sessions' && init?.method === 'POST')
            return Response.json(created)
          if (path !== '/v1/ws/demo/agent/sessions/session-1/events')
            throw new Error(`Unexpected request: ${path}`)
          const durableStream = createSessionEventStream({
            convex: {
              query: async (_ref: unknown, args: { afterSeq: number }) => ({
                events: events.filter(event => event.seq > args.afterSeq),
                headSeq: 6,
                closed: false,
                terminal: true,
              }),
            } as unknown as ConvexHttpClient,
            internalKey: 'internal',
            gatewayClient: {
              openAgentSessionHints: async () => {
                throw new Error('A completed durable page needs no gateway')
              },
            },
            workspaceSlug: 'demo',
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            afterSeq: 0,
          })
          const reader = durableStream.getReader()
          closeStreams.push(async () => {
            await reader.cancel().catch(() => undefined)
            reader.releaseLock()
          })
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                const chunk = await reader.read()
                if (chunk.done) controller.close()
                else controller.enqueue(chunk.value)
              },
              async cancel(reason) {
                streamCancelled = true
                await reader.cancel(reason)
                reader.releaseLock()
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        },
      })
      expect({ ...result, stderr: stderr.join('') }).toEqual({ exitCode: 0, stderr: '' })
      const output = stdout.join('')
      if (json) {
        expect(
          output
            .trim()
            .split('\n')
            .map(line => JSON.parse(line)),
        ).toEqual([created, ...events.slice(0, 5).map(({ seq, event }) => ({ seq, event }))])
      } else {
        expect(output).toContain('turn: started\n')
        expect(output).toContain('complete: done\n')
      }
      expect(output).not.toContain('after terminal')
      expect(streamCancelled).toBe(true)
    }
  } finally {
    await Promise.all(closeStreams.map(close => close()))
    await rm(home, { recursive: true, force: true })
  }
})
