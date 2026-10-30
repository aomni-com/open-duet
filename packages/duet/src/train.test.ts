import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FetchLike } from '@repo/contract'

import { ApiClient } from './http.js'
import { train } from './train.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('duet train', () => {
  test('defaults binary uploads and train start to the workspace root scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-train-'))
    roots.push(root)
    const path = join(root, 'corpus.bin')
    const expected = Buffer.from([0, 1, 2, 127, 128, 254, 255, 10])
    await writeFile(path, expected)
    const calls: Array<{ path: string; body: string | null }> = []
    let uploadBodyWasNodeStream = false
    let uploaded = Buffer.alloc(0)

    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/ws/demo/train/uploads/session') {
        return Response.json({
          vmBaseUrl: 'https://vm.test/',
          uploadPath: '/v1/train/uploads',
          uploadToken: 'upload_test',
          expiresAt: Date.now() + 60_000,
        })
      }
      if (url.pathname === '/v1/train/uploads/corpus.bin') {
        if (init?.body === undefined || init.body === null) throw new Error('missing upload body')
        uploadBodyWasNodeStream = typeof (init.body as { pipe?: unknown }).pipe === 'function'
        const chunks: Buffer[] = []
        for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk))
        }
        uploaded = Buffer.concat(chunks)
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer upload_test')
        return Response.json({ filename: 'corpus.bin', size: uploaded.byteLength, uploadedAt: 1 })
      }
      if (url.pathname === '/v1/ws/demo/train' && init?.method === 'POST') {
        calls.push({ path: url.pathname, body: init.body === undefined ? null : String(init.body) })
        return Response.json({ jobId: 'train_1' }, { status: 202 })
      }
      if (url.pathname === '/v1/ws/demo/train/train_1') {
        return Response.json({ job: { jobId: 'train_1', state: 'done', phase: 'done' } })
      }
      throw new Error(`unexpected request: ${url}`)
    }
    const api = new ApiClient({
      baseUrl: 'https://api.test',
      apiKey: 'duet_sk_test',
      fetch: fetchImpl,
    })

    await train(['demo', '--file', path], {
      global: { json: true },
      api,
      io: sinks(),
      sleep: async () => undefined,
      fetch: fetchImpl,
    })

    expect(uploadBodyWasNodeStream).toBe(true)
    expect(createHash('sha256').update(uploaded).digest('hex')).toBe(
      createHash('sha256').update(expected).digest('hex'),
    )
    expect(calls).toEqual([{ path: '/v1/ws/demo/train', body: null }])
  })

  test('stages each URL through the add-URL endpoint before starting', async () => {
    const calls: Array<{ path: string; body: string | null }> = []
    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, body: init?.body === undefined ? null : String(init.body) })
      if (url.pathname === '/v1/ws/demo/train/uploads/url') {
        return Response.json({ filename: 'source.md', size: 12, uploadedAt: 1 }, { status: 201 })
      }
      if (url.pathname === '/v1/ws/demo/train') {
        return Response.json({ jobId: 'train_1' }, { status: 202 })
      }
      if (url.pathname === '/v1/ws/demo/train/train_1') {
        return Response.json({ job: { jobId: 'train_1', state: 'done', phase: 'done' } })
      }
      throw new Error(`unexpected request: ${url}`)
    }
    const api = new ApiClient({
      baseUrl: 'https://api.test',
      apiKey: 'duet_sk_test',
      fetch: fetchImpl,
    })

    await train(
      ['demo', '--url', 'https://one.example/guide', '--url', 'https://two.example/docs'],
      {
        global: { json: true },
        api,
        io: sinks(),
        sleep: async () => undefined,
        fetch: fetchImpl,
      },
    )

    expect(calls.slice(0, 3)).toEqual([
      {
        path: '/v1/ws/demo/train/uploads/url',
        body: '{"url":"https://one.example/guide"}',
      },
      {
        path: '/v1/ws/demo/train/uploads/url',
        body: '{"url":"https://two.example/docs"}',
      },
      { path: '/v1/ws/demo/train', body: null },
    ])
  })

  test('--wait-timeout bounds polling without cancelling the server-side job', async () => {
    let now = 0
    let polls = 0
    const fetchImpl: FetchLike = async input => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/train/uploads/url')) {
        return Response.json({ filename: 'source.md', size: 12, uploadedAt: 1 }, { status: 201 })
      }
      if (url.pathname.endsWith('/train')) {
        return Response.json({ jobId: 'train_1' }, { status: 202 })
      }
      if (url.pathname.endsWith('/train/train_1')) {
        polls += 1
        return Response.json({ job: { jobId: 'train_1', state: 'running', phase: 'training' } })
      }
      throw new Error(`unexpected request: ${url}`)
    }
    const api = new ApiClient({
      baseUrl: 'https://api.test',
      apiKey: 'duet_sk_test',
      fetch: fetchImpl,
    })

    await expect(
      train(['demo', '--url', 'https://one.example', '--wait-timeout', '2'], {
        global: { json: false },
        api,
        io: sinks(),
        sleep: async ms => {
          now += ms
        },
        now: () => now,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({
      code: 'train_timeout',
      message: 'Timed out waiting for train job train_1; it continues server-side.',
    })
    expect(polls).toBe(2)
  })

  test('human output renders phase and explains that exit does not cancel the job', async () => {
    let polls = 0
    let stdout = ''
    const fetchImpl: FetchLike = async input => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/train/uploads/url')) {
        return Response.json({ filename: 'source.md', size: 12, uploadedAt: 1 }, { status: 201 })
      }
      if (url.pathname.endsWith('/train')) {
        return Response.json({ jobId: 'train_1' }, { status: 202 })
      }
      if (url.pathname.endsWith('/train/train_1')) {
        polls += 1
        return Response.json({
          job: {
            jobId: 'train_1',
            state: polls === 1 ? 'running' : 'done',
            phase: polls === 1 ? 'snapshotting' : 'done',
          },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }
    const api = new ApiClient({
      baseUrl: 'https://api.test',
      apiKey: 'duet_sk_test',
      fetch: fetchImpl,
    })

    await train(['demo', '--url', 'https://one.example'], {
      global: { json: false },
      api,
      io: {
        stdout: { write: chunk => ((stdout += String(chunk)), true) },
        stderr: { write: () => true },
      },
      sleep: async () => undefined,
      fetch: fetchImpl,
    })

    expect(stdout).toContain('The job continues server-side if this CLI exits.')
    expect(stdout).toContain('Train job train_1: snapshotting')
  })
})

function sinks() {
  return {
    stdout: { write: () => true },
    stderr: { write: () => true },
  }
}
