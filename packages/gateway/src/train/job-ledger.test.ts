import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_TRAIN_ERROR_UTF8_BYTES,
  MAX_TRAIN_IDENTIFIER_UTF8_BYTES,
  MAX_TRAIN_REPORTS_PER_SYNC,
  type GatewayTrainJobPhase,
} from '@repo/contract'

import { createTrainJobLedger } from './job-ledger'

let stateDir: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'duet-train-job-ledger-'))
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('durable train job ledger', () => {
  test('rejects oversized authored ids and scalar-safely bounds trainer diagnostics', () => {
    const ledger = createTrainJobLedger({ stateDir, now: () => 100 })
    expect(() => ledger.start('x'.repeat(MAX_TRAIN_IDENTIFIER_UTF8_BYTES + 1), 'user')).toThrow(
      /Train identifier exceeds/,
    )
    ledger.start('job', 'user')
    ledger.fail('job', `${'x'.repeat(MAX_TRAIN_ERROR_UTF8_BYTES - 1)}🚀tail`)
    const error = ledger.snapshot('job')?.error
    expect(new TextEncoder().encode(error ?? '').byteLength).toBeLessThanOrEqual(
      MAX_TRAIN_ERROR_UTF8_BYTES,
    )
    expect(error?.endsWith('\ud83d')).toBe(false)
  })

  test('bounds the complete multi-job report outbox while retaining every newest snapshot', () => {
    const ledger = createTrainJobLedger({ stateDir, now: () => 100 })
    for (let index = 0; index < 51; index += 1) {
      const jobId = `job-${index}`
      ledger.start(jobId, 'user', index === 0 ? undefined : { anchorId: `anchor-${index}` })
      ledger.setPhase(jobId, 'snapshotting')
      ledger.setPhase(jobId, 'training')
    }
    const reports = ledger.reports()
    expect(reports).toHaveLength(MAX_TRAIN_REPORTS_PER_SYNC)
    for (let index = 0; index < 51; index += 1) {
      expect(
        reports.some(report => report.jobId === `job-${index}` && report.phase === 'training'),
      ).toBe(true)
    }
  })

  test('refuses a new distinct job before a full backlog mutates while existing jobs keep advancing', () => {
    const ledger = createTrainJobLedger({ stateDir, now: () => 100 })
    for (let index = 0; index < MAX_TRAIN_REPORTS_PER_SYNC; index += 1) {
      ledger.start(`job-${index}`, 'user')
    }

    expect(() => ledger.start('job-overflow', 'user')).toThrow('backlog is full')
    expect(ledger.snapshot('job-overflow')).toBeNull()
    ledger.setPhase('job-0', 'snapshotting')
    expect(ledger.reports()).toHaveLength(MAX_TRAIN_REPORTS_PER_SYNC)
    expect(ledger.snapshot('job-0')).toMatchObject({ phase: 'snapshotting' })
  })
  test('a retrain job installs over the named record instead of deriving a slug', () => {
    const ledger = createTrainJobLedger({ stateDir, now: () => 100 })

    // Without a target the slug is derived from the job id, which is what
    // makes every ordinary training a new memory.
    const fresh = ledger.start('job-fresh', 'user-one')
    const retrain = ledger.start('job-retrain', 'user-one', {
      targetSlug: 'train-2026-08-17-abcd1234',
    })

    expect(fresh.recordSlug).not.toBe('train-2026-08-17-abcd1234')
    expect(retrain.recordSlug).toBe('train-2026-08-17-abcd1234')
    // The slug survives a reload: the pipeline reads it from the persisted
    // snapshot, not from the request that started the job.
    expect(
      createTrainJobLedger({ stateDir, now: () => 100 }).snapshot('job-retrain'),
    ).toMatchObject({ recordSlug: 'train-2026-08-17-abcd1234' })
  })

  test('advances concurrent jobs through independently interleaved phases', () => {
    let now = 100
    const ledger = createTrainJobLedger({ stateDir, now: () => now })

    expect(ledger.start('job-one', 'user-one')).toMatchObject({
      jobId: 'job-one',
      phase: 'preparing',
    })
    now += 1
    expect(ledger.start('job-two', 'user-two', { anchorId: 'anchor-two' })).toMatchObject({
      jobId: 'job-two',
      anchorId: 'anchor-two',
      phase: 'preparing',
    })
    now += 1
    ledger.setPhase('job-two', 'snapshotting')
    now += 1
    ledger.setPhase('job-one', 'snapshotting')
    now += 1
    ledger.setPhase('job-one', 'training')
    now += 1
    ledger.setPhase('job-two', 'training')

    expect(ledger.snapshot('job-one')).toMatchObject({
      creatorUserId: 'user-one',
      phase: 'training',
      updatedAt: 104,
    })
    expect(ledger.snapshot('job-two')).toMatchObject({
      creatorUserId: 'user-two',
      anchorId: 'anchor-two',
      phase: 'training',
      updatedAt: 105,
    })
    expect(ledger.reports().map(report => [report.jobId, report.phase])).toEqual([
      ['job-one', 'preparing'],
      ['job-two', 'preparing'],
      ['job-two', 'snapshotting'],
      ['job-one', 'snapshotting'],
      ['job-one', 'training'],
      ['job-two', 'training'],
    ])
  })

  test('completes two jobs in reverse order without touching the other snapshot', async () => {
    let now = 200
    const ledger = createTrainJobLedger({ stateDir, now: () => now })
    ledger.start('job-one', 'user-one')
    ledger.start('job-two', 'user-two')
    const firstDir = join(stateDir, 'train', 'jobs', 'job-one')
    const secondDir = join(stateDir, 'train', 'jobs', 'job-two')
    await Promise.all([mkdir(firstDir, { recursive: true }), mkdir(secondDir, { recursive: true })])
    await Promise.all([
      writeFile(join(firstDir, 'source.md'), 'one'),
      writeFile(join(secondDir, 'source.md'), 'two'),
    ])
    for (const phase of ['snapshotting', 'training', 'finalizing'] as const) {
      ledger.setPhase('job-one', phase)
      ledger.setPhase('job-two', phase)
    }

    now += 1
    ledger.complete('job-two')
    expect(ledger.snapshot('job-two')).toMatchObject({ phase: 'done', completedAt: 201 })
    expect(ledger.snapshot('job-one')).toMatchObject({ phase: 'finalizing' })
    await expect(stat(secondDir)).rejects.toThrow()
    expect((await stat(firstDir)).isDirectory()).toBe(true)

    now += 1
    ledger.complete('job-one')
    expect(ledger.snapshot('job-one')).toMatchObject({ phase: 'done', completedAt: 202 })
    await expect(stat(firstDir)).rejects.toThrow()
  })

  test("isolates one job's failure from another running job", () => {
    const ledger = createTrainJobLedger({ stateDir, now: () => 300 })
    ledger.start('job-failed', 'user-one')
    ledger.start('job-running', 'user-two')
    ledger.setPhase('job-failed', 'snapshotting')
    ledger.setPhase('job-running', 'snapshotting')
    ledger.setPhase('job-running', 'training')

    ledger.fail('job-failed', 'trainer_failed')

    expect(ledger.snapshot('job-failed')).toMatchObject({
      phase: 'failed',
      error: 'trainer_failed',
      completedAt: 300,
    })
    expect(ledger.snapshot('job-running')).toMatchObject({ phase: 'training' })
    expect(ledger.reports().at(-1)).toMatchObject({
      jobId: 'job-failed',
      state: 'failed',
      error: 'trainer_failed',
    })
  })

  test('defers updates while any job runs and reports running state per scope', () => {
    const ledger = createTrainJobLedger({ stateDir, now: () => 400 })
    expect(ledger.hasRunningJob()).toBe(false)
    expect(ledger.hasRunningJob('root')).toBe(false)

    ledger.start('job-root', 'user-root')
    expect(ledger.hasRunningJob()).toBe(true)
    expect(ledger.hasRunningJob('root')).toBe(true)
    expect(ledger.hasRunningJob('anchor-one')).toBe(false)

    ledger.start('job-anchor', 'user-anchor', { anchorId: 'anchor-one' })
    expect(ledger.hasRunningJob()).toBe(true)
    expect(ledger.hasRunningJob('root')).toBe(true)
    expect(ledger.hasRunningJob('anchor-one')).toBe(true)

    ledger.fail('job-root', 'root_failed')
    expect(ledger.hasRunningJob()).toBe(true)
    expect(ledger.hasRunningJob('root')).toBe(false)
    expect(ledger.hasRunningJob('anchor-one')).toBe(true)

    ledger.fail('job-anchor', 'anchor_failed')
    expect(ledger.hasRunningJob()).toBe(false)
    expect(ledger.hasRunningJob('root')).toBe(false)
    expect(ledger.hasRunningJob('anchor-one')).toBe(false)
  })

  test('bounds unacknowledged reports independently per job', () => {
    const ledger = createTrainJobLedger({ stateDir, now: () => 500 })
    for (let run = 0; run < 20; run += 1) {
      ledger.start('job-one', 'user-one')
      ledger.fail('job-one', `one-${run}`)
      ledger.start('job-two', 'user-two')
      ledger.fail('job-two', `two-${run}`)
    }

    const reports = ledger.reports()
    const one = reports.filter(report => report.jobId === 'job-one')
    const two = reports.filter(report => report.jobId === 'job-two')
    expect(one).toHaveLength(32)
    expect(two).toHaveLength(32)
    expect(one.filter(report => report.state === 'failed').map(report => report.error)).toEqual(
      Array.from({ length: 20 }, (_, index) => `one-${index}`),
    )
    expect(two.filter(report => report.state === 'failed').map(report => report.error)).toEqual(
      Array.from({ length: 20 }, (_, index) => `two-${index}`),
    )
  })

  test('boot reconciliation kills every live child and fails every nonterminal job', () => {
    const initial = createTrainJobLedger({ stateDir, now: () => 600 })
    initial.start('job-one', 'user-one')
    initial.recordChildPid('job-one', 41_001)
    initial.start('job-two', 'user-two')
    initial.setPhase('job-two', 'snapshotting')
    initial.setPhase('job-two', 'training')
    initial.setPhase('job-two', 'finalizing')
    initial.setPhase('job-two', 'cleanup')
    initial.recordChildPid('job-two', 41_002)
    initial.start('job-dead-child', 'user-three')
    initial.recordChildPid('job-dead-child', 41_003)
    const killed: number[] = []
    const afterBoot = createTrainJobLedger({
      stateDir,
      now: () => 700,
      isPidAlive: pid => pid !== 41_003,
      killPid: pid => {
        killed.push(pid)
        if (pid === 41_001) throw new Error('process disappeared during kill')
      },
    })

    afterBoot.reconcileAtBoot()

    expect(killed).toEqual([41_001, 41_002])
    for (const jobId of ['job-one', 'job-two', 'job-dead-child']) {
      expect(afterBoot.snapshot(jobId)).toMatchObject({
        phase: 'failed',
        error: 'gateway_restarted',
        completedAt: 700,
      })
    }
    const reportGenerations = afterBoot.reports().map(report => report.generation)
    afterBoot.reconcileAtBoot()
    expect(afterBoot.reports().map(report => report.generation)).toEqual(reportGenerations)
  })

  test('uses a private v3 ledger filename and abandons older ledgers unread', async () => {
    const trainDir = join(stateDir, 'train')
    await mkdir(trainDir, { recursive: true })
    await writeFile(join(trainDir, 'job-controller.json'), '{ abandoned and invalid')
    const ledger = createTrainJobLedger({ stateDir, now: () => 800 })

    expect(ledger.snapshot('old-job')).toBeNull()
    ledger.start('new-job', 'new-user')

    const ledgerPath = join(trainDir, 'job-ledger-v3.json')
    expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toMatchObject({
      version: 3,
      nextGeneration: 2,
      jobs: { 'new-job': { jobId: 'new-job', phase: 'preparing' } },
    })
    expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600)
    expect((await readdir(trainDir)).sort()).toEqual(['job-controller.json', 'job-ledger-v3.json'])

    const unsupported = JSON.parse(await readFile(ledgerPath, 'utf8'))
    unsupported.version = 1
    await writeFile(ledgerPath, JSON.stringify(unsupported))
    expect(() => createTrainJobLedger({ stateDir, now: () => 801 })).toThrow(
      'unsupported train job ledger version',
    )
  })

  test('acknowledges reports idempotently and retires only fully acknowledged terminal snapshots', () => {
    const first = createTrainJobLedger({ stateDir, now: () => 900 })
    first.start('job-one', 'user-one')
    first.fail('job-one', 'failed_once')
    first.start('job-two', 'user-two')

    first.acknowledge(['1', '1', 'unknown'])
    expect(first.reports().map(report => [report.generation, report.jobId])).toEqual([
      ['2', 'job-one'],
      ['3', 'job-two'],
    ])
    expect(first.snapshot('job-one')).not.toBeNull()

    first.acknowledge(['2'])
    expect(first.snapshot('job-one')).toBeNull()
    expect(first.snapshot('job-two')).toMatchObject({ phase: 'preparing' })

    const restarted = createTrainJobLedger({ stateDir, now: () => 901 })
    restarted.fail('job-two', 'failed_two')
    expect(restarted.reports().map(report => report.generation)).toEqual(['3', '4'])
  })

  test('rejects lifecycle operations outside the declared per-job state graph', () => {
    const phases: GatewayTrainJobPhase[] = [
      'preparing',
      'snapshotting',
      'training',
      'finalizing',
      'cleanup',
      'done',
      'failed',
    ]
    const nextPhase: Partial<Record<GatewayTrainJobPhase, GatewayTrainJobPhase>> = {
      preparing: 'snapshotting',
      snapshotting: 'training',
      training: 'finalizing',
      finalizing: 'cleanup',
    }

    for (const source of phases) {
      for (const target of phases) {
        const ledger = ledgerAtPhase(join(stateDir, `set-${source}-${target}`), source)
        const transition = () => ledger.setPhase('job-one', target)
        if (nextPhase[source] === target) expect(transition).not.toThrow()
        else expect(transition).toThrow(`invalid train job transition: ${source} -> ${target}`)
      }

      const complete = ledgerAtPhase(join(stateDir, `complete-${source}`), source)
      if (source === 'finalizing' || source === 'cleanup') {
        expect(() => complete.complete('job-one')).not.toThrow()
      } else {
        expect(() => complete.complete('job-one')).toThrow(
          `invalid train job transition: ${source} -> done`,
        )
      }

      const fail = ledgerAtPhase(join(stateDir, `fail-${source}`), source)
      if (source === 'done' || source === 'failed') {
        expect(() => fail.fail('job-one', 'failure')).toThrow(
          `invalid train job transition: ${source} -> failed`,
        )
      } else {
        expect(() => fail.fail('job-one', 'failure')).not.toThrow()
      }
    }

    const absent = createTrainJobLedger({ stateDir: join(stateDir, 'absent'), now: () => 1_000 })
    expect(() => absent.setPhase('missing', 'snapshotting')).toThrow('unknown train job: missing')
    expect(() => absent.complete('missing')).toThrow('unknown train job: missing')
    expect(() => absent.fail('missing', 'failure')).toThrow('unknown train job: missing')
  })

  test('durably records child pids without emitting reports', () => {
    const ledger = createTrainJobLedger({ stateDir, now: () => 1_100 })
    ledger.start('job-one', 'user-one')
    ledger.recordChildPid('job-one', 42_424)

    const restarted = createTrainJobLedger({ stateDir, now: () => 1_101 })
    expect(restarted.snapshot('job-one')).toMatchObject({ childPid: 42_424, phase: 'preparing' })
    expect(restarted.reports().map(report => report.generation)).toEqual(['1'])
    expect(() => restarted.recordChildPid('job-one', 0)).toThrow(
      'trainer child pid must be positive',
    )
  })

  test('derives deterministic record slugs from the job id and UTC date', () => {
    const atNoon = Date.parse('2026-07-15T12:00:00.000Z')
    const first = createTrainJobLedger({ stateDir: join(stateDir, 'first'), now: () => atNoon })
    const same = createTrainJobLedger({ stateDir: join(stateDir, 'same'), now: () => atNoon })
    const otherJob = createTrainJobLedger({
      stateDir: join(stateDir, 'other-job'),
      now: () => atNoon,
    })
    const otherDate = createTrainJobLedger({
      stateDir: join(stateDir, 'other-date'),
      now: () => Date.parse('2026-07-16T00:00:00.000Z'),
    })

    const slug = first.start('Job / One', 'user-one').recordSlug
    expect(same.start('Job / One', 'different-user').recordSlug).toBe(slug)
    expect(slug).toMatch(/^train-2026-07-15-job-one-[a-f0-9]{8}$/)
    expect(otherJob.start('Job / Two', 'user-one').recordSlug).not.toBe(slug)
    expect(otherDate.start('Job / One', 'user-one').recordSlug).not.toBe(slug)
  })

  test('boot reconciliation sweeps only legacy train staging directories', async () => {
    const stagingRoot = join(stateDir, 'train-staging')
    await mkdir(join(stagingRoot, 'duet-train-old-one'), { recursive: true })
    await mkdir(join(stagingRoot, 'keep-me'), { recursive: true })
    const ledger = createTrainJobLedger({ stateDir, now: () => 1_200 })

    ledger.reconcileAtBoot()

    await expect(stat(join(stagingRoot, 'duet-train-old-one'))).rejects.toThrow()
    expect((await stat(join(stagingRoot, 'keep-me'))).isDirectory()).toBe(true)
    expect(ledger.reports()).toEqual([])
  })
})

function ledgerAtPhase(stateDir: string, target: GatewayTrainJobPhase) {
  const ledger = createTrainJobLedger({ stateDir, now: () => 1_000 })
  ledger.start('job-one', 'user-one')
  if (target === 'failed') {
    ledger.fail('job-one', 'failure')
    return ledger
  }
  for (const phase of ['snapshotting', 'training', 'finalizing', 'cleanup'] as const) {
    if (target === 'preparing') break
    ledger.setPhase('job-one', phase)
    if (target === phase) break
  }
  if (target === 'done') ledger.complete('job-one')
  return ledger
}

describe('failed-job corpus cleanup', () => {
  test('fail removes the job snapshot directory exactly as complete does', async () => {
    const ledger = createTrainJobLedger({ stateDir, now: () => 1_700_000_000_000 })
    ledger.start('job-fail', 'user-1')
    const jobDir = join(stateDir, 'train', 'jobs', 'job-fail')
    await mkdir(jobDir, { recursive: true })
    await writeFile(join(jobDir, 'corpus.md'), 'staged source')

    ledger.fail('job-fail', 'synthesis exploded')

    await expect(stat(jobDir)).rejects.toThrow()
    expect(ledger.snapshot('job-fail')?.phase).toBe('failed')
    expect(ledger.snapshot('job-fail')?.error).toBe('synthesis exploded')
  })
})
