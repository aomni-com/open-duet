#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSeedArchive, type SeedArchive } from '../src'

interface SeedBundle {
  storageId: string
  sha256: string
}

interface RecordSeedBundleResult extends SeedBundle {
  created: boolean
  activated: boolean
}

export interface SeedPublicationBackend {
  current(): Promise<SeedBundle | null>
  generateUploadUrl(): Promise<string>
  record(args: SeedBundle): Promise<RecordSeedBundleResult>
  downloadUrl(): Promise<string | null>
}

interface PublishSeedDriveOptions {
  buildArchive: () => Promise<SeedArchive>
  backend: SeedPublicationBackend
  fetch: typeof globalThis.fetch
}

export async function publishSeedDrive(
  options: PublishSeedDriveOptions,
): Promise<SeedBundle & { status: 'published' | 'unchanged' }> {
  const archive = await options.buildArchive()
  const before = await options.backend.current()
  if (before?.sha256 === archive.sha256) {
    await verifyCurrentArchive(options, archive, before)
    return { status: 'unchanged', ...before }
  }

  const uploadUrl = await options.backend.generateUploadUrl()
  const upload = await options.fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-tar' },
    body: archive.bytes,
  })
  if (!upload.ok) {
    throw new Error(`Seed drive upload failed (${upload.status}): ${await upload.text()}`)
  }
  const { storageId } = (await upload.json()) as { storageId?: unknown }
  if (typeof storageId !== 'string' || storageId.length === 0) {
    throw new Error('Seed drive upload did not return a storage id')
  }

  const recorded = await options.backend.record({ storageId, sha256: archive.sha256 })
  if (recorded.sha256 !== archive.sha256) {
    throw new Error(`Seed drive activation selected unexpected hash ${recorded.sha256}`)
  }
  await verifyCurrentArchive(options, archive, recorded)
  return { status: 'published', storageId: recorded.storageId, sha256: recorded.sha256 }
}

async function verifyCurrentArchive(
  options: PublishSeedDriveOptions,
  archive: SeedArchive,
  expected: SeedBundle,
): Promise<void> {
  const current = await options.backend.current()
  if (current?.storageId !== expected.storageId || current.sha256 !== archive.sha256) {
    throw new Error('Seed drive activation did not persist the expected current bundle')
  }
  const downloadUrl = await options.backend.downloadUrl()
  if (downloadUrl === null) throw new Error('Current seed drive bundle has no readable URL')
  const response = await options.fetch(downloadUrl)
  if (!response.ok) {
    throw new Error(`Current seed drive bundle is unreadable (${response.status})`)
  }
  const downloaded = new Uint8Array(await response.arrayBuffer())
  const downloadedHash = createHash('sha256').update(downloaded).digest('hex')
  if (downloadedHash !== archive.sha256) {
    throw new Error(
      `Current seed drive bundle hash mismatch: expected ${archive.sha256}, got ${downloadedHash}`,
    )
  }
}

class ConvexCliSeedPublicationBackend implements SeedPublicationBackend {
  current(): Promise<SeedBundle | null> {
    return runConvexJson<SeedBundle | null>('run', [
      'domains/workspaces/seed:currentSeedBundle',
      '{}',
    ])
  }

  generateUploadUrl(): Promise<string> {
    return runConvexJson<string>('run', [
      'domains/workspaces/seed:generateSeedBundleUploadUrl',
      '{}',
    ])
  }

  record(args: SeedBundle): Promise<RecordSeedBundleResult> {
    return runConvexJson<RecordSeedBundleResult>('run', [
      'domains/workspaces/seed:recordSeedBundle',
      JSON.stringify(args),
    ])
  }

  downloadUrl(): Promise<string | null> {
    return runConvexJson<string | null>('run', [
      'domains/workspaces/seed:currentSeedBundleDownloadUrl',
      '{}',
    ])
  }
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const backendDir = join(packageDir, '..', 'backend')

async function runConvexJson<T>(command: string, args: string[]): Promise<T> {
  const output = await runConvex(command, args)
  // The Convex CLI renders a null function result as empty stdout.
  return JSON.parse(output === '' ? 'null' : output) as T
}

async function runConvex(command: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['bunx', 'convex', command, ...args], {
    cwd: backendDir,
    env: process.env,
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const output = await new Response(child.stdout).text()
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`convex ${command} failed with exit code ${exitCode}`)
  return output.trim()
}

async function main(): Promise<void> {
  const result = await publishSeedDrive({
    buildArchive: buildSeedArchive,
    backend: new ConvexCliSeedPublicationBackend(),
    fetch,
  })
  console.log(
    result.status === 'unchanged'
      ? `seed drive: unchanged ${result.sha256} (${result.storageId})`
      : `seed drive: published ${result.sha256} (${result.storageId})`,
  )
}

if (import.meta.main) await main()
