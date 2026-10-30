import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RoutingTable } from '@repo/agent/model-routing/table'
import { buildManagedRoutingTable } from '@repo/contract'

import { writeAtomicJson } from '../atomic-json'
import routing from './routing-table.json'

/** The complete routing table travels in the gateway bundle and its release hash. */
export const MANAGED_ROUTING_TABLE = buildManagedRoutingTable(routing.table as RoutingTable)

/** Refresh gateway-owned config at the actual spawn cwd, ahead of the agent's loader. */
export function prepareRoutingConfig(cwd: string): void {
  const path = join(cwd, '.duet', 'models.json')
  const contents = `${JSON.stringify(MANAGED_ROUTING_TABLE)}\n`
  try {
    if (readFileSync(path, 'utf8') === contents) return
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  writeAtomicJson(path, MANAGED_ROUTING_TABLE)
}
