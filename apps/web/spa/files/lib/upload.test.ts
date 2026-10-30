import { describe, expect, test } from 'bun:test'

import { VmUploadClient } from '../../api/vm-uploads'
import { RestFileSystemProvider } from './rest-provider'

/**
 * A file the browser cannot hold in memory.
 *
 * This is not a contrivance: `File.arrayBuffer()` on a seven-gigabyte pick
 * rejects, and reading one before sending it is the difference between an
 * upload that works and a tab that dies. Every test here uses a file that
 * refuses to be read, so buffering it is not a slow path — it is a failure.
 */
function unbufferableFile(name: string, size: number): File {
  const file = new File([], name, { type: 'application/zip' })
  Object.defineProperties(file, {
    size: { value: size },
    arrayBuffer: {
      value: () => Promise.reject(new RangeError('Array buffer allocation failed')),
    },
    slice: {
      value: () => {
        throw new RangeError('Array buffer allocation failed')
      },
    },
  })
  return file
}

function fakeXhr() {
  const sent: unknown[] = []
  const opened: Array<{ method: string; url: string }> = []
  const headers = new Headers()
  const xhr = {
    status: 200,
    responseText: '{"ok":true}',
    upload: {} as { onprogress?: (event: ProgressEvent) => void },
    onload: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
    onabort: undefined as (() => void) | undefined,
    open: (method: string, url: string) => opened.push({ method, url }),
    setRequestHeader: (name: string, value: string) => headers.set(name, value),
    send: (body: unknown) => {
      sent.push(body)
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 4 } as ProgressEvent)
      queueMicrotask(() => xhr.onload?.())
    },
    abort: () => xhr.onabort?.(),
  }
  return { xhr, sent, opened, headers }
}

const grant = {
  vmBaseUrl: 'https://duet-ws-abc.exe.xyz/',
  uploadPath: '/v1/files/reports',
  uploadToken: 'upload-token',
  expiresAt: 10 ** 13,
}

describe('uploading a file into the drive', () => {
  test('streams the file itself at the workspace VM, never through the API', async () => {
    const fake = fakeXhr()
    const minted: Array<{ workspaceSlug: string; pathPrefix: string }> = []
    const provider = new RestFileSystemProvider(
      'acme',
      {
        mintDriveUploadSession: async (workspaceSlug: string, pathPrefix: string) => {
          minted.push({ workspaceSlug, pathPrefix })
          return grant
        },
        writeWorkspaceFile: () => {
          throw new Error('the API must never carry the bytes of a picked file')
        },
      } as never,
      undefined,
      new VmUploadClient({ createXhr: () => fake.xhr as never }),
    )
    const percentages: number[] = []

    const file = unbufferableFile('sandbox-home-backup.zip', 7 * 1024 ** 3)
    const result = await provider.upload('/reports/sandbox-home-backup.zip', file, {
      onProgress: percent => percentages.push(percent),
    })

    expect(result.success).toBe(true)
    expect(minted).toEqual([{ workspaceSlug: 'acme', pathPrefix: 'reports' }])
    expect(fake.opened).toEqual([
      {
        method: 'PUT',
        url: 'https://duet-ws-abc.exe.xyz/v1/files/reports/sandbox-home-backup.zip',
      },
    ])
    // The `File` itself, so the browser streams from disk. A copy of its bytes
    // would have had to exist first, and this file cannot produce one.
    expect(fake.sent).toEqual([file])
    expect(percentages).toEqual([75])
  })

  // The browser deliberately asserts no identity of its own. The grant carries
  // the actor, stamped by the API from the authenticated caller, so a direct
  // upload cannot claim to be someone else — and cannot forget to say, which is
  // what once made these writes land as `system`.
  test('sends no actor of its own, because the grant already carries one', async () => {
    const fake = fakeXhr()
    const provider = new RestFileSystemProvider(
      'acme',
      { mintDriveUploadSession: async () => grant } as never,
      undefined,
      new VmUploadClient({ createXhr: () => fake.xhr as never }),
    )

    await provider.upload('/reports/notes.zip', unbufferableFile('notes.zip', 1), {})

    expect(fake.headers.get('x-duet-actor-context')).toBeNull()
  })

  test('a folder is minted for once however many files land in it, and once per folder', async () => {
    const fake = fakeXhr()
    const minted: string[] = []
    const provider = new RestFileSystemProvider(
      'acme',
      {
        mintDriveUploadSession: async (_slug: string, pathPrefix: string) => {
          minted.push(pathPrefix)
          return grant
        },
      } as never,
      undefined,
      new VmUploadClient({ createXhr: () => fake.xhr as never }),
    )

    await provider.upload('/reports/one.zip', unbufferableFile('one.zip', 1), {})
    await provider.upload('/reports/two.zip', unbufferableFile('two.zip', 1), {})
    await provider.upload('/notes/three.zip', unbufferableFile('three.zip', 1), {})

    // A grant covers a folder, and the cache that reuses it is keyed on the
    // identity of the closure that mints it — so a per-call closure would round
    // trip for every file with every other assertion here still passing.
    expect(minted).toEqual(['reports', 'notes'])
  })

  test('uploads to the drive root', async () => {
    const fake = fakeXhr()
    const minted: string[] = []
    const provider = new RestFileSystemProvider(
      'acme',
      {
        mintDriveUploadSession: async (_slug: string, pathPrefix: string) => {
          minted.push(pathPrefix)
          return { ...grant, uploadPath: '/v1/files' }
        },
      } as never,
      undefined,
      new VmUploadClient({ createXhr: () => fake.xhr as never }),
    )

    const result = await provider.upload('/backup.zip', unbufferableFile('backup.zip', 1), {})

    expect(result.success).toBe(true)
    expect(minted).toEqual([''])
    expect(fake.opened[0]?.url).toBe('https://duet-ws-abc.exe.xyz/v1/files/backup.zip')
  })

  test('surfaces a full drive as the typed error the drive already speaks', async () => {
    const fake = fakeXhr()
    fake.xhr.status = 507
    fake.xhr.responseText = JSON.stringify({ error: 'storage_full' })
    const reported: Error[] = []
    const provider = new RestFileSystemProvider(
      'acme',
      { mintDriveUploadSession: async () => grant } as never,
      error => reported.push(error),
      new VmUploadClient({ createXhr: () => fake.xhr as never }),
    )

    const result = await provider.upload('/reports/big.zip', unbufferableFile('big.zip', 1), {})

    expect(result).toMatchObject({
      success: false,
      error: { code: 'storage_full', status: 507 },
    })
    expect(reported.map(error => (error as { code?: string }).code)).toEqual(['storage_full'])
  })
})
