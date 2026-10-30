import type { Agent, App } from '@repo/contract'

// One status vocabulary shared by apps and agents so their dot tints and pills
// cannot drift. The table below is shared; precedence is per-entity — each
// entity has its own projector and decides which of these values it can reach.
export type DisplayStatus =
  | 'reconciled'
  | 'reconciling'
  | 'failed'
  | 'broken'
  | 'disabled'
  | 'shared'

// Apps never project 'shared': an app carrying a share origin still renders as
// its runtime says. Only agents surface the replica state as a pill.
export type AppDisplayStatus = Exclude<DisplayStatus, 'shared'>
export type AgentDisplayStatus = 'reconciled' | 'broken' | 'disabled' | 'shared'

export type AppStatusPill = 'starting' | 'broken' | 'disabled'

// The `duetApp.*` message-key token for an agent status. Every status labels its
// dot; only the three non-default states also render a pill. One owner so the
// roster card and the detail canvas resolve the same token (each in its own i18n
// namespace) instead of keeping parallel maps that drift.
export const AGENT_STATUS_LABEL_KEYS: Record<AgentDisplayStatus, string> = {
  reconciled: 'statusActive',
  shared: 'statusShared',
  disabled: 'statusDisabled',
  broken: 'statusBroken',
}

export const AGENT_STATUS_PILL_KEYS: Partial<Record<AgentDisplayStatus, string>> = {
  shared: 'statusShared',
  disabled: 'statusDisabled',
  broken: 'statusBroken',
}

type AppStatusInput = Pick<App, 'runtimeStatus' | 'disabledAt' | 'anchorState'>

export function appDisplayStatus(app: AppStatusInput): AppDisplayStatus {
  if (app.disabledAt !== undefined) return 'disabled'
  if (app.anchorState === 'broken') return 'broken'
  if (app.runtimeStatus === 'reconciled') return 'reconciled'
  if (app.runtimeStatus === 'reconciling') return 'reconciling'
  return 'failed'
}

type StatusClasses = {
  tint: string
  pill?: string
}

const STATUS_CLASSES: Record<DisplayStatus, StatusClasses> = {
  reconciled: { tint: 'text-emerald-500' },
  reconciling: {
    tint: 'text-amber-500',
    pill: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  failed: {
    tint: 'text-destructive',
    pill: 'bg-destructive/10 text-destructive',
  },
  broken: {
    tint: 'text-destructive',
    pill: 'bg-destructive/10 text-destructive',
  },
  disabled: {
    tint: 'text-muted-foreground',
    pill: 'bg-muted-foreground/15 text-foreground',
  },
  shared: {
    tint: 'text-sky-500',
    pill: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  },
}

export function statusClasses(status: DisplayStatus): StatusClasses {
  return STATUS_CLASSES[status]
}

type AgentStatusInput = Pick<Agent, 'anchorState' | 'disabledAt' | 'sourceShareId'>

// Precedence mirrors apps (disabled first, then a broken anchor) and adds the
// replica state below both: a shared-in agent that is also disabled or broken
// surfaces the more urgent state. A healthy owned agent is 'reconciled'.
export function agentDisplayStatus(agent: AgentStatusInput): AgentDisplayStatus {
  if (agent.disabledAt !== undefined) return 'disabled'
  switch (agent.anchorState) {
    case 'broken':
      return 'broken'
    case 'active':
      return agent.sourceShareId !== undefined ? 'shared' : 'reconciled'
    case 'orphaned':
      // Unreachable: an agent row is itself a live anchor consumer, so any
      // agent returned by listAgents has an 'active' or 'broken' anchor — never
      // 'orphaned'. Assert rather than invent a fourth pill nobody would see.
      throw new Error('agentDisplayStatus: orphaned anchor on a live agent row')
    default:
      return assertNever(agent.anchorState)
  }
}

function assertNever(value: never): never {
  throw new Error(`agentDisplayStatus: unhandled anchor state ${String(value)}`)
}

export function appStatusPresentation(app: AppStatusInput): {
  status: AppDisplayStatus
  tint: string
  pill?: AppStatusPill
  pillClass?: string
} {
  const status = appDisplayStatus(app)
  const pill =
    status === 'reconciling'
      ? 'starting'
      : status === 'failed' || status === 'broken'
        ? 'broken'
        : status === 'disabled'
          ? 'disabled'
          : undefined
  return {
    status,
    tint: STATUS_CLASSES[status].tint,
    pill,
    pillClass: STATUS_CLASSES[status].pill,
  }
}
