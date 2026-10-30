#!/usr/bin/env bun

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { countConvexExportRows, listConvexExportEntries } from './convex-export-snapshot'

export const FILE_ACTIVITY_CUTOVER_DEPLOYMENTS = {
  staging: 'chatty-llama-452',
  production: 'elated-hippopotamus-235',
} as const
export type FileActivityCutoverEnvironment = keyof typeof FILE_ACTIVITY_CUTOVER_DEPLOYMENTS

export const FILE_ACTIVITY_CUTOVER_TABLES = [
  'fileEvents',
  'fileEventScopes',
  'fileAccess',
  'fileEventBatches',
  'fileEventProjectionState',
  'fileActivityNamespaces',
  'fileActivityEntities',
  'fileActivityBindings',
] as const

export type FileActivityCutoverTable = (typeof FILE_ACTIVITY_CUTOVER_TABLES)[number]

export interface FileActivityCutoverBackend {
  preCutoverCount(table: FileActivityCutoverTable): Promise<number>
  replaceWithEmpty(table: FileActivityCutoverTable): Promise<void>
  isEmpty(table: FileActivityCutoverTable): Promise<boolean>
}

export interface FileActivityCutoverTableResult {
  table: FileActivityCutoverTable
  before: number
  deleted: number
  emptyAfter: boolean
}

export class FileActivityCutoverPartialFailure extends Error {
  constructor(
    readonly table: FileActivityCutoverTable,
    readonly completed: FileActivityCutoverTableResult[],
    options: ErrorOptions,
  ) {
    super(
      `file activity reset stopped at ${table} after ${completed.length} table(s): ${options.cause instanceof Error ? options.cause.message : String(options.cause)}`,
      options,
    )
  }
}

export function assertStagingCutoverTarget(args: {
  environment: string
  deployment: string
  confirmedDeployment: string
}): string {
  if (args.environment !== 'staging' && args.environment !== 'production') {
    throw new Error('DUET_CUTOVER_ENV must be staging or production')
  }
  const expected = FILE_ACTIVITY_CUTOVER_DEPLOYMENTS[args.environment]
  if (args.deployment !== expected) {
    throw new Error(
      `expected ${args.environment} deployment ${expected}, received ${args.deployment}`,
    )
  }
  if (args.confirmedDeployment !== args.deployment) {
    throw new Error('deployment confirmation does not match CONVEX_DEPLOYMENT')
  }
  return args.deployment
}

export async function inspectFileActivityTables(
  backend: FileActivityCutoverBackend,
): Promise<FileActivityCutoverTableResult[]> {
  const results: FileActivityCutoverTableResult[] = []
  for (const table of FILE_ACTIVITY_CUTOVER_TABLES) {
    const before = await backend.preCutoverCount(table)
    results.push({ table, before, deleted: 0, emptyAfter: before === 0 })
  }
  return results
}

export async function resetFileActivityTables(
  backend: FileActivityCutoverBackend,
): Promise<FileActivityCutoverTableResult[]> {
  const results: FileActivityCutoverTableResult[] = []
  for (const table of FILE_ACTIVITY_CUTOVER_TABLES) {
    try {
      const before = await backend.preCutoverCount(table)
      await backend.replaceWithEmpty(table)
      if (!(await backend.isEmpty(table)))
        throw new Error(`${table} still contains rows after reset`)
      results.push({ table, before, deleted: before, emptyAfter: true })
    } catch (cause) {
      throw new FileActivityCutoverPartialFailure(table, results, { cause })
    }
  }
  return results
}

class ConvexCliCutoverBackend implements FileActivityCutoverBackend {
  private snapshotCounts: Map<FileActivityCutoverTable, number> | null = null

  constructor(
    private readonly backendDir: string,
    private readonly deployment: string,
    private readonly emptyFile: string,
    private readonly snapshotFile: string,
  ) {}

  async preCutoverCount(table: FileActivityCutoverTable): Promise<number> {
    if (this.snapshotCounts === null) this.snapshotCounts = await this.exportCounts()
    return this.snapshotCounts.get(table) ?? 0
  }

  async isEmpty(table: FileActivityCutoverTable): Promise<boolean> {
    const output = await this.run([
      'data',
      table,
      '--limit',
      '1',
      '--format',
      'jsonLines',
      '--deployment',
      this.deployment,
    ])
    return output.trim() === ''
  }

  async replaceWithEmpty(table: FileActivityCutoverTable): Promise<void> {
    await this.run([
      'import',
      this.emptyFile,
      '--table',
      table,
      '--replace',
      '--yes',
      '--deployment',
      this.deployment,
    ])
  }

  private async exportCounts(): Promise<Map<FileActivityCutoverTable, number>> {
    await this.run(['export', '--path', this.snapshotFile, '--deployment', this.deployment])
    const counts = new Map<FileActivityCutoverTable, number>()
    const entries = await listConvexExportEntries(this.snapshotFile)
    for (const table of FILE_ACTIVITY_CUTOVER_TABLES) {
      const entry = `${table}/documents.jsonl`
      counts.set(
        table,
        entries.has(entry) ? await countConvexExportRows(this.snapshotFile, entry) : 0,
      )
    }
    return counts
  }

  private async run(args: string[]): Promise<string> {
    const env = { ...process.env }
    // The encrypted staging environment carries the CI deploy key, while
    // import/data target selection uses the operator's authenticated CLI.
    delete env.CONVEX_DEPLOY_KEY
    const child = Bun.spawn(['bunx', 'convex', ...args], {
      cwd: this.backendDir,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) {
      throw new Error(`convex ${args[0]} failed (${exitCode}): ${stderr.trim()}`)
    }
    return stdout
  }
}

interface CliOptions {
  execute: boolean
  confirmedDeployment?: string
  admissionQuiesced: boolean
  discardSealedRetries: boolean
  snapshotPath?: string
}

export function parseCutoverCliOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    admissionQuiesced: false,
    discardSealedRetries: false,
  }
  for (const argument of args) {
    if (argument === '--execute') options.execute = true
    else if (argument === '--admission-quiesced') options.admissionQuiesced = true
    else if (argument === '--discard-sealed-retries') options.discardSealedRetries = true
    else if (argument.startsWith('--confirm-deployment=')) {
      options.confirmedDeployment = argument.slice('--confirm-deployment='.length)
    } else if (argument.startsWith('--snapshot-path=')) {
      options.snapshotPath = path.resolve(argument.slice('--snapshot-path='.length))
    } else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

async function main(): Promise<void> {
  const options = parseCutoverCliOptions(process.argv.slice(2))
  const deployment = requiredEnvironment('CONVEX_DEPLOYMENT')
  const environment = requiredEnvironment('DUET_CUTOVER_ENV')
  if (options.execute) {
    if (options.confirmedDeployment === undefined) {
      throw new Error('--execute requires --confirm-deployment=<exact deployment>')
    }
    assertStagingCutoverTarget({
      environment,
      deployment,
      confirmedDeployment: options.confirmedDeployment,
    })
    if (!options.admissionQuiesced) {
      throw new Error('--execute requires --admission-quiesced')
    }
    if (!options.discardSealedRetries) {
      throw new Error('--execute requires --discard-sealed-retries')
    }
    if (options.snapshotPath === undefined) {
      throw new Error('--execute requires --snapshot-path=<unoccupied zip path>')
    }
  } else {
    assertStagingCutoverTarget({ environment, deployment, confirmedDeployment: deployment })
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'duet-file-activity-cutover-'))
  const emptyFile = path.join(temporaryDirectory, 'empty.json')
  const snapshotFile = options.snapshotPath ?? path.join(temporaryDirectory, 'pre-cutover.zip')
  try {
    await Bun.write(emptyFile, '[]\n')
    const backend = new ConvexCliCutoverBackend(
      path.resolve(import.meta.dir, '..'),
      deployment,
      emptyFile,
      snapshotFile,
    )
    let results: FileActivityCutoverTableResult[]
    try {
      results = options.execute
        ? await resetFileActivityTables(backend)
        : await inspectFileActivityTables(backend)
    } catch (error) {
      if (error instanceof FileActivityCutoverPartialFailure) {
        console.error(`pre-cutover recovery snapshot: ${snapshotFile}`)
        for (const result of error.completed) {
          console.error(`${result.table}: ${result.deleted} deleted and verified empty`)
        }
        console.error(`${error.table}: not verified; later tables were not attempted`)
      }
      throw error
    }
    console.log(`file activity cutover ${options.execute ? 'reset' : 'plan'}: ${deployment}`)
    for (const result of results) {
      console.log(
        `${result.table}: ${options.execute ? `${result.deleted} deleted` : `${result.before} rows`}`,
      )
    }
    if (options.execute) console.log(`pre-cutover recovery snapshot: ${snapshotFile}`)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function requiredEnvironment(name: 'CONVEX_DEPLOYMENT' | 'DUET_CUTOVER_ENV'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

if (import.meta.main) {
  await main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
