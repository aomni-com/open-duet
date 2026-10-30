import type { RefObject } from 'react'

import type {
  Agent,
  AgentTag,
  App,
  AppListResponse,
  AgentInputImage,
  AgentStateMachineSession,
  IntegrationConnection,
  McpServer,
  OAuthGrant,
  MarketplaceListingSummary,
  MarketplaceAgentSubscription,
  PublishRow,
  Machine,
  ShareListResponse,
  ShareRequest,
  SessionInitialHistorySnapshot,
  SessionTimelineEntry,
  SessionSnapshot,
  SessionSummary,
  SyncMachine,
  TrainJobStatus,
  TrainUploadEntry,
  UserApiKey,
  WhoamiResponse,
  WorkspaceMember,
  WorkspaceSkill,
} from '@repo/contract'
import {
  agentResolutionCandidate,
  APP_AUTO_PORT_RANGE_START,
  canonicalAppUrl,
  DESKTOP_SCREEN,
  DUET_EDGE_HOST,
  normalizeWorkspaceMemberSearch,
  resolveNearestAgent,
  ROOT_AGENT_SCOPE,
  SESSION_ACTIVITY_PRIORITY,
  TRAIN_UPLOADS_CAP_BYTES,
} from '@repo/contract'

import { DuetApiError } from '../../spa/api/client'
import { TrainUploadsClient } from '../../spa/api/train-uploads'
import type { SpaApi } from '../../spa/context'
import { createBackupFixture } from './backup-fixture'
import { CURRENT_RUNTIME_VERSION } from './runtime-fixture'
import { workspaceSessionProjection } from './session-fixture'

/* ============================================================================
   The product's REST surface, faked once.

   Every product playground needs the same thing: a `SpaApi` complete enough to
   mount the real SPA against, backed by data that never moves. This module is
   that one fake, and each fixture drives it somewhere different — through a
   scenario, through a first run, through an outage. Keeping it in a `.ts`
   module (no JSX) is deliberate: the visual-coverage inventory only reads
   `.tsx`, so sharing the fake cannot move which fixture owns which component.
   ========================================================================= */

// Frozen clock: relative-time labels ("3d ago") must not rot as the wall-clock
// date advances past the fixture mtimes.
export const FIXTURE_NOW = Date.UTC(2026, 6, 18, 9, 0)

/* An invitation is only on the roster while it is still redeemable, and the
   roster asks the real clock rather than the frozen one above — the product
   has no fixture seam for time here, and inventing one to photograph a row is
   the wrong trade. So this date is far out on purpose: an expiry authored near
   `FIXTURE_NOW` silently rots into an expired invite, the row vanishes, and
   the fixture stops covering the state it exists to cover. Nothing renders the
   value, so its distance costs nothing. */
const OPEN_INVITE_EXPIRY = Date.UTC(2099, 0, 1)

/** Every fixture input is typed by the signed-in owner of this shell. */
export const FIXTURE_VIEWER_SENDER = { kind: 'user', userId: 'user_owner' } as const

/* Skills as the VM reports them: one from the drive, one the user installed
   globally, one built into the agent. Three scopes, and one description long
   enough to prove the picker clamps it rather than growing the popup. */
export const FIXTURE_SKILLS: WorkspaceSkill[] = [
  {
    name: 'review',
    description: 'Closeout pass on a finished change — shape, diff, then docs.',
    path: '/home/duet/drive/.agents/skills/review',
    scope: 'project',
  },
  {
    name: 'write-spec',
    description:
      'Break large features into independently verifiable, human-reviewable slices, with browser checkpoints and screenshot gates at every step.',
    path: '/home/duet/.duet/skills/write-spec',
    scope: 'user',
  },
  { name: 'relay', path: '/opt/duet/skills/relay', scope: 'builtin' },
]

export const IDENTITY = {
  user: { id: 'user_owner', email: 'owner@duet.so', name: 'Ada Lovelace' },
  workspaces: [
    {
      id: 'workspace_acme',
      slug: 'acme',
      name: 'Acme Studio',
      /* Deliberately not the drive's name. The default agent is named in
         onboarding and the drive is named separately, so a fixture where the
         two agree cannot tell you which one a surface is actually reading —
         and the map read the drive's for both. */
      duetName: 'Milo',
      status: 'active',
      role: 'owner',
      billingUserId: 'user_owner',
      funding: { plan: 'pro', active: true },
      creditRecovery: null,
      defaultTier: { configured: 'balanced', effective: 'balanced' },
      servicingStatus: 'active',
      onboardedAt: FIXTURE_NOW,
    },
    {
      id: 'workspace_labs',
      slug: 'labs',
      name: 'Duet Labs',
      status: 'provisioning',
      role: 'owner',
      billingUserId: 'user_owner',
      funding: { plan: 'pro', active: true },
      creditRecovery: null,
      defaultTier: { configured: 'balanced', effective: 'balanced' },
      servicingStatus: 'active',
      onboardedAt: FIXTURE_NOW,
    },
  ],
  scopes: ['ws:acme:admin', 'ws:labs:admin'],
  versions: { api: 1 },
  internalAdmin: true,
} as const satisfies WhoamiResponse

export const NIGHTLY_EXPORT_RELAY = {
  definitionName: 'Nightly export relay',
  currentState: 'wait for export',
  followingDefinitionState: 'verify export',
  progress: { completed: 1, total: 4 },
  orderedPath: [
    { key: 'prepare', index: 0, name: 'prepare export', kind: 'script', phase: 'past' },
    { key: 'wait', index: 1, name: 'wait for export', kind: 'timer', phase: 'current' },
    { key: 'verify', index: 2, name: 'verify export', kind: 'poll', phase: 'future' },
    {
      key: 'complete',
      index: 3,
      name: 'export ready',
      kind: 'terminal',
      phase: 'outcome',
      terminalStatus: 'completed',
    },
  ],
  activity: 'sleeping',
  nextWakeAt: Date.UTC(2026, 6, 19, 8),
} as const satisfies Machine

export const NIGHTLY_EXPORT_MACHINE = {
  definition: {
    name: 'Nightly export relay',
    prompt: 'Prepare, wait for, verify, and publish the nightly customer export.',
    states: [
      {
        name: 'prepare export',
        kind: 'script',
        command: 'scripts/prepare-export.sh',
        cwd: '/home/duet/reports',
      },
      {
        name: 'wait for export',
        kind: 'timer',
        wakeAt: Date.UTC(2026, 6, 19, 8),
      },
      {
        name: 'verify export',
        kind: 'poll',
        command: 'scripts/check-export.sh',
        intervalMs: '10m',
      },
      { name: 'export ready', kind: 'terminal', status: 'completed' },
      { name: 'export failed', kind: 'terminal', status: 'failed' },
      { name: 'cancelled', kind: 'terminal', status: 'cancelled' },
    ],
  },
  prompt: 'Wait for the nightly export and publish it when ready.',
  currentState: 'wait for export',
  history: [],
  createdAt: Date.UTC(2026, 6, 18, 8),
  updatedAt: Date.UTC(2026, 6, 18, 9),
} as const satisfies AgentStateMachineSession

export const SHARE_REQUEST_FIXTURES = [
  {
    id: 'share_qbr',
    anchorId: 'anchor_qbr',
    originWorkspaceId: 'workspace_research',
    fromWorkspaceId: 'workspace_research',
    toEmail: 'owner@duet.so',
    mode: 'write',
    ignorePatterns: ['**/.git', '(?d)**/node_modules', '.duet-anchor', '**/.duet-anchor'],
    state: 'pending',
    createdByUserId: 'user_grace',
    createdAt: Date.UTC(2026, 6, 15, 8),
    expiresAt: Date.UTC(2026, 6, 22, 8),
    source: {
      workspaceName: 'Research Studio',
      path: 'Projects/qbr-deck',
      folderName: 'qbr-deck',
      sharerName: 'Grace Hopper',
      originLive: true,
      apps: [
        { slug: 'qbr-dashboard', path: 'Projects/qbr-deck/dashboard' },
        { slug: 'forecast', path: 'Projects/qbr-deck/forecast' },
      ],
    },
  },
  {
    id: 'share_brand',
    anchorId: 'anchor_brand',
    originWorkspaceId: 'workspace_design',
    fromWorkspaceId: 'workspace_design',
    toEmail: 'owner@duet.so',
    mode: 'read',
    ignorePatterns: ['**/.git', '(?d)**/node_modules', '.duet-anchor', '**/.duet-anchor'],
    state: 'pending',
    createdByUserId: 'user_maya',
    createdAt: Date.UTC(2026, 6, 15, 9),
    expiresAt: Date.UTC(2026, 6, 22, 9),
    source: {
      workspaceName: 'Design System',
      path: 'Brand/library',
      folderName: 'library',
      sharerName: 'Maya Chen',
      originLive: true,
      apps: [],
    },
  },
] as const satisfies readonly ShareRequest[]

export const TELEMETRY_FIXTURES = Array.from({ length: 31 }, (_, index) => ({
  at: Date.UTC(2026, 5, 12) + index * 24 * 60 * 60 * 1000,
  cpuPct: 32 + Math.sin(index / 2.4) * 13 + (index % 4) * 1.5,
  memUsedMb: 5_600 + Math.sin(index / 4) * 900 + index * 65,
  memTotalMb: 16_384,
  diskUsedMb: 72_000 + index * 820,
  diskTotalMb: 204_800,
}))

export const OAUTH_GRANT_FIXTURES = [
  {
    id: 'active',
    clientId: 'https://research.example/oauth/client.json',
    clientName: 'Research companion',
    redirectHost: 'research.example',
    workspace: { slug: 'acme', name: 'Acme Studio' },
    scopes: ['ws:acme:files:read', 'ws:acme:memory'],
    createdAt: Date.UTC(2026, 5, 18, 10),
    lastUsedAt: Date.UTC(2026, 6, 18, 8, 42),
  },
  {
    id: 'revoked',
    clientId: 'duet_client_revoked',
    clientName: 'Retired release bot',
    redirectHost: 'release.example',
    workspace: { slug: 'acme', name: 'Acme Studio' },
    scopes: ['ws:acme:files:read'],
    createdAt: Date.UTC(2026, 4, 2, 9),
    revokedAt: Date.UTC(2026, 6, 10, 16),
  },
  {
    id: 'localhost',
    clientId: 'duet_client_localhost',
    clientName: 'Claude Desktop (local)',
    redirectHost: '127.0.0.1',
    workspace: { slug: 'labs', name: 'Duet Labs' },
    scopes: ['ws:labs:files:read', 'ws:labs:sessions'],
    createdAt: Date.UTC(2026, 6, 17, 14),
  },
  {
    id: 'long-name',
    clientId: 'https://automation.example/oauth/client.json',
    clientName:
      'Quarterly customer research synthesis and executive reporting automation companion',
    redirectHost: 'automation.example',
    workspace: { slug: 'acme', name: 'Acme Studio' },
    scopes: ['ws:acme:files:read', 'ws:acme:memory', 'ws:acme:sessions'],
    createdAt: Date.UTC(2026, 6, 1, 11),
    lastUsedAt: Date.UTC(2026, 6, 16, 12, 30),
  },
] as const satisfies readonly OAuthGrant[]

/**
 * The app whose anchor is the longest ancestor of a working folder, as a list.
 *
 * Depth-first from the folder itself outward, which is how the drive resolves
 * it: `apps/reports/editor/src` belongs to the editor anchored at
 * `apps/reports/editor` rather than to the app anchored at `apps/reports`, and
 * a folder under no anchor belongs to nothing at all.
 */
function appAnchoredAbove(apps: App[], cwd: string): App[] {
  const parts = cwd.split('/').filter(part => part.length > 0)
  for (let depth = parts.length; depth > 0; depth -= 1) {
    const path = parts.slice(0, depth).join('/')
    const app = apps.find(candidate => candidate.anchorPath === path)
    if (app !== undefined) return [app]
  }
  return []
}

export function createFixtureApi(
  identity: RefObject<WhoamiResponse>,
  sessionStore: RefObject<ReturnType<typeof createSessionStore>>,
  apps: RefObject<App[]>,
  members: RefObject<WorkspaceMember[]>,
  profile: RefObject<{
    id: string
    email: string
    firstName: string
    lastName: string
    name: string
  }>,
  userKeys: RefObject<UserApiKey[]>,
  oauthGrants: RefObject<OAuthGrant[]>,
  syncMachines: RefObject<SyncMachine[]>,
  recordSessionInput: (input: unknown) => void,
  recordMarketplaceAgentMutation: (input: unknown) => void,
  recordIntegrationPolicyMutation: (input: unknown) => void,
  recordMemberRequest: (input: unknown) => void = () => {},
): SpaApi {
  let startedTrainingJob: TrainJobStatus | undefined
  let workspaceAuditContinuationAttempts = 0
  let shareRequests = SHARE_REQUEST_FIXTURES.slice(0, 1).map(share => structuredClone(share))
  // Local assets stand in for provider runtime logo URLs so Docker captures stay hermetic.
  let integrationConnections: IntegrationConnection[] = [
    {
      id: 'connection_gmail',
      integration: 'gmail',
      name: 'Gmail',
      logoUrl: '/playground/provider-gmail.webp',
      status: 'active',
      connectedAt: Date.UTC(2026, 6, 8, 9),
      updatedAt: Date.UTC(2026, 6, 11, 8),
    },
    {
      id: 'connection_github',
      integration: 'github',
      name: 'GitHub',
      logoUrl: '/playground/provider-github.webp',
      status: 'pending',
      connectedAt: Date.UTC(2026, 6, 11, 8),
      updatedAt: Date.UTC(2026, 6, 11, 8),
      allowedAgentIds: ['agent_research'],
    },
    {
      id: 'connection_slack',
      integration: 'slack',
      name: 'Slack',
      logoUrl: '/playground/provider-slack.webp',
      status: 'error',
      connectedAt: Date.UTC(2026, 5, 20, 12),
      updatedAt: Date.UTC(2026, 6, 10, 15),
      allowedAgentIds: [],
    },
  ]
  /* Three servers, three health answers: a reachable one, one still waiting on
     its authorization, and one the proxy could not reach on its last call.
     Rarer states (an expired credential, dropped tools) live in their own
     scenario so the page shot stays the size a real workspace's is. */
  let mcpServers: McpServer[] = [
    {
      name: 'acme_internal',
      label: 'Acme Internal',
      url: 'https://mcp.acme-internal.test/v1/mcp',
      authKind: 'static',
      state: 'ready',
      toolCount: 24,
      estimatedPromptBytes: 9800,
      lastSuccessAt: FIXTURE_NOW - 4 * 60_000,
      createdAt: Date.UTC(2026, 6, 8, 10),
      updatedAt: FIXTURE_NOW - 4 * 60_000,
    },
    {
      name: 'research_wire',
      label: 'Research Wire',
      url: 'https://wire.research.test/mcp',
      authKind: 'oauth',
      state: 'needs_auth',
      allowedAgentIds: ['agent_research'],
      createdAt: FIXTURE_NOW - 30 * 60_000,
      updatedAt: FIXTURE_NOW - 30 * 60_000,
    },
    {
      name: 'ops_bridge',
      label: 'Ops Bridge',
      url: 'https://bridge.ops.test/mcp',
      authKind: 'none',
      state: 'ready',
      toolCount: 6,
      estimatedPromptBytes: 2100,
      lastSuccessAt: FIXTURE_NOW - 6 * 3_600_000,
      lastErrorAt: FIXTURE_NOW - 3 * 60_000,
      lastErrorCode: 'unreachable',
      allowedAgentIds: [],
      createdAt: Date.UTC(2026, 6, 2, 14),
      updatedAt: FIXTURE_NOW - 3 * 60_000,
    },
  ]
  let officialSubscriptions: MarketplaceAgentSubscription[] = [
    {
      id: 'subscription_research',
      agentId: 'agent_research',
      anchorId: 'anchor_research',
      listingId: 'listing-research',
      agentName: 'research',
      path: 'agents/research',
      mode: 'subscribe',
      state: 'active',
      appliedEtag: 'etag-2',
      acknowledgedEtag: 'etag-1',
      lastAppliedAt: Date.UTC(2026, 6, 17, 9),
    },
  ]
  let agents = AGENT_FIXTURES.map(agent => ({ ...agent }))
  let registeredAgentRefetchPending = false

  /* The one owner of "a session comes into being", shared by the create route
     and the default-chat mint. Mirrors the server's attribution: the web app
     sends a `cwd`, never an agentId, and the backend stamps `agent` from the
     nearest-agent rule. With no cwd (the default agent) the session stays
     unattributed. */
  const mintSession = (input: {
    prompt: string
    clientRequestId?: string
    images?: readonly AgentInputImage[]
    cwd?: string
    agentFirstMessage?: string
  }) => {
    const id = `session_${sessionStore.current.sessions.length + 1}`
    const now = Date.now()
    const attributedAgent =
      input.cwd === undefined
        ? null
        : resolveNearestAgent(input.cwd, AGENT_FIXTURES.map(agentResolutionCandidate))
    const attribution = attributedAgent
      ? AGENT_FIXTURES.find(agent => agent.id === attributedAgent.agentId)
      : undefined
    const events = fixturePromptEvents(
      input.prompt,
      input.images ?? false,
      input.clientRequestId,
      input.agentFirstMessage,
    )
    const summary: SessionSummary = {
      id,
      ...workspaceSessionProjection(),
      turnStatus: 'running',
      bucket: 'running',
      title: input.prompt,
      titleOrigin: 'excerpt',
      titleStatus: 'generating',
      // Never unread: the caller is the one who just started it.
      unread: false,
      createdAt: now,
      updatedAt: now,
      lastEventSeq: events.length,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(attribution
        ? { agent: { id: attribution.id, name: attribution.name ?? attribution.slug } }
        : {}),
    }
    sessionStore.current.sessions.unshift(summary)
    const snapshot = {
      ...summary,
      workspaceId: identity.current.workspaces[0]?.id ?? 'workspace_acme',
      lastDeliveredInputSeq: 0,
    }
    const history = { events }
    sessionStore.current.snapshots[id] = snapshot
    sessionStore.current.history[id] = history
    return {
      session: {
        sessionId: id,
        status: 'running' as const,
        lastEventSeq: events.length,
        lastDeliveredInputSeq: 0,
      },
      snapshot,
      history,
      dispatched: false as const,
      delivery: 'accepted' as const,
    }
  }

  return {
    ...createBackupFixture().api,
    getAppDomain: async () => ({ domain: null }),
    attachAppDomain: async () => {
      throw new Error('Use the app domain fixture for domain mutations')
    },
    recheckAppDomain: async () => {
      throw new Error('Use the app domain fixture for domain mutations')
    },
    removeAppDomain: async () => ({ domain: null }),
    listAppDomains: async () => ({ items: [], nextCursor: null }),
    whoami: async () => identity.current,
    mintDesktopSession: async () => ({
      entryUrl: 'https://desktop.example/v1/desktop/playground.token/',
      token: 'playground-token',
      expiresAt: 4_102_444_800_000,
      phase: 'ready' as const,
      screen: DESKTOP_SCREEN,
    }),
    readDesktopStatus: async () => ({ phase: 'ready' as const, viewers: 1, owners: [] }),
    focusDesktopOwner: async () => ({ focused: false }),
    recordAnalyticsEvent: async () => {},
    createOnboardingPaymentIntent: async () => ({
      status: 'requires_confirmation' as const,
      attemptId: 'fixture-attempt',
      paymentIntentId: 'pi_fixture',
      clientSecret: 'pi_fixture_secret',
      publishableKey: 'pk_fixture',
      amount: 1000 as const,
      currency: 'usd' as const,
    }),
    completeOnboardingPayment: async () => ({ ready: true, status: 'ready' as const }),
    onboardingPaymentStatus: async () => ({ ready: false }),
    // D10 profile reads. Research carries an AGENTS.md (a role) and a
    // `.agents/skills/` folder (five skills); Reviewer's anchor is broken, so both
    // reads 404 and its card degrades silently — no role, no skills, health pill
    // untouched.
    /* Creation changes the same roster the product refetches. Keeping this
       stateful matters: a fixture that returns a registered agent and then
       omits it from listAgents recreates an impossible server contract and
       masks the navigation/cache race in the real flow. */
    writeWorkspaceFile: async () => ({ ok: true as const, etag: 'fixture', size: 0 }),
    registerAgent: async (_workspaceSlug, input) => {
      const registered = {
        ...AGENT_FIXTURES[0]!,
        id: 'agent_created',
        slug: input.slug,
        name: input.name ?? input.slug,
        anchorPath: input.path,
      }
      agents = [...agents.filter(agent => agent.id !== registered.id), registered]
      registeredAgentRefetchPending = true
      return { agent: registered, apps: [] }
    },
    readWorkspaceFile: async (_workspaceSlug, path) => {
      const content = AGENT_PROFILE_FILES[path]
      if (content === undefined) throw new DuetApiError(404, 'not_found')
      const data = new TextEncoder().encode(content)
      return { data, etag: null, contentType: 'text/markdown', size: data.byteLength }
    },
    readOptionalWorkspaceFile: async (_workspaceSlug, path) => {
      const content = AGENT_PROFILE_FILES[path]
      if (content === undefined) return null
      const data = new TextEncoder().encode(content)
      return { data, etag: null, contentType: 'text/markdown', size: data.byteLength }
    },
    listOptionalWorkspaceFiles: async (_workspaceSlug, path) => {
      const skills = AGENT_SKILL_DIRS[path]
      if (skills === undefined) return null
      return {
        items: skills.map(name => ({
          name,
          path: `${path}/${name}`,
          type: 'directory' as const,
          size: 0,
          mtime: '2026-07-15T08:00:00.000Z',
        })),
        nextCursor: null,
      }
    },
    listWorkspaceFiles: async (_workspaceSlug, path = '') => {
      const skills = AGENT_SKILL_DIRS[path]
      if (skills !== undefined)
        return {
          items: skills.map(name => ({
            name,
            path: `${path}/${name}`,
            type: 'directory' as const,
            size: 0,
            mtime: '2026-07-15T08:00:00.000Z',
          })),
          nextCursor: null,
        }
      return {
        items:
          path === ''
            ? [
                {
                  name: 'Shared',
                  path: 'Shared',
                  type: 'directory' as const,
                  size: 0,
                  mtime: '2026-07-15T08:00:00.000Z',
                },
                {
                  name: 'Projects',
                  path: 'Projects',
                  type: 'directory' as const,
                  size: 0,
                  mtime: '2026-07-15T08:00:00.000Z',
                },
              ]
            : path === 'Shared'
              ? [
                  {
                    name: 'Finance',
                    path: 'Shared/Finance',
                    type: 'directory' as const,
                    size: 0,
                    mtime: '2026-07-15T08:00:00.000Z',
                  },
                ]
              : [],
        nextCursor: null,
      }
    },
    statWorkspaceFile: async () => {
      throw new DuetApiError(404, 'not_found')
    },
    statOptionalWorkspaceFile: async () => null,
    operateOnWorkspaceFiles: async () => {
      throw new Error('Fixture file operation is not configured')
    },
    mintDriveUploadSession: async () => {
      throw new Error('Fixture drive upload is not configured')
    },
    listShareRequests: async () => ({ items: shareRequests, nextCursor: null }),
    consumePendingShare: async () => null,
    resolveShareToken: async () => ({ share: structuredClone(SHARE_REQUEST_FIXTURES[0]) }),
    acceptShare: async (shareId, input) => {
      const share = shareRequests.find(candidate => candidate.id === shareId)
      if (share === undefined) throw new DuetApiError(404, 'not_found')
      shareRequests = shareRequests.filter(candidate => candidate.id !== shareId)
      return {
        share: {
          ...share,
          state: 'active' as const,
          toWorkspaceId: input.toWorkspaceId,
          mountPath: input.mountPath,
        },
      }
    },
    declineShare: async shareId => {
      shareRequests = shareRequests.filter(candidate => candidate.id !== shareId)
      return { ok: true }
    },
    createWorkspace: async input => {
      const result = {
        workspaceId: `workspace_${input.slug}`,
        slug: input.slug,
        status: 'provisioning' as const,
      }
      identity.current = {
        ...identity.current,
        workspaces: [
          ...identity.current.workspaces,
          {
            id: result.workspaceId,
            slug: result.slug,
            name: input.name,
            status: result.status,
            servicingStatus: 'active',
            role: 'owner',
            billingUserId: identity.current.user.id,
            funding: { plan: 'pro', active: true },
            creditRecovery: null,
            defaultTier: { effective: 'balanced' },
            onboardedAt: FIXTURE_NOW,
          },
        ],
      }
      return result
    },
    /* The cwd and id filters answer the way the drive does, because the surface
       that asks is deciding whether an app stands beside a conversation at all.
       This used to hand back the whole shelf whatever was asked, so
       `useSessionPaneApp` — which reads `items[0]` and trusts the server to have
       narrowed — mounted the first app in the fixture for *every* working
       folder. A scenario that moved a session out of every app kept its pane,
       and one that moved it into a different app kept the first one. `cwd`
       resolves to the app anchored at the longest ancestor of the folder, and to
       nothing when no ancestor is anchored, which is the rule the backend's own
       lookup walks depth-first (`domains/apps/model.ts`). */
    listApps: async (_workspaceSlug, query = {}) => {
      const items =
        query.id !== undefined
          ? apps.current.filter(app => app.id === query.id)
          : query.cwd === undefined
            ? apps.current
            : appAnchoredAbove(apps.current, query.cwd)
      return {
        items,
        nextCursor: null,
        meta: { capabilities: OWNER_APP_CAPABILITIES },
      }
    },
    getApp: async (_workspaceSlug, appSlug) => {
      const app = apps.current.find(candidate => candidate.slug === appSlug)
      if (app === undefined) throw new DuetApiError(404, 'not_found')
      return { app }
    },
    listAgents: async (workspaceSlug, options = {}) => {
      /* Keep the post-registration read visibly asynchronous. Production has
         a network round trip here; an instant fixture response lets navigation
         win or lose by scheduler luck and can hide the unknown-agent flash. */
      if (registeredAgentRefetchPending) {
        registeredAgentRefetchPending = false
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      /* `id` and `slug` narrow the read on the server, and a fixture that
         ignored them answered every lookup with whichever agent happened to be
         first — so a surface that resolves one agent by id (the short session
         link's redirect does exactly that) was right here only by accident, and
         would have stayed right here while being wrong in production. */
      const matches = agents.filter(
        agent =>
          (options.id === undefined || agent.id === options.id) &&
          (options.slug === undefined || agent.slug === options.slug),
      )
      return {
        items: workspaceSlug === 'acme' ? matches.map(agent => ({ ...agent })) : [],
        nextCursor: null,
      }
    },
    openAgentOnboardingSession: async () => ({ sessionId: 'session_onboarding' }),
    listMarketplaceCatalog: async (options = {}) => {
      const items: MarketplaceListingSummary[] = [
        {
          id: 'listing-research',
          publisherSlug: 'official-agents-hub',
          verifiedPublisher: true,
          agentName: 'research',
          title: 'Research',
          summary: 'Builds source-backed research briefs with a clear review trail.',
          skills: ['Web research', 'Source comparison', 'Brief writing'],
          tags: ['marketing', 'personal'],
          appNames: ['Insights Board'],
          installs: 0,
          availability: 'available' as const,
        },
        {
          id: 'listing-brief-writer',
          publisherSlug: 'official-agents-hub',
          verifiedPublisher: true,
          agentName: 'brief-writer',
          title: 'Brief Writer',
          summary: 'Turns verified findings into concise decision-ready briefs.',
          skills: ['Brief writing', 'Executive summaries'],
          tags: ['sales'],
          appNames: [],
          installs: 0,
          availability: 'available' as const,
        },
      ]
      return {
        items: items.filter(
          listing =>
            (options.tag === undefined || listing.tags.includes(options.tag)) &&
            (options.availability === undefined || listing.availability === options.availability) &&
            (options.q === undefined ||
              `${listing.title} ${listing.summary}`
                .toLocaleLowerCase()
                .includes(options.q.toLocaleLowerCase())),
        ),
        nextCursor: null,
        meta: { canPublishListings: false },
      }
    },
    getMarketplaceListingDetail: async (publisherSlug: string, name: string) => ({
      id: `listing-${name}`,
      publisherSlug,
      verifiedPublisher: true as boolean,
      agentName: name,
      title: name,
      installs: 0,
      availability: 'available' as 'available' | 'unavailable',
      summary:
        name === 'research'
          ? 'Builds source-backed research briefs with a clear review trail.'
          : 'Turns verified findings into concise decision-ready briefs.',
      skills: name === 'research' ? ['Web research', 'Source comparison'] : ['Brief writing'],
      tags: (name === 'research' ? ['marketing', 'personal'] : ['sales']) as AgentTag[],
      apps: [],
      appNames: name === 'research' ? ['Insights Board'] : [],
      changelog:
        '### July 2026\n\n- Added a two-source verification pass.\n- Clarified evidence gaps.',
    }),
    listMarketplaceAgentSubscriptions: async workspaceSlug => {
      if (workspaceSlug !== 'acme') return { items: [], nextCursor: null }
      officialSubscriptions = officialSubscriptions.map(subscription =>
        subscription.state === 'installing'
          ? {
              ...subscription,
              agentId: subscription.agentId ?? `agent_${subscription.agentName}`,
              anchorId: subscription.anchorId ?? `anchor_${subscription.agentName}`,
              state: 'active',
              appliedEtag: 'etag-installed',
              acknowledgedEtag: 'etag-installed',
              lastAppliedAt: FIXTURE_NOW,
            }
          : subscription,
      )
      return { items: officialSubscriptions, nextCursor: null }
    },
    installMarketplaceAgent: async (_workspaceSlug, input) => {
      recordMarketplaceAgentMutation({ action: 'install', input })
      // The fixture catalog names listings `listing-<agentName>`, so the
      // listing identity is recoverable from the id the caller sent. An
      // additional instance gets its own slug from its explicit path, just as
      // production does.
      const agentName = input.listingId.replace(/^listing-/, '')
      const path = input.path ?? `agents/${agentName}`
      const instanceSlug = path.split('/').at(-1) ?? agentName
      const instanceId = `agent_${instanceSlug}`
      const subscriptionId = `subscription_${instanceSlug}`
      if (!agents.some(agent => agent.slug === instanceSlug)) {
        agents = [
          ...agents,
          {
            id: instanceId,
            workspaceId: 'workspace_acme',
            anchorId: `anchor_${instanceSlug}`,
            anchorPath: path,
            anchorState: 'active',
            slug: instanceSlug,
            name: input.name ?? agentName,
            listingSubscriptionId: subscriptionId,
            createdAt: FIXTURE_NOW,
            updatedAt: FIXTURE_NOW,
          },
        ]
      }
      const subscription: MarketplaceAgentSubscription = {
        id: subscriptionId,
        listingId: input.listingId,
        agentName,
        path,
        mode: 'subscribe',
        state: 'installing',
        agentId: instanceId,
        anchorId: `anchor_${instanceSlug}`,
      }
      officialSubscriptions = [...officialSubscriptions, subscription]
      return { subscription }
    },
    completeWorkspaceOnboarding: async (_workspaceSlug, input) => ({
      duetName: input.duetName,
      onboardedAt: 1_700_000_000_000,
      results: [],
    }),
    // Empty means "no rail" — the shell fixture keeps the team step on the
    // plain catalog; the dedicated onboarding playground mocks real picks.
    recommendOnboardingAgents: async () => ({ recommendations: [] }),
    cloneMarketplaceAgent: async (_workspaceSlug, input) => {
      recordMarketplaceAgentMutation({ action: 'clone', input })
      const agentName = input.listingId.replace(/^listing-/, '')
      return {
        subscription: {
          id: `clone_${agentName}`,
          listingId: input.listingId,
          agentName,
          path: input.path,
          mode: 'clone_once',
          state: 'detached',
        },
      }
    },
    acknowledgeMarketplaceAgent: async (_workspaceSlug, subscriptionId) => {
      const subscription = officialSubscriptions.find(candidate => candidate.id === subscriptionId)
      if (subscription === undefined) throw new DuetApiError(404, 'not_found')
      const acknowledged = { ...subscription, acknowledgedEtag: subscription.appliedEtag }
      officialSubscriptions = officialSubscriptions.map(candidate =>
        candidate.id === subscriptionId ? acknowledged : candidate,
      )
      recordMarketplaceAgentMutation({ action: 'acknowledge', subscriptionId })
      return { subscription: acknowledged }
    },
    uninstallMarketplaceAgent: async () => ({ ok: true }),
    updateAgent: async (_workspaceSlug, slug, input) => {
      const base = AGENT_FIXTURES.find(agent => agent.slug === slug) ?? AGENT_FIXTURES[0]!
      return { agent: { ...base, ...input } }
    },
    updateDefaultAgent: async (_workspaceSlug, input) => ({ name: input.name }),
    setAgentOnboarded: async (_workspaceSlug, slug) => {
      const base = AGENT_FIXTURES.find(agent => agent.slug === slug) ?? AGENT_FIXTURES[0]!
      return { agent: { ...base, onboardedAt: undefined } }
    },
    deleteAgent: async () => ({ ok: true as const }),
    listShares: async () => ({ items: [], nextCursor: null }),
    listWorkspaceSkills: async () => ({ items: FIXTURE_SKILLS, nextCursor: null }),
    readAgentRoster: async () => ({
      items: [{ slug: 'root', name: 'Duet', locked: false, relationship: 'self' as const }],
      nextCursor: null,
    }),
    listConnectedProviders: async () => [],
    connectConnectedProvider: async () => ({
      sessionId: 'provider-session-fixture',
      intervalMs: 60_000,
    }),
    pollConnectedProvider: async () => ({ status: 'pending' }),
    disconnectConnectedProvider: async () => ({ ok: true }),
    listPublishes: async () => ({
      items: PUBLISH_MANAGEMENT_FIXTURE.map(publish => ({ ...publish })),
      nextCursor: null,
    }),
    setPublishPaused: async (_workspaceSlug, slug, paused) => ({
      publish: {
        ...PUBLISH_MANAGEMENT_FIXTURE.find(publish => publish.slug === slug)!,
        pausedAt: paused ? FIXTURE_NOW : undefined,
      },
    }),
    setSharePaused: async () => {
      throw new Error('Share pause is not configured in this shell fixture')
    },
    createShare: async () => {
      throw new Error('Share creation is not configured in this shell fixture')
    },
    unlinkShare: async (_workspaceSlug, shareId) => ({
      ok: true,
      unlinkedShareIds: [shareId],
    }),
    revokeShare: async (_workspaceSlug, shareId) => ({
      ok: true,
      revokedShareIds: [shareId],
    }),
    registerApp: async (workspaceSlug, input) => {
      const app: App = {
        id: `app_${input.slug}`,
        workspaceId: 'workspace_acme',
        anchorId: `anchor_${input.slug}`,
        anchorPath: input.path,
        anchorState: 'active',
        command: input.command,
        apiScopes: input.apiScopes,
        port: input.port ?? APP_AUTO_PORT_RANGE_START,
        slug: input.slug,
        visibility: 'folder',
        canonicalUrl: canonicalAppUrl(workspaceSlug, input.slug, DUET_EDGE_HOST),
        runtimeStatus: 'reconciled',
        createdByUserId: 'user_owner',
        createdAt: 1_750_000_000_000,
        updatedAt: 1_750_000_000_000,
        controls: {
          manageDomain: true,
          updateRuntime: true,
          makePublic: true,
          makePrivate: true,
          delete: true,
        },
      }
      apps.current = [...apps.current, app]
      return { app }
    },
    updateApp: async (_workspaceSlug, appSlug, input) => {
      const app = apps.current.find(candidate => candidate.slug === appSlug)
      if (app === undefined) throw new DuetApiError(404, 'not_found')
      const updated: App = { ...app, ...input, updatedAt: app.updatedAt + 1 }
      apps.current = apps.current.map(candidate =>
        candidate.slug === appSlug ? updated : candidate,
      )
      return { app: updated }
    },
    setAppVisibility: async (_workspaceSlug, appSlug, visibility) => {
      const app = apps.current.find(candidate => candidate.slug === appSlug)
      if (app === undefined) throw new DuetApiError(404, 'not_found')
      const updated: App = { ...app, visibility }
      apps.current = apps.current.map(candidate =>
        candidate.slug === appSlug ? updated : candidate,
      )
      return { app: updated }
    },
    deleteApp: async (_workspaceSlug, appSlug) => {
      apps.current = apps.current.filter(candidate => candidate.slug !== appSlug)
      return { ok: true }
    },
    updateWorkspace: async (workspaceSlug, input) => {
      identity.current = {
        ...identity.current,
        workspaces: identity.current.workspaces.map(workspace =>
          workspace.slug === workspaceSlug
            ? { ...workspace, slug: input.slug, name: input.name }
            : workspace,
        ),
      }
    },
    setWorkspaceDefaultTier: async (workspaceSlug, tier) => {
      identity.current = {
        ...identity.current,
        workspaces: identity.current.workspaces.map(workspace =>
          workspace.slug === workspaceSlug
            ? {
                ...workspace,
                defaultTier: { configured: tier, effective: tier },
              }
            : workspace,
        ),
      }
      return { tier }
    },
    listWorkspaceMembers: async (_workspaceSlug, options = {}) => {
      recordMemberRequest({
        ...(options.search === undefined ? {} : { search: options.search }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      })
      const search = normalizeWorkspaceMemberSearch(options.search)
      if (search === 'loading') return await new Promise(() => {})
      if (search === 'page-loading' && options.cursor !== undefined)
        return await new Promise(() => {})
      if (search === 'error') throw new DuetApiError(503, 'fixture_member_search_error')
      if (search === 'page-error' && options.cursor !== undefined)
        throw new DuetApiError(503, 'fixture_member_page_error')
      const filtered =
        search === 'empty'
          ? []
          : members.current.filter(member =>
              normalizeWorkspaceMemberSearch(`${member.name ?? ''} ${member.email}`).includes(
                search === 'page-error' || search === 'page-loading' ? '' : search,
              ),
            )
      if (options.limit !== 20) return { items: filtered, nextCursor: null }
      const offset =
        options.cursor === undefined ? 0 : Number(options.cursor.split(':').at(-1) ?? 0)
      const nextOffset = offset + 2
      return {
        items: filtered.slice(offset, nextOffset),
        nextCursor: filtered.length > nextOffset ? `members:${nextOffset}` : null,
      }
    },
    updateWorkspaceMember: async (_workspaceSlug, userId, role) => {
      const member = members.current.find(candidate => candidate.id === userId)!
      member.role = role
      return { member }
    },
    removeWorkspaceMember: async (_workspaceSlug, userId) => {
      members.current = members.current.filter(member => member.id !== userId)
      return { removed: true }
    },
    setWorkspaceBillingUser: async (workspaceSlug, userId) => {
      members.current = members.current.map(member => ({
        ...member,
        isBillingUser: member.id === userId,
      }))
      identity.current = {
        ...identity.current,
        workspaces: identity.current.workspaces.map(workspace =>
          workspace.slug === workspaceSlug ? { ...workspace, billingUserId: userId } : workspace,
        ),
      }
      return {
        billingUserId: userId,
        member: members.current.find(member => member.id === userId)!,
      }
    },
    listIncomingInvitations: async () => ({ items: [], nextCursor: null }),
    acceptInvitation: async () => {
      throw new DuetApiError(404, 'invitation_unavailable')
    },
    listWorkspaceInvites: async () => ({
      items: [
        {
          id: 'invite_1',
          email: 'katherine@example.com',
          role: 'editor',
          expiresAt: OPEN_INVITE_EXPIRY,
        },
      ],
      nextCursor: null,
    }),
    createWorkspaceInvite: async (_workspaceSlug, input) => ({
      id: 'invite_new',
      ...input,
      expiresAt: OPEN_INVITE_EXPIRY,
    }),
    revokeWorkspaceInvite: async () => ({ revokedAt: Date.UTC(2026, 6, 11, 9) }),
    listWorkspaceAudit: async (_workspaceSlug, options = {}) => {
      if (options.cursor !== undefined) {
        workspaceAuditContinuationAttempts += 1
        await new Promise(resolve => setTimeout(resolve, 500))
        if (workspaceAuditContinuationAttempts === 1) {
          throw new DuetApiError(503, 'fixture_audit_page_error')
        }
        return {
          items: [
            {
              id: 'audit_1',
              event: 'api_key.issued',
              actorId: 'user_owner',
              at: Date.UTC(2026, 6, 8, 9),
            },
          ],
          nextCursor: null,
        }
      }
      return {
        items: [
          {
            id: 'audit_3',
            event: 'workspace.billing_user_changed',
            actorId: 'user_owner',
            at: Date.UTC(2026, 6, 11, 8, 45),
          },
          {
            id: 'audit_2',
            event: 'workspace.member_role_changed',
            actorId: 'user_owner',
            at: Date.UTC(2026, 6, 10, 16, 20),
          },
        ],
        nextCursor: 'audit:older',
      }
    },
    workspaceUsage: async () => ({
      period: 'monthly',
      group: 'workspace',
      rows: [{ workspaceId: 'workspace_acme', period: '2026-07', spendMicroUsd: 18_420_000 }],
    }),
    workspaceTelemetry: async () => ({ samples: TELEMETRY_FIXTURES }),
    workspaceLedger: async () => ({
      items: [
        {
          id: 'txn_usage_1',
          amountMicroUsd: -420_000,
          type: 'usage' as const,
          actorUserId: 'user_owner',
          createdAt: Date.UTC(2026, 6, 9, 15),
        },
        {
          id: 'txn_grant_1',
          amountMicroUsd: 5_000_000,
          type: 'grant' as const,
          createdAt: Date.UTC(2026, 6, 1, 12),
        },
      ],
      nextCursor: null,
    }),
    userProfile: async () => profile.current,
    sendFeedback: async () => {},
    updateUserProfile: async input => {
      profile.current = {
        ...profile.current,
        ...input,
        name: [input.firstName, input.lastName].filter(Boolean).join(' '),
      }
      return profile.current
    },
    userBilling: async () => ({
      autoTopupEnabled: true,
      autoTopupThresholdMicroUsd: 5_000_000,
      autoTopupAmountMicroUsd: 20_000_000,
      maxMonthlySpendMicroUsd: 250_000_000,
      monthlySpendMicroUsd: 42_680_000,
      monthlySpendPeriodKey: '2026-07',
      balanceMicroUsd: 117_320_000,
      paidCreditBalanceMicroUsd: 117_320_000,
      monthlyCreditBalanceMicroUsd: 0,
      subscription: null,
      trial: { status: 'ended' },
      consecutiveTopupFailures: 0,
      firstPaidAt: Date.UTC(2026, 4, 3),
      hasPaymentMethod: true,
      workspaces: identity.current.workspaces
        .filter(workspace => workspace.billingUserId === identity.current.user.id)
        .map(({ id, slug, name }) => ({
          id,
          slug,
          name,
          storage: {
            usableGb: 20,
            plan: 'starter' as const,
            nextPlan: 'pro' as const,
            nextUsableGb: 50,
          },
        })),
    }),
    updateUserBilling: async input => ({
      autoTopupEnabled: input.autoTopupEnabled,
      autoTopupThresholdMicroUsd: input.autoTopupThresholdMicroUsd ?? 5_000_000,
      autoTopupAmountMicroUsd: input.autoTopupAmountMicroUsd,
      maxMonthlySpendMicroUsd: input.maxMonthlySpendMicroUsd ?? undefined,
      monthlySpendMicroUsd: 42_680_000,
      monthlySpendPeriodKey: '2026-07',
      balanceMicroUsd: 117_320_000,
      paidCreditBalanceMicroUsd: 117_320_000,
      monthlyCreditBalanceMicroUsd: 0,
      subscription: null,
      trial: { status: 'ended' },
      consecutiveTopupFailures: 0,
      firstPaidAt: Date.UTC(2026, 4, 3),
      hasPaymentMethod: true,
      workspaces: [
        {
          id: 'workspace_acme',
          slug: 'acme',
          name: 'Acme Studio',
          storage: {
            usableGb: 20,
            plan: 'starter' as const,
            nextPlan: 'pro' as const,
            nextUsableGb: 50,
          },
        },
      ],
    }),
    billingHistory: async () => ({
      items: [
        {
          id: 'txn_1',
          scope: 'workspace',
          workspaceId: 'workspace_acme',
          workspaceName: 'Acme Studio',
          amountMicroUsd: -8_420_000,
          type: 'usage',
          createdAt: Date.UTC(2026, 6, 10, 18),
        },
        {
          id: 'txn_2',
          scope: 'workspace',
          workspaceId: 'workspace_labs',
          workspaceName: 'Duet Labs',
          amountMicroUsd: 20_000_000,
          type: 'topup',
          createdAt: Date.UTC(2026, 6, 8, 11),
        },
      ],
      nextCursor: null,
    }),
    createBillingCheckout: async () => ({ url: 'https://checkout.stripe.com/fixture' }),
    createSubscriptionCheckout: async () => ({ url: 'https://checkout.stripe.com/subscription' }),
    changeSubscriptionPlan: async () => ({ ok: true as const }),
    createBillingPortal: async workspaceSlug => {
      const mode = (globalThis as { __billingPortalMode?: 'pending' | 'error' }).__billingPortalMode
      if (mode === 'pending') return await new Promise<never>(() => {})
      if (mode === 'error') throw new Error('Fixture billing portal unavailable')
      return {
        url: `https://billing.stripe.com/fixture?workspace=${encodeURIComponent(workspaceSlug)}`,
      }
    },
    listUserApiKeys: async () => ({ items: userKeys.current, nextCursor: null }),
    issueUserApiKey: async input => {
      const record = {
        id: 'key_new',
        name: input.name,
        prefix: 'duet_sk_29a8cdef',
        createdAt: Date.UTC(2026, 6, 11, 9),
      }
      userKeys.current = [record, ...userKeys.current]
      return { key: 'duet_sk_29a8cdef0123456789fixture', record }
    },
    revokeUserApiKey: async keyId => {
      const key = userKeys.current.find(candidate => candidate.id === keyId)!
      const revokedAt = Date.UTC(2026, 6, 11, 9, 30)
      userKeys.current = userKeys.current.map(candidate =>
        candidate.id === keyId ? { ...candidate, revokedAt } : candidate,
      )
      return { prefix: key.prefix, revokedAt }
    },
    listOAuthGrants: async () => ({ items: oauthGrants.current, nextCursor: null }),
    revokeOAuthGrant: async grantId => {
      const revokedAt =
        oauthGrants.current.find(candidate => candidate.id === grantId)?.revokedAt ??
        Date.UTC(2026, 6, 18, 9)
      oauthGrants.current = oauthGrants.current.map(candidate =>
        candidate.id === grantId ? { ...candidate, revokedAt } : candidate,
      )
      return { grantId, revokedAt }
    },
    listSyncMachines: async () => ({ items: syncMachines.current, nextCursor: null }),
    removeSyncMachine: async machineId => {
      const removedAt = Date.UTC(2026, 6, 11, 9, 45)
      syncMachines.current = syncMachines.current.map(candidate =>
        candidate.machineId === machineId ? { ...candidate, removedAt } : candidate,
      )
      return { ok: true, machineId, removedAt }
    },
    listIntegrationCatalog: async (_workspaceSlug, query) => {
      query ??= {}
      const all = [
        {
          integration: 'gmail',
          name: 'Gmail',
          logoUrl: '/playground/provider-gmail.webp',
          connected: true,
        },
        {
          integration: 'github',
          name: 'GitHub',
          logoUrl: '/playground/provider-github.webp',
          connected: true,
        },
        {
          integration: 'slack',
          name: 'Slack',
          logoUrl: '/playground/provider-slack.webp',
          connected: true,
        },
        {
          integration: 'notion',
          name: 'Notion',
          logoUrl: '/playground/provider-notion.webp',
          connected: false,
        },
        {
          integration: 'googlecalendar',
          name: 'Google Calendar',
          logoUrl: '/playground/provider-googlecalendar.webp',
          connected: false,
        },
        {
          integration: 'linear',
          name: 'Linear',
          logoUrl: '/playground/provider-linear.webp',
          connected: false,
        },
        {
          integration: 'hubspot',
          name: 'HubSpot',
          logoUrl: '/playground/provider-hubspot.webp',
          connected: false,
        },
        {
          integration: 'googledrive',
          name: 'Google Drive',
          logoUrl: '/playground/provider-googledrive.webp',
          connected: false,
        },
      ]
      const filtered = query.q
        ? all.filter(item => item.name.toLowerCase().includes(query.q!.toLowerCase()))
        : all
      return {
        items: query.cursor ? filtered.slice(6) : filtered.slice(0, 6),
        nextCursor: filtered.length > 6 && !query.cursor ? 'catalog-page-2' : null,
      }
    },
    listIntegrationConnections: async () => ({ items: integrationConnections, nextCursor: null }),
    connectIntegration: async (_workspaceSlug, input) => ({
      integration: input.integration,
      authorizeUrl: `https://connect.example.test/${input.integration}`,
    }),
    disconnectIntegration: async (_workspaceSlug, connectionId) => {
      const existed = integrationConnections.some(connection => connection.id === connectionId)
      integrationConnections = integrationConnections.filter(
        connection => connection.id !== connectionId,
      )
      return { id: connectionId, disconnected: existed }
    },
    setIntegrationAgentPolicy: async (_workspaceSlug, integration, input) => {
      recordIntegrationPolicyMutation({ integration, input })
      integrationConnections = integrationConnections.map(connection => {
        if (connection.integration !== integration) return connection
        const next = { ...connection }
        delete next.allowedAgentIds
        if (input.allowedAgentIds !== undefined) next.allowedAgentIds = input.allowedAgentIds
        return next
      })
      return input.allowedAgentIds === undefined
        ? { integration }
        : { integration, allowedAgentIds: input.allowedAgentIds }
    },
    listMcpServers: async () => ({ items: mcpServers, nextCursor: null }),
    probeMcpServer: async () => ({
      auth: 'none' as const,
      toolCount: 8,
      estimatedPromptBytes: 3_600,
    }),
    addMcpServer: async (_workspaceSlug, input) => {
      const server: McpServer = {
        name: input.name,
        label: input.label ?? input.name,
        url: input.url,
        authKind: input.auth?.kind ?? 'none',
        state: input.auth?.kind === 'oauth' ? 'needs_auth' : 'ready',
        ...(input.auth?.kind === 'oauth' ? {} : { toolCount: 8, estimatedPromptBytes: 3_600 }),
        createdAt: FIXTURE_NOW,
        updatedAt: FIXTURE_NOW,
      }
      mcpServers = [...mcpServers, server]
      return server
    },
    connectMcpServer: async (_workspaceSlug, name) => ({
      authorizeUrl: `https://consent.example.test/${name}/authorize`,
    }),
    removeMcpServer: async (_workspaceSlug, name) => {
      const removed = mcpServers.some(server => server.name === name)
      mcpServers = mcpServers.filter(server => server.name !== name)
      return { name, removed, revoked: 'revoked' as const, registration: 'deleted' as const }
    },
    setMcpServerAgentPolicy: async (_workspaceSlug, name, input) => {
      mcpServers = mcpServers.map(server => {
        if (server.name !== name) return server
        const next = { ...server }
        delete next.allowedAgentIds
        if (input.allowedAgentIds !== undefined) next.allowedAgentIds = input.allowedAgentIds
        return next
      })
      return input.allowedAgentIds === undefined
        ? { name }
        : { name, allowedAgentIds: input.allowedAgentIds }
    },
    internalAdminCreateUser: async ({ email }) => ({
      userId: 'user_new',
      email,
      workspaceId: 'workspace_new',
      workspaceSlug: 'new-workspace',
    }),
    internalAdminUserCleanupPreview: async () => ({
      user: { userId: 'user_owner', email: 'owner@acme.test' }, selfTarget: false,
      alreadyRetired: false, canStart: true, workspaces: [], blockers: [],
      identity: { kind: 'retire_identity', userId: 'user_owner' },
      retainedHistory: { kind: 'retained_history', tables: [] }, auditId: 'cleanup_preview',
    }),
    internalAdminStartUserCleanup: async () => ({
      operationId: 'cleanup_fixture', targetUserId: 'user_owner', status: 'scheduled',
      canRetry: false, resources: [], auditId: 'cleanup_start',
    }),
    internalAdminCleanupStatus: async () => ({
      operationId: 'cleanup_fixture', targetUserId: 'user_owner', status: 'completed',
      canRetry: false, resources: [], auditId: 'cleanup_status',
    }),
    internalAdminRetryUserCleanup: async () => ({
      operationId: 'cleanup_fixture', targetUserId: 'user_owner', status: 'scheduled',
      canRetry: false, resources: [], auditId: 'cleanup_retry',
    }),
    internalAdminSearch: async () => ({
      auditId: 'admin_audit_search',
      workspaces: [
        {
          id: 'workspace_acme',
          slug: 'acme',
          name: 'Acme Studio',
          status: 'active',
          servicingStatus: 'active',
          suspended: false,
          billingUserId: 'user_owner',
          billingEmail: 'owner@acme.test',
          stripeCustomerId: 'cus_acme_fixture',
          paidCreditBalanceMicroUsd: 117_320_000,
          monthlyCreditBalanceMicroUsd: 42_000_000,
          memberCount: 3,
          vmName: 'duet-acme',
          sshDest: 'duet-acme.exe.xyz',
          runtimeVersion: CURRENT_RUNTIME_VERSION,
          imageVersion: '2026.07.10',
          lastHeartbeatAt: Date.UTC(2026, 6, 11, 9, 25),
        },
      ],
    }),
    internalAdminOpenOfficialHub: async () => ({
      token: 'duet_imp_fixture',
      prefix: 'duet_imp_fixt',
      expiresAt: Date.UTC(2026, 6, 11, 11),
      userId: 'user_official_owner',
      workspaceSlug: 'official-agents-hub',
      created: false,
    }),
    internalAdminSyncOfficialHub: async () => ({
      workspaceId: 'workspace_official_hub',
      workspaceSlug: 'official-agents-hub',
      publishId: 'publish_official_agents',
      written: [],
      deleted: [],
      retiredAgents: [],
    }),
    internalAdminWorkspace: async () => ({
      auditId: 'admin_audit_workspace',
      workspace: {
        id: 'workspace_acme',
        slug: 'acme',
        name: 'Acme Studio',
        status: 'active',
        servicingStatus: 'active',
        suspended: false,
        billingUserId: 'user_owner',
        billingEmail: 'owner@acme.test',
        stripeCustomerId: 'cus_acme_fixture',
        paidCreditBalanceMicroUsd: 117_320_000,
        monthlyCreditBalanceMicroUsd: 42_000_000,
        memberCount: 3,
        vmName: 'duet-acme',
        sshDest: 'duet-acme.exe.xyz',
        runtimeVersion: CURRENT_RUNTIME_VERSION,
        imageVersion: '2026.07.10',
      },
      usage: {
        month: '2026-07',
        spendMicroUsd: 42_680_000,
        inputTokens: 8_420_000,
        outputTokens: 1_120_000,
        members: [
          {
            userId: 'user_owner',
            email: 'owner@acme.test',
            name: 'Avery Chen',
            role: 'owner',
            spendMicroUsd: 31_200_000,
            inputTokens: 6_200_000,
            outputTokens: 820_000,
          },
          {
            userId: 'user_editor',
            email: 'ops@acme.test',
            name: 'Mina Park',
            role: 'editor',
            spendMicroUsd: 11_480_000,
            inputTokens: 2_220_000,
            outputTokens: 300_000,
          },
          {
            userId: 'user_viewer',
            email: 'finance@acme.test',
            role: 'viewer',
            spendMicroUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
        ],
      },
      ledger: [
        {
          id: 'ledger_1',
          amountMicroUsd: -8_420_000,
          type: 'usage',
          reference: 'generation:session_live',
          createdAt: Date.UTC(2026, 6, 10, 18),
        },
        {
          id: 'ledger_2',
          amountMicroUsd: 20_000_000,
          type: 'topup',
          reference: 'stripe:pi_fixture',
          createdAt: Date.UTC(2026, 6, 8, 11),
        },
      ],
      syncHealth: {
        batches: 42,
        droppedReads: 3,
        overflow: 0,
        lastRecordedAt: Date.UTC(2026, 6, 10, 18, 30),
      },
    }),
    internalAdminFeedback: async archived => ({
      auditId: 'admin_audit_feedback',
      feedback: archived
        ? []
        : [
            {
              id: 'feedback_1',
              content:
                'The session timeline is much easier to follow now. I would still love a compact density option.',
              source: 'web',
              createdAt: Date.UTC(2026, 6, 11, 7, 30),
            },
            {
              id: 'feedback_2',
              content: 'Train accepted the handbook and correctly retained the policy exceptions.',
              source: 'duet-agent-cli',
              createdAt: Date.UTC(2026, 6, 10, 15, 10),
            },
          ],
    }),
    internalAdminMutateFeedback: async () => ({
      ok: true,
      auditId: 'admin_audit_feedback_mutation',
    }),
    internalAdminFreeCredits: async () => ({
      totalFreeCreditsMicroUsd: 842_000_000,
      unpaidUserCount: 18,
      usersWithBalanceCount: 12,
      auditId: 'admin_audit_credits',
    }),
    internalAdminTakedownListing: async () => ({
      ok: true as const,
      auditId: 'audit_takedown',
      detached: 0,
      remaining: false,
    }),
    internalAdminResetFreeCredits: async () => ({ ok: true, auditId: 'admin_audit_reset' }),
    internalAdminVmUpdates: async () => ({ paused: false, auditId: 'admin_audit_vm_updates' }),
    internalAdminSetVmUpdates: async () => ({ ok: true, auditId: 'admin_audit_vm_updates_flip' }),
    internalAdminFleetHealth: async () => ({
      generatedAt: 0,
      activeCount: 0,
      truncated: false,
      versions: { runtime: [] },
      staleHeartbeatCount: 0,
      updates: { paused: false },
      telemetry: { withSample: 0, missing: 0 },
      vms: [],
      auditId: 'admin_audit_fleet',
    }),
    internalAdminInferenceMargin: async granularity => ({
      granularity,
      window: { start: '', end: '' },
      olderThrough: 0,
      totals: { calls: 0, upstreamCostMicroUsd: 0, billedCostMicroUsd: 0 },
      periods: [],
      models: [],
      truncated: false,
      auditId: 'admin_audit_inference_margin',
    }),
    internalAdminModelRouterPolicy: async () => ({
      version: 1 as const,
      rules: [],
      updatedAt: 0,
      auditId: 'admin_audit_model_router',
    }),
    internalAdminSetModelRouterPolicy: async input => ({
      version: 1 as const,
      rules: input.rules,
      updatedAt: 0,
      auditId: 'admin_audit_model_router_save',
    }),
    internalAdminMutateWorkspace: async () => ({
      ok: true,
      auditId: 'admin_audit_workspace_mutation',
    }),
    internalAdminVmStatus: async () => ({
      workspaceId: 'workspace_acme',
      vmName: 'duet-acme',
      controlStatus: 'running',
      gateway: {
        reachable: true,
        runtimeVersion: CURRENT_RUNTIME_VERSION,
        imageVersion: '2026.07.10',
        uptimeSeconds: 93_420,
      },
      auditId: 'admin_audit_vm',
    }),
    internalAdminVmOperation: async () => ({
      ok: true,
      status: 'completed',
      auditId: 'admin_audit_vm_operation',
    }),
    internalAdminVmBackup: async () => {
      throw new Error('No backup has been admitted in this fixture')
    },
    internalAdminFiles: async (_workspaceId, path = '') => ({
      path,
      truncated: false,
      auditId: 'admin_audit_files',
      entries: path
        ? [{ name: 'report.md', path: `${path}/report.md`, kind: 'file', size: 1840 }]
        : [
            { name: 'projects', path: 'projects', kind: 'directory' },
            { name: 'README.md', path: 'README.md', kind: 'file', size: 940 },
          ],
    }),
    internalAdminFile: async (_workspaceId, path) => ({
      path,
      content: '# Acme operations\n\nCustomer workspace health notes.\n',
      byteLength: 52,
      truncated: false,
      auditId: 'admin_audit_file',
    }),
    internalAdminLogs: async (_workspaceId, source, anchorId) => ({
      source,
      ...(anchorId === undefined ? {} : { anchorId }),
      path: source === 'gateway' ? 'logs/gateway.log' : `logs/agents/${anchorId}.log`,
      content: '[gateway] healthy\n',
      byteLength: 18,
      truncated: false,
      available: [{ source: 'gateway', byteLength: 18 }],
      auditId: 'admin_audit_logs',
    }),
    internalAdminCommand: async (_workspaceId, command) => ({
      command,
      stdout: ' 09:30:14 up 1 day,  2 users,  load average: 0.18, 0.22, 0.20\n',
      stderr: '',
      exitCode: 0,
      durationMs: 84,
      truncated: false,
      auditId: 'admin_audit_command',
    }),
    startTraining: async () => {
      startedTrainingJob = {
        jobId: 'train_fixture_queued',
        userId: 'user_demo',
        workspaceId: 'workspace_acme',
        state: 'queued',
        phase: 'preparing',
        createdAt: Date.UTC(2026, 6, 11, 8, 30),
        updatedAt: Date.UTC(2026, 6, 11, 8, 30),
      }
      return { jobId: startedTrainingJob.jobId, job: startedTrainingJob }
    },
    listTrainJobs: async () => ({
      items: [
        ...(startedTrainingJob === undefined ? [] : [startedTrainingJob]),
        {
          jobId: 'train_running_01',
          userId: 'user_demo',
          workspaceId: 'workspace_acme',
          state: 'running',
          phase: 'training',
          createdAt: Date.UTC(2026, 6, 11, 8, 15),
          updatedAt: Date.UTC(2026, 6, 11, 8, 19),
          startedAt: Date.UTC(2026, 6, 11, 8, 16),
        },
        {
          jobId: 'train_completed_01',
          userId: 'user_demo',
          workspaceId: 'workspace_acme',
          state: 'done',
          phase: 'done',
          createdAt: Date.UTC(2026, 6, 10, 12),
          updatedAt: Date.UTC(2026, 6, 10, 12, 4),
          completedAt: Date.UTC(2026, 6, 10, 12, 4),
        },
        {
          jobId: 'train_failed_01',
          userId: 'user_demo',
          workspaceId: 'workspace_acme',
          state: 'failed',
          phase: 'failed',
          error: 'One source could not be reached.',
          createdAt: Date.UTC(2026, 6, 9, 9),
          updatedAt: Date.UTC(2026, 6, 9, 9, 1),
          completedAt: Date.UTC(2026, 6, 9, 9, 1),
        },
      ],
      nextCursor: null,
    }),
    getTrainJob: async (_workspaceSlug, jobId) => ({
      job: {
        jobId,
        userId: 'user_demo',
        workspaceId: 'workspace_acme',
        state: 'done',
        phase: 'done',
        createdAt: Date.UTC(2026, 6, 10, 12),
        updatedAt: Date.UTC(2026, 6, 10, 12, 4),
      },
    }),
    listTrainRecords: async () => ({
      items: [
        {
          slug: 'support-handbook-2026',
          memoryId: 'mem_support',
          createdAt: '2026-07-10T12:04:00.000Z',
          observedDate: '2026-07-10',
          headline: 'Customer support handbook and escalation practices',
          model: 'openai/gpt-5.6-luna',
          fileCount: 14,
          hasArchive: true,
        },
        {
          slug: 'product-context',
          memoryId: 'mem_product',
          createdAt: '2026-07-08T09:30:00.000Z',
          observedDate: '2026-07-08',
          headline: 'Product positioning and launch context',
          fileCount: 4,
          hasArchive: true,
        },
      ],
      nextCursor: null,
    }),
    listTrainMemoryCounts: async () => ({
      rootCount: 2,
      trainableAgents: agents.map(agent => agent.slug),
      counts: Object.fromEntries(
        agents.map(agent => [agent.slug, agent.slug === 'research' ? 2 : 0]),
      ),
    }),
    getTrainRecord: async (_workspaceSlug, slug) => ({
      record: {
        slug,
        memoryId: 'mem_support',
        createdAt: '2026-07-10T12:04:00.000Z',
        observedDate: '2026-07-10',
        headline: 'Customer support handbook and escalation practices',
        model: 'openai/gpt-5.6-luna',
        fileCount: 14,
        hasArchive: true,
        content:
          'Support requests are acknowledged within one business day. Escalate security incidents immediately to the incident commander.\n\nEnterprise customers receive a named owner for critical incidents.',
      },
    }),
    updateTrainRecord: async (_workspaceSlug, slug, content) => ({
      record: {
        slug,
        memoryId: 'mem_support',
        createdAt: '2026-07-10T12:04:00.000Z',
        observedDate: '2026-07-10',
        headline: 'Customer support handbook and escalation practices',
        model: 'openai/gpt-5.6-luna',
        fileCount: 14,
        hasArchive: true,
        content,
      },
    }),
    deleteTrainRecord: async (_workspaceSlug, slug) => ({
      deleted: true,
      slug,
      memoryId: 'mem_support',
    }),
    restageTrainRecord: async () => ({ staged: 14, rescraped: 3, fellBack: [] }),
    listSessions: async (_workspaceSlug, query) => {
      query ??= {}
      let sessions = [...sessionStore.current.sessions]
      if (query.search)
        sessions = sessions.filter(session =>
          session.title.toLowerCase().includes(query.search!.toLowerCase()),
        )
      if (query.bucket) sessions = sessions.filter(session => session.bucket === query.bucket)
      if (query.agentId !== undefined)
        sessions = sessions.filter(
          session => (session.agent?.id ?? ROOT_AGENT_SCOPE) === query.agentId,
        )
      if (query.topLevel === true)
        sessions = sessions.filter(session => session.createdBySessionId === undefined)
      /* The owner's own chat, withheld exactly as the server withholds it — the
         jobs dialog asks for this, because that thread has a panel of its own
         beside the list. Modelled here rather than ignored because a fixture
         that answers with *more* than production is a fixture that cannot fail:
         the dialog decided membership from this list for a while, and every
         screenshot said it was fine because the fixture never withheld the one
         row the server always does. `defaultSessionOf` is the same rule
         `getDefaultSession` answers with, so the two endpoints agree. */
      if (query.excludeDefault === true) {
        const own = defaultSessionOf(sessionStore.current, query.agentId ?? ROOT_AGENT_SCOPE)?.id
        if (own !== undefined) sessions = sessions.filter(session => session.id !== own)
      }
      sessions = sessions.filter(session =>
        query.archived === 'only'
          ? session.archive.reason !== null
          : session.archive.reason === null,
      )
      /* Paged by what the caller asked for, not by a number of this stub's own.
         It used to hand back three rows whatever the limit was, which made every
         surface that asks for twelve look like a surface with three
         conversations and one more page — and the Work rail hid that by
         draining pages until its rail was full. The drain is gone (nothing
         filters these rows client-side any more), so the lie is visible, and the
         fix is for the stub to answer the question it was asked. A scenario that
         wants a short page still forces one by overriding this endpoint. */
      const limit = query.limit ?? 3
      const page = query.cursor ? sessions.slice(limit) : sessions.slice(0, limit)
      return {
        items: page,
        nextCursor: sessions.length > limit && !query.cursor ? 'page-2' : null,
      }
    },
    listSessionChildren: async (_workspaceSlug, sessionId, query) => {
      query ??= {}
      let sessions = sessionStore.current.sessions.filter(
        session => session.createdBySessionId === sessionId,
      )
      if (query.bucket) sessions = sessions.filter(session => session.bucket === query.bucket)
      sessions = sessions.filter(session =>
        query.archived === 'only'
          ? session.archive.reason !== null
          : session.archive.reason === null,
      )
      const page = query.cursor ? sessions.slice(3) : sessions.slice(0, 3)
      return {
        items: page,
        nextCursor: sessions.length > 3 && !query.cursor ? 'page-2' : null,
      }
    },
    getSession: async (_workspaceSlug, sessionId) => {
      const snapshot = sessionStore.current.snapshots[sessionId]
      if (!snapshot) throw new DuetApiError(404, 'not_found')
      return snapshot
    },
    getDefaultSession: async (_workspaceSlug, agentSlug) => {
      const agentId =
        agentSlug === null ? undefined : AGENT_FIXTURES.find(agent => agent.slug === agentSlug)?.id
      const summary = defaultSessionOf(sessionStore.current, agentId ?? ROOT_AGENT_SCOPE)
      if (summary === undefined) return null
      return sessionStore.current.snapshots[summary.id]!
    },
    getSessionHistory: async (_workspaceSlug, sessionId, query = {}) => {
      if (sessionId === 'session_live' && query.cursor !== undefined)
        return {
          items: fixturePromptEvents(
            'Build a launch readiness report from the staging checks.',
            true,
          ).slice(0, 1),
          nextCursor: null,
        }
      const history = sessionStore.current.history[sessionId]
      return {
        items: [...(history?.events ?? [])].toReversed(),
        nextCursor: sessionId === 'session_live' ? 'session-live-older' : null,
      }
    },
    getSessionAudience: async () => ({ items: [], nextCursor: null }),
    updateSessionAudience: async (_workspaceSlug, sessionId) => {
      const snapshot = sessionStore.current.snapshots[sessionId]
      if (!snapshot) throw new DuetApiError(404, 'not_found')
      return snapshot
    },
    createSession: async (_workspaceSlug, input) => {
      recordSessionInput({ kind: 'create', input })
      return mintSession(input)
    },
    /* One endpoint, the server's own two-step: a message into an agent's
       default chat lands on the session that is that chat, and the first
       message ever sent mints it — attributed to the agent, in the agent's
       anchor — and answers with the create response. Throwing here was a stub
       from before the agent surface had an address; now that `/agents/:slug`
       mounts this chat, the fixture has to keep the server's promise. */
    sendDefaultSessionMessage: async (_workspaceSlug, agentSlug, input) => {
      const agent =
        agentSlug === null ? undefined : AGENT_FIXTURES.find(entry => entry.slug === agentSlug)
      if (agentSlug !== null && agent === undefined) throw new DuetApiError(404, 'not_found')
      const owner = agent?.id ?? ROOT_AGENT_SCOPE
      const existing = defaultSessionOf(sessionStore.current, owner)
      if (existing !== undefined) {
        recordSessionInput({ kind: 'message', input })
        appendFixtureEvent(sessionStore.current, existing.id, {
          type: 'prompt_submitted',
          prompt: input.prompt,
          inputKind: 'message',
          behavior: input.behavior ?? 'steer',
          sender: FIXTURE_VIEWER_SENDER,
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
          ...fixtureInputEventImages(input.images),
        })
        setFixtureSessionStatus(sessionStore.current, existing.id, 'running')
        return { ok: true, delivery: 'accepted', sessionId: existing.id }
      }
      recordSessionInput({ kind: 'create', input })
      const minted = mintSession({
        ...input,
        ...(agent === undefined ? {} : { cwd: agent.anchorPath }),
      })
      // The same request that creates the row stamps the pointer at it, exactly
      // as delivery does — which is what makes the next read resolve to it.
      stampDefaultSession(sessionStore.current, owner, minted.session.sessionId)
      return minted
    },
    /* Move the pointer, or clear it. Clearing is the product's whole gesture:
       the conversation stays, keeps running and re-enters `listSessions`, and
       the owner's panel falls back to its day-one empty state. The answer is
       the read's own body so the caller sees the pointer's new state. */
    setDefaultSession: async (_workspaceSlug, agentSlug, sessionId) => {
      const agent =
        agentSlug === ROOT_AGENT_SCOPE
          ? undefined
          : AGENT_FIXTURES.find(entry => entry.slug === agentSlug)
      if (agentSlug !== ROOT_AGENT_SCOPE && agent === undefined)
        throw new DuetApiError(404, 'not_found')
      const owner = agent?.id ?? ROOT_AGENT_SCOPE
      if (sessionId !== null && sessionStore.current.snapshots[sessionId] === undefined)
        throw new DuetApiError(404, 'not_found')
      stampDefaultSession(sessionStore.current, owner, sessionId)
      const summary = defaultSessionOf(sessionStore.current, owner)
      return summary === undefined ? null : sessionStore.current.snapshots[summary.id]!
    },
    sendSessionMessage: async (_workspaceSlug, sessionId, input) => {
      recordSessionInput({ kind: 'message', input })
      appendFixtureEvent(sessionStore.current, sessionId, {
        type: 'prompt_submitted',
        prompt: input.prompt,
        inputKind: 'message',
        behavior: input.behavior ?? 'steer',
        sender: FIXTURE_VIEWER_SENDER,
        ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
        ...fixtureInputEventImages(input.images),
      })
      setFixtureSessionStatus(sessionStore.current, sessionId, 'running')
      return { ok: true, delivery: 'accepted' }
    },
    addSessionNote: async (_workspaceSlug, sessionId, input) => {
      recordSessionInput({ kind: 'note', input })
      return {
        seq: appendFixtureEvent(sessionStore.current, sessionId, {
          type: 'note_submitted',
          note: input.note,
          sender: FIXTURE_VIEWER_SENDER,
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
          ...fixtureInputEventImages(input.images),
        }),
      }
    },
    answerSession: async (_workspaceSlug, sessionId, input) => {
      recordSessionInput({ kind: 'answer', input })
      appendFixtureEvent(sessionStore.current, sessionId, {
        type: 'answer_submitted',
        answer: input.answer,
        sender: FIXTURE_VIEWER_SENDER,
        ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
        ...fixtureInputEventImages(input.images),
      })
      // The next turn starts streaming right away, so the running surface has
      // an open draft — and with it the counting "thinking for" line, pinned
      // by the playground clock.
      appendFixtureEvent(sessionStore.current, sessionId, { type: 'turn_started' })
      appendFixtureEvent(sessionStore.current, sessionId, {
        type: 'step',
        step: { type: 'text_delta', delta: 'Drafting the rollout handoff…' },
      })
      setFixtureSessionStatus(sessionStore.current, sessionId, 'running')
      return { ok: true, delivery: 'accepted' }
    },
    interruptSession: async (_workspaceSlug, sessionId) => {
      appendFixtureEvent(sessionStore.current, sessionId, {
        type: 'interrupt_requested',
        requestedAt: '2026-07-11T00:03:00.000Z',
      })
      appendFixtureEvent(sessionStore.current, sessionId, {
        type: 'interrupted',
      })
      setFixtureSessionStatus(sessionStore.current, sessionId, 'interrupted')
      return { ok: true }
    },
    renameSession: async (_workspaceSlug, sessionId, title) =>
      updateFixtureSession(sessionStore.current, sessionId, {
        title,
        titleOrigin: 'manual',
        titleStatus: 'complete',
      }),
    archiveSession: async (_workspaceSlug, sessionId, kind, archived) => {
      const current = sessionStore.current.sessions.find(session => session.id === sessionId)!
      const globalArchivedAt =
        kind === 'global' ? (archived ? FIXTURE_NOW : null) : current.archive.globalArchivedAt
      const personalArchivedAt =
        kind === 'personal' ? (archived ? FIXTURE_NOW : null) : current.archive.personalArchivedAt
      return updateFixtureSession(sessionStore.current, sessionId, {
        archive: {
          globalArchivedAt,
          personalArchivedAt,
          reason:
            globalArchivedAt !== null ? 'global' : personalArchivedAt !== null ? 'personal' : null,
        },
      })
    },
    /* No cursor store — one boolean, because that is all the wire carries. The
       stamp clears the dot exactly the way the product does, so a playground
       shot of an unread row is a shot of a row that can still be read. */
    /* The ring's read, grouped the way the wire groups it. The playground's
       store is small enough that no cap is ever reached, so `more` is zero and
       `capped` is false — a fixture that faked a cap would be drawing a state
       this store cannot produce. */
    listSessionActivity: async () => {
      /* Every owner the store has a row for, plus every owner the *pointer* has
         one for: an owner whose only session is its own chat still has a face to
         draw, and dropping it here is how a drive of agents nobody has given
         work to comes back empty. */
      const byOwner = new Map<string, SessionSummary[]>()
      for (const owner of Object.keys(sessionStore.current.defaultSessionIds)) {
        if (defaultSessionOf(sessionStore.current, owner) !== undefined) byOwner.set(owner, [])
      }
      for (const session of sessionStore.current.sessions) {
        if (session.onboarding === true || session.archive.reason !== null) continue
        const key = session.agent?.id ?? ROOT_AGENT_SCOPE
        byOwner.set(key, [...(byOwner.get(key) ?? []), session])
      }
      return {
        owners: [...byOwner].map(([agentId, sessions]) => {
          /* The same split the server makes, off the same pointer: the chat is
             the conversation this owner *is*, and it is not work. A fixture that
             left it among the sessions could not photograph the difference —
             which is exactly how the ring came to draw a Jobs bead for it. */
          const chat = defaultSessionOf(sessionStore.current, agentId)
          const work = sessions.filter(session => session.id !== chat?.id)
          return {
            agentId,
            sessions: work.sort(
              (left, right) =>
                SESSION_ACTIVITY_PRIORITY.indexOf(left.bucket) -
                  SESSION_ACTIVITY_PRIORITY.indexOf(right.bucket) ||
                right.updatedAt - left.updatedAt,
            ),
            truncated: false,
            ...(chat === undefined ? {} : { chat }),
          }
        }),
      }
    },
    markSessionRead: async (_workspaceSlug, sessionId, seq) => {
      /* The summary rows only. `updateFixtureSession` would also rewrite the
         snapshot, and a scenario that has hand-set a snapshot field the summary
         does not carry — `sessions-pane-reconciling` sets `cwd` — would lose it
         the moment the reader opened the session. The wire agrees: the response
         is a cursor, and every cache the SPA keeps it patches itself. */
      sessionStore.current.sessions = sessionStore.current.sessions.map(session =>
        session.id === sessionId ? { ...session, unread: false } : session,
      )
      return { lastReadSeq: seq }
    },
    deleteSession: async (_workspaceSlug, sessionId) => {
      sessionStore.current.sessions = sessionStore.current.sessions.filter(
        session => session.id !== sessionId,
      )
      delete sessionStore.current.snapshots[sessionId]
      delete sessionStore.current.history[sessionId]
    },
    sessionImageUrl: () => '/playground/session-image.jpg',
    workspaceFileDownloadUrl: (_workspaceSlug, path) => `/api/duet/ws/acme/files/${path}`,
  }
}

/**
 * Which session is an owner's default chat.
 *
 * One rule, because three endpoints answer about the same fact:
 * `getDefaultSession` resolves it, `listSessions` withholds it under
 * `excludeDefault`, and `setDefaultSession` moves it. Two copies of the rule
 * would let the dialog's list and the agent's own panel disagree about which
 * conversation is the chat.
 *
 * It reads a **pointer**, the way the backend does (`agents.defaultSessionId`,
 * `workspaces.rootDefaultSessionId`), rather than deriving "the first session
 * this owner has". Derivation cannot represent an owner whose pointer has been
 * cleared — which is exactly what archiving the default chat does, and a
 * fixture that cannot represent it is a fixture that cannot fail on it.
 *
 * `agentId` is the scope vocabulary the wire filters by — a real id, or
 * `ROOT_AGENT_SCOPE` for the sessions no agent claimed.
 */
function defaultSessionOf(
  store: ReturnType<typeof createSessionStore>,
  agentId: string,
): SessionSummary | undefined {
  const pointer = store.defaultSessionIds[agentId]
  if (pointer === undefined || pointer === null) return undefined
  return store.sessions.find(session => session.id === pointer)
}

/** Stamp an owner's pointer, the way delivery does when it mints the chat. */
function stampDefaultSession(
  store: ReturnType<typeof createSessionStore>,
  agentId: string,
  sessionId: string | null,
): void {
  store.defaultSessionIds[agentId] = sessionId
}

export function createSessionStore() {
  const now = Date.now()
  const sessions: SessionSummary[] = [
    {
      // Waiting on a person, and nobody has looked yet — the loudest case.
      unread: true,
      id: 'session_live',
      ...workspaceSessionProjection(),
      turnStatus: 'ask',
      bucket: 'asking',
      title: 'Prepare the launch readiness report',
      titleOrigin: 'auto',
      titleStatus: 'complete',
      createdAt: now - 3_600_000,
      updatedAt: now - 2 * 60_000,
      lastEventSeq: 9,
    },
    {
      unread: false,
      id: 'session_running',
      ...workspaceSessionProjection(),
      turnStatus: 'running',
      bucket: 'running',
      title: 'Audit production API latency',
      titleOrigin: 'auto',
      titleStatus: 'complete',
      createdAt: now - 7_200_000,
      updatedAt: now - 240_000,
      lastEventSeq: 5,
    },
    {
      /* The conversation you have with the drive itself — its own row, never
         one of the jobs below it. Every job surface withholds exactly this id,
         and the address that names it belongs to the panel rather than to the
         dialog, so the fixture that photographs those rules has to be able to
         tell the two apart: `session_live` is work Milo is stuck on and asking
         about, and this is the chat it was asked from. */
      unread: true,
      id: 'session_root_chat',
      ...workspaceSessionProjection(),
      turnStatus: 'ask',
      bucket: 'asking',
      title: 'Weekly drive check-in',
      titleOrigin: 'auto',
      titleStatus: 'complete',
      createdAt: now - 172_800_000,
      updatedAt: now - 1_800_000,
      lastEventSeq: 5,
    },
    {
      // Finished while you were away. This is what the whole feature is for.
      unread: true,
      id: 'session_complete',
      ...workspaceSessionProjection(),
      turnStatus: 'complete',
      bucket: 'done',
      title: 'Summarize customer interviews',
      titleOrigin: 'manual',
      titleStatus: 'complete',
      createdAt: now - 86_400_000,
      updatedAt: now - 3_600_000,
      lastEventSeq: 6,
    },
    // The two machine-backed rows below used to live in a separate `listJobs`
    // stub, which is why this one was duplicated there with a machine attached.
    // One list, one fixture: the machine belongs on the session itself.
    {
      unread: false,
      id: 'session_sleep',
      ...workspaceSessionProjection(),
      turnStatus: 'sleep',
      bucket: 'scheduled',
      title: 'Wait for the nightly export',
      titleOrigin: 'auto',
      titleStatus: 'complete',
      createdAt: now - 86_400_000,
      updatedAt: now - 7_200_000,
      lastEventSeq: 4,
      agent: { id: 'agent_research', name: 'Research' },
      createdBySessionId: 'session_live',
      machine: NIGHTLY_EXPORT_RELAY,
    },
    {
      unread: false,
      id: 'session_export_complete',
      ...workspaceSessionProjection(),
      turnStatus: 'complete',
      bucket: 'done',
      title: 'Publish the customer export summary',
      titleOrigin: 'auto',
      titleStatus: 'complete',
      createdAt: now - 86_400_000,
      updatedAt: now - 10_800_000,
      lastEventSeq: 4,
      createdBySessionId: 'session_live',
      machine: {
        activity: 'idle',
        definitionName: 'Customer export summary',
        currentState: 'publish summary',
        outcome: 'completed',
        orderedPath: [],
      },
    },
    {
      /* A delegated conversation running no machine at all — the shape that had
         nowhere to appear. The rail excludes it for being a child and the
         parent's panel used to exclude it for being quiet, so it existed and no
         surface listed it. Its two siblings above both carry a machine, which is
         exactly why this row has to be here: without it the fixture cannot tell
         "every child" from "every child that is a job". */
      unread: false,
      id: 'session_export_notes',
      ...workspaceSessionProjection(),
      turnStatus: 'complete',
      bucket: 'done',
      title: 'Draft the handover notes',
      titleOrigin: 'auto',
      titleStatus: 'complete',
      createdAt: now - 82_800_000,
      updatedAt: now - 9_000_000,
      lastEventSeq: 3,
      createdBySessionId: 'session_live',
    },
    {
      /* A machine on a top-level conversation the drive itself owns.
         `session_research_scan` below is the same shape under an agent, and both
         are load-bearing for one rule: Work lists every non-default top-level
         session whatever it is running. The rail used to drop any row carrying a
         `machine` — while the per-agent groups under it kept theirs — so this
         row was invisible in Duet's own Chats and its twin was visible one
         heading lower. Take this row out and the fixture stops being able to
         tell the two answers apart. */
      unread: false,
      id: 'session_root_machine',
      ...workspaceSessionProjection(),
      turnStatus: 'running',
      bucket: 'running',
      title: 'Reconcile the quarterly ledger',
      titleOrigin: 'auto',
      titleStatus: 'complete',
      createdAt: now - 10_800_000,
      updatedAt: now - 900_000,
      lastEventSeq: 7,
      machine: {
        activity: 'running',
        definitionName: 'Quarterly ledger reconcile',
        currentState: 'match entries',
        progress: { completed: 3, total: 6 },
        orderedPath: [],
      },
    },
    {
      unread: true,
      id: 'session_research_brief',
      ...workspaceSessionProjection(),
      turnStatus: 'complete',
      bucket: 'done',
      title: 'Compare the new market entrants',
      titleOrigin: 'auto',
      titleStatus: 'complete',
      createdAt: now - 43_200_000,
      updatedAt: now - 1_200_000,
      lastEventSeq: 6,
      cwd: 'agents/research',
      agent: { id: 'agent_research', name: 'Research' },
    },
    {
      unread: false,
      id: 'session_research_scan',
      ...workspaceSessionProjection(),
      turnStatus: 'running',
      bucket: 'running',
      title: 'Track competitor launches',
      titleOrigin: 'auto',
      titleStatus: 'complete',
      createdAt: now - 21_600_000,
      updatedAt: now - 600_000,
      lastEventSeq: 4,
      cwd: 'agents/research',
      agent: { id: 'agent_research', name: 'Research' },
      machine: {
        activity: 'running',
        definitionName: 'Competitor launch watch',
        currentState: 'scan sources',
        progress: { completed: 2, total: 5 },
        orderedPath: [],
      },
    },
  ]
  const live: SessionSnapshot = {
    ...sessions.find(session => session.id === 'session_live')!,
    workspaceId: 'workspace_acme',
    lastDeliveredInputSeq: 8,
    cwd: '/home/duet/reports',
    todos: [
      { id: 'gather-metrics', content: 'Gather launch metrics', status: 'completed' },
      { id: 'confirm-owner', content: 'Confirm rollout owner', status: 'pending' },
    ],
  }
  /* The drive's own conversation, with the todos the panel draws beside its
     question — `live` carries its own for the job it belongs to, and these are
     this chat's. */
  const rootChat: SessionSnapshot = {
    ...sessions.find(session => session.id === 'session_root_chat')!,
    workspaceId: 'workspace_acme',
    lastDeliveredInputSeq: 2,
    todos: [
      { id: 'weekly-digest', content: 'Send the weekly digest', status: 'pending' },
      { id: 'nightly-export', content: 'Watch the nightly export', status: 'completed' },
    ],
  }
  /* Named for the relay it carries, not for the row it decorates: the machine
     below is the sleeping one, and the conversation underneath is
     `session_complete`. Addressed by id, as its two neighbours are — a
     positional index here made inserting a row silently move this machine onto
     a different conversation, which is a whole afternoon of debugging. */
  const sleeping: SessionSnapshot = {
    ...sessions.find(session => session.id === 'session_complete')!,
    workspaceId: 'workspace_acme',
    lastDeliveredInputSeq: 4,
    machine: NIGHTLY_EXPORT_RELAY,
    machineState: NIGHTLY_EXPORT_MACHINE,
  }
  /* Attributed before its agent was given a display name: the row's stamp is
     the slug-era name ('research', not 'Research'), so any surface echoing
     the stamp instead of the live profile shows the slug. Snapshot-only —
     absent from the list — so the deep link is the only way in and no list
     scene gains a row. */
  const staleStamp: SessionSnapshot = {
    unread: false,
    id: 'session_stale_stamp',
    ...workspaceSessionProjection(),
    workspaceId: 'workspace_acme',
    turnStatus: 'running',
    bucket: 'running',
    title: 'Refresh the competitor briefing',
    titleOrigin: 'auto',
    titleStatus: 'complete',
    createdAt: now - 5_400_000,
    updatedAt: now - 120_000,
    lastEventSeq: 4,
    lastDeliveredInputSeq: 2,
    agent: { id: 'agent_research', name: 'research' },
    cwd: 'agents/research',
  }
  /* The onboarding endpoint returns a hidden conversation rather than a jobs
     row. Keep it snapshot-only so the production-shell locked-agent fixture
     can exercise the real setup chat without teaching the ordinary lists that
     onboarding conversations are browseable work. */
  const onboarding: SessionSnapshot = {
    unread: false,
    id: 'session_onboarding',
    ...workspaceSessionProjection(),
    workspaceId: 'workspace_acme',
    turnStatus: 'complete',
    bucket: 'done',
    title: 'Set up Research',
    titleOrigin: 'auto',
    titleStatus: 'complete',
    createdAt: now - 60_000,
    updatedAt: now - 30_000,
    lastEventSeq: 3,
    lastDeliveredInputSeq: 2,
    agent: { id: 'agent_research', name: 'Research' },
    cwd: 'agents/research',
  }
  /* The seeded pointers, one per owner with a conversation here. Written out as
     a pointer rather than re-derived on every read so that clearing one is
     representable at all.

     The drive's own chat is named rather than taken from the top of the list,
     and the reason is the product rule this fixture exists to photograph: an
     owner's chat is *not* one of its jobs. Every job surface withholds it, and
     the address that names it belongs to the panel, so a chat that doubled as
     the list's first row left the playground unable to tell the two apart —
     `…/sessions/<that id>` was both "a job in the dialog" and "the chat", and
     whichever the code did looked right. Naming it splits them: `session_live`
     is work an agent is stuck on and asking about, and the conversation you
     have with the drive is its own row. */
  const defaultSessionIds: Record<string, string | null> = {
    [ROOT_AGENT_SCOPE]: 'session_root_chat',
  }
  return {
    sessions,
    defaultSessionIds,
    snapshots: {
      ...(Object.fromEntries(
        sessions.map(session => [
          session.id,
          session.id === live.id
            ? live
            : session.id === sleeping.id
              ? sleeping
              : session.id === rootChat.id
                ? rootChat
                : { ...session, workspaceId: 'workspace_acme' },
        ]),
      ) as Record<string, SessionSnapshot>),
      [staleStamp.id]: staleStamp,
      [onboarding.id]: onboarding,
    },
    history: {
      session_onboarding: {
        events: fixturePromptEvents(
          'Help me set up Research',
          false,
          undefined,
          'What kinds of sources should I prioritize, and how should I format the finished brief?',
        ),
        nextCursor: null,
      },
      session_stale_stamp: {
        events: [
          ...fixturePromptEvents('Refresh the competitor briefing'),
          { seq: 3, createdAt: FIXTURE_NOW - 40_000, event: { type: 'turn_started' } },
          {
            seq: 4,
            createdAt: FIXTURE_NOW - 30_000,
            event: {
              type: 'step',
              step: {
                type: 'text',
                text: 'Pulling the latest competitor launches before rewriting the briefing.',
              },
            },
          },
        ],
      },
      session_sleep: {
        events: [
          ...fixturePromptEvents('Wait for the nightly export and publish it when ready.'),
          {
            seq: 3,
            createdAt: FIXTURE_NOW - 20_000,
            event: { type: 'state_machine', stateMachine: NIGHTLY_EXPORT_MACHINE },
          },
          {
            seq: 4,
            createdAt: FIXTURE_NOW - 10_000,
            event: {
              type: 'sleep',
              wakeAt: NIGHTLY_EXPORT_RELAY.nextWakeAt,
              state: {
                status: 'sleeping',
                mode: NIGHTLY_EXPORT_MACHINE.definition,
                agent: { status: 'waiting', messages: [] },
                stateMachine: NIGHTLY_EXPORT_MACHINE,
              },
            },
          },
        ],
      },
      session_root_chat: {
        events: [
          ...fixturePromptEvents('How did the week go on this drive?'),
          { seq: 3, createdAt: FIXTURE_NOW - 55_000, event: { type: 'turn_started' } },
          {
            seq: 4,
            createdAt: FIXTURE_NOW - 50_000,
            event: {
              type: 'step',
              step: {
                type: 'text',
                text: 'Quiet week: the nightly export ran clean every night, and the launch report is the one thing still waiting on a person.',
              },
            },
          },
          {
            /* Waiting on you, with todos on the snapshot beside it. That pairing
               is the composer's fullest state and the shape a short window has
               to absorb without pushing Send under the fold — so it belongs on
               the conversation the panel always opens, not on a job that has to
               be navigated to. */
            seq: 5,
            createdAt: FIXTURE_NOW - 45_000,
            event: {
              type: 'ask',
              questions: [
                {
                  header: 'Weekly digest',
                  question: 'Who should the weekly digest go to?',
                  options: [
                    { label: 'Just me', description: 'Keep it on this drive.' },
                    { label: 'The launch channel', description: 'Post it where the team reads.' },
                    { label: 'Nobody yet', description: 'Hold it until the launch lands.' },
                  ],
                  multiSelect: true,
                },
              ],
            },
          },
        ],
      },
      session_live: {
        events: [
          ...fixturePromptEvents(
            'Build a launch readiness report from the staging checks.',
            true,
          ).slice(1),
          { seq: 3, createdAt: FIXTURE_NOW - 50_000, event: { type: 'turn_started' } },
          {
            seq: 4,
            createdAt: FIXTURE_NOW - 45_000,
            event: {
              type: 'step',
              step: {
                type: 'reasoning',
                text: 'I’ll compare the release checklist with the latest staging evidence.',
              },
            },
          },
          {
            // A failed probe the agent routes around: the row must read as
            // signal (dash glyph), never as the product's alarm color.
            seq: 5,
            createdAt: FIXTURE_NOW - 43_000,
            event: {
              type: 'step',
              step: {
                type: 'tool_call',
                toolName: 'bash',
                toolCallId: 'tool_probe',
                input: { command: 'test -f /reports/staging.md' },
                isError: true,
                output: [{ type: 'text', text: 'exit status 1' }],
              },
            },
          },
          {
            seq: 6,
            createdAt: FIXTURE_NOW - 40_000,
            event: {
              type: 'step',
              step: {
                type: 'tool_call',
                toolName: 'read_file',
                toolCallId: 'tool_launch',
                input: { path: '/reports/staging.md' },
                isError: false,
                output: [{ type: 'text', text: 'All critical checks passed.' }],
              },
            },
          },
          {
            seq: 7,
            createdAt: FIXTURE_NOW - 30_000,
            event: {
              type: 'step',
              step: {
                type: 'text',
                text: 'Staging is healthy. The remaining decision is who owns the production rollout.',
              },
            },
          },
          {
            seq: 8,
            createdAt: FIXTURE_NOW - 20_000,
            event: {
              type: 'ask',
              questions: [
                {
                  header: 'Rollout owners',
                  question: 'Select the production rollout owners.',
                  options: [
                    {
                      label: 'Ada owns the rollout',
                      description: 'Keep ownership with the launch lead.',
                    },
                    {
                      label: 'Release manager',
                      description: 'Hand ownership to the release function.',
                    },
                    {
                      label: 'Engineering lead',
                      description: 'Keep the final decision with engineering.',
                    },
                  ],
                  multiSelect: true,
                },
              ],
              // The terminal event carries the turn's tally; with the
              // turn_started stamp above it puts "thought for 30s" and the
              // usage hover on Milo's message.
              turnUsage: {
                input: 1_840,
                output: 512,
                cacheRead: 22_400,
                cacheWrite: 640,
                totalTokens: 25_392,
                cost: {
                  input: 0.0055,
                  output: 0.0077,
                  cacheRead: 0.0022,
                  cacheWrite: 0.0024,
                  total: 0.0178,
                },
              },
              usageByModel: [
                {
                  model: 'claude-sonnet-5',
                  transport: { provider: 'duet-gateway', billing: 'plan-covered' },
                  usage: {
                    input: 1_840,
                    output: 512,
                    cacheRead: 22_400,
                    cacheWrite: 640,
                    totalTokens: 25_392,
                    cost: {
                      input: 0.0055,
                      output: 0.0077,
                      cacheRead: 0.0022,
                      cacheWrite: 0.0024,
                      total: 0.0178,
                    },
                  },
                },
              ],
            },
          },
          {
            seq: 9,
            createdAt: FIXTURE_NOW - 10_000,
            event: {
              type: 'todos',
              todos: [
                { id: 'gather-metrics', content: 'Gather launch metrics', status: 'completed' },
                { id: 'confirm-owner', content: 'Confirm rollout owner', status: 'pending' },
              ],
            },
          },
        ],
        nextCursor: 2,
      },
    } as Record<string, SessionInitialHistorySnapshot>,
  }
}

/* The two envelope stamps below are `FIXTURE_NOW`, not the wall clock, and that
   is the whole of a screenshot bug that outlived several baselines: a message
   bubble prints its time as an absolute clock face — `Intl.DateTimeFormat` with
   an hour and a minute, see `formatMessageTime` — so a stamp taken from
   `Date.now()` bakes the hour the baseline was approved at into the picture.
   Every run at a different time of day then failed, and the failure aborted the
   rest of the suite, which is how one fixture's clock took ninety-three
   unrelated tests with it.

   The session summaries keep the live clock on purpose: the rail dates them
   *relatively* — "4 minutes ago" — against the same clock the app renders with,
   so those two moving together is what holds them still. It is only the
   absolute face that has to be pinned, which is what the `session_created`
   payload below was already doing on the inside. */
export function fixturePromptEvents(
  prompt: string,
  withImage: boolean | readonly AgentInputImage[] = false,
  clientRequestId?: string,
  agentFirstMessage?: string,
): SessionTimelineEntry[] {
  return [
    {
      seq: 1,
      createdAt: FIXTURE_NOW - 60_000,
      event: {
        type: 'session_created',
        prompt,
        createdAt: '2026-07-11T00:00:00.000Z',
        ...(clientRequestId === undefined ? {} : { clientRequestId }),
      },
    },
    // Mirrors the server: the materialized suggestion lands ahead of the
    // user's prompt, and every later seq shifts by one.
    ...(agentFirstMessage === undefined
      ? []
      : [
          {
            seq: 2,
            createdAt: FIXTURE_NOW - 58_000,
            event: {
              type: 'agent_message' as const,
              message: agentFirstMessage,
              createdAt: '2026-07-11T00:00:00.000Z',
            },
          },
        ]),
    {
      seq: agentFirstMessage === undefined ? 2 : 3,
      createdAt: FIXTURE_NOW - 55_000,
      event: {
        type: 'prompt_submitted',
        prompt,
        inputKind: 'initial',
        behavior: 'steer',
        sender: FIXTURE_VIEWER_SENDER,
        ...(clientRequestId === undefined ? {} : { clientRequestId }),
        ...(Array.isArray(withImage)
          ? fixtureInputEventImages(withImage)
          : withImage
            ? {
                images: [
                  {
                    storageId: 'launch-dashboard',
                    mimeType: 'image/jpeg' as const,
                    bytes: 1024,
                  },
                ],
              }
            : {}),
      },
    },
  ]
}

export function fixtureInputEventImages(images: readonly AgentInputImage[] | undefined) {
  return images === undefined || images.length === 0
    ? {}
    : {
        images: images.map((image, index) => ({
          storageId: `fixture-upload-${index}`,
          mimeType: image.mimeType,
          bytes: 1024,
        })),
      }
}

export function updateFixtureSession(
  store: ReturnType<typeof createSessionStore>,
  sessionId: string,
  patch: Partial<SessionSummary>,
): SessionSummary {
  const current = store.sessions.find(session => session.id === sessionId)
  if (!current) throw new DuetApiError(404, 'not_found')
  const updated = { ...current, ...patch }
  store.sessions = store.sessions.map(session => (session.id === sessionId ? updated : session))
  /* Only patch a snapshot that exists. The `!` here used to assert one for every
     listed session, which is a lie for any row the playground never opened: the
     spread would leave a bare summary standing where a snapshot should be, with
     no `workspaceId` and no `lastDeliveredInputSeq`.

     Note this rewrites the snapshot from the *summary*, so a scenario that has
     hand-set a snapshot-only value loses it. That is why the read stamp does
     not come through here — see `markSessionRead`. */
  const snapshot = store.snapshots[sessionId]
  if (snapshot !== undefined) store.snapshots[sessionId] = { ...snapshot, ...updated }
  return updated
}

/**
 * The stamp a session *summary* carries after the fixture touches it.
 *
 * A summary is dated relatively — "4 minutes ago" — so it used to be stamped
 * `Date.now()` on the argument that the label and the clock behind it move
 * together and therefore hold still. They do not. The clock the app renders
 * against is `useMapClock`, which is deliberately coarse: it samples the wall
 * clock and then only re-samples once a minute, so the app's "now" trails real
 * time by anything from zero to a full tick. A summary stamped at real `now` is
 * therefore *ahead* of the clock it is measured against, and renders as a
 * **future** label — "in 3 seconds" on one run, "in 2 seconds" on the next,
 * depending only on where in the minute the run happened to land. That is a
 * screenshot that can never settle, and it took a session-detail baseline with
 * it every few runs.
 *
 * One tick of margin was not enough, because one tick is exactly the WORST
 * lag: sample the clock at the wrong moment and `now - 60s` lands on the app's
 * own "now", which renders as "in 1 second" and takes the shot with it. The
 * margin has to clear the whole tick and then some, so it is two.
 */
const FIXTURE_SUMMARY_MARGIN_MS = 2 * 60_000

function fixtureSummaryStamp(): number {
  return Date.now() - FIXTURE_SUMMARY_MARGIN_MS
}

export function appendFixtureEvent(
  store: ReturnType<typeof createSessionStore>,
  sessionId: string,
  event: SessionTimelineEntry['event'],
): number {
  const history = store.history[sessionId] ?? { events: [] }
  const seq = (history.events.at(-1)?.seq ?? 0) + 1
  /* `FIXTURE_NOW` for the same reason the seeded events use it: a bubble sent
     during a flow is photographed like any other, and its clock face would
     otherwise be the hour the baseline was approved at. Order on this list is
     `seq`, never the stamp, so pinning it costs the fixture nothing. */
  store.history[sessionId] = {
    events: [...history.events, { seq, createdAt: FIXTURE_NOW, event }],
  }
  store.sessions = store.sessions.map(session =>
    session.id === sessionId
      ? { ...session, lastEventSeq: seq, updatedAt: fixtureSummaryStamp() }
      : session,
  )
  const snapshot = store.snapshots[sessionId]
  if (snapshot !== undefined) store.snapshots[sessionId] = { ...snapshot, lastEventSeq: seq }
  return seq
}

export function setFixtureSessionStatus(
  store: ReturnType<typeof createSessionStore>,
  sessionId: string,
  turnStatus: SessionSummary['turnStatus'],
): void {
  const current = store.sessions.find(session => session.id === sessionId)
  if (current !== undefined) updateFixtureSession(store, sessionId, { turnStatus })
}

export const OWNER_APP_CAPABILITIES: NonNullable<AppListResponse['meta']>['capabilities'] = {
  register: true,
}

/* A data: URL keeps the framed app deterministic and offline, so the shot
   proves the viewer's chrome and layout rather than a workspace's live output.

   The document is deliberately shaped like the onboarding pages — a hero
   heading flush at the very top, sectioned content taller than any viewport,
   and a named marker at the very bottom — because the frame's failure modes
   are geometric and a page that centres one line cannot show any of them. A
   clipped top cuts the hero mid-letterform, a collapsed height buries the
   cards, and a broken scroll makes the end marker unreachable. The single
   centred line this used to be rendered identically through all three, which
   is how a clipped composition shipped with every gate green. */
export function fixtureAppFrameSource(_workspaceSlug: string, appSlug: string): string {
  const sections = ['Step 1 — Connect', 'Step 2 — Choose scope', 'What this page never does']
    .map(
      title =>
        `<section style="margin:0 0 20px;padding:20px;border:1px solid #e2ddd2;border-radius:14px;background:#fffdf9"><h2 style="margin:0 0 6px;font-size:17px">${title}</h2><p style="margin:0;color:#6b6878">Deterministic fixture copy, long enough to wrap onto a second line at phone widths.</p></section>`,
    )
    .join('')
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><html><body style="margin:0;font:16px/1.5 system-ui;background:#f4f1ec;color:#1c1a24"><main style="max-width:640px;margin:0 auto;padding:24px 20px 40px"><h1 style="margin:0 0 10px;font:600 34px/1.15 ui-serif,Georgia,serif">${appSlug} hero, flush with the top</h1><p style="margin:0 0 24px;color:#6b6878">If the line above is cut mid-letter, the frame is clipping its top.</p>${sections}<p data-fixture-page-end style="margin:24px 0 0;padding:10px;border-radius:10px;background:#e7e5fb;color:#4f46b8;font-weight:600">END OF PAGE — reachable only if the frame scrolls.</p></main></body></html>`,
  )}`
}

export const APP_FIXTURES: App[] = [
  {
    id: 'app_reporting',
    workspaceId: 'workspace_acme',
    anchorId: 'anchor_reporting',
    anchorPath: 'apps/reporting',
    anchorState: 'active',
    name: 'Launch intelligence',
    icon: 'icon.svg',
    command: 'bun run start',
    apiScopes: [],
    port: 4173,
    slug: 'reporting',
    visibility: 'folder',
    canonicalUrl: canonicalAppUrl('acme', 'reporting', DUET_EDGE_HOST),
    runtimeStatus: 'reconciled',
    createdByUserId: 'user_owner',
    createdAt: 1_749_999_000_000,
    updatedAt: 1_750_000_000_000,
    controls: {
      manageDomain: true,
      updateRuntime: true,
      makePublic: true,
      makePrivate: true,
      delete: true,
    },
  },
  {
    id: 'app_status',
    workspaceId: 'workspace_acme',
    anchorId: 'anchor_status',
    anchorPath: 'tools/status-page',
    anchorState: 'active',
    name: 'Customer readiness, launch analytics, and incident response command center',
    icon: 'missing-icon.svg',
    command: 'bun run serve',
    apiScopes: [],
    port: 4310,
    slug: 'status-page',
    visibility: 'public',
    canonicalUrl: canonicalAppUrl('acme', 'status-page', DUET_EDGE_HOST),
    runtimeStatus: 'reconcile_failed',
    reconciliationError: 'gateway_unavailable',
    createdByUserId: 'user_owner',
    createdAt: 1_749_990_000_000,
    updatedAt: 1_750_000_100_000,
    controls: {
      manageDomain: true,
      updateRuntime: true,
      makePublic: true,
      makePrivate: true,
      delete: true,
    },
  },
  {
    id: 'app_archive',
    workspaceId: 'workspace_acme',
    anchorId: 'anchor_archive',
    anchorPath: 'tools/archive-browser',
    anchorState: 'active',
    command: 'bun run serve',
    apiScopes: [],
    port: 4311,
    slug: 'archive-browser',
    visibility: 'folder',
    canonicalUrl: canonicalAppUrl('acme', 'archive-browser', DUET_EDGE_HOST),
    runtimeStatus: 'reconciled',
    disabledAt: 1_750_000_200_000,
    disabledByUserId: 'user_owner',
    createdByUserId: 'user_owner',
    createdAt: 1_749_980_000_000,
    updatedAt: 1_750_000_200_000,
    controls: {
      manageDomain: true,
      updateRuntime: true,
      makePublic: true,
      makePrivate: true,
      delete: true,
    },
  },
]

/**
 * Two owners with conversations in the Work sidebar, which the default fixture
 * cannot show: only Research owns work, so "Other chats" has one group and a
 * column that can hold several groups open looks identical to one that cannot.
 *
 * One row changes hands rather than a new one appearing — the sidebar's claim is
 * about groups, and moving an existing conversation gives a second group without
 * changing how much work this workspace has. Research keeps its unread row, so
 * the same scenario also shows a marked group beside an unmarked one.
 */
export function prepareTwoOwnerSidebarFixture(sessionStore: ReturnType<typeof createSessionStore>) {
  updateFixtureSession(sessionStore, 'session_research_scan', {
    agent: { id: 'agent_reviewer', name: 'Reviewer' },
    cwd: 'agents/reviewer',
  })
}

export function prepareSessionPaneFixture(sessionStore: ReturnType<typeof createSessionStore>) {
  /* A delegated job with a working folder inside an app — which is what the
     app-beside-the-thread pane is *for*, and now also what it takes to be
     addressable: Work admits a child conversation only when it is a job (see
     `validWorkShape`), because a child's place in the product is the parent's
     Recent-jobs rail. This session was a child with no machine, which is a
     shape nothing can open — it only ever rendered because Build's jobs dialog
     classified nothing and mounted whatever the URL named. */
  updateFixtureSession(sessionStore, 'session_running', {
    cwd: 'apps/reporting/dashboard',
    createdBySessionId: 'session_complete',
    machine: {
      definitionName: 'Dashboard refresh',
      currentState: 'refresh the dashboard',
      progress: { completed: 1, total: 2 },
      orderedPath: [
        { key: 'gather', index: 0, name: 'gather metrics', kind: 'script', phase: 'past' },
        {
          key: 'refresh',
          index: 1,
          name: 'refresh the dashboard',
          kind: 'script',
          phase: 'current',
        },
      ],
      activity: 'running',
    },
  })
  updateFixtureSession(sessionStore, 'session_live', {
    cwd: 'apps/reporting/dashboard',
  })
}

// The registered agents `GET /agents` returns: a healthy launchable agent and
// one whose anchor is broken (folder gone) — the launchable/non-launchable
// spread the roster renders. The drive-root "Duet" card is a presentation record
// the roster pins itself (D15); it is deliberately NOT a listed agent row, so
// root sessions stay unattributed and file under the Duet card via
// ROOT_AGENT_SCOPE.
// Derived-profile sources (D10) keyed by drive path. Research's AGENTS.md gives it
// a role and its `.agents/skills/` folder five skills; Reviewer has neither, so its
// reads 404 and the card degrades silently.
export const AGENT_PROFILE_FILES: Record<string, string> = {
  'agents/research/AGENTS.md': '# Research\n\nSynthesizes sources into decision-ready briefs.\n',
  // The suggested first message renders in Research's empty default chat and
  // rides the first send as `agentFirstMessage` (map D3/D6).
  'agents/research/agent.json': JSON.stringify({
    suggestedFirstMessage:
      'Hi — I’m Research. Give me a question and I’ll come back with a source-backed brief. What should I dig into first?',
  }),
}
export const AGENT_SKILL_DIRS: Record<string, readonly string[]> = {
  'agents/research/.agents/skills': ['deep-research', 'summarize', 'cite', 'fact-check', 'outline'],
}

export const AGENT_FIXTURES: Agent[] = [
  {
    id: 'agent_research',
    workspaceId: 'workspace_acme',
    anchorId: 'anchor_research',
    anchorPath: 'agents/research',
    anchorState: 'active',
    slug: 'research',
    name: 'Research',
    icon: 'assets/icon.png',
    listingSubscriptionId: 'subscription_research',
    createdAt: 1_749_950_000_000,
    updatedAt: 1_750_000_050_000,
  },
  {
    id: 'agent_reviewer',
    workspaceId: 'workspace_acme',
    anchorId: 'anchor_reviewer',
    anchorPath: 'agents/reviewer',
    anchorState: 'broken',
    slug: 'reviewer',
    name: 'Reviewer',
    createdAt: 1_749_970_000_000,
    updatedAt: 1_750_000_070_000,
  },
]

export const INTEGRATION_OVERFLOW_AGENTS: Agent[] = Array.from({ length: 500 }, (_, index) => {
  const number = String(index + 1).padStart(3, '0')
  return {
    id: `agent_${number}`,
    workspaceId: 'workspace_acme',
    anchorId: `anchor_${number}`,
    anchorPath: `agents/agent-${number}`,
    anchorState: 'active',
    slug: `agent-${number}`,
    name: `Agent ${number}`,
    createdAt: FIXTURE_NOW - index * 1_000,
    updatedAt: FIXTURE_NOW,
  }
})

/**
 * The two answers the default list does not already show: a credential that has
 * stopped being accepted, and a server whose longest tool names were dropped
 * because the namespaced form exceeds the tool-name ceiling. Reachable,
 * waiting-on-authorization and unreachable are on the default fixture, so
 * between the two scenarios every health state owes and gets a shot — kept in
 * two panels rather than one so neither is taller than a viewport.
 */
export const MCP_SERVER_STATES: McpServer[] = [
  {
    name: 'billing_ledger',
    label: 'Billing Ledger',
    url: 'https://ledger.billing.test/mcp',
    authKind: 'static',
    state: 'reauth_required',
    toolCount: 12,
    estimatedPromptBytes: 5_200,
    lastSuccessAt: FIXTURE_NOW - 4 * 3_600_000,
    lastErrorAt: FIXTURE_NOW - 25 * 60_000,
    lastErrorCode: 'reauth_required',
    createdAt: Date.UTC(2026, 5, 28, 16),
    updatedAt: FIXTURE_NOW - 25 * 60_000,
  },
  {
    name: 'data_lake',
    label: 'Data Lake',
    url: 'https://lake.data.test/mcp',
    authKind: 'none',
    state: 'ready',
    toolCount: 41,
    estimatedPromptBytes: 22_400,
    droppedToolNames: [
      'list_quarterly_revenue_recognition_adjustments_by_region',
      'reconcile_deferred_revenue_schedule_against_subscription_ledger',
    ],
    lastSuccessAt: FIXTURE_NOW - 55 * 60_000,
    createdAt: Date.UTC(2026, 6, 12, 9),
    updatedAt: FIXTURE_NOW - 55 * 60_000,
  },
]

export const PUBLISH_MANAGEMENT_FIXTURE: PublishRow[] = [
  {
    id: 'publish_weekly',
    workspaceId: 'workspace_acme',
    anchorId: 'anchor_weekly',
    anchorPath: 'Reports/Weekly',
    slug: 'weekly',
    kind: 'folder',
    createdByUserId: 'user_owner',
    createdAt: FIXTURE_NOW - 86_400_000,
    updatedAt: FIXTURE_NOW - 3_600_000,
  },
  {
    id: 'publish_brief',
    workspaceId: 'workspace_acme',
    anchorId: 'anchor_brief',
    anchorPath: 'Launch/brief.pdf',
    slug: 'launch-brief',
    kind: 'file',
    createdByUserId: 'user_owner',
    createdAt: FIXTURE_NOW - 172_800_000,
    updatedAt: FIXTURE_NOW - 7_200_000,
  },
]

export function pausedShare<T extends ShareListResponse['items'][number]>(share: T): T {
  return {
    ...share,
    pausedAt: FIXTURE_NOW - 60_000,
    syncStatus: {
      origin: { state: 'paused', matchesCurrentGeneration: true, updatedAt: FIXTURE_NOW - 5_000 },
      recipient: {
        state: 'paused',
        matchesCurrentGeneration: true,
        updatedAt: FIXTURE_NOW - 4_000,
      },
    },
  }
}

export function createTrainUploadsFixture(
  options: {
    listing?: {
      files: TrainUploadEntry[]
      totalBytes: number
      capBytes: number
      running: boolean
    }
    uploadProgress?: number
    urlResult?: 'pending' | 'failed' | 'success'
    listingError?: boolean
  } = {},
): TrainUploadsClient {
  let listing = options.listing ?? {
    files: [],
    totalBytes: 0,
    capBytes: TRAIN_UPLOADS_CAP_BYTES,
    running: false,
  }
  const fetchFixture = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input)
    if (path.endsWith('/session')) {
      return Response.json({
        vmBaseUrl: 'https://fixture-vm.invalid/',
        uploadPath: '/v1/train/uploads',
        uploadToken: 'fixture-upload-token',
        expiresAt: Date.now() + 60_000,
      })
    }
    if (path.endsWith('/url') && init?.method === 'POST') {
      if (options.urlResult === 'pending') return await new Promise<Response>(() => {})
      if (options.urlResult === 'failed') {
        return Response.json(
          { error: 'source_fetch_failed', detail: 'timeout', message: 'The page fetch timed out.' },
          { status: 422 },
        )
      }
      const url = (JSON.parse(String(init.body)) as { url: string }).url
      const entry = {
        filename: 'url-fixture-page.md',
        size: 18_432,
        uploadedAt: Date.UTC(2026, 6, 15, 9),
        url,
      }
      listing = {
        ...listing,
        files: [...listing.files, entry],
        totalBytes: listing.totalBytes + entry.size,
      }
      return Response.json(entry)
    }
    if (init?.method === 'DELETE') return Response.json({ ok: true })
    if (options.listingError) {
      return Response.json({ error: 'fixture_upload_listing_error' }, { status: 503 })
    }
    return Response.json({
      items: listing.files,
      nextCursor: null,
      meta: {
        totalBytes: listing.totalBytes,
        fileCount: listing.files.length,
        capBytes: listing.capBytes,
        running: listing.running,
      },
    })
  }
  const createXhr = () => {
    const upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
    const xhr = {
      upload,
      status: 200,
      responseText: '{}',
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      open() {},
      setRequestHeader() {},
      send() {
        window.setTimeout(
          () =>
            upload.onprogress?.({
              lengthComputable: true,
              loaded: options.uploadProgress ?? 43,
              total: 100,
            } as ProgressEvent),
          20,
        )
      },
      abort() {
        xhr.onabort?.()
      },
    }
    return xhr as unknown as XMLHttpRequest
  }
  return new TrainUploadsClient({ fetch: fetchFixture, createXhr })
}
