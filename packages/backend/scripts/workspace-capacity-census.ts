#!/usr/bin/env bun

import path from 'node:path'

import { z } from 'zod'

import {
  MAX_ACTIVE_SHARES_PER_WORKSPACE,
  MAX_APPS_PER_WORKSPACE,
  MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE,
} from '@repo/contract'

import { listConvexExportEntries, readConvexExportRows } from './convex-export-snapshot'

const CAPACITIES = {
  nonOrphanedAnchors: MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE,
  apps: MAX_APPS_PER_WORKSPACE,
  activeShares: MAX_ACTIVE_SHARES_PER_WORKSPACE,
} as const

type CapacityResource = keyof typeof CAPACITIES

const capacityCountsSchema = z.object({
  nonOrphanedAnchors: z.number().int().nonnegative(),
  apps: z.number().int().nonnegative(),
  activeShares: z.number().int().nonnegative(),
})

export const WorkspaceCapacityCensusReportSchema = z.object({
  snapshotPath: z.string().min(1),
  tableRows: z.object({
    anchors: z.number().int().nonnegative(),
    apps: z.number().int().nonnegative(),
    shares: z.number().int().nonnegative(),
  }),
  workspacesChecked: z.number().int().nonnegative(),
  limits: z.object({
    nonOrphanedAnchors: z.literal(MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE),
    apps: z.literal(MAX_APPS_PER_WORKSPACE),
    activeShares: z.literal(MAX_ACTIVE_SHARES_PER_WORKSPACE),
  }),
  maximumObserved: capacityCountsSchema,
  violations: z.array(
    z.object({
      workspaceId: z.string().min(1),
      resource: z.enum(['nonOrphanedAnchors', 'apps', 'activeShares']),
      count: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
    }),
  ),
})
export type WorkspaceCapacityCensusReport = z.infer<typeof WorkspaceCapacityCensusReportSchema>

export async function censusWorkspaceCapacities(
  snapshotPath: string,
): Promise<WorkspaceCapacityCensusReport> {
  const entries = await listConvexExportEntries(snapshotPath)
  const counts = new Map<string, Record<CapacityResource, number>>()
  const tableRows = { anchors: 0, apps: 0, shares: 0 }

  await visitTable('anchors', row => {
    tableRows.anchors += 1
    const document = asDocument(row, 'anchors')
    if (document.state === 'orphaned') return
    if (document.state !== 'active' && document.state !== 'broken') {
      throw new Error('anchors snapshot row has an invalid state')
    }
    increment(requireString(document, 'workspaceId', 'anchors'), 'nonOrphanedAnchors')
  })
  await visitTable('apps', row => {
    tableRows.apps += 1
    increment(requireString(asDocument(row, 'apps'), 'workspaceId', 'apps'), 'apps')
  })
  await visitTable('shares', row => {
    tableRows.shares += 1
    const document = asDocument(row, 'shares')
    if (document.state !== 'active') return
    const participants = new Set([
      requireString(document, 'fromWorkspaceId', 'shares'),
      requireString(document, 'toWorkspaceId', 'shares'),
    ])
    for (const workspaceId of participants) increment(workspaceId, 'activeShares')
  })

  const maximumObserved = { nonOrphanedAnchors: 0, apps: 0, activeShares: 0 }
  const violations: WorkspaceCapacityCensusReport['violations'] = []
  for (const [workspaceId, workspaceCounts] of counts) {
    for (const resource of Object.keys(CAPACITIES) as CapacityResource[]) {
      maximumObserved[resource] = Math.max(maximumObserved[resource], workspaceCounts[resource])
      if (workspaceCounts[resource] > CAPACITIES[resource]) {
        violations.push({
          workspaceId,
          resource,
          count: workspaceCounts[resource],
          limit: CAPACITIES[resource],
        })
      }
    }
  }
  violations.sort((left, right) =>
    left.workspaceId === right.workspaceId
      ? left.resource.localeCompare(right.resource)
      : left.workspaceId.localeCompare(right.workspaceId),
  )

  return WorkspaceCapacityCensusReportSchema.parse({
    snapshotPath: path.resolve(snapshotPath),
    tableRows,
    workspacesChecked: counts.size,
    limits: CAPACITIES,
    maximumObserved,
    violations,
  })

  async function visitTable(
    table: keyof typeof tableRows,
    visit: (row: unknown) => void,
  ): Promise<void> {
    const entry = `${table}/documents.jsonl`
    if (!entries.has(entry)) return
    for await (const row of readConvexExportRows(snapshotPath, entry)) visit(row)
  }

  function increment(workspaceId: string, resource: CapacityResource): void {
    let workspaceCounts = counts.get(workspaceId)
    if (workspaceCounts === undefined) {
      workspaceCounts = { nonOrphanedAnchors: 0, apps: 0, activeShares: 0 }
      counts.set(workspaceId, workspaceCounts)
    }
    workspaceCounts[resource] += 1
  }
}

export function assertWorkspaceCapacityCensusPasses(report: WorkspaceCapacityCensusReport): void {
  if (report.violations.length > 0) throw new Error('workspace capacity census failed')
}

function asDocument(value: unknown, table: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${table} snapshot row must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(document: Record<string, unknown>, field: string, table: string): string {
  const value = document[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${table} snapshot row requires ${field}`)
  }
  return value
}

async function main(): Promise<void> {
  const argument = process.argv.slice(2).find(value => value.startsWith('--snapshot='))
  if (argument === undefined || process.argv.length !== 3) {
    throw new Error('usage: workspace-capacity-census --snapshot=<Convex export zip>')
  }
  const report = await censusWorkspaceCapacities(argument.slice('--snapshot='.length))
  console.log(JSON.stringify(report, null, 2))
  assertWorkspaceCapacityCensusPasses(report)
}

if (import.meta.main) {
  await main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
