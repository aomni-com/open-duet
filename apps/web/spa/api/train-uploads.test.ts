import { expect, test } from 'bun:test'

import { ROOT_TRAIN_SCOPE } from './train-scope'
import { TrainUploadsClient } from './train-uploads'
import type { UploadRequest } from './vm-uploads'

class FakeXhr {
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  readonly headers = new Map<string, string>()
  status = 200
  responseText = '{}'
  method = ''
  url = ''
  body?: XMLHttpRequestBodyInit | null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  open(method: string, url: string) {
    this.method = method
    this.url = url
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value)
  }

  send(body?: XMLHttpRequestBodyInit | null) {
    this.body = body
  }

  abort() {
    this.onabort?.()
  }
}

test('direct upload reports XHR progress and uses the upload grant bearer token', async () => {
  const xhr = new FakeXhr()
  const client = new TrainUploadsClient({
    fetch: async () =>
      Response.json({
        vmBaseUrl: 'https://vm.example/',
        uploadPath: '/v1/train/uploads',
        uploadToken: 'upload-token',
        expiresAt: Date.now() + 60_000,
      }),
    createXhr: () => xhr as unknown as XMLHttpRequest,
  })
  const progress: number[] = []
  const request: UploadRequest = client.upload(
    'acme',
    ROOT_TRAIN_SCOPE,
    new File(['abcd'], 'notes.bin'),
    value => progress.push(value),
  )

  while (xhr.method === '') await Bun.sleep(0)
  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 } as ProgressEvent)
  xhr.onload?.()

  await expect(request.done).resolves.toBeUndefined()
  expect(progress).toEqual([50])
  expect(xhr.method).toBe('PUT')
  expect(xhr.url).toBe('https://vm.example/v1/train/uploads/notes.bin')
  expect(xhr.headers.get('authorization')).toBe('Bearer upload-token')
  expect(xhr.body).toBeInstanceOf(File)
})

test('renews a near-expiry upload grant before the next PUT', async () => {
  let now = 1_000
  let grants = 0
  const created: FakeXhr[] = []
  const client = new TrainUploadsClient({
    now: () => now,
    fetch: async () => {
      grants += 1
      return Response.json({
        vmBaseUrl: 'https://vm.example/',
        uploadPath: '/v1/train/uploads',
        uploadToken: `token-${grants}`,
        expiresAt: now + 31_000,
      })
    },
    createXhr: () => {
      const xhr = new FakeXhr()
      created.push(xhr)
      return xhr as unknown as XMLHttpRequest
    },
  })

  const first = client.upload('acme', ROOT_TRAIN_SCOPE, new File(['a'], 'a.bin'), () => {})
  while (created.length < 1) await Bun.sleep(0)
  created[0]!.onload?.()
  await first.done

  now += 2_000
  const second = client.upload('acme', ROOT_TRAIN_SCOPE, new File(['b'], 'b.bin'), () => {})
  while (created.length < 2) await Bun.sleep(0)
  created[1]!.onload?.()
  await second.done

  expect(grants).toBe(2)
  expect(created[1]!.headers.get('authorization')).toBe('Bearer token-2')
})

test('abort cancels only its XHR and rejects with AbortError', async () => {
  const first = new FakeXhr()
  const second = new FakeXhr()
  const created = [first, second]
  const client = new TrainUploadsClient({
    fetch: async () =>
      Response.json({
        vmBaseUrl: 'https://vm.example/',
        uploadPath: '/v1/train/uploads',
        uploadToken: 'token',
        expiresAt: Date.now() + 60_000,
      }),
    createXhr: () => created.shift() as unknown as XMLHttpRequest,
  })
  const a = client.upload('acme', ROOT_TRAIN_SCOPE, new File(['a'], 'a.bin'), () => {})
  const b = client.upload('acme', ROOT_TRAIN_SCOPE, new File(['b'], 'b.bin'), () => {})
  while (first.method === '' || second.method === '') await Bun.sleep(0)

  a.abort()
  second.onload?.()

  await expect(a.done).rejects.toMatchObject({ name: 'AbortError' })
  await expect(b.done).resolves.toBeUndefined()
})

test('surfaces a gateway 413 as a typed quota response', async () => {
  const xhr = new FakeXhr()
  xhr.status = 413
  xhr.responseText = JSON.stringify({ error: 'uploads_quota_exceeded', message: 'quota exceeded' })
  const client = new TrainUploadsClient({
    fetch: async () =>
      Response.json({
        vmBaseUrl: 'https://vm.example/',
        uploadPath: '/v1/train/uploads',
        uploadToken: 'token',
        expiresAt: Date.now() + 60_000,
      }),
    createXhr: () => xhr as unknown as XMLHttpRequest,
  })
  const upload = client.upload('acme', ROOT_TRAIN_SCOPE, new File(['large'], 'large.bin'), () => {})
  while (xhr.method === '') await Bun.sleep(0)
  xhr.onload?.()

  await expect(upload.done).rejects.toMatchObject({ status: 413, code: 'uploads_quota_exceeded' })
})

test('routes staged upload operations through the selected Train scope', async () => {
  const requests: Array<{ path: string; method: string }> = []
  const client = new TrainUploadsClient({
    fetch: async (input, init) => {
      const path = String(input)
      requests.push({ path, method: init?.method ?? 'GET' })
      if (init?.method === 'DELETE') return Response.json({ ok: true })
      if (path.endsWith('/url')) {
        return Response.json({
          filename: 'source.md',
          size: 1,
          uploadedAt: 1,
          url: 'https://example.com/',
        })
      }
      return Response.json({
        items: [],
        nextCursor: null,
        meta: { totalBytes: 0, fileCount: 0, capBytes: 1, running: false },
      })
    },
  })
  const agentScope = { kind: 'agent' as const, agentSlug: 'research' }

  await client.list('acme', ROOT_TRAIN_SCOPE)
  await client.list('acme', agentScope, { cursor: 'next', limit: 25 })
  await client.addUrl('acme', agentScope, 'https://example.com/')
  await client.remove('acme', agentScope, 'source.md')

  expect(requests).toEqual([
    { method: 'GET', path: '/api/duet/ws/acme/train/uploads' },
    {
      method: 'GET',
      path: '/api/duet/ws/acme/agents/research/train/uploads?cursor=next&limit=25',
    },
    { method: 'POST', path: '/api/duet/ws/acme/agents/research/train/uploads/url' },
    { method: 'DELETE', path: '/api/duet/ws/acme/agents/research/train/uploads/source.md' },
  ])
})

test('isolates upload grants by Train scope and uses each server-provided upload path', async () => {
  const sessionPaths: string[] = []
  const created: FakeXhr[] = []
  const client = new TrainUploadsClient({
    fetch: async input => {
      const path = String(input)
      sessionPaths.push(path)
      const agentSlug = path.match(/\/agents\/([^/]+)\/train/)?.[1]
      return Response.json({
        vmBaseUrl: 'https://vm.example/',
        uploadPath:
          agentSlug === undefined ? '/v1/train/uploads' : `/v1/agents/${agentSlug}/train/uploads`,
        uploadToken: agentSlug ?? 'root',
        expiresAt: Date.now() + 60_000,
      })
    },
    createXhr: () => {
      const xhr = new FakeXhr()
      created.push(xhr)
      return xhr as unknown as XMLHttpRequest
    },
  })
  const agentA = { kind: 'agent' as const, agentSlug: 'research' }
  const agentB = { kind: 'agent' as const, agentSlug: 'writer' }

  const uploads = [
    client.upload('acme', ROOT_TRAIN_SCOPE, new File(['root'], 'same.bin'), () => {}),
    client.upload('acme', agentA, new File(['a'], 'same.bin'), () => {}),
    client.upload('acme', agentB, new File(['b'], 'same.bin'), () => {}),
  ]
  while (created.length < 3 || created.some(xhr => xhr.method === '')) await Bun.sleep(0)
  for (const xhr of created) xhr.onload?.()
  await Promise.all(uploads.map(upload => upload.done))

  expect(sessionPaths).toEqual([
    '/api/duet/ws/acme/train/uploads/session',
    '/api/duet/ws/acme/agents/research/train/uploads/session',
    '/api/duet/ws/acme/agents/writer/train/uploads/session',
  ])
  expect(created.map(xhr => xhr.url)).toEqual([
    'https://vm.example/v1/train/uploads/same.bin',
    'https://vm.example/v1/agents/research/train/uploads/same.bin',
    'https://vm.example/v1/agents/writer/train/uploads/same.bin',
  ])
})
