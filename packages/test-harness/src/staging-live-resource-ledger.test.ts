import { describe, expect, test } from 'bun:test'

import { StagingResourceLedger } from './staging-live-resource-ledger.ts'

describe('staging resource ledger', () => {
  // AgentMail reports a just-deleted message as still present for a few
  // seconds. Sampling verification once made a journey's result depend on how
  // much OTHER cleanup happened to run between the delete and the check: the
  // long journeys passed, and the short one declared a deleted message an
  // orphan and failed the run.
  test('a deletion that takes a moment to show up is not an orphan', async () => {
    const sleeps: number[] = []
    const ledger = new StagingResourceLedger(
      'run_123',
      () => 1_000,
      async ms => {
        sleeps.push(ms)
      },
    )
    let checks = 0

    ledger.record({
      kind: 'mail-message',
      id: 'message_1',
      label: 'staging-e2e-run_123-mail',
      cleanup: async () => undefined,
      verify: async () => {
        checks += 1
        return checks > 2
      },
    })

    const report = await ledger.cleanupAll()

    expect(report).toMatchObject({ status: 'pass', orphans: [] })
    expect(checks).toBe(3)
    expect(sleeps.length).toBe(2)
  })

  test('a deletion that never shows up is still an orphan', async () => {
    const ledger = new StagingResourceLedger(
      'run_123',
      () => 1_000,
      async () => undefined,
    )
    ledger.record({
      kind: 'workspace',
      id: 'workspace_1',
      label: 'staging-e2e-run_123',
      cleanup: async () => undefined,
      verify: async () => false,
    })

    const report = await ledger.cleanupAll()

    expect(report.status).toBe('fail')
    expect(report.orphans).toEqual([
      { kind: 'workspace', id: 'workspace_1', label: 'staging-e2e-run_123' },
    ])
  })

  test('cleans resources in reverse creation order and verifies every deletion', async () => {
    const calls: string[] = []
    const ledger = new StagingResourceLedger('run_123', () => 1_000)

    ledger.record({
      kind: 'workspace',
      id: 'workspace_1',
      label: 'staging-e2e-run_123',
      cleanup: async () => calls.push('cleanup workspace'),
      verify: async () => {
        calls.push('verify workspace')
        return true
      },
    })
    ledger.record({
      kind: 'app',
      id: 'app_1',
      label: 'staging-e2e-run_123-app',
      cleanup: async () => calls.push('cleanup app'),
      verify: async () => {
        calls.push('verify app')
        return true
      },
    })
    ledger.record({
      kind: 'user',
      id: 'user_1',
      label: 'staging-e2e-run_123-user',
      cleanupPriority: -100,
      cleanup: async () => calls.push('cleanup user'),
      verify: async () => {
        calls.push('verify user')
        return true
      },
    })

    const report = await ledger.cleanupAll()

    expect(calls).toEqual([
      'cleanup app',
      'cleanup workspace',
      'cleanup user',
      'verify app',
      'verify workspace',
      'verify user',
    ])
    expect(report.status).toBe('pass')
    expect(report.resources.map(resource => resource.status)).toEqual([
      'deleted',
      'deleted',
      'deleted',
    ])
  })

  test('continues cleanup after failures and reports unverified resources as orphans', async () => {
    const cleaned: string[] = []
    const ledger = new StagingResourceLedger('run_456', Date.now, async () => undefined)
    ledger.record({
      kind: 'session',
      id: 'session_bad',
      label: 'staging-e2e-run_456-session',
      cleanup: async () => {
        throw new Error('delete failed')
      },
      verify: async () => false,
    })
    ledger.record({
      kind: 'file',
      id: 'reports/run_456.md',
      label: 'staging-e2e-run_456-file',
      cleanup: async () => cleaned.push('file'),
      verify: async () => true,
    })

    const report = await ledger.cleanupAll()

    expect(cleaned).toEqual(['file'])
    expect(report.status).toBe('fail')
    expect(report.orphans).toEqual([
      { kind: 'session', id: 'session_bad', label: 'staging-e2e-run_456-session' },
    ])
    expect(report.resources.find(resource => resource.id === 'session_bad')).toMatchObject({
      status: 'orphaned',
      error: 'delete failed',
    })
  })

  test('fails when an explicit cleanup endpoint errors even if container teardown removes it', async () => {
    const ledger = new StagingResourceLedger('run_cleanup', Date.now, async () => undefined)
    ledger.record({
      kind: 'app',
      id: 'app_1',
      label: 'staging-e2e-run_cleanup-app',
      cleanup: async () => {
        throw new Error('app delete returned 500')
      },
      verify: async () => true,
    })

    const report = await ledger.cleanupAll()

    expect(report.status).toBe('fail')
    expect(report.orphans).toEqual([])
    expect(report.resources[0]).toMatchObject({
      status: 'deleted',
      error: 'app delete returned 500',
    })
  })

  test('rejects duplicate ids and labels that are not tagged with the run id', () => {
    const ledger = new StagingResourceLedger('run_789', Date.now, async () => undefined)
    const resource = {
      kind: 'workspace' as const,
      id: 'workspace_1',
      label: 'staging-e2e-run_789',
      cleanup: async () => undefined,
      verify: async () => true,
    }

    ledger.record(resource)
    expect(() => ledger.record(resource)).toThrow('already recorded')
    expect(() => ledger.record({ ...resource, id: 'workspace_2', label: 'untagged' })).toThrow(
      'must contain run id',
    )
  })
})
