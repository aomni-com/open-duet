import { expect, test } from 'bun:test'

import { DRIVE_UPLOAD_MAX_BYTES, FILE_TOO_LARGE_ERROR } from '@repo/contract'

import { uploadErrorCode } from '../api/vm-uploads'
import { runDriveUpload, type DriveUploadProgress } from './drive-upload-run'
import type { Result } from './lib/types'

function pickedFile(name: string): File {
  const file = new File([], name)
  Object.defineProperty(file, 'arrayBuffer', {
    value: () => Promise.reject(new RangeError('Array buffer allocation failed')),
  })
  return file
}

/** A pick the Drive will not take — one byte past the published limit. */
function oversizeFile(name: string): File {
  const file = pickedFile(name)
  Object.defineProperty(file, 'size', { value: DRIVE_UPLOAD_MAX_BYTES + 1 })
  return file
}

function recordingProvider(
  outcome: (path: string) => Result = () => ({ success: true, data: undefined }),
) {
  const uploaded: Array<{ path: string; name: string }> = []
  return {
    uploaded,
    provider: {
      upload: async (
        path: string,
        file: File,
        options: { onProgress?(percent: number): void } = {},
      ) => {
        uploaded.push({ path, name: file.name })
        options.onProgress?.(50)
        options.onProgress?.(100)
        return outcome(path)
      },
    },
  }
}

test('passes each pick to the provider in folder order and relays progress', async () => {
  const { provider, uploaded } = recordingProvider()
  const seen: DriveUploadProgress[] = []

  const result = await runDriveUpload({
    files: [pickedFile('one.zip'), pickedFile('two.zip')],
    folderPath: '/reports/q3',
    provider,
    onProgress: state => seen.push(state),
  })

  expect(result).toEqual({ ok: true })
  expect(uploaded).toEqual([
    { path: '/reports/q3/one.zip', name: 'one.zip' },
    { path: '/reports/q3/two.zip', name: 'two.zip' },
  ])
  expect(seen).toEqual([
    { done: 0, total: 2, currentName: 'one.zip', percent: 0 },
    { done: 0, total: 2, currentName: 'one.zip', percent: 50 },
    { done: 0, total: 2, currentName: 'one.zip', percent: 100 },
    { done: 1, total: 2, currentName: 'two.zip', percent: 0 },
    { done: 1, total: 2, currentName: 'two.zip', percent: 50 },
    { done: 1, total: 2, currentName: 'two.zip', percent: 100 },
  ])
})

// A drop is one gesture. Uploading three files and stopping on the fourth
// means watching minutes of progress to learn something that was knowable at
// pick time — the exact wait this limit exists to prevent.
test('refuses the whole drop when one file is over the limit, before sending any', async () => {
  const { provider, uploaded } = recordingProvider()

  const result = await runDriveUpload({
    files: [pickedFile('small.zip'), oversizeFile('enormous.zip'), pickedFile('also-small.zip')],
    folderPath: '/reports',
    provider,
    onProgress: () => {},
  })

  expect(result).toMatchObject({
    ok: false,
    file: { name: 'enormous.zip' },
    error: { code: 'file_too_large' },
  })
  // The claim is zero bytes, and this array is what measures it.
  expect(uploaded).toEqual([])
})

// The refusal carries the same code the VM would have sent, so the surface
// maps one reason rather than telling client and server failures apart.
test('refuses with the code the server would have used', async () => {
  const { provider } = recordingProvider()

  const result = await runDriveUpload({
    files: [oversizeFile('enormous.zip')],
    folderPath: '/',
    provider,
    onProgress: () => {},
  })

  if (result.ok || 'cancelled' in result) throw new Error('expected a size refusal')
  expect(uploadErrorCode(result.error)).toBe(FILE_TOO_LARGE_ERROR)
})

// Stopping is not failing. A cancelled run must not reach the error notice or
// the storage-full notifier — the person already knows what happened.
test('stopping between files reports how many landed, not an error', async () => {
  const controller = new AbortController()
  const uploaded: string[] = []
  const provider = {
    upload: async (path: string) => {
      uploaded.push(path)
      controller.abort()
      return { success: true as const, data: undefined }
    },
  }

  const result = await runDriveUpload({
    files: [pickedFile('one.zip'), pickedFile('two.zip'), pickedFile('three.zip')],
    folderPath: '/',
    provider,
    onProgress: () => {},
    signal: controller.signal,
  })

  expect(result).toEqual({ ok: false, cancelled: true, done: 1 })
  expect(uploaded).toEqual(['/one.zip'])
})

test('stopping during a file reports cancelled rather than failed', async () => {
  const controller = new AbortController()
  const provider = {
    upload: async (_path: string, _file: File, options: { signal?: AbortSignal } = {}) => {
      controller.abort()
      options.signal?.throwIfAborted()
      return { success: true as const, data: undefined }
    },
  }

  const result = await runDriveUpload({
    files: [pickedFile('one.zip')],
    folderPath: '/',
    provider,
    onProgress: () => {},
    signal: controller.signal,
  })

  expect(result).toEqual({ ok: false, cancelled: true, done: 0 })
})

// The drive filling up is the common failure, and it is the whole point of
// stopping: every remaining file would fail the same way, and each one costs
// another full transfer to find that out.
test('stops at the first failure and says which file it was', async () => {
  const { provider, uploaded } = recordingProvider(path =>
    path.endsWith('two.zip')
      ? { success: false, error: new Error('storage_full') }
      : { success: true, data: undefined },
  )

  const result = await runDriveUpload({
    files: [pickedFile('one.zip'), pickedFile('two.zip'), pickedFile('three.zip')],
    folderPath: '/',
    provider,
    onProgress: () => {},
  })

  expect(result).toMatchObject({
    ok: false,
    file: { name: 'two.zip' },
    error: { message: 'storage_full' },
  })
  expect(uploaded.map(entry => entry.path)).toEqual(['/one.zip', '/two.zip'])
})
