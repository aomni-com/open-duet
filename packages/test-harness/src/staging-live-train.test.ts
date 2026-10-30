import { describe, expect, test } from 'bun:test'

import { assertScopedTrainAcceptance } from './staging-live-train.ts'

const rootRecord = {
  slug: 'northstar-renewals',
  memoryId: 'mem_root',
  createdAt: '2026-07-23T00:00:00.000Z',
  observedDate: '2026-07-23',
  headline: 'Northstar renewals',
  hasArchive: true,
}

const childRecord = {
  slug: 'child-operating-guide',
  memoryId: 'mem_child',
  createdAt: '2026-07-23T00:01:00.000Z',
  observedDate: '2026-07-23',
  headline: 'Child operating guide',
  hasArchive: true,
}

const previousRootRecord = {
  ...rootRecord,
  slug: 'previous-root',
  memoryId: 'mem_previous_root',
}

const previousChildRecord = {
  ...childRecord,
  slug: 'previous-child',
  memoryId: 'mem_previous_child',
}

describe('staging scoped train acceptance', () => {
  test('accepts newly owned records with root inheritance and no child leakage', () => {
    expect(
      assertScopedTrainAcceptance({
        rootJobId: 'train_root',
        agentJobId: 'train_agent',
        agentSlug: 'research',
        rootRecordsBefore: [],
        agentRecordsBefore: [],
        rootRecords: [rootRecord],
        agentRecords: [childRecord, { ...rootRecord, inherited: true, ownerAgentSlug: undefined }],
      }),
    ).toEqual({ rootRecord, agentRecord: childRecord })
  })

  test('rejects a child record that leaked into the root list', () => {
    expect(() =>
      assertScopedTrainAcceptance({
        rootJobId: 'train_root',
        agentJobId: 'train_agent',
        agentSlug: 'research',
        rootRecordsBefore: [],
        agentRecordsBefore: [],
        rootRecords: [rootRecord, childRecord],
        agentRecords: [childRecord, { ...rootRecord, inherited: true, ownerAgentSlug: undefined }],
      }),
    ).toThrow('root records exposed the child agent memory')
  })

  test('rejects any root record attributed to the child agent slug', () => {
    expect(() =>
      assertScopedTrainAcceptance({
        rootJobId: 'train_root',
        agentJobId: 'train_agent',
        agentSlug: 'research',
        rootRecordsBefore: [],
        agentRecordsBefore: [],
        rootRecords: [rootRecord, { ...previousChildRecord, ownerAgentSlug: 'research' }],
        agentRecords: [childRecord, { ...rootRecord, inherited: true, ownerAgentSlug: undefined }],
      }),
    ).toThrow('root records exposed the child agent owner slug')
  })

  test('identifies records created by this run instead of relying on list order', () => {
    expect(
      assertScopedTrainAcceptance({
        rootJobId: 'train_root',
        agentJobId: 'train_agent',
        agentSlug: 'research',
        rootRecordsBefore: [previousRootRecord],
        agentRecordsBefore: [previousChildRecord],
        rootRecords: [previousRootRecord, rootRecord],
        agentRecords: [
          previousChildRecord,
          childRecord,
          { ...rootRecord, inherited: true, ownerAgentSlug: undefined },
        ],
      }),
    ).toEqual({ rootRecord, agentRecord: childRecord })
  })
})
