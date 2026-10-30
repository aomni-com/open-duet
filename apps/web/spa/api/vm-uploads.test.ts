import { expect, test } from 'bun:test'

import { DuetApiError } from './client'
import { SessionAttachmentUploads } from './session-attachment-uploads'
import { uploadErrorCode, VmUploadClient, VmUploadError } from './vm-uploads'

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

test('a drive-full refusal reads as one code whether the API or the VM answered it', () => {
  // The compose bar sends its bytes straight at the VM and fails with
  // `VmUploadError`; a drive action that goes through the API fails with
  // `DuetApiError`. A surface asking "was this the full-drive answer?" must not
  // have to know which of the two it was handed.
  expect(uploadErrorCode(new VmUploadError(507, 'storage_full'))).toBe('storage_full')
  expect(uploadErrorCode(new DuetApiError(507, 'storage_full'))).toBe('storage_full')
  expect(uploadErrorCode(new DOMException('Upload aborted', 'AbortError'))).toBeUndefined()
})

test('shares one pending grant request and caches the settled grant', async () => {
  let resolveMint!: (grant: {
    vmBaseUrl: string
    uploadPath: string
    uploadToken: string
    expiresAt: number
  }) => void
  let mintCalls = 0
  const mint = () => {
    mintCalls += 1
    return new Promise<{
      vmBaseUrl: string
      uploadPath: string
      uploadToken: string
      expiresAt: number
    }>(resolve => {
      resolveMint = resolve
    })
  }
  const client = new VmUploadClient({ now: () => 1_000 })

  const first = client.session(mint)
  const second = client.session(mint)
  expect(mintCalls).toBe(1)

  resolveMint({
    vmBaseUrl: 'https://vm.example/',
    uploadPath: '/v1/files/uploads',
    uploadToken: 'token',
    expiresAt: 61_001,
  })
  const grant = await first

  expect(await second).toBe(grant)
  expect(await client.session(mint)).toBe(grant)
  expect(mintCalls).toBe(1)
})

test('refreshes a grant once it reaches the thirty-second renewal window', async () => {
  let now = 1_000
  let mintCalls = 0
  const mint = async () => ({
    vmBaseUrl: 'https://vm.example/',
    uploadPath: '/v1/files/uploads',
    uploadToken: `token-${++mintCalls}`,
    expiresAt: now + 31_000,
  })
  const client = new VmUploadClient({ now: () => now })

  expect((await client.session(mint)).uploadToken).toBe('token-1')
  now += 999
  expect((await client.session(mint)).uploadToken).toBe('token-1')
  now += 2
  expect((await client.session(mint)).uploadToken).toBe('token-2')
  expect(mintCalls).toBe(2)
})

test('PUT reports progress and sends the grant headers with the raw file body', async () => {
  const xhr = new FakeXhr()
  const client = new VmUploadClient({ createXhr: () => xhr as unknown as XMLHttpRequest })
  const progress: number[] = []
  const file = new File(['abcd'], 'notes one.bin')
  const upload = client.put(
    {
      vmBaseUrl: 'https://vm.example',
      uploadPath: '/v1/files/agents/research/uploads',
      uploadToken: 'token',
      expiresAt: 60_000,
      requestHeaders: { 'x-duet-actor-context': 'web:user-one' },
    },
    file.name,
    file,
    value => progress.push(value),
  )

  xhr.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 4 } as ProgressEvent)
  xhr.onload?.()

  await expect(upload.done).resolves.toBeUndefined()
  expect(progress).toEqual([75])
  expect(xhr.method).toBe('PUT')
  expect(xhr.url).toBe('https://vm.example/v1/files/agents/research/uploads/notes%20one.bin')
  expect(xhr.headers.get('authorization')).toBe('Bearer token')
  expect(xhr.headers.get('x-duet-actor-context')).toBe('web:user-one')
  expect(xhr.body).toBe(file)
})

test('abort cancels the PUT and rejects it as an AbortError', async () => {
  const xhr = new FakeXhr()
  const client = new VmUploadClient({ createXhr: () => xhr as unknown as XMLHttpRequest })
  const upload = client.put(
    {
      vmBaseUrl: 'https://vm.example/',
      uploadPath: '/v1/files/uploads',
      uploadToken: 'token',
      expiresAt: 60_000,
    },
    'notes.bin',
    new File(['notes'], 'notes.bin'),
    () => {},
  )

  upload.abort()

  await expect(upload.done).rejects.toMatchObject({ name: 'AbortError' })
})

test('maps a drive reserve refusal to a typed storage-full upload error', async () => {
  const xhr = new FakeXhr()
  xhr.status = 507
  xhr.responseText = JSON.stringify({ error: 'storage_full' })
  const client = new VmUploadClient({ createXhr: () => xhr as unknown as XMLHttpRequest })
  const upload = client.put(
    {
      vmBaseUrl: 'https://vm.example/',
      uploadPath: '/v1/files/uploads',
      uploadToken: 'token',
      expiresAt: 60_000,
    },
    'large.bin',
    new File(['large'], 'large.bin'),
    () => {},
  )

  xhr.onload?.()

  await expect(upload.done).rejects.toMatchObject({
    name: 'VmUploadError',
    status: 507,
    code: 'storage_full',
  })
})

test('DELETE uses the same encoded upload URL and grant headers', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const receivers: unknown[] = []
  const client = new VmUploadClient({
    fetch: async function (input, init) {
      receivers.push(this)
      requests.push({ url: String(input), init })
      return new Response(null, { status: 204 })
    },
  })

  await client.delete(
    {
      vmBaseUrl: 'https://vm.example/',
      uploadPath: '/v1/files/uploads',
      uploadToken: 'token',
      expiresAt: 60_000,
      requestHeaders: { 'x-duet-actor-context': 'web:user-one' },
    },
    'notes one.bin',
  )

  expect(requests).toHaveLength(1)
  expect(receivers).toEqual([undefined])
  expect(requests[0]!.url).toBe('https://vm.example/v1/files/uploads/notes%20one.bin')
  expect(requests[0]!.init?.method).toBe('DELETE')
  expect(new Headers(requests[0]!.init?.headers).get('authorization')).toBe('Bearer token')
  expect(new Headers(requests[0]!.init?.headers).get('x-duet-actor-context')).toBe('web:user-one')
})

test("session attachments mint for a cwd's landing folder", async () => {
  const firstXhr = new FakeXhr()
  const secondXhr = new FakeXhr()
  const xhrs = [firstXhr, secondXhr]
  const mintInputs: Array<{ workspaceSlug: string; pathPrefix: string }> = []
  const uploader = new SessionAttachmentUploads({
    workspaceSlug: 'acme',
    api: {
      mintDriveUploadSession: async (workspaceSlug, pathPrefix) => {
        mintInputs.push({ workspaceSlug, pathPrefix })
        return {
          vmBaseUrl: 'https://vm.example/',
          uploadPath: '/v1/files/agents/research/uploads',
          uploadToken: 'token',
          expiresAt: Date.now() + 60_000,
          prefix: 'agents/research/uploads',
        }
      },
      statOptionalWorkspaceFile: async () => {
        throw new Error('not used')
      },
      operateOnWorkspaceFiles: async () => ({ ok: true, affectedEntries: 1 }),
    },
    uploads: new VmUploadClient({
      createXhr: () => xhrs.shift() as unknown as XMLHttpRequest,
    }),
  })
  const file = new File(['notes'], 'notes.bin')

  const first = uploader.put('agents/research', file.name, file, () => {})
  while (firstXhr.method === '') await Bun.sleep(0)
  firstXhr.onload?.()
  await first.done
  const second = uploader.put('agents/research', 'more.bin', file, () => {})
  while (secondXhr.method === '') await Bun.sleep(0)
  secondXhr.onload?.()

  await expect(second.done).resolves.toBeUndefined()
  // The cwd is translated to its landing folder here rather than server-side,
  // and one grant covers that folder however many files the draft carries.
  expect(mintInputs).toEqual([{ workspaceSlug: 'acme', pathPrefix: 'agents/research/uploads' }])
  expect(firstXhr.url).toBe('https://vm.example/v1/files/agents/research/uploads/notes.bin')
  expect(secondXhr.url).toBe('https://vm.example/v1/files/agents/research/uploads/more.bin')
  // Neither request asserts an identity. The grant carries the actor, stamped
  // by the API from the authenticated caller, so the browser cannot claim to be
  // someone else and cannot forget to say who it is.
  expect(firstXhr.headers.get('x-duet-actor-context')).toBeUndefined()
  expect(secondXhr.headers.get('x-duet-actor-context')).toBeUndefined()
})

test('session attachment directory creation and moves use the existing workspace files action shape', async () => {
  const operations: Array<{ workspaceSlug: string; operation: unknown }> = []
  const uploader = new SessionAttachmentUploads({
    workspaceSlug: 'acme',
    api: {
      mintDriveUploadSession: async () => {
        throw new Error('not used')
      },
      statOptionalWorkspaceFile: async () => {
        throw new Error('not used')
      },
      operateOnWorkspaceFiles: async (workspaceSlug, operation) => {
        operations.push({ workspaceSlug, operation })
        return { ok: true, affectedEntries: 1 }
      },
    },
  })

  await uploader.mkdir('agents/writer/uploads')
  await uploader.move('agents/research/uploads/notes.pdf', 'agents/writer/uploads/notes.pdf')

  expect(operations).toEqual([
    {
      workspaceSlug: 'acme',
      operation: {
        operation: 'mkdir',
        path: 'agents/writer/uploads',
        recursive: true,
      },
    },
    {
      workspaceSlug: 'acme',
      operation: {
        operation: 'move',
        source: 'agents/research/uploads/notes.pdf',
        destination: 'agents/writer/uploads/notes.pdf',
        overwrite: false,
      },
    },
  ])
})

test('session attachment removal mints for its cwd and deletes the landed file', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const uploader = new SessionAttachmentUploads({
    workspaceSlug: 'acme',
    api: {
      mintDriveUploadSession: async () => ({
        vmBaseUrl: 'https://vm.example/',
        uploadPath: '/v1/files/agents/research/uploads',
        uploadToken: 'token',
        expiresAt: Date.now() + 60_000,
        prefix: 'agents/research/uploads',
      }),
      statOptionalWorkspaceFile: async () => {
        throw new Error('not used')
      },
      operateOnWorkspaceFiles: async () => ({ ok: true, affectedEntries: 1 }),
    },
    uploads: new VmUploadClient({
      fetch: async (input, init) => {
        requests.push({ url: String(input), init })
        return new Response(null, { status: 204 })
      },
    }),
  })

  await uploader.delete('agents/research', 'notes one.bin')

  expect(requests).toHaveLength(1)
  expect(requests[0]!.url).toBe(
    'https://vm.example/v1/files/agents/research/uploads/notes%20one.bin',
  )
  expect(requests[0]!.init?.method).toBe('DELETE')
  // No actor from the browser: the grant carries one, stamped by the API from
  // the authenticated caller, so a direct request cannot claim an identity.
  expect(new Headers(requests[0]!.init?.headers).get('x-duet-actor-context')).toBeNull()
})

/* The name an upload is about to claim is usually free, so the probe declares
   the path optional: a missing file is a plain "not there", never a 404 the
   browser logs on every attachment. An API failure is still a failure. */
test('session attachment collision checks distinguish a missing file from API failures', async () => {
  let status = 200
  const paths: string[] = []
  const uploader = new SessionAttachmentUploads({
    workspaceSlug: 'acme',
    api: {
      mintDriveUploadSession: async () => {
        throw new Error('not used')
      },
      statOptionalWorkspaceFile: async (_workspaceSlug, path) => {
        paths.push(path)
        if (status === 204) return null
        if (status !== 200) throw new DuetApiError(status, 'request_failed')
        return {
          entry: {
            name: 'notes.pdf',
            path,
            type: 'file',
            size: 5,
            mtime: '2026-08-12T00:00:00.000Z',
          },
          etag: 'etag',
        }
      },
      operateOnWorkspaceFiles: async () => ({ ok: true }),
    },
  })

  expect(await uploader.exists('agents/research', 'notes.pdf')).toBe(true)
  status = 204
  expect(await uploader.exists('agents/research', 'missing.pdf')).toBe(false)
  status = 503
  await expect(uploader.exists(undefined, 'unavailable.pdf')).rejects.toMatchObject({ status: 503 })
  expect(paths).toEqual([
    'agents/research/uploads/notes.pdf',
    'agents/research/uploads/missing.pdf',
    'uploads/unavailable.pdf',
  ])
})
