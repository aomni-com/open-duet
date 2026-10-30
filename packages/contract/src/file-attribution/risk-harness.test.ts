import { describe, expect, test } from 'bun:test'

import {
  ATOMIC_EDITOR_REPLACEMENT,
  EXPLICIT_FILES_MOVE,
  LOGICAL_ENTRY_MATRIX,
  SAME_BATCH_ORDER_CASES,
  gatewayLivenessAnchorWorkload,
  gatewayLivenessWorkload,
  sealedBatch,
} from '../../testing/gateway-liveness'
import { DriveFileEventSchema, FILE_ACTIVITY_LIMITS, FileEventBatchSchema } from './index'

describe('gateway-liveness risk fixtures', () => {
  test('the shared workload and retry payload are deterministic', () => {
    const workload = gatewayLivenessWorkload()
    expect(workload).toContainEqual(expect.objectContaining({ path: 'README.md', kind: 'write' }))
    expect(workload).toContainEqual(expect.objectContaining({ path: '.git/objects/aa/object' }))
    expect(workload).toContainEqual(expect.objectContaining({ kind: 'restore' }))
    const bounded = sealedBatch(workload.slice(0, FILE_ACTIVITY_LIMITS.maxEventsPerBatch))
    expect(bounded).toEqual(sealedBatch(workload.slice(0, FILE_ACTIVITY_LIMITS.maxEventsPerBatch)))
    expect(FileEventBatchSchema.safeParse(bounded).success).toBeTrue()
    expect(FileEventBatchSchema.safeParse(sealedBatch(workload)).success).toBeFalse()
  })

  test('the lineage matrix pins every ambiguous identity decision and array ordering', () => {
    expect(LOGICAL_ENTRY_MATRIX.map(scenario => scenario.name)).toEqual([
      'file rename chain',
      'folder move retains descendant history',
      'path reuse shadows an alias',
      'rename-over keeps source identity',
      'copy does not inherit',
      'delete then create does not inherit',
      'hard link is a separate entry',
      'restore starts a new epoch',
    ])
    expect(SAME_BATCH_ORDER_CASES).toEqual([
      ['rename', 'write'],
      ['write', 'rename'],
      ['delete', 'create'],
      ['create', 'delete'],
    ])
    expect(ATOMIC_EDITOR_REPLACEMENT.map(item => item.kind)).toEqual(['rename', 'write'])
    expect(EXPLICIT_FILES_MOVE.map(item => item.kind)).toEqual(['rename'])
  })

  test('the anchor workload distinguishes scale, evidence, and caller semantics', () => {
    const workload = gatewayLivenessAnchorWorkload()
    expect(workload.generatedEntryCount).toBe(1_828_400)
    expect(workload.generatedPathAt(workload.generatedEntryCount - 1)).toBe(
      'node_modules/pkg-1828399/nested/index.js',
    )
    expect(workload.anchors.map(anchor => anchor.path)).toEqual(['agents/researcher'])
    expect(workload.evidenceCases).toEqual([
      'restore_in_flight',
      'drive_unreadable',
      'genuine_absence',
    ])
    expect(workload.reconcileCallers).toEqual(['sync', 'sync', 'api', 'api'])
  })

  test('structural facts carry entry kind and summaries are contract events', () => {
    expect(
      DriveFileEventSchema.safeParse({
        kind: 'create',
        entryKind: 'file',
        path: 'a',
        actor: 'system',
        at: 1,
      }).success,
    ).toBeTrue()
    expect(
      DriveFileEventSchema.safeParse({
        kind: 'changed-summary',
        path: 'node_modules',
        count: 2_000,
        actor: 'system',
        at: 1,
      }).success,
    ).toBeTrue()
  })
})
