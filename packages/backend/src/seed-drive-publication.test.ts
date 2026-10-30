import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  type ConvexDevFixture,
} from '@repo/test-harness'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-api-internal-key'

let convex: ConvexDevFixture

describe('seed drive publication', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('recording the same hash twice keeps one canonical bundle row', async () => {
    const firstStorageId = await uploadTar('first')
    const secondStorageId = await uploadTar('duplicate')

    const first = await recordBundle('a'.repeat(64), firstStorageId)
    const created = (await seedBundleRows())[0]!
    const duplicate = await recordBundle('a'.repeat(64), secondStorageId)
    const rows = await seedBundleRows()

    expect(first).toEqual({
      sha256: 'a'.repeat(64),
      storageId: firstStorageId,
      created: true,
      activated: true,
    })
    expect(duplicate).toEqual({
      sha256: 'a'.repeat(64),
      storageId: firstStorageId,
      created: false,
      activated: false,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sha256: 'a'.repeat(64),
      storageId: firstStorageId,
      createdAt: created.createdAt,
      current: true,
    })
  })

  test('recording a new hash atomically makes only the new bundle current', async () => {
    const oldStorageId = await uploadTar('old')
    const newStorageId = await uploadTar('new')
    await recordBundle('b'.repeat(64), oldStorageId)

    const activated = await recordBundle('c'.repeat(64), newStorageId)
    const rows = await seedBundleRows()

    expect(activated).toEqual({
      sha256: 'c'.repeat(64),
      storageId: newStorageId,
      created: true,
      activated: true,
    })
    expect(
      rows
        .filter(row => row.sha256 === 'b'.repeat(64) || row.sha256 === 'c'.repeat(64))
        .map(row => ({ sha256: row.sha256, current: row.current }))
        .sort((left, right) => left.sha256.localeCompare(right.sha256)),
    ).toEqual([
      { sha256: 'b'.repeat(64), current: false },
      { sha256: 'c'.repeat(64), current: true },
    ])
  })

  test('current lookup returns the active storage id and hash', async () => {
    const storageId = await uploadTar('current lookup')
    await recordBundle('d'.repeat(64), storageId)

    expect(
      await query(convex, 'testing/seedDrive:currentSeedBundle', {
        internalKey: INTERNAL_KEY,
      }),
    ).toEqual({ storageId, sha256: 'd'.repeat(64) })
  })
})

async function uploadTar(contents: string): Promise<string> {
  const uploadUrl = (await mutate(convex, 'testing/seedDrive:generateSeedBundleUploadUrl', {
    internalKey: INTERNAL_KEY,
  })) as string
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-tar' },
    body: contents,
  })
  expect(response.ok).toBe(true)
  return ((await response.json()) as { storageId: string }).storageId
}

async function recordBundle(sha256: string, storageId: string): Promise<RecordBundleResult> {
  return (await mutate(convex, 'testing/seedDrive:recordSeedBundle', {
    internalKey: INTERNAL_KEY,
    sha256,
    storageId,
  })) as RecordBundleResult
}

async function seedBundleRows(): Promise<SeedBundleRow[]> {
  return (await query(convex, 'testing/seedDrive:rawSeedDriveBundles', {
    internalKey: INTERNAL_KEY,
  })) as SeedBundleRow[]
}

interface RecordBundleResult {
  sha256: string
  storageId: string
  created: boolean
  activated: boolean
}

interface SeedBundleRow {
  sha256: string
  storageId: string
  createdAt: number
  current: boolean
}
