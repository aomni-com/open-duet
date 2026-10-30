import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseMemoryFile, serializeMemoryFile } from '@repo/agent/memory-store'

import { serializeScrapedUrlFrontmatter, type DriveFileEvent } from '@repo/contract'

import { createTrainRoutes } from '../train-runner'
import { resolveTrainScope } from './agent-scope'
import { createTrainJobLedger } from './job-ledger'
import { MemoryStoreError, readMemoryRecord, updateMemoryRecord } from './memory-store'
import { rebuildTrainRecordIndex } from './record-index'
import { createUploadsStore } from './uploads-store'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'duet-train-memory-store-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('file-backed train records', () => {
  test('pages the durable index instead of returning the pre-cutover records envelope', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const storeDir = join(driveDir, '.agents', 'memories')
    await mkdir(storeDir, { recursive: true })
    await writeFile(
      join(storeDir, 'handbook.md'),
      serializeMemoryFile({
        version: 1,
        id: 'mem_1',
        kind: 'train',
        createdAt: Date.parse('2026-07-11T00:00:00.000Z'),
        content: 'original',
      }),
    )
    const scope = resolveTrainScope({ anchors: [], driveDir, stateDir })
    await rebuildTrainRecordIndex(scope, stateDir)
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      uploadsStores: uploadsStore(stateDir),
      resolveScope: () => scope,
      jobLedger: createTrainJobLedger({ stateDir, now: () => Date.now() }),
    })

    const list = await routes.request('/records?limit=1')
    const detail = await routes.request('/records/handbook')
    const listJson = await list.json()
    const detailJson = await detail.json()

    expect(list.status).toBe(200)
    expect(detail.status).toBe(200)
    expect(jsonShape(listJson)).toEqual({
      items: [
        {
          createdAt: 'string',
          hasArchive: 'boolean',
          memoryId: 'string',
          observedDate: 'string',
          slug: 'string',
        },
      ],
      nextCursor: 'object',
    })
    expect(jsonShape(detailJson)).toEqual({
      record: {
        content: 'string',
        createdAt: 'string',
        hasArchive: 'boolean',
        memoryId: 'string',
        observedDate: 'string',
        slug: 'string',
      },
    })
    expect(detailJson).toEqual({
      record: {
        slug: 'handbook',
        memoryId: 'mem_1',
        createdAt: '2026-07-11T00:00:00.000Z',
        observedDate: '2026-07-11',
        hasArchive: false,
        content: 'original',
      },
    })
  })

  test('updates and deletes a canonical file while preserving its metadata', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const storeDir = join(driveDir, '.agents', 'memories')
    const archiveDir = join(stateDir, 'train', 'archive_1')
    await Promise.all([
      mkdir(storeDir, { recursive: true }),
      mkdir(archiveDir, { recursive: true }),
    ])
    await writeFile(join(archiveDir, 'manifest.json'), JSON.stringify({ memoryId: 'mem_1' }))
    await writeFile(
      join(storeDir, 'handbook.md'),
      serializeMemoryFile({
        version: 1,
        id: 'mem_1',
        kind: 'train',
        createdAt: Date.parse('2026-07-11T00:00:00.000Z'),
        headline: 'Handbook',
        archiveId: 'archive_1',
        content: 'original',
      }),
    )
    const fileEvents: DriveFileEvent[] = []
    const scope = resolveTrainScope({ anchors: [], driveDir, stateDir })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      uploadsStores: uploadsStore(stateDir),
      resolveScope: () => scope,
      recordIndexesReady: rebuildTrainRecordIndex(scope, stateDir),
      emitFileEvent: event => fileEvents.push(event),
      jobLedger: createTrainJobLedger({ stateDir, now: () => Date.now() }),
    })

    const update = await routes.request('/records/handbook', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'updated body\n' }),
    })

    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({
      record: {
        slug: 'handbook',
        memoryId: 'mem_1',
        archiveId: 'archive_1',
        headline: 'Handbook',
        hasArchive: true,
        content: 'updated body\n',
      },
    })
    expect(parseMemoryFile(await Bun.file(join(storeDir, 'handbook.md')).text())).toMatchObject({
      id: 'mem_1',
      archiveId: 'archive_1',
      headline: 'Handbook',
      content: 'updated body\n',
    })

    const deleted = await routes.request('/records/handbook', { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ deleted: true, slug: 'handbook', memoryId: 'mem_1' })
    expect(await Bun.file(join(storeDir, 'handbook.md')).exists()).toBe(false)
    expect(await lstat(archiveDir).catch(() => null)).toBeNull()
    expect(fileEvents).toEqual([
      {
        kind: 'write',
        path: '.agents/memories/handbook.md',
        actor: '',
        at: expect.any(Number),
      },
      {
        kind: 'delete',
        entryKind: 'file',
        path: '.agents/memories/handbook.md',
        actor: '',
        at: expect.any(Number),
      },
    ])
  })

  test('lists newest createdAt first and uses file mtime as the stable fallback', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const storeDir = join(driveDir, '.agents', 'memories')
    await mkdir(storeDir, { recursive: true })
    const writeRecord = async (slug: string, createdAt: number) => {
      const path = join(storeDir, `${slug}.md`)
      await writeFile(
        path,
        serializeMemoryFile({
          version: 1,
          id: `mem_${slug.replaceAll('-', '_')}`,
          kind: 'train',
          createdAt,
          content: `${slug} body`,
        }),
      )
      return path
    }
    const newest = await writeRecord('newest-created', 200)
    const olderMtime = await writeRecord('tie-older-mtime', 100)
    const newerMtime = await writeRecord('tie-newer-mtime', 100)
    await utimes(newest, new Date(1_000), new Date(1_000))
    await utimes(olderMtime, new Date(2_000), new Date(2_000))
    await utimes(newerMtime, new Date(3_000), new Date(3_000))
    const scope = resolveTrainScope({ anchors: [], driveDir, stateDir })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      uploadsStores: uploadsStore(stateDir),
      resolveScope: () => scope,
      recordIndexesReady: rebuildTrainRecordIndex(scope, stateDir),
      jobLedger: createTrainJobLedger({ stateDir, now: () => Date.now() }),
    })

    const response = await routes.request('/records')
    const body = (await response.json()) as { items: Array<{ slug: string }> }

    expect(response.status).toBe(200)
    expect(body.items.map(record => record.slug)).toEqual([
      'newest-created',
      'tie-newer-mtime',
      'tie-older-mtime',
    ])
  })

  test('projects archived sources onto the record, resolving scrapes to their URL', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const storeDir = join(driveDir, '.agents', 'memories')
    await mkdir(storeDir, { recursive: true })
    await writeFile(
      join(storeDir, 'titan.md'),
      serializeMemoryFile({
        version: 1,
        id: 'mem_titan',
        kind: 'train',
        createdAt: Date.parse('2026-08-17T00:00:00.000Z'),
        archiveId: 'mem_titan',
        content: '## Plans',
      }),
    )
    // A scraped page carries its own provenance in frontmatter, which is why
    // the manifest never had to record URLs — the archived copy still knows.
    const scrape = serializeScrapedUrlFrontmatter(
      {
        url: 'https://titan.dev/pricing',
        title: 'Pricing — Titan',
        scrapedAt: '2026-08-17T00:00:00.000Z',
      },
      '# Pricing\n',
    )
    await writeArchive(stateDir, 'mem_titan', [
      { relPath: 'url-titan-dev-pricing-a1b2c3d4.md', body: scrape },
      { relPath: 'contract-2026.pdf', body: '%PDF-1.7 binary-ish' },
    ])

    const scope = resolveTrainScope({ anchors: [], driveDir, stateDir })
    await rebuildTrainRecordIndex(scope, stateDir)
    const routes = trainRoutes(stateDir, driveDir)
    const detailResponse = await routes.request('/records/titan')
    expect(detailResponse.status).toBe(200)
    const detail = (await detailResponse.json()) as { record: { sources?: unknown } }
    const list = (await (await routes.request('/records')).json()) as {
      items: Record<string, unknown>[]
    }

    expect(detail.record.sources).toEqual([
      {
        relPath: 'url-titan-dev-pricing-a1b2c3d4.md',
        bytes: Buffer.byteLength(scrape),
        url: 'https://titan.dev/pricing',
        title: 'Pricing — Titan',
        scrapedAt: '2026-08-17T00:00:00.000Z',
      },
      { relPath: 'contract-2026.pdf', bytes: 19 },
    ])
    // The list is the hot path: one frontmatter read per archived markdown
    // file would multiply by every memory in the store, on every render.
    expect(list.items[0]).not.toHaveProperty('sources')
    expect(list.items[0]).toMatchObject({ slug: 'titan', hasArchive: true })
  })

  test('serves an archived source, and refuses to escape the archive', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const storeDir = join(driveDir, '.agents', 'memories')
    const secret = join(root, 'outside-the-archive.txt')
    await mkdir(storeDir, { recursive: true })
    await writeFile(secret, 'not yours')
    await writeFile(
      join(storeDir, 'titan.md'),
      serializeMemoryFile({
        version: 1,
        id: 'mem_titan',
        kind: 'train',
        createdAt: 1,
        archiveId: 'mem_titan',
        content: 'body',
      }),
    )
    await writeArchive(stateDir, 'mem_titan', [
      { relPath: 'notes.md', body: '# Notes\n' },
      { relPath: 'sheet.csv', body: 'a,b\n1,2\n' },
    ])
    // A symlink planted inside the archive is the case a lexical path check
    // passes and a resolved one catches.
    await symlink(secret, join(stateDir, 'train', 'mem_titan', 'files', 'escape.md'))

    const routes = trainRoutes(stateDir, driveDir)
    const served = await routes.request('/records/titan/sources/notes.md')
    const missing = await routes.request('/records/titan/sources/absent.md')
    const traversal = await routes.request('/records/titan/sources/..%2F..%2Fmanifest.json')
    const linked = await routes.request('/records/titan/sources/escape.md')

    expect(served.status).toBe(200)
    expect(await served.text()).toBe('# Notes\n')
    // Every refusal looks the same, so the route never confirms what exists
    // outside the archive.
    expect(missing.status).toBe(404)
    expect(traversal.status).toBe(404)
    expect(linked.status).toBe(404)
    expect(await linked.text()).not.toContain('not yours')
  })

  test('restage replaces the inbox with the archive, and refuses to while a job runs', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const storeDir = join(driveDir, '.agents', 'memories')
    await mkdir(storeDir, { recursive: true })
    await writeFile(
      join(storeDir, 'titan.md'),
      serializeMemoryFile({
        version: 1,
        id: 'mem_titan',
        kind: 'train',
        createdAt: 1,
        archiveId: 'mem_titan',
        content: 'body',
      }),
    )
    const scrape = serializeScrapedUrlFrontmatter(
      { url: 'https://titan.dev/pricing', title: 'Pricing', scrapedAt: '2026-08-17T00:00:00.000Z' },
      '# Pricing\n',
    )
    await writeArchive(stateDir, 'mem_titan', [
      { relPath: 'url-titan-dev-pricing-a1b2c3d4.md', body: scrape },
      { relPath: 'notes.txt', body: 'archived notes' },
    ])

    const stores = uploadsStore(stateDir)
    const ledger = createTrainJobLedger({ stateDir, now: () => Date.now() })
    const routes = createTrainRoutes({
      stateDir,
      driveDir,
      uploadsStores: stores,
      resolveScope: () => resolveTrainScope({ anchors: [], driveDir, stateDir }),
      jobLedger: ledger,
    })
    const scope = resolveTrainScope({ anchors: [], driveDir, stateDir })
    await stores.forScope(scope.uploadsScope).put('stale.txt', new Blob(['stale']).stream())

    const restaged = await routes.request('/records/titan/restage', { method: 'POST' })
    const inbox = await stores.forScope(scope.uploadsScope).list()

    expect(restaged.status).toBe(200)
    expect(await restaged.json()).toEqual({
      staged: 2,
      rescraped: 0,
      fellBack: [],
      urls: ['https://titan.dev/pricing'],
    })
    // Replaced, not merged: what was staged before is gone.
    expect(inbox.items.map(file => file.filename).sort()).toEqual([
      'notes.txt',
      'url-titan-dev-pricing-a1b2c3d4.md',
    ])
    // The scrape's frontmatter survived the copy, so the inbox reports it as a
    // URL rather than an anonymous markdown file — which is what lets the API
    // know it has something to re-scrape.
    expect(inbox.items.find(file => file.filename.startsWith('url-'))?.url).toBe(
      'https://titan.dev/pricing',
    )

    // A running job is reading this inbox; clearing it out from under one is
    // the failure this guard exists for.
    ledger.start('job-running', 'user-one')
    const duringJob = await routes.request('/records/titan/restage', { method: 'POST' })
    const afterRefusal = await stores.forScope(scope.uploadsScope).list()

    expect(duringJob.status).toBe(409)
    expect(afterRefusal.items).toHaveLength(2)
  })

  test('survives an archive whose files are gone without failing the read', async () => {
    const stateDir = join(root, '.duet')
    const driveDir = join(root, 'drive')
    const storeDir = join(driveDir, '.agents', 'memories')
    await mkdir(storeDir, { recursive: true })
    await writeFile(
      join(storeDir, 'pruned.md'),
      serializeMemoryFile({
        version: 1,
        id: 'mem_pruned',
        kind: 'train',
        createdAt: 1,
        archiveId: 'mem_pruned',
        content: 'body',
      }),
    )
    // Manifest present, files pruned out of band — the state `hasArchive`
    // exists to describe. A named-but-absent file is omitted, not fatal.
    await writeArchive(stateDir, 'mem_pruned', [{ relPath: 'gone.md', body: 'x' }])
    await rm(join(stateDir, 'train', 'mem_pruned', 'files'), { recursive: true, force: true })

    const routes = trainRoutes(stateDir, driveDir)
    const response = await routes.request('/records/pruned')
    const detail = (await response.json()) as { record: { sources?: unknown } }

    expect(response.status).toBe(200)
    expect(detail.record.sources).toEqual([])
  })

  test('rejects traversal slugs and refuses to read or replace symlinked files', async () => {
    const stateDir = join(root, '.duet')
    const storeDir = join(root, 'drive', '.agents', 'memories')
    const outside = join(root, 'outside.md')
    await mkdir(storeDir, { recursive: true })
    await writeFile(
      outside,
      serializeMemoryFile({
        version: 1,
        id: 'mem_outside',
        kind: 'train',
        createdAt: 1,
        content: 'outside',
      }),
    )
    await symlink(outside, join(storeDir, 'linked.md'))
    const options = { stateDir, storeDir }

    await expect(readMemoryRecord('../outside', options)).rejects.toBeInstanceOf(MemoryStoreError)
    await expect(readMemoryRecord('linked', options)).rejects.toThrow(
      'Memory files cannot be symlinks',
    )
    await expect(updateMemoryRecord('linked', 'replacement', options)).rejects.toThrow(
      'Memory files cannot be symlinks',
    )
    expect(await Bun.file(outside).text()).toContain('outside')
  })
})

function trainRoutes(stateDir: string, driveDir: string) {
  const scope = resolveTrainScope({ anchors: [], driveDir, stateDir })
  return createTrainRoutes({
    stateDir,
    driveDir,
    uploadsStores: uploadsStore(stateDir),
    resolveScope: () => scope,
    jobLedger: createTrainJobLedger({ stateDir, now: () => Date.now() }),
  })
}

/** Write the archive layout duet-agent produces: manifest plus `files/`. */
async function writeArchive(
  stateDir: string,
  memoryId: string,
  files: { relPath: string; body: string }[],
) {
  const root = join(stateDir, 'train', memoryId)
  await mkdir(join(root, 'files'), { recursive: true })
  for (const file of files) {
    await writeFile(join(root, 'files', file.relPath), file.body)
  }
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      memoryId,
      slug: memoryId,
      createdAt: 1,
      sourceFolder: '/tmp/corpus',
      model: 'gpt-6-luna',
      headline: 'fixture',
      files: files.map(file => ({
        relPath: file.relPath,
        bytes: Buffer.byteLength(file.body),
        sha256: 'x'.repeat(64),
      })),
    }),
  )
}

function uploadsStore(stateDir: string) {
  return createUploadsStore({
    trainDir: join(stateDir, 'train'),
    capBytes: 1024,
    maxFiles: 10,
  })
}

function jsonShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonShape)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, jsonShape(entry)]),
    )
  }
  return typeof value
}
