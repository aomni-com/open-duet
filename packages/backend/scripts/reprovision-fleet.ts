#!/usr/bin/env bun

import path from 'node:path'

import type { Doc } from '../convex/_generated/dataModel'

export interface FleetWorkspace {
  workspaceId: string
  slug: string
  status: Doc<'workspaces'>['status']
  vmName?: string
  imageRef?: string
}

export interface FleetBackup {
  status: Doc<'workspaceBackups'>['status']
  completeness?: Doc<'workspaceBackups'>['completeness']
  error?: { message: string }
  lifecycle?: {
    status: NonNullable<Doc<'workspaceBackups'>['lifecycle']>['status']
    reason?: string
  }
}

export interface FleetBackend {
  list(): Promise<FleetWorkspace[]>
  backup(args: { workspaceId: string; backupId: string }): Promise<FleetBackup | null>
  reprovision(args: { workspaceId: string; imageRef: string; discardState?: boolean }): Promise<
    | { status: 'provisioning' }
    | { status: 'backup_pending'; backupId: string }
    | {
        status: 'deferred'
        reason: 'active_workspace_work'
        activeAgentSessions: number
        activeTrainJobs: number
      }
  >
}

export interface ReprovisionFleetOptions {
  targetImageRef: string
  concurrency?: number
  timeoutMs?: number
  pollIntervalMs?: number
  dryRun?: boolean
  discardState?: boolean
  log?: (message: string) => void
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

export interface ReprovisionFleetResult {
  planned: FleetWorkspace[]
  completed: FleetWorkspace[]
}

export function selectFleetCandidates(
  workspaces: FleetWorkspace[],
  targetImageRef: string,
): FleetWorkspace[] {
  return workspaces.filter(
    workspace =>
      (workspace.status === 'active' || workspace.status === 'unhealthy') &&
      workspace.vmName !== undefined &&
      workspace.imageRef !== targetImageRef,
  )
}

export async function reprovisionFleet(
  backend: FleetBackend,
  options: ReprovisionFleetOptions,
): Promise<ReprovisionFleetResult> {
  const concurrency = positiveInteger(options.concurrency ?? 3, 'concurrency')
  const timeoutMs = positiveInteger(options.timeoutMs ?? 30 * 60_000, 'timeoutMs')
  const pollIntervalMs = nonNegativeInteger(options.pollIntervalMs ?? 5_000, 'pollIntervalMs')
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (milliseconds => Bun.sleep(milliseconds))
  const log = options.log ?? (() => undefined)
  const planned = selectFleetCandidates(await backend.list(), options.targetImageRef)

  if (options.dryRun === true || planned.length === 0) return { planned, completed: [] }

  const completed = await parallelMap(planned, concurrency, async workspace => {
    const deadline = now() + timeoutMs
    let deferredMessage = ''
    let admitted = false
    let backupId: string | undefined

    while (now() <= deadline) {
      let recoveryComplete = backupId === undefined
      if (backupId) {
        let backup: FleetBackup | null
        try {
          backup = await backend.backup({ workspaceId: workspace.workspaceId, backupId })
        } catch (error) {
          throw new Error(
            `${workspace.slug}: backup ${backupId} status unavailable: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
        recoveryComplete = backup?.lifecycle?.status === 'complete'
        if (!backup) throw new Error(`${workspace.slug}: backup ${backupId} disappeared`)
        if (
          backup.status === 'failed' ||
          backup.status === 'deleting' ||
          ['failed', 'deferred', 'abandoned'].includes(backup.lifecycle?.status ?? '') ||
          (backup.status === 'ready' && backup.completeness !== 'complete')
        ) {
          const reason =
            backup.error?.message ??
            backup.lifecycle?.reason ??
            (backup.completeness === 'partial' ? 'backup_partial' : backup.status)
          throw new Error(`${workspace.slug}: backup ${backupId} failed: ${reason}`)
        }
      }
      const current = (await backend.list()).find(row => row.workspaceId === workspace.workspaceId)
      if (current === undefined) throw new Error(`${workspace.slug}: workspace disappeared`)
      if (
        recoveryComplete &&
        current.status === 'active' &&
        current.imageRef === options.targetImageRef &&
        current.vmName !== undefined
      ) {
        log(`${workspace.slug}: active on ${current.vmName}`)
        return current
      }
      if (!admitted && (current.status === 'active' || current.status === 'unhealthy')) {
        let started: Awaited<ReturnType<FleetBackend['reprovision']>>
        try {
          started = await backend.reprovision({
            workspaceId: current.workspaceId,
            imageRef: options.targetImageRef,
            ...(options.discardState === true ? { discardState: true } : {}),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`${workspace.slug}: ${message}`, { cause: error })
        }
        if (started.status === 'deferred') {
          const message = `${workspace.slug}: waiting for ${started.activeAgentSessions} agent session(s) and ${started.activeTrainJobs} train job(s)`
          if (message !== deferredMessage) log(message)
          deferredMessage = message
        } else if (started.status === 'backup_pending') {
          admitted = true
          backupId = started.backupId
          log(`${workspace.slug}: capturing backup ${backupId} before reprovision`)
        } else {
          admitted = true
          log(`${workspace.slug}: reprovision scheduled from ${workspace.vmName}`)
        }
      } else if (
        current.status !== 'provisioning' &&
        current.status !== 'active' &&
        !(backupId && current.status === 'unhealthy')
      ) {
        throw new Error(`${workspace.slug}: became ${current.status} during reprovision`)
      }
      await sleep(pollIntervalMs)
    }
    throw new Error(
      `${workspace.slug}: timed out waiting for the target image${backupId ? ` (backup ${backupId})` : ''}`,
    )
  })

  return { planned, completed }
}

async function parallelMap<T, R>(
  values: T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  const failures: unknown[] = []
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++
        try {
          results[index] = await work(values[index]!)
        } catch (error) {
          failures.push(error)
        }
      }
    }),
  )
  if (failures.length > 0) {
    const messages = failures.map(error => (error instanceof Error ? error.message : String(error)))
    throw new AggregateError(failures, messages.join('; '))
  }
  return results
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

interface CliOptions {
  dryRun: boolean
  discardState: boolean
  concurrency: number
  timeoutMs: number
}

class ConvexCliFleetBackend implements FleetBackend {
  constructor(
    private readonly backendDir: string,
    private readonly internalKey: string,
  ) {}

  list(): Promise<FleetWorkspace[]> {
    return this.runJson<FleetWorkspace[]>([
      'run',
      '--inline-query',
      `const rows = await ctx.db.query("workspaces").take(1001);
       if (rows.length > 1000) throw new Error("Fleet inventory exceeds the 1000-workspace operator limit");
       return rows
         .filter(row => row.status !== "deleted" && row.status !== "retired")
         .map(({ _id, slug, status, vmName, imageRef }) => ({
           workspaceId: _id, slug, status, vmName, imageRef
         }));`,
    ])
  }

  reprovision(args: { workspaceId: string; imageRef: string; discardState?: boolean }) {
    return this.runJson<Awaited<ReturnType<FleetBackend['reprovision']>>>([
      'run',
      'domains/workspaces/lifecycle:requestReprovision',
      JSON.stringify({ internalKey: this.internalKey, ...args }),
    ])
  }

  backup(args: { workspaceId: string; backupId: string }): Promise<FleetBackup | null> {
    return this.runJson<FleetBackup | null>([
      'run',
      'domains/workspaceBackups/jobs:get',
      JSON.stringify({ internalKey: this.internalKey, ...args }),
    ])
  }

  private async runJson<T>(args: string[]): Promise<T> {
    const child = Bun.spawn(['bunx', 'convex', ...args], {
      cwd: this.backendDir,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 60_000)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (timedOut) throw new Error('Convex command timed out after 60 seconds')
      if (exitCode !== 0) {
        throw new Error(
          `convex ${args[0]} failed (${exitCode}): ${stderr.trim().replaceAll(this.internalKey, '[redacted]')}`,
        )
      }
      return JSON.parse(stdout.trim() === '' ? 'null' : stdout) as T
    } finally {
      clearTimeout(timer)
    }
  }
}

function parseCliOptions(args: string[]): CliOptions {
  let dryRun = false
  let discardState = false
  let concurrency = 3
  let timeoutMs = 30 * 60_000
  for (const argument of args) {
    if (argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (argument === '--discard-state') {
      discardState = true
      continue
    }
    if (argument.startsWith('--concurrency=')) {
      concurrency = positiveInteger(Number(argument.slice('--concurrency='.length)), 'concurrency')
      continue
    }
    if (argument.startsWith('--timeout-minutes=')) {
      const minutes = Number(argument.slice('--timeout-minutes='.length))
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error('timeout-minutes must be positive')
      }
      timeoutMs = Math.round(minutes * 60_000)
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  return { dryRun, discardState, concurrency, timeoutMs }
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2))
  const environment = requiredEnv('DUET_FLEET_ENV')
  const deployment = requiredEnv('CONVEX_DEPLOYMENT')
  const targetImageRef = requiredEnv('DUET_VM_IMAGE_REF')
  if (!/^ghcr\.io\/aomni-com\/duet-vm-image@sha256:[a-f0-9]{64}$/.test(targetImageRef)) {
    throw new Error('DUET_VM_IMAGE_REF must be the immutable Duet GHCR digest')
  }
  const backend = new ConvexCliFleetBackend(
    path.resolve(import.meta.dir, '..'),
    requiredEnv('DUET_API_INTERNAL_KEY'),
  )
  console.log(
    `${environment} fleet (${deployment}): ${options.dryRun ? 'planning' : 'reprovisioning'} to ${targetImageRef}`,
  )
  const result = await reprovisionFleet(backend, {
    targetImageRef,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    dryRun: options.dryRun,
    discardState: options.discardState,
    log: message => console.log(message),
  })
  if (result.planned.length === 0) {
    console.log(`${environment} fleet: every attached live VM already uses the target image`)
    return
  }
  if (options.dryRun) {
    for (const workspace of result.planned) {
      console.log(`${workspace.slug}: ${workspace.vmName} (${workspace.status})`)
    }
    console.log(`${environment} fleet: ${result.planned.length} VM(s) would be reprovisioned`)
    return
  }
  console.log(`${environment} fleet: ${result.completed.length}/${result.planned.length} complete`)
}

if (import.meta.main) await main()
