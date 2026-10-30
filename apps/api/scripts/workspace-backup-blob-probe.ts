import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as sdk from '@vercel/blob/client'

import { BACKUP_UPLOAD_GRANT_MS } from '@repo/contract'

import { uploadWorkspaceBackup } from '../../../packages/gateway/src/backups/upload'
import { createBackupBlobStore } from '../src/backups/blob'

// Disposable generated data only. The dedicated command is never part of tests.
const token = process.env.BLOB_READ_WRITE_TOKEN
if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required for the live backup probe')
const bytes = Number(process.argv[2] ?? 1024 ** 3 + 1024 ** 2)
if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Expected a positive byte count')
const pathname = `backup-probes/${crypto.randomUUID()}.zip`
const store = createBackupBlobStore({ token })
const scratchDir = await mkdtemp(join(tmpdir(), 'duet-backup-probe-'))
const startedAt = Date.now()
let transferClock = startedAt
let grants = 0
const sourceHash = createHash('sha256')
const chunk = randomBytes(256 * 1024)
let remaining = bytes
let uploadedBytes = 0
let peakRss = process.memoryUsage().rss
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 250)

try {
  const upload = await uploadWorkspaceBackup({
    pathname,
    scratchDir,
    signal: AbortSignal.timeout(15 * 60_000),
    // Advance only the client's renewal clock after each accepted part. The
    // provider receives real short-lived grants; renewal is exercised without
    // making an opt-in probe idle for the token's entire lifetime.
    now: () => transferClock,
    sdk: {
      ...sdk,
      uploadPart: async (...args) => {
        const part = await sdk.uploadPart(...args)
        transferClock += BACKUP_UPLOAD_GRANT_MS - 60_000
        return part
      },
    },
    grant: async () => {
      const grant = await store.uploadGrant(pathname)
      grants++
      return { ...grant, pathname, expiresAt: transferClock + BACKUP_UPLOAD_GRANT_MS }
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) {
          controller.close()
          return
        }
        const next = chunk.subarray(0, Math.min(remaining, chunk.byteLength))
        sourceHash.update(next)
        remaining -= next.byteLength
        controller.enqueue(next)
      },
    }),
    onProgress: bytes => {
      uploadedBytes = bytes
    },
  })
  const uploadMs = Date.now() - startedAt
  if (uploadedBytes !== bytes || grants < 2) {
    throw new Error('Upload progress or grant renewal was not observed')
  }
  const artifact = await store.verify(pathname, bytes)
  const unsigned = await fetch(artifact.url)
  await unsigned.body?.cancel()
  if (unsigned.ok) throw new Error('Private object was readable without a grant')
  const download = await store.download(pathname)
  const response = await fetch(download.url)
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`)
  const downloadedHash = createHash('sha256')
  let downloadedBytes = 0
  for await (const part of response.body) {
    downloadedBytes += part.byteLength
    downloadedHash.update(part)
  }
  const sha256 = sourceHash.digest('hex')
  if (
    downloadedBytes !== bytes ||
    downloadedHash.digest('hex') !== sha256 ||
    upload.sha256 !== sha256 ||
    upload.bytes !== bytes
  ) {
    throw new Error('Downloaded bytes did not match the source')
  }
  const range = await fetch(download.url, { headers: { range: 'bytes=0-31' } })
  if (
    range.status !== 206 ||
    !Buffer.from(await range.arrayBuffer()).equals(chunk.subarray(0, Math.min(bytes, 32)))
  ) {
    throw new Error('Signed range read did not match the source')
  }
  await store.delete(pathname)
  const deleted = await fetch(download.url)
  await deleted.body?.cancel()
  if (deleted.status !== 404)
    throw new Error(`Deleted object read returned ${deleted.status}, expected 404`)
  console.log(
    JSON.stringify(
      {
        outcome: 'passed',
        runtime: `bun ${Bun.version}`,
        sdk: '@vercel/blob@2.8.0',
        bytes,
        uploadedBytes,
        grants,
        downloadedBytes,
        sha256,
        uploadMs,
        elapsedMs: Date.now() - startedAt,
        peakRss,
        privateDeniedStatus: unsigned.status,
        signedRangeStatus: range.status,
        deletedStatus: deleted.status,
      },
      null,
      2,
    ),
  )
} finally {
  clearInterval(sampler)
  try {
    await store.delete(pathname)
  } finally {
    await rm(scratchDir, { recursive: true, force: true })
  }
}
