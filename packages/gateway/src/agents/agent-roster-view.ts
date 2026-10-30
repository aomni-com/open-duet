import { join } from 'node:path'

import {
  agentIsLocked,
  gatewayAgentCandidate,
  groupAgentsByParent,
  resolveAgentConfig,
  type AgentRelationship,
  type GatewayAgentConfig,
  type GatewayAgentRow,
} from '@repo/contract'

import { readContainedDriveFile } from './contained-drive-file'

/** Whose roster to read: the drive root, or one agent by id. */
export type AgentRosterScope = { kind: 'root' } | { kind: 'agent'; agentId: string }

export interface AgentRosterRow {
  slug: string
  name: string
  /** Absent for root, which has no folder of its own. */
  anchorPath?: string
  /** D4: declared onboarding, not yet completed. Listed and flagged, never hidden. */
  locked: boolean
  relationship: AgentRelationship
}

export interface ReachableAgentRoster {
  /**
   * Self, then the agent above, then peers, then the agents below — one list,
   * because the relationship is a verdict this function owns rather than a
   * shape its readers decode.
   *
   * `self` rides here so a composer can name the agent it is talking to. It is
   * never a delegation target: an agent that handed itself work would send it
   * to its own default session and then wait for a turn it cannot end.
   */
  rows: readonly AgentRosterRow[]
}

/**
 * Who a session can reach: its parent (root included), its siblings, and its
 * direct children. The sole owner of that projection — hierarchy, lock verdict,
 * relationship and order. Everything that shows a session its colleagues reads
 * this one function, so two surfaces can never describe two different rosters.
 *
 * There is no row cap. `MAX_AGENTS_PER_WORKSPACE` already bounds the roster at
 * its source, and a cap here could only hide colleagues from a list with no
 * room to say it had.
 *
 * `undefined` means there is no answer, which is not the answer "nobody":
 * either no roster has arrived yet, or the scope names an agent this roster
 * does not carry (disabled, or the roster is stale). Neither may be flattened
 * into an empty roster — that is how a cold gateway comes to state, as fact,
 * that a workspace has no agents.
 */
export function readReachableAgentRoster(args: {
  members: readonly GatewayAgentConfig[] | undefined
  scope: AgentRosterScope
  driveDir: string
}): ReachableAgentRoster | undefined {
  const { members, scope, driveDir } = args
  if (members === undefined) return undefined
  const rows = members.filter((member): member is GatewayAgentRow => member.kind === 'agent')
  if (scope.kind === 'agent' && !rows.some(row => row.agentId === scope.agentId)) return undefined

  const hierarchy = groupAgentsByParent(rows.map(gatewayAgentCandidate))
  // The lock verdict needs the agent's own agent.json, which the roster cannot
  // carry — it is drive content. Fail-open on a missing or malformed file, and
  // refuse a symlink that escapes the drive, exactly like the authored prompts.
  const toRow = (row: GatewayAgentRow, relationship: AgentRelationship): AgentRosterRow => ({
    slug: row.slug,
    name: row.name,
    anchorPath: row.anchorPath,
    locked: agentIsLocked(
      { onboardedAt: row.onboardedAt },
      resolveAgentConfig(
        readContainedDriveFile(driveDir, join(driveDir, row.anchorPath, 'agent.json')),
      ),
    ),
    relationship,
  })
  const bySlug = (left: AgentRosterRow, right: AgentRosterRow) =>
    left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0
  const group = (
    candidates: readonly GatewayAgentRow[],
    relationship: AgentRelationship,
  ): AgentRosterRow[] => candidates.map(row => toRow(row, relationship)).sort(bySlug)

  const rootMember = members.find(member => member.kind === 'root')
  if (scope.kind === 'root') {
    // Root answers to nobody and has no peers, so its family is its children
    // and itself. It has no `agents` row either, hence the synthetic self.
    return {
      rows: [
        {
          slug: rootMember?.slug ?? 'root',
          name: rootMember?.name ?? 'Duet',
          locked: false,
          relationship: 'self',
        },
        ...group(hierarchy.rootChildren, 'child'),
      ],
    }
  }

  // The scope resolved above, so the row is known to exist: an agent scope the
  // roster does not carry was rejected at the top.
  const selfRow = rows.find(row => row.agentId === scope.agentId)!
  // A nested agent's parent is its nearest enclosing agent; an agent no agent
  // encloses answers to root, which wears the workspace's own name.
  // A roster carrying no root member yields no parent at all, deliberately: the
  // self row may fall back to a default name because a session must know who it
  // is, but inventing a parent teaches an agent to report to one that does not
  // exist. Hence zero-or-one rows rather than a fallback.
  const enclosing = hierarchy.parentByAgentId.get(scope.agentId)
  const parentRows: readonly AgentRosterRow[] =
    enclosing !== undefined
      ? [toRow(enclosing, 'parent')]
      : rootMember !== undefined
        ? [
            {
              slug: rootMember.slug,
              name: rootMember.name,
              locked: false,
              relationship: 'parent' as const,
            },
          ]
        : []

  /* Peers under the same parent. An enclosed agent reads its parent's children;
     a top-level agent cannot, because its parent is the SYNTHETIC root member —
     no agentId, no entry in the map — so its peers are the agents no agent
     encloses. Both branches drop self by hand: `groupAgentsByParent` excludes an
     agent from its own parent search, not from its parent's child list. */
  const siblingPool =
    enclosing !== undefined
      ? (hierarchy.childrenByAgentId.get(enclosing.agentId) ?? [])
      : hierarchy.rootChildren

  return {
    rows: [
      toRow(selfRow, 'self'),
      ...parentRows,
      ...group(
        siblingPool.filter(row => row.agentId !== scope.agentId),
        'sibling',
      ),
      ...group(hierarchy.childrenByAgentId.get(scope.agentId) ?? [], 'child'),
    ],
  }
}
