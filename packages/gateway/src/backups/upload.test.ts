import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { uploadWorkspaceBackup, type BackupMultipartSdk } from './upload'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
test('manual multipart preserves streaming bytes, renews grants per operation and removes part scratch', async () => {
  const scratchDir = await mkdtemp(join(tmpdir(), 'backup-upload-'))
  roots.push(scratchDir)
  const chunk = crypto.getRandomValues(new Uint8Array(64 * 1024))
  const expected = createHash('sha256')
  for (let i = 0; i < 256; i++) expected.update(chunk)
  let time = 1000,
    grants = 0,
    uploaded = 0
  const parts = new Map<number, Uint8Array>()
  const tokens: string[] = []
  const progress: number[] = []
  let previousPartBytes = 0
  const sdk: BackupMultipartSdk = {
    async createMultipartUpload(_path, options) {
      tokens.push(options.token)
      time += 20 * 60 * 1000
      return { key: 'key', uploadId: 'upload' }
    },
    async uploadPart(_path, body, options) {
      tokens.push(options.token)
      parts.set(options.partNumber, new Uint8Array(await new Response(body as Blob).arrayBuffer()))
      const partBytes = parts.get(options.partNumber)!.length
      const before = uploaded
      options.onUploadProgress?.({ loaded: partBytes / 2, total: partBytes, percentage: 50 })
      expect(uploaded).toBeGreaterThan(before)
      // A provider retry can restart its local byte counter. Public progress
      // still counts unique part bytes and must never move backwards.
      options.onUploadProgress?.({ loaded: 1, total: partBytes, percentage: 0 })
      options.onUploadProgress?.({ loaded: partBytes, total: partBytes, percentage: 100 })
      expect(uploaded).toBe(previousPartBytes + partBytes)
      previousPartBytes += partBytes
      time += 20 * 60 * 1000
      return { etag: `etag-${options.partNumber}`, partNumber: options.partNumber }
    },
    async completeMultipartUpload(path, completed, options) {
      tokens.push(options.token)
      expect(completed.map(part => part.partNumber)).toEqual(
        [...parts.keys()].sort((a, b) => a - b),
      )
      return {
        pathname: path,
        url: 'https://fixture.private.blob.vercel-storage.com/backup.zip',
        downloadUrl: 'https://fixture.private.blob.vercel-storage.com/backup.zip',
        contentType: 'application/zip',
        contentDisposition: 'attachment',
        etag: 'fixture-etag',
      }
    },
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 256; i++) controller.enqueue(chunk)
      controller.close()
    },
  })
  const result = await uploadWorkspaceBackup({
    body: stream,
    pathname: 'backup.zip',
    scratchDir,
    sdk,
    now: () => time,
    signal: new AbortController().signal,
    grant: async () => ({
      pathname: 'backup.zip',
      token: `token-${++grants}`,
      expiresAt: time + 15 * 60 * 1000,
    }),
    onProgress: bytes => {
      uploaded = bytes
      progress.push(bytes)
    },
  })
  const actual = createHash('sha256')
  for (const [, bytes] of [...parts].sort(([a], [b]) => a - b)) actual.update(bytes)
  expect(actual.digest('hex')).toBe(expected.digest('hex'))
  expect(result.bytes).toBe(chunk.length * 256)
  expect(result.sha256).toBe(
    createHash('sha256')
      .update(Buffer.concat([...parts.values()]))
      .digest('hex'),
  )
  expect(uploaded).toBe(result.bytes)
  expect(progress).toEqual([...progress].sort((a, b) => a - b))
  expect(Math.max(...progress)).toBe(result.bytes)
  expect(new Set(tokens).size).toBeGreaterThan(1)
  expect(await readdir(scratchDir)).toEqual([])
})

test('cancellation interrupts a stalled grant and removes scratch', async () => {
  const scratchDir = await mkdtemp(join(tmpdir(), 'backup-upload-'))
  roots.push(scratchDir)
  let begin!: () => void
  const began = new Promise<void>(resolve => {
    begin = resolve
  })
  const controller = new AbortController()
  const uploading = uploadWorkspaceBackup({
    body: new ReadableStream(),
    pathname: 'backup.zip',
    scratchDir,
    signal: controller.signal,
    grant: () => {
      begin()
      return new Promise(() => {})
    },
  })
  await began
  controller.abort(new Error('cancelled'))
  await expect(uploading).rejects.toThrow('cancelled')
  expect(await readdir(scratchDir)).toEqual([])
}, 1000)
