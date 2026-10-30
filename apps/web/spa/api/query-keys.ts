import type { AgentTag, SessionBucket, UsageReportPeriod } from '@repo/contract'

import { trainScopeKey, type TrainScope } from './train-scope'

const root = ['duet'] as const
const userRoot = [...root, 'user'] as const
const workspaceRoot = (workspaceSlug: string) => [...root, 'workspaces', workspaceSlug] as const
const trainRoot = (workspaceSlug: string, scope: TrainScope) =>
  [...workspaceRoot(workspaceSlug), ...trainScopeKey(scope), 'train'] as const
const sessionsRoot = (workspaceSlug: string) =>
  [...workspaceRoot(workspaceSlug), 'sessions'] as const
const sessionDetail = (workspaceSlug: string, sessionId: string) =>
  [...sessionsRoot(workspaceSlug), 'detail', sessionId] as const

type DuetQueryScope = 'identity' | 'user' | 'agents' | 'workspaces' | 'internal-admin'

export type DuetQueryKey =
  | typeof root
  | readonly ['duet', DuetQueryScope, ...ReadonlyArray<unknown>]

export type DuetMutationKey = readonly ['duet', 'mutation', ...ReadonlyArray<unknown>]

export type SessionListKeyFilters = Readonly<{
  search: string
  bucket?: SessionBucket
  archived: 'exclude' | 'only'
  agentId?: string
  /* Part of the key, not a page-size style extra: it changes which rows come
     back, so a list asked with it and one asked without it are different lists
     and must not share a cache entry. */
  excludeDefault?: true
  topLevel?: true
}>

export type SessionChildrenKeyFilters = Readonly<{
  bucket?: SessionBucket
  archived: 'exclude' | 'only'
}>

export type MarketplaceCatalogKeyFilters = Readonly<{
  q?: string
  tag?: AgentTag
  availability?: 'available' | 'unavailable'
  verifiedPublisher?: boolean
}>

declare module '@tanstack/react-query' {
  interface Register {
    queryKey: DuetQueryKey
    mutationKey: DuetMutationKey
  }
}

export const duetQueryKeys = {
  all: root,
  identity: [...root, 'identity'] as const,
  agents: {
    all: [...root, 'agents'] as const,
    marketplace: {
      all: [...root, 'agents', 'marketplace'] as const,
      catalog: (filters: MarketplaceCatalogKeyFilters = {}) =>
        [...root, 'agents', 'marketplace', 'catalog', filters] as const,
      details: [...root, 'agents', 'marketplace', 'detail'] as const,
      detail: (publisherSlug: string, agentName: string) =>
        [...root, 'agents', 'marketplace', 'detail', publisherSlug, agentName] as const,
    },
  },
  user: {
    all: userRoot,
    profile: [...userRoot, 'profile'] as const,
    billing: {
      all: [...userRoot, 'billing'] as const,
      overview: [...userRoot, 'billing', 'overview'] as const,
      history: [...userRoot, 'billing', 'history'] as const,
    },
    apiKeys: [...userRoot, 'api-keys'] as const,
    oauthGrants: [...userRoot, 'oauth-grants'] as const,
    syncMachines: [...userRoot, 'sync-machines'] as const,
    invitations: [...userRoot, 'invitations'] as const,
    shareRequests: [...userRoot, 'share-requests'] as const,
    pendingShareLanding: [...userRoot, 'share-requests', 'landing'] as const,
  },
  workspaces: {
    all: [...root, 'workspaces'] as const,
    scope: workspaceRoot,
    backups: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'backups'] as const,
    desktop: {
      session: (workspaceSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'desktop', 'session'] as const,
      status: (workspaceSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'desktop', 'status'] as const,
    },
    appDomains: (workspaceSlug: string) =>
      [...workspaceRoot(workspaceSlug), 'app-domains', 'list'] as const,
    apps: {
      domain: (workspaceSlug: string, appSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'app-domains', 'app', appSlug] as const,
      all: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'apps'] as const,
      list: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'apps', 'list'] as const,
      subtree: (workspaceSlug: string, path: string) =>
        [...workspaceRoot(workspaceSlug), 'apps', 'subtree', { path }] as const,
      children: (workspaceSlug: string, path: string) =>
        [...workspaceRoot(workspaceSlug), 'apps', 'children', { path }] as const,
      app: (workspaceSlug: string, appSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'apps', 'app', appSlug] as const,
      lookup: (workspaceSlug: string, filter: { id: string } | { cwd: string }) =>
        [...workspaceRoot(workspaceSlug), 'apps', 'lookup', filter] as const,
    },
    agents: {
      all: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'agents'] as const,
      list: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'agents', 'list'] as const,
      lookup: (workspaceSlug: string, filter: { id: string } | { slug: string }) =>
        [...workspaceRoot(workspaceSlug), 'agents', 'lookup', filter] as const,
      // Keyed by the agent asked about: a roster is one layer around that agent,
      // so every composer pointed at it shares one entry.
      roster: (workspaceSlug: string, agentSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'agents', 'roster', agentSlug] as const,
      marketplace: {
        all: (workspaceSlug: string) =>
          [...workspaceRoot(workspaceSlug), 'agents', 'marketplace'] as const,
        subscriptions: (workspaceSlug: string) =>
          [...workspaceRoot(workspaceSlug), 'agents', 'marketplace', 'subscriptions'] as const,
      },
      // Per-agent derived profile (role + skills) from the agent's own files (D10).
      // Keyed by agentId so the roster card and slice 12's detail canvas share one
      // cache entry rather than re-reading.
      profile: (workspaceSlug: string, agentId: string) =>
        [...workspaceRoot(workspaceSlug), 'agents', 'profile', agentId] as const,
      // Per-agent file-derived detail, keyed by agentId. The config key is owned
      // by `drive/agent-config`; every surface shares its resolved agent.json
      // meaning while the full AGENTS.md remains detail-only.
      readme: (workspaceSlug: string, agentId: string) =>
        [...workspaceRoot(workspaceSlug), 'agents', 'readme', agentId] as const,
      config: (workspaceSlug: string, agentId: string) =>
        [...workspaceRoot(workspaceSlug), 'agents', 'config', agentId] as const,
      // The setup conversation, keyed by agent ID: a slug outlives the agent
      // that wore it (delete + reinstall), and the conversation belongs to the
      // row, not the name.
      onboardingSession: (workspaceSlug: string, agentId: string) =>
        [...workspaceRoot(workspaceSlug), 'agents', 'onboarding-session', agentId] as const,
    },
    sessions: {
      all: sessionsRoot,
      lists: (workspaceSlug: string) => [...sessionsRoot(workspaceSlug), 'list'] as const,
      list: (workspaceSlug: string, filters: SessionListKeyFilters) =>
        [...sessionsRoot(workspaceSlug), 'list', { filters }] as const,
      workConversationPresence: (workspaceSlug: string, activityFingerprint: readonly string[]) =>
        [
          ...sessionsRoot(workspaceSlug),
          'work-conversation-presence',
          activityFingerprint,
        ] as const,
      childrenLists: (workspaceSlug: string) =>
        [...sessionsRoot(workspaceSlug), 'list', 'children'] as const,
      children: (
        workspaceSlug: string,
        sessionId: string,
        filters: SessionChildrenKeyFilters = { archived: 'exclude' },
      ) => [...sessionsRoot(workspaceSlug), 'list', 'children', sessionId, { filters }] as const,
      details: (workspaceSlug: string) => [...sessionsRoot(workspaceSlug), 'detail'] as const,
      detail: sessionDetail,
      histories: (workspaceSlug: string) => [...sessionsRoot(workspaceSlug), 'history'] as const,
      history: (workspaceSlug: string, sessionId: string) =>
        [...sessionsRoot(workspaceSlug), 'history', sessionId] as const,
      audiences: (workspaceSlug: string) => [...sessionsRoot(workspaceSlug), 'audience'] as const,
      audience: (workspaceSlug: string, sessionId: string) =>
        [...sessionsRoot(workspaceSlug), 'audience', sessionId] as const,
      defaults: (workspaceSlug: string) => [...sessionsRoot(workspaceSlug), 'default'] as const,
      default: (workspaceSlug: string, agentSlug: string) =>
        [...sessionsRoot(workspaceSlug), 'default', { agentSlug }] as const,
      /* Not under `list`: it is a different family with no filters and no
         cursor, and putting it there would make `lists()` invalidate it. */
      activity: (workspaceSlug: string) => [...sessionsRoot(workspaceSlug), 'activity'] as const,
    },
    // One entry per folder the drive has listed, so walking back into a folder
    // is a cache read rather than a fresh wait. Keyed by the browser path the
    // address bar carries, which is what the reader navigated to.
    files: {
      all: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'files'] as const,
      view: (workspaceSlug: string, path: string | null) =>
        [...workspaceRoot(workspaceSlug), 'files', 'view', path] as const,
    },
    integrations: {
      all: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'integrations'] as const,
      connections: (workspaceSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'integrations', 'connections'] as const,
      catalog: (workspaceSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'integrations', 'catalog'] as const,
      catalogSearch: (workspaceSlug: string, search: string) =>
        [...workspaceRoot(workspaceSlug), 'integrations', 'catalog', { search }] as const,
    },
    /* Not under `integrations`: a workspace's own MCP servers survive a
       provider outage, and sharing a key root would let one family's
       invalidation reach the other. */
    mcpServers: {
      all: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'mcp-servers'] as const,
      list: (workspaceSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'mcp-servers', 'list'] as const,
    },
    connectedProviders: {
      all: (workspaceSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'connected-providers'] as const,
      list: (workspaceSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'connected-providers', 'list'] as const,
      connectPoll: (workspaceSlug: string, sessionId: string) =>
        [...workspaceRoot(workspaceSlug), 'connected-providers', 'connect', sessionId] as const,
    },
    // Keyed by the folder asked about: an agent's skills are not the drive's,
    // so one cache entry per composer scope rather than one per workspace.
    skills: (workspaceSlug: string, cwd: string | undefined) =>
      [...workspaceRoot(workspaceSlug), 'skills', cwd ?? ''] as const,
    train: {
      all: trainRoot,
      uploads: (workspaceSlug: string, scope: TrainScope) =>
        [...trainRoot(workspaceSlug, scope), 'uploads'] as const,
      jobs: (workspaceSlug: string, scope: TrainScope) =>
        [...trainRoot(workspaceSlug, scope), 'jobs'] as const,
      jobPages: (workspaceSlug: string, scope: TrainScope) =>
        [...trainRoot(workspaceSlug, scope), 'job-pages'] as const,
      records: {
        all: (workspaceSlug: string, scope: TrainScope) =>
          [...trainRoot(workspaceSlug, scope), 'records'] as const,
        memoryCounts: (workspaceSlug: string) =>
          [...trainRoot(workspaceSlug, { kind: 'root' }), 'records', 'memory-counts'] as const,
        list: (workspaceSlug: string, scope: TrainScope) =>
          [...trainRoot(workspaceSlug, scope), 'records', 'list'] as const,
        detail: (workspaceSlug: string, scope: TrainScope, recordSlug: string) =>
          [...trainRoot(workspaceSlug, scope), 'records', 'detail', recordSlug] as const,
      },
    },
    members: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'members'] as const,
    memberSearch: (workspaceSlug: string, search: string) =>
      [...workspaceRoot(workspaceSlug), 'members', 'search', { search }] as const,
    invites: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'invites'] as const,
    shares: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'shares'] as const,
    publishes: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'publishes'] as const,
    shareFolder: (workspaceSlug: string, path: string) =>
      [...workspaceRoot(workspaceSlug), 'shares', 'folder', { path }] as const,
    usage: (workspaceSlug: string, period: UsageReportPeriod, currentOnly: boolean) =>
      [...workspaceRoot(workspaceSlug), 'usage', period, currentOnly] as const,
    telemetry: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'telemetry'] as const,
    ledger: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'ledger'] as const,
    audit: (workspaceSlug: string) => [...workspaceRoot(workspaceSlug), 'audit'] as const,
    entitlementMomentum: (workspaceSlug: string) =>
      [...workspaceRoot(workspaceSlug), 'entitlement-momentum'] as const,
    fileAttribution: {
      all: (workspaceSlug: string) =>
        [...workspaceRoot(workspaceSlug), 'file-attribution'] as const,
      seenBy: (workspaceSlug: string, path: string) =>
        [...workspaceRoot(workspaceSlug), 'file-attribution', 'seen-by', { path }] as const,
      history: (workspaceSlug: string, path: string) =>
        [...workspaceRoot(workspaceSlug), 'file-attribution', 'history', { path }] as const,
      activity: (workspaceSlug: string, scope?: { path: string; scope: 'exact' | 'subtree' }) =>
        [...workspaceRoot(workspaceSlug), 'file-attribution', 'activity', scope ?? null] as const,
    },
  },
  admin: {
    all: [...root, 'internal-admin'] as const,
    searches: [...root, 'internal-admin', 'search'] as const,
    search: (query: string) => [...root, 'internal-admin', 'search', { query }] as const,
    userCleanupPreview: (query: string) =>
      [...root, 'internal-admin', 'user-cleanup-preview', { query }] as const,
    userCleanup: (operationId: string) =>
      [...root, 'internal-admin', 'user-cleanup', operationId] as const,
    workspace: (workspaceId: string) =>
      [...root, 'internal-admin', 'workspace', workspaceId] as const,
    vm: (workspaceId: string) =>
      [...root, 'internal-admin', 'workspace', workspaceId, 'vm'] as const,
    files: (workspaceId: string, path: string) =>
      [...root, 'internal-admin', 'workspace', workspaceId, 'files', { path }] as const,
    file: (workspaceId: string, path: string | undefined) =>
      [...root, 'internal-admin', 'workspace', workspaceId, 'file', { path }] as const,
    logs: (workspaceId: string, source: 'gateway' | 'agent', anchorId?: string) =>
      [...root, 'internal-admin', 'workspace', workspaceId, 'logs', { source, anchorId }] as const,
    feedback: (archived: boolean) => [...root, 'internal-admin', 'feedback', { archived }] as const,
    freeCredits: [...root, 'internal-admin', 'free-credits'] as const,
    vmUpdates: [...root, 'internal-admin', 'vm-updates'] as const,
    fleetHealth: [...root, 'internal-admin', 'fleet-health'] as const,
    inferenceMargin: (granularity: UsageReportPeriod, through: number | undefined) =>
      [...root, 'internal-admin', 'inference-margin', { granularity, through }] as const,
    modelRouterPolicy: [...root, 'internal-admin', 'model-router'] as const,
  },
}

export const duetMutationKeys = {
  all: [...root, 'mutation'] as const,
  workspaces: {
    backups: (workspaceSlug: string, action: 'create' | 'download' | 'delete') =>
      [...root, 'mutation', 'workspaces', workspaceSlug, 'backups', action] as const,
    connectedProviders: (workspaceSlug: string, action: 'connect' | 'disconnect') =>
      [...root, 'mutation', 'workspaces', workspaceSlug, 'connected-providers', action] as const,
    agents: {
      marketplace: (workspaceSlug: string, action: 'install' | 'acknowledge' | 'uninstall') =>
        [
          ...root,
          'mutation',
          'workspaces',
          workspaceSlug,
          'agents',
          'marketplace',
          action,
        ] as const,
    },
    sessions: {
      creations: (workspaceSlug: string, kind: 'job' | 'work') =>
        [...root, 'mutation', 'workspaces', workspaceSlug, 'sessions', 'create', kind] as const,
      creation: (workspaceSlug: string, kind: 'job' | 'work', agentSlug: string) =>
        [
          ...root,
          'mutation',
          'workspaces',
          workspaceSlug,
          'sessions',
          'create',
          kind,
          agentSlug,
        ] as const,
      /* The first message into an owner's default chat, keyed by owner because
         the whole point of that send is that the session does not exist yet.
         It is keyed at all so a control *outside* the chat panel can see one in
         flight: the send ends by stamping the owner's pointer, and the archive
         control has to stay shut until it has. */
      defaultMessage: (workspaceSlug: string, agentSlug: string) =>
        [
          ...root,
          'mutation',
          'workspaces',
          workspaceSlug,
          'sessions',
          'default',
          agentSlug,
          'message',
        ] as const,
      inputs: (workspaceSlug: string, sessionId: string) =>
        [...root, 'mutation', 'workspaces', workspaceSlug, 'sessions', sessionId, 'input'] as const,
      input: (workspaceSlug: string, sessionId: string, kind: 'message' | 'note' | 'answer') =>
        [
          ...root,
          'mutation',
          'workspaces',
          workspaceSlug,
          'sessions',
          sessionId,
          'input',
          kind,
        ] as const,
    },
  },
}

export function isWorkspaceQueryKey(queryKey: readonly unknown[], workspaceSlug: string): boolean {
  return queryKey[0] === 'duet' && queryKey[1] === 'workspaces' && queryKey[2] === workspaceSlug
}
