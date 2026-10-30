import { createHash } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createMultipartUpload, uploadPart, completeMultipartUpload } from '@vercel/blob/client'

import { BackupUploadGrantSchema } from '@repo/contract'

import { abortableBackupOperation, backupOperationDeadline } from './operation'

export type BackupMultipartSdk = Pick<
  typeof import('@vercel/blob/client'),
  'createMultipartUpload' | 'uploadPart' | 'completeMultipartUpload'
>
export type BackupUploadGrant = ReturnType<typeof BackupUploadGrantSchema.parse>
export const BACKUP_BLOB_OPERATION_TIMEOUT_MS = 60_000
// 500 MiB parts cover Blob's 5 TB limit within 10,000 parts, even after the
// smaller initial parts. The provider edge rejects 512 MiB requests with 413.
// Two outstanding files bound scratch to 1,000 MiB independently of total size.
const PART_BYTES = 500 * 1024 * 1024
const ORDINARY_PART_BYTES = 64 * 1024 * 1024
const FIRST_PART_BYTES = 8 * 1024 * 1024

export async function uploadWorkspaceBackup(options: {
  body: ReadableStream<Uint8Array>
  pathname: string
  scratchDir: string
  signal: AbortSignal
  grant: () => Promise<BackupUploadGrant>
  sdk?: BackupMultipartSdk
  now?: () => number
  onRead?: (bytes: number) => void
  onProgress?: (bytes: number) => void
}): Promise<{ bytes: number; sha256: string }> {
  const sdk = options.sdk ?? { createMultipartUpload, uploadPart, completeMultipartUpload }
  const now = options.now ?? Date.now
  const controller = new AbortController()
  const signal = AbortSignal.any([options.signal, controller.signal])
  let grant: BackupUploadGrant | undefined
  let renewing: Promise<BackupUploadGrant> | undefined
  async function token() {
    if (grant && grant.expiresAt - now() > 2 * 60_000) return grant.token
    renewing ??= options
      .grant()
      .then(value => {
        const next = BackupUploadGrantSchema.parse(value)
        if (
          next.pathname !== options.pathname ||
          next.expiresAt - now() <= BACKUP_BLOB_OPERATION_TIMEOUT_MS
        )
          throw new Error('Invalid backup upload grant')
        grant = next
        return next
      })
      .finally(() => {
        renewing = undefined
      })
    return (await renewing).token
  }
  async function operation<T>(
    run: (options: {
      access: 'private'
      token: string
      contentType: string
      abortSignal: AbortSignal
    }) => Promise<T>,
  ) {
    const current = await abortableBackupOperation(token, signal)
    return backupOperationDeadline(
      abortSignal =>
        run({ access: 'private', token: current, contentType: 'application/zip', abortSignal }),
      signal,
      BACKUP_BLOB_OPERATION_TIMEOUT_MS,
    )
  }
  const scratch = await mkdtemp(join(options.scratchDir, 'duet-backup-parts-'))
  const reader = options.body.getReader()
  const pending: Promise<void>[] = []
  const parts: Awaited<ReturnType<BackupMultipartSdk['uploadPart']>>[] = []
  const hash = createHash('sha256')
  let bytes = 0,
    uploaded = 0
  let carry: Uint8Array | undefined,
    offset = 0,
    ended = false
  try {
    const multipart = await operation(config => sdk.createMultipartUpload(options.pathname, config))
    for (let partNumber = 1; !ended; partNumber++) {
      if (pending.length === 2) await pending.shift()
      signal.throwIfAborted()
      if (partNumber > 10_000) throw new Error('Blob multipart part limit exceeded')
      const path = join(scratch, String(partNumber))
      const file = await open(path, 'wx', 0o600)
      let size = 0
      try {
        const limit =
          partNumber === 1 ? FIRST_PART_BYTES : partNumber <= 512 ? ORDINARY_PART_BYTES : PART_BYTES
        while (size < limit) {
          if (!carry || offset === carry.length) {
            const next = await abortableBackupOperation(() => reader.read(), signal)
            if (next.done) {
              ended = true
              break
            }
            carry = next.value
            offset = 0
            if (carry.length === 0) continue
          }
          const count = Math.min(limit - size, carry.length - offset)
          const data = carry.subarray(offset, offset + count)
          let written = 0
          while (written < count) written += (await file.write(data.subarray(written))).bytesWritten
          hash.update(data)
          bytes += count
          size += count
          offset += count
          options.onRead?.(bytes)
        }
      } finally {
        await file.close()
      }
      if (size === 0) {
        await rm(path)
        break
      }
      const uploading = (async () => {
        let reported = 0
        const report = (loaded: number) => {
          const next = Math.max(reported, Math.min(size, loaded))
          if (next === reported) return
          uploaded += next - reported
          reported = next
          options.onProgress?.(uploaded)
        }
        try {
          const part = await operation(config =>
            sdk.uploadPart(options.pathname, Bun.file(path), {
              ...config,
              ...multipart,
              partNumber,
              // The SDK progress path chunks Bun.file bodies before undici
              // reads them; the direct Blob path buffers a whole large part.
              onUploadProgress: progress => report(progress.loaded),
            }),
          )
          parts.push(part)
          report(size)
        } finally {
          await rm(path, { force: true })
        }
      })()
      void uploading.catch(error => controller.abort(error))
      pending.push(uploading)
    }
    await Promise.all(pending)
    signal.throwIfAborted()
    if (bytes === 0) throw new Error('Empty backup archive')
    parts.sort((a, b) => a.partNumber - b.partNumber)
    await operation(config =>
      sdk.completeMultipartUpload(options.pathname, parts, { ...config, ...multipart }),
    )
    return { bytes, sha256: hash.digest('hex') }
  } catch (error) {
    controller.abort(error)
    throw error
  } finally {
    await reader.cancel().catch(() => {})
    await Promise.allSettled(pending)
    await rm(scratch, { recursive: true, force: true })
  }
}
