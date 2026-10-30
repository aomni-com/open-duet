import type { Agent } from '@repo/contract'

/**
 * The ⋯ menu vocabulary: which actions an agent offers, and what it is called.
 *
 * Pure types and tables. Behavior lives in `../agents/agent-actions.tsx`, and
 * the surfaces that render this are the detail canvas's header and — should one
 * return — any card that lists agents.
 *
 * This module used to describe a roster rail as well. That rail no longer
 * exists; the live Agents surface is the knowledge map. Its projection and card
 * type were deleted rather than left to imply a surface a reader would then go
 * looking for.
 */

/**
 * Which actions an agent offers, by what kind of agent it is.
 *
 * `agent` is one you own; `replica` is shared in to you; `default` is Duet, the
 * drive root.
 */
export type AgentMenuShape = 'default' | 'agent' | 'replica'

export type AgentRosterMenuAction =
  | 'open-in-drive'
  | 'rename'
  | 'share'
  | 'redo-onboarding'
  | 'delete'

// A shared-in (replica) agent is read-only at the origin: its menu never offers
// rename or delete, though its workspace copy can reset onboarding. Eligibility
// mirrors the backend guard (`sourceShareId`/`sourceAgentId`) rather than
// re-deriving it. The default agent has no row, so it never reaches this.
export function agentMenuShape(agent: Agent): 'agent' | 'replica' {
  return agent.sourceShareId !== undefined || agent.sourceAgentId !== undefined
    ? 'replica'
    : 'agent'
}

// The D21/L8 three-shape table, the single source of which actions each menu
// exposes. `replica` (shared-in, read-only at the origin) never lists rename or
// delete, but can reset its own onboarding. `default` (the drive root) can be
// renamed — its name is the workspace's `duetName` rather than an agent row —
// but has no folder of its own to delete or share, and nothing to onboard.
export const AGENT_MENU_ITEMS: Record<AgentMenuShape, readonly AgentRosterMenuAction[]> = {
  default: ['rename', 'open-in-drive'],
  agent: ['open-in-drive', 'rename', 'share', 'redo-onboarding', 'delete'],
  replica: ['open-in-drive', 'share', 'redo-onboarding'],
}

// Each action's message-key suffix, shared so every surface labels the same
// action identically. Consumers resolve it under their own `t` namespace — same
// key, different scope — so wording stays owned per surface while the
// action↔key mapping has one home.
export const AGENT_MENU_ACTION_KEYS: Record<AgentRosterMenuAction, string> = {
  'open-in-drive': 'openInDrive',
  rename: 'rename',
  share: 'share',
  'redo-onboarding': 'redoOnboarding',
  delete: 'delete',
}
