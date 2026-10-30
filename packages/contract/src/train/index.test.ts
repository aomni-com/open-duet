import { describe, expect, test } from 'bun:test'

import { COLLECTION_PAGE_DEFAULT_LIMIT, COLLECTION_PAGE_MAX_LIMIT } from '../pagination/index'

import {
  GatewayTrainJobReportBatchSchema,
  GatewayTrainJobReportSchema,
  MAX_TRAIN_ERROR_UTF8_BYTES,
  MAX_TRAIN_IDENTIFIER_UTF8_BYTES,
  MAX_TRAIN_REPORTS_PER_SYNC,
  MAX_TRAIN_RECORD_HEADLINE_UTF8_BYTES,
  TRAIN_CLI_CONTRACT,
  TrainMemoryCountsResponseSchema,
  GatewayTrainRestageResponseSchema,
  TrainJobListQuerySchema,
  TrainJobListResponseSchema,
  TrainRestageResponseSchema,
  TrainStartRequestSchema,
  TrainRecordDeleteResponseSchema,
  TrainRecordSchema,
  TrainRecordListResponseSchema,
  TrainRecordResponseSchema,
  TrainRecordSummarySchema,
  TrainRecordUpdateRequestSchema,
  TrainUploadsListQuerySchema,
  TrainUploadsListResponseSchema,
} from './index'

test('train reports, identifiers, diagnostics, and batches are byte bounded', () => {
  const report = {
    generation: '1',
    jobId: 'job',
    creatorUserId: 'user',
    state: 'failed' as const,
    phase: 'failed' as const,
    createdAt: 1,
    updatedAt: 1,
  }
  expect(
    GatewayTrainJobReportSchema.safeParse({
      ...report,
      error: `${'x'.repeat(MAX_TRAIN_ERROR_UTF8_BYTES - 4)}🚀`,
    }).success,
  ).toBe(true)
  expect(
    GatewayTrainJobReportSchema.safeParse({
      ...report,
      error: `${'x'.repeat(MAX_TRAIN_ERROR_UTF8_BYTES - 3)}🚀`,
    }).success,
  ).toBe(false)
  expect(
    GatewayTrainJobReportSchema.safeParse({
      ...report,
      jobId: 'x'.repeat(MAX_TRAIN_IDENTIFIER_UTF8_BYTES + 1),
    }).success,
  ).toBe(false)
  expect(
    GatewayTrainJobReportBatchSchema.safeParse(
      Array.from({ length: MAX_TRAIN_REPORTS_PER_SYNC + 1 }, (_, i) => ({
        ...report,
        generation: `${i}`,
      })),
    ).success,
  ).toBe(false)
})

test('train record summaries bound inherited merge row strings', () => {
  const summary = {
    slug: 'demo',
    memoryId: 'memory',
    createdAt: 1,
    observedDate: '2026-08-28',
    hasArchive: false,
  }
  expect(
    TrainRecordSummarySchema.safeParse({
      ...summary,
      headline: 'x'.repeat(MAX_TRAIN_RECORD_HEADLINE_UTF8_BYTES + 1),
    }).success,
  ).toBe(false)
  expect(
    TrainRecordSummarySchema.safeParse({
      ...summary,
      memoryId: 'x'.repeat(MAX_TRAIN_IDENTIFIER_UTF8_BYTES + 1),
    }).success,
  ).toBe(false)
})

describe('train CLI contract', () => {
  test('training uploads and jobs use the universal bounded page contract', () => {
    expect(TrainUploadsListQuerySchema.parse({})).toEqual({ limit: COLLECTION_PAGE_DEFAULT_LIMIT })
    expect(TrainJobListQuerySchema.parse({ cursor: 'next' })).toEqual({
      cursor: 'next',
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
    })
    expect(TrainUploadsListQuerySchema.safeParse({ extra: 'nope' }).success).toBe(false)
    expect(TrainJobListQuerySchema.safeParse({ limit: COLLECTION_PAGE_MAX_LIMIT + 1 }).success).toBe(false)

    expect(
      TrainUploadsListResponseSchema.parse({
        items: [],
        nextCursor: null,
        meta: { totalBytes: 12, fileCount: 2, capBytes: 100, running: false },
        additive: 'future-safe',
      }),
    ).toEqual({
      items: [],
      nextCursor: null,
      meta: { totalBytes: 12, fileCount: 2, capBytes: 100, running: false },
    })
    expect(
      TrainJobListResponseSchema.parse({ items: [], nextCursor: null, additive: true }),
    ).toEqual({ items: [], nextCursor: null })

    expect(
      TrainUploadsListResponseSchema.safeParse({
        files: [],
        totalBytes: 0,
        capBytes: 100,
        running: false,
      }).success,
    ).toBe(false)
    expect(TrainJobListResponseSchema.safeParse({ jobs: [] }).success).toBe(false)
  })

  test('pins duet train synthesis argv to an explicit memory store', () => {
    expect(
      TRAIN_CLI_CONTRACT.argv({
        sourceDir: '/tmp/duet-train/demo',
        slug: 'demo-acme-1234',
        storeDir: '/tmp/duet-train/output',
      }),
    ).toEqual([
      'train',
      '/tmp/duet-train/demo',
      '--slug',
      'demo-acme-1234',
      '--store',
      '/tmp/duet-train/output',
      '--model',
      'luna',
    ])
  })

  test('carries archived sources on the full record, never on the summary', () => {
    // The summary feeds the list, and projecting sources costs a file read per
    // archived markdown file — on the list that multiplies by every memory in
    // the store, on every render. The asymmetry is deliberate.
    const base = {
      slug: 'demo-acme-1234',
      memoryId: 'mem_1',
      createdAt: '2026-08-17T00:00:00.000Z',
      observedDate: '2026-08-17',
      hasArchive: true,
    }
    const sources = [
      {
        relPath: 'url-titan-dev-pricing-a1b2c3d4.md',
        bytes: 4096,
        url: 'https://titan.dev/pricing',
        title: 'Pricing — Titan',
        scrapedAt: '2026-08-17T00:00:00.000Z',
      },
      { relPath: 'contract-2026.pdf', bytes: 421_888 },
    ]

    expect(TrainRecordSchema.parse({ ...base, content: 'body', sources }).sources).toEqual(sources)
    // A gateway that predates the field omits it, and the page must render.
    expect(TrainRecordSchema.parse({ ...base, content: 'body' }).sources).toBeUndefined()
    expect(TrainRecordSummarySchema.parse({ ...base, sources })).not.toHaveProperty('sources')
  })

  test('accepts a retrain target slug and refuses a traversal', () => {
    expect(
      TrainStartRequestSchema.parse({ targetSlug: 'train-2026-08-17-abcd1234' }).targetSlug,
    ).toBe('train-2026-08-17-abcd1234')
    expect(TrainStartRequestSchema.parse({}).targetSlug).toBeUndefined()
    expect(TrainStartRequestSchema.safeParse({ targetSlug: '../evil' }).success).toBe(false)
    expect(TrainStartRequestSchema.safeParse({ targetSlug: '' }).success).toBe(false)
  })

  test('restage reports which URLs fell back to their archived copy', () => {
    // `fellBack` is what the UI uses to tell the user a source is stale, so it
    // is a contract fact rather than a log line.
    expect(
      TrainRestageResponseSchema.parse({
        staged: 7,
        rescraped: 2,
        fellBack: ['https://titan.dev/changelog'],
      }),
    ).toEqual({ staged: 7, rescraped: 2, fellBack: ['https://titan.dev/changelog'] })
    expect(
      GatewayTrainRestageResponseSchema.parse({
        staged: 2,
        rescraped: 0,
        fellBack: [],
        urls: ['https://titan.dev/changelog'],
      }).urls,
    ).toEqual(['https://titan.dev/changelog'])
  })

  test('accepts file-backed train records with provenance and inheritance metadata', () => {
    expect(
      TrainRecordSchema.parse({
        slug: 'demo-acme-1234',
        memoryId: 'mem_1',
        archiveId: 'archive_1',
        store: '/workspace/.agents/memories',
        inherited: true,
        ownerAgentSlug: 'researcher',
        createdAt: '2026-07-07T00:00:00.000Z',
        observedDate: '2026-07-07',
        headline: 'Demo corpus',
        model: 'sonnet-4.6',
        fileCount: 3,
        hasArchive: true,
        content: 'durable manual memory',
      }),
    ).toEqual({
      slug: 'demo-acme-1234',
      memoryId: 'mem_1',
      archiveId: 'archive_1',
      store: '/workspace/.agents/memories',
      inherited: true,
      ownerAgentSlug: 'researcher',
      createdAt: '2026-07-07T00:00:00.000Z',
      observedDate: '2026-07-07',
      headline: 'Demo corpus',
      model: 'sonnet-4.6',
      fileCount: 3,
      hasArchive: true,
      content: 'durable manual memory',
    })
  })

  test('list summaries tolerate legacy numeric timestamps and updates reject empty content', () => {
    expect(
      TrainRecordSummarySchema.parse({
        slug: 'demo-acme-1234',
        memoryId: 'mem_1',
        createdAt: 1_788_000_000_000,
        observedDate: '2026-07-07',
        hasArchive: false,
      }).createdAt,
    ).toBe(1_788_000_000_000)
    expect(TrainRecordUpdateRequestSchema.safeParse({ content: '   ' }).success).toBe(false)
    expect(TrainRecordUpdateRequestSchema.parse({ content: '\nkeep me\n' }).content).toBe(
      '\nkeep me\n',
    )
    expect(TrainRecordListResponseSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    })
    expect(
      TrainRecordResponseSchema.parse({
        record: {
          slug: 'demo',
          memoryId: 'mem_1',
          createdAt: 1,
          observedDate: '2026-07-07',
          hasArchive: false,
          content: 'memory',
        },
      }),
    ).toMatchObject({ record: { slug: 'demo', content: 'memory' } })
    expect(
      TrainRecordDeleteResponseSchema.parse({ deleted: true, slug: 'demo', memoryId: 'mem_1' }),
    ).toEqual({ deleted: true, slug: 'demo', memoryId: 'mem_1' })
  })

  test('agent memory counts stay compact and keyed by public agent slug', () => {
    expect(
      TrainMemoryCountsResponseSchema.parse({
        rootCount: 73,
        counts: { research: 3, support: 0, reviewer: null },
        trainableAgents: ['research', 'reviewer'],
      }),
    ).toEqual({
      rootCount: 73,
      counts: { research: 3, support: 0, reviewer: null },
      trainableAgents: ['research', 'reviewer'],
    })
    expect(
      TrainMemoryCountsResponseSchema.parse({
        rootCount: 0,
        counts: { research: 3 },
        trainableAgents: [],
      }),
    ).toEqual({ rootCount: 0, counts: { research: 3 }, trainableAgents: [] })
    expect(
      TrainMemoryCountsResponseSchema.safeParse({
        rootCount: 0,
        counts: { research: -1 },
        trainableAgents: [],
      }).success,
    ).toBe(false)
  })
})
