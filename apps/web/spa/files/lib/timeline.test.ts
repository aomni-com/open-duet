import { describe, expect, test } from 'bun:test'

import { READ_BUCKET_MS, type FileActivityEvent, type FileFeedEvent } from '@repo/contract'

import appEn from '../../../messages/en/app.json'
import { buildFeedRows, buildHistoryRows, mergeEventPages } from './timeline'

const history = appEn.duetApp.filesSurface.history as Record<string, string>
const activity = appEn.duetApp.filesSurface.activity as Record<string, string>

function feed(seq: number, event: FileActivityEvent): FileFeedEvent {
  return { seq, event }
}
function write(actor: string, path: string, at: number, userId?: string): FileActivityEvent {
  return { kind: 'write', path, actor, at, ...(userId === undefined ? {} : { userId }) }
}
function read(actor: string, path: string, at: number, userId?: string): FileActivityEvent {
  return { kind: 'read', path, actor, at, ...(userId === undefined ? {} : { userId }) }
}

describe('mergeEventPages', () => {
  test('dedupes on seq across a page boundary and re-sorts ascending', () => {
    const pageA = [feed(3, write('terminal', 'a.md', 30)), feed(2, write('terminal', 'a.md', 20))]
    const pageB = [feed(2, write('terminal', 'a.md', 20)), feed(4, write('terminal', 'a.md', 40))]
    const merged = mergeEventPages([pageA, pageB])
    expect(merged.map(row => row.seq)).toEqual([2, 3, 4])
    expect(merged).toEqual([pageB[0]!, pageA[0]!, pageB[1]!])
  })
})

describe('buildHistoryRows', () => {
  test('equal timestamps keep server seq order — seq is the only total order', () => {
    const rows = buildHistoryRows([
      feed(2, write('web:u2', 'a.md', 1000, 'u2')),
      feed(1, write('web:u1', 'a.md', 1000, 'u1')),
    ])
    expect(rows.map(row => row.seq)).toEqual([1, 2])
  })

  test('a rename row carries both the old and new path', () => {
    const rows = buildHistoryRows([
      feed(1, {
        kind: 'rename',
        entryKind: 'file',
        path: 'final.md',
        fromPath: 'draft.md',
        actor: 'terminal',
        at: 10,
      }),
    ])
    expect(rows[0]).toMatchObject({
      type: 'event',
      event: { kind: 'rename', path: 'final.md', fromPath: 'draft.md' },
    })
  })

  test('a deleted path stays a visible history row', () => {
    const rows = buildHistoryRows([
      feed(1, {
        kind: 'delete',
        entryKind: 'file',
        path: 'gone.md',
        actor: 'web:u1',
        at: 5,
        userId: 'u1',
      }),
    ])
    expect(rows[0]).toMatchObject({ type: 'event', event: { kind: 'delete', path: 'gone.md' } })
  })

  test('a workspace restore row has no path and stays inline', () => {
    const rows = buildHistoryRows([
      feed(1, write('terminal', 'a.md', 5)),
      feed(2, { kind: 'restore', actor: 'web:u1', at: 6, userId: 'u1' }),
    ])
    expect(rows[1]).toMatchObject({ type: 'event', event: { kind: 'restore' } })
    expect(rows[1]?.type === 'event' && 'path' in rows[1].event).toBe(false)
  })

  test('reads collapse per actor per 6h bucket and never carry a count', () => {
    const rows = buildHistoryRows([
      feed(1, read('web:u1', 'a.md', 1000, 'u1')),
      feed(2, read('web:u1', 'a.md', 2000, 'u1')),
      feed(3, read('web:u1', 'a.md', READ_BUCKET_MS + 1000, 'u1')),
      feed(4, read('web:u2', 'a.md', READ_BUCKET_MS + 1000, 'u2')),
    ])
    const buckets = rows.filter(row => row.type === 'read-bucket')
    // Two reads in bucket 0 collapse; the next bucket and the other actor split.
    expect(buckets).toMatchObject([
      { actor: 'web:u1', userId: 'u1', bucketStart: 0, firstAt: 1000, lastAt: 2000 },
      {
        actor: 'web:u1',
        userId: 'u1',
        bucketStart: READ_BUCKET_MS,
        firstAt: READ_BUCKET_MS + 1000,
        lastAt: READ_BUCKET_MS + 1000,
      },
      {
        actor: 'web:u2',
        userId: 'u2',
        bucketStart: READ_BUCKET_MS,
        firstAt: READ_BUCKET_MS + 1000,
        lastAt: READ_BUCKET_MS + 1000,
      },
    ])
    const first = buckets[0]
    expect(first?.type === 'read-bucket' && first.firstAt).toBe(1000)
    expect(first?.type === 'read-bucket' && first.lastAt).toBe(2000)
    expect(first).not.toHaveProperty('count')
    // The honesty firewall lives in the copy too: no exact read tally exists.
    expect(history.seenThisPeriod).not.toMatch(/\{count\}/)
  })

  test('a write between two same-bucket reads splits them — order is never bent', () => {
    const rows = buildHistoryRows([
      feed(1, read('web:u1', 'a.md', 1000, 'u1')),
      feed(2, write('web:u1', 'a.md', 1500, 'u1')),
      feed(3, read('web:u1', 'a.md', 2000, 'u1')),
    ])
    expect(rows.map(row => row.type)).toEqual(['read-bucket', 'event', 'read-bucket'])
  })
})

describe('buildFeedRows', () => {
  test('newest-first feeds keep newest grouped activity first', () => {
    const rows = buildFeedRows(
      [
        feed(1, write('terminal', 'old.md', 10)),
        feed(2, write('session:s1', 'new-a.md', 20)),
        feed(3, write('session:s1', 'new-b.md', 30)),
      ],
      'desc',
    )
    expect(rows.map(row => row.seq)).toEqual([3, 1])
    expect(rows[0]).toMatchObject({ type: 'group', paths: ['new-b.md', 'new-a.md'] })
    expect(rows[0]?.type === 'group' && rows[0].latestAt).toBe(30)
  })

  test('adjacent same-actor writes group into one row with every path', () => {
    const rows = buildFeedRows([
      feed(1, write('session:s1', 'a.md', 10, 'u1')),
      feed(2, write('session:s1', 'b.md', 11, 'u1')),
      feed(3, write('session:s1', 'c.md', 12, 'u1')),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'group', paths: ['a.md', 'b.md', 'c.md'] })
  })

  test('mirror and terminal writes are never grouped away or hidden', () => {
    const rows = buildFeedRows([
      feed(1, write('session:s1', 'a.md', 10, 'u1')),
      feed(2, write('mirror:dev_1', 'b.md', 11)),
      feed(3, write('terminal', 'c.md', 12)),
    ])
    const actors = rows.map(row => (row.type === 'group' ? row.actor : row.event.actor))
    expect(actors).toEqual(['session:s1', 'mirror:dev_1', 'terminal'])
  })

  test('renames and deletes stand alone between grouped bursts', () => {
    const rows = buildFeedRows([
      feed(1, write('web:u1', 'a.md', 10, 'u1')),
      feed(2, {
        kind: 'rename',
        entryKind: 'file',
        path: 'b.md',
        fromPath: 'a.md',
        actor: 'web:u1',
        at: 11,
        userId: 'u1',
      }),
      feed(3, {
        kind: 'delete',
        entryKind: 'file',
        path: 'c.md',
        actor: 'web:u1',
        at: 12,
        userId: 'u1',
      }),
    ])
    expect(rows.map(row => row.type)).toEqual(['group', 'single', 'single'])
  })

  test('a group of only creates is flagged so the feed can say "created"', () => {
    const rows = buildFeedRows([
      feed(1, { kind: 'create', entryKind: 'file', path: 'a.md', actor: 'terminal', at: 10 }),
      feed(2, { kind: 'create', entryKind: 'file', path: 'b.md', actor: 'terminal', at: 11 }),
    ])
    expect(rows[0]).toMatchObject({ type: 'group', allCreates: true })
    // The "created N files" copy the flag selects exists.
    expect(activity.createdCount).toContain('{count}')
  })

  test('canonical summaries remain separate counted rows at the noisy root', () => {
    const rows = buildFeedRows([
      feed(1, write('terminal', 'README.md', 10)),
      {
        seq: 2,
        event: {
          kind: 'changed-summary',
          path: '.git',
          actor: 'terminal',
          at: 12,
          count: 487,
        },
      },
      {
        seq: 3,
        event: {
          kind: 'viewed-summary',
          path: 'node_modules',
          actor: 'session:s1',
          at: 13,
          count: 22,
        },
      },
    ])
    expect(rows).toHaveLength(3)
    expect(rows[1]).toMatchObject({
      type: 'single',
      event: { kind: 'changed-summary', path: '.git', count: 487 },
    })
    expect(rows[2]).toMatchObject({
      type: 'single',
      event: { kind: 'viewed-summary', path: 'node_modules', count: 22 },
    })
    expect(activity.summaryCount).toContain('{count}')
  })
})
