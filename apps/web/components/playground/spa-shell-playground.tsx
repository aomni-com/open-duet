'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useMemo, useRef, useState } from 'react'

import type {
  Agent,
  App,
  OAuthGrant,
  SyncMachine,
  ShareListResponse,
  TrainJobStatus,
  UserApiKey,
  UserBillingOverview,
  WhoamiResponse,
  WorkspaceSummary,
  WorkspaceCreateRefusal,
  WorkspaceMember,
} from '@repo/contract'
import { appControls, TRAIN_UPLOADS_CAP_BYTES } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import { DuetApiError } from '../../spa/api/client'
import type { TrainUploadsClient } from '../../spa/api/train-uploads'
import { AppFrameSourceProvider } from '../../spa/apps/app-frame'
import type { SpaApi } from '../../spa/context'
import { DriveFileIconClientProvider } from '../../spa/drive/drive-file-icon'
import { AttributionConfigProvider } from '../../spa/files/attribution'
import { DuetSpa } from '../../spa/root'
import { BACKUP_FIXTURE_STATES, createBackupFixture } from './backup-fixture'
import { createDriveFileIconFixture } from './drive-file-icon-fixture'
import { SHARE_MANAGEMENT_FIXTURE } from './share-management-fixtures'
import {
  AGENT_FIXTURES,
  APP_FIXTURES,
  createFixtureApi,
  createSessionStore,
  createTrainUploadsFixture,
  fixtureAppFrameSource,
  FIXTURE_NOW,
  FIXTURE_VIEWER_SENDER,
  IDENTITY,
  INTEGRATION_OVERFLOW_AGENTS,
  MCP_SERVER_STATES,
  OAUTH_GRANT_FIXTURES,
  OWNER_APP_CAPABILITIES,
  pausedShare,
  prepareSessionPaneFixture,
  prepareTwoOwnerSidebarFixture,
  PUBLISH_MANAGEMENT_FIXTURE,
  SHARE_REQUEST_FIXTURES,
} from './spa-fixture'

export function SpaShellPlayground({
  initialScenario = 'default',
}: {
  initialScenario?: Scenario
} = {}) {
  // Scenarios entered through a playground id never run the scenario button's
  // handler, so the language a scene is named for has to be readable from the
  // name itself or the chrome renders English around Spanish fixture prose.
  const [locale, setLocale] = useState<'en' | 'es-419'>(() => localeForScenario(initialScenario))
  const [signedOut, setSignedOut] = useState(false)
  const [driveIcons] = useState(() =>
    createDriveFileIconFixture(['/apps/reporting/icon.svg', '/agents/research/assets/icon.png']),
  )
  const [scenario, setScenario] = useState<Scenario>(initialScenario)
  const [lastBackupEvent, setLastBackupEvent] = useState<unknown>()
  const backupFixture = useMemo(
    () =>
      createBackupFixture(
        BACKUP_FIXTURE_STATES.find(state => scenario === `settings-backups-${state}`) ?? 'empty',
        setLastBackupEvent,
      ),
    [scenario],
  )
  const [browserPath, setBrowserPath] = useState<string>()
  const [lastSessionInput, setLastSessionInput] = useState<unknown>()
  const [lastMemberRequest, setLastMemberRequest] = useState<unknown>()
  const [lastRecoveryCheckout, setLastRecoveryCheckout] = useState<unknown>()
  const [lastMarketplaceAgentMutation, setLastMarketplaceAgentMutation] = useState<unknown>()
  const [lastIntegrationPolicyMutation, setLastIntegrationPolicyMutation] = useState<unknown>()
  const [onboardingSessionRequests, setOnboardingSessionRequests] = useState(0)
  const [onboardingAppLookups, setOnboardingAppLookups] = useState(0)
  const [historyContinuationRequests, setHistoryContinuationRequests] = useState(0)
  const historyContinuationRequestsRef = useRef(0)
  const identity = useRef<WhoamiResponse>(identityForScenario(initialScenario))
  const sessionStore = useRef(createSessionStore())
  const apps = useRef<App[]>(APP_FIXTURES.map(app => ({ ...app })))
  const initializedPaneScenario = useRef(false)
  if (initialScenario === 'sessions-pane-open' && !initializedPaneScenario.current) {
    initializedPaneScenario.current = true
    prepareSessionPaneFixture(sessionStore.current)
  }
  const initializedTwoOwnerScenario = useRef(false)
  if (initialScenario === 'team-space-home-two-owners' && !initializedTwoOwnerScenario.current) {
    initializedTwoOwnerScenario.current = true
    prepareTwoOwnerSidebarFixture(sessionStore.current)
  }
  const members = useRef<WorkspaceMember[]>([
    {
      id: 'user_owner',
      email: 'owner@duet.so',
      name: 'Ada Lovelace',
      role: 'owner',
      isBillingUser: true,
    },
    {
      id: 'user_grace',
      email: 'grace@duet.so',
      name: 'Grace Hopper',
      role: 'owner',
      isBillingUser: false,
    },
    {
      id: 'user_linus',
      email: 'linus@example.com',
      name: 'Linus Torvalds',
      role: 'editor',
      isBillingUser: false,
    },
    {
      id: 'user_long_name',
      email: 'alexandra.very.long.address@international-product-research.example.com',
      name: 'Alexandra Fernández-Montgomery with a deliberately long mobile display name',
      role: 'viewer',
      isBillingUser: false,
    },
    {
      id: 'user_margaret',
      email: 'margaret@example.com',
      name: 'Margaret Hamilton',
      role: 'editor',
      isBillingUser: false,
    },
    {
      id: 'user_katherine',
      email: 'katherine@example.com',
      name: 'Katherine Johnson',
      role: 'editor',
      isBillingUser: false,
    },
    {
      id: 'user_radia',
      email: 'radia@example.com',
      name: 'Radia Perlman',
      role: 'viewer',
      isBillingUser: false,
    },
    {
      id: 'user_barbara',
      email: 'barbara@example.com',
      name: 'Barbara Liskov',
      role: 'viewer',
      isBillingUser: false,
    },
    {
      id: 'user_hedy',
      email: 'hedy@example.com',
      name: 'Hedy Lamarr',
      role: 'viewer',
      isBillingUser: false,
    },
    {
      id: 'user_mary',
      email: 'mary@example.com',
      name: 'Mary Jackson',
      role: 'viewer',
      isBillingUser: false,
    },
  ])
  const profile = useRef({
    id: 'user_owner',
    email: 'owner@duet.so',
    firstName: 'Ada',
    lastName: 'Lovelace',
    name: 'Ada Lovelace',
  })
  const userKeys = useRef<UserApiKey[]>([
    {
      id: 'key_local',
      name: 'Local development',
      prefix: 'duet_sk_8f8a21c0',
      createdAt: Date.UTC(2026, 6, 8, 9),
      lastUsedAt: Date.UTC(2026, 6, 11, 8),
    },
  ])
  const syncMachines = useRef<SyncMachine[]>([
    {
      machineId: 'machine_macbook',
      syncthingDeviceId: 'AAAAAAA-BBBBBBB',
      name: 'MacBook Pro',
      createdAt: Date.UTC(2026, 6, 2, 17),
      lastUsedAt: Date.UTC(2026, 6, 11, 8, 58),
    },
    {
      machineId: 'machine_studio',
      syncthingDeviceId: 'CCCCCCC-DDDDDDD',
      name: 'Mac Studio',
      createdAt: Date.UTC(2026, 5, 20, 12),
      lastUsedAt: Date.UTC(2026, 6, 11, 8, 57),
    },
  ])
  const oauthGrants = useRef<OAuthGrant[]>(OAUTH_GRANT_FIXTURES.map(grant => ({ ...grant })))
  const apiRef = useRef<SpaApi | null>(null)
  if (apiRef.current === null) {
    apiRef.current = createFixtureApi(
      identity,
      sessionStore,
      apps,
      members,
      profile,
      userKeys,
      oauthGrants,
      syncMachines,
      setLastSessionInput,
      setLastMarketplaceAgentMutation,
      setLastIntegrationPolicyMutation,
      setLastMemberRequest,
    )
  }
  const defaultApi = apiRef.current
  const messages = locale === 'es-419' ? appEs : appEn
  const scenarioState: ReturnType<typeof scenarioFixture> = scenario.startsWith('settings-backups-')
    ? {
        initialPath: '/w/acme/settings/backups',
        identity:
          scenario === 'settings-backups-archived'
            ? {
                ...IDENTITY,
                workspaces: IDENTITY.workspaces.map(workspace =>
                  workspace.slug === 'acme'
                    ? {
                        ...workspace,
                        status: 'archived' as const,
                        servicingStatus: 'paused' as const,
                      }
                    : workspace,
                ),
              }
            : IDENTITY,
        api: { ...defaultApi, ...backupFixture.api },
      }
    : scenarioFixture(
        scenario,
        defaultApi,
        setLastRecoveryCheckout,
        () => {
          historyContinuationRequestsRef.current += 1
          setHistoryContinuationRequests(historyContinuationRequestsRef.current)
          return historyContinuationRequestsRef.current
        },
        {
          recordOnboardingSessionRequest: () => setOnboardingSessionRequests(count => count + 1),
          recordOnboardingAppLookup: () => setOnboardingAppLookups(count => count + 1),
        },
      )
  const scenarioIdentity = scenarioState.identity
  const fixture =
    scenarioIdentity !== undefined &&
    scenarioIdentity !== IDENTITY &&
    scenarioState.api.whoami === defaultApi.whoami
      ? {
          ...scenarioState,
          api: {
            ...scenarioState.api,
            whoami: async () => scenarioIdentity,
          },
        }
      : scenarioState

  return (
    <NextIntlClientProvider key={locale} locale={locale} messages={messages} timeZone="UTC">
      <AttributionConfigProvider now={() => FIXTURE_NOW}>
        <nav aria-label="Playground scenarios" className="sr-only">
          <button onClick={() => backupFixture.advance('ready')}>Finish backup</button>
          <button onClick={() => backupFixture.finishDeletion()}>Complete backup deletion</button>
          <button onClick={() => backupFixture.loseNextResponse()}>
            Lose next backup response
          </button>
          {fixture.armWorkspaceTransitionFailure ? (
            <button onClick={fixture.armWorkspaceTransitionFailure}>
              Simulate workspace transition failure
            </button>
          ) : null}
          {SCENARIOS.map(value => (
            <button
              key={value}
              onClick={() => {
                setLocale(localeForScenario(value))
                if (
                  value === 'sessions-pane-open' ||
                  value === 'sessions-pane-waiting' ||
                  value === 'sessions-pane-reconciling' ||
                  value === 'sessions-pane-apps-loading'
                )
                  prepareSessionPaneFixture(sessionStore.current)
                if (value === 'sessions-pane-reconciling') {
                  const statusApp = apps.current.find(app => app.slug === 'status-page')
                  if (statusApp !== undefined) {
                    statusApp.runtimeStatus = 'reconciling'
                    statusApp.reconciliationError = undefined
                  }
                  sessionStore.current.snapshots.session_running = {
                    ...sessionStore.current.snapshots.session_running!,
                    cwd: 'tools/status-page/incidents',
                  }
                }
                setBrowserPath(undefined)
                historyContinuationRequestsRef.current = 0
                setHistoryContinuationRequests(0)
                setOnboardingSessionRequests(0)
                setOnboardingAppLookups(0)
                identity.current = identityForScenario(value)
                setScenario(value)
              }}
            >
              Scenario: {value}
            </button>
          ))}
          <button
            onClick={() => {
              sessionStore.current.snapshots.session_running = {
                ...sessionStore.current.snapshots.session_running!,
                cwd: 'apps/reporting/another-report',
              }
            }}
          >
            Move running session within reporting app
          </button>
          <button
            onClick={() => {
              const statusApp = apps.current.find(app => app.slug === 'status-page')
              if (statusApp !== undefined) {
                statusApp.runtimeStatus = 'reconciling'
                statusApp.reconciliationError = undefined
              }
              sessionStore.current.snapshots.session_running = {
                ...sessionStore.current.snapshots.session_running!,
                cwd: 'tools/status-page/incidents',
              }
            }}
          >
            Move running session to status app
          </button>
          <button
            onClick={() => {
              sessionStore.current.snapshots.session_running = {
                ...sessionStore.current.snapshots.session_running!,
                cwd: 'notes/launch',
              }
            }}
          >
            Move running session outside apps
          </button>
          <button
            onClick={() => {
              sessionStore.current.defaultSessionIds.root = 'session_live'
            }}
          >
            Make child parent the default chat
          </button>
          <button
            onClick={() => {
              const store = sessionStore.current
              store.defaultSessionIds.agent_research = 'session_research_brief'
              for (const id of [
                'session_sleep',
                'session_export_complete',
                'session_export_notes',
                'session_research_scan',
              ]) {
                const row = store.sessions.find(session => session.id === id)!
                row.createdBySessionId = 'session_research_brief'
                store.snapshots[id] = {
                  ...store.snapshots[id]!,
                  createdBySessionId: 'session_research_brief',
                }
              }
            }}
          >
            Prepare agent default chat jobs
          </button>
          {BROWSER_ROUTES.map(path => (
            <button
              key={path}
              onClick={() => {
                window.history.pushState(null, '', path)
                setBrowserPath(path)
              }}
            >
              Browser route: {path}
            </button>
          ))}
          <button
            onClick={() => {
              identity.current = {
                ...identity.current,
                workspaces: identity.current.workspaces.map(workspace =>
                  workspace.slug === 'acme'
                    ? { ...workspace, servicingStatus: 'paused' }
                    : workspace,
                ),
              }
            }}
          >
            Simulate entitlement pause webhook
          </button>
          <button
            onClick={() => {
              identity.current = {
                ...identity.current,
                workspaces: identity.current.workspaces.map(workspace =>
                  workspace.slug === 'acme'
                    ? { ...workspace, servicingStatus: 'active' }
                    : workspace,
                ),
              }
            }}
          >
            Simulate entitlement resume webhook
          </button>
          <button
            onClick={() => {
              identity.current = withAcmeRecovery(identity.current, 'subscribe', 'active')
            }}
          >
            Simulate low credit subscribe
          </button>
          <button
            onClick={() => {
              identity.current = withAcmeRecovery(identity.current, 'topup', 'active')
            }}
          >
            Simulate low credit still pending
          </button>
          <button
            onClick={() => {
              const recovered = withAcmeRecovery(identity.current, 'topup', 'active')
              identity.current = {
                ...recovered,
                workspaces: recovered.workspaces.map(workspace =>
                  workspace.slug === 'acme'
                    ? {
                        ...workspace,
                        creditRecovery: 'topup',
                        servicingStatus: 'active',
                        billingUserId: 'user_grace',
                      }
                    : workspace,
                ),
              }
            }}
          >
            Simulate low credit member waiting
          </button>
          <button
            onClick={() => {
              identity.current = withAcmeRecovery(identity.current, null, 'active')
            }}
          >
            Simulate low credit recovery complete
          </button>
          <button
            onClick={() => {
              identity.current = withAcmeRecovery(identity.current, 'topup', 'paused')
            }}
          >
            Simulate entitlement precedence over low credit
          </button>
        </nav>
        <DriveFileIconClientProvider client={driveIcons.client}>
          <AppFrameSourceProvider source={fixtureAppFrameSource}>
            <DuetSpa
              key={browserPath ?? scenario}
              initialPath={browserPath === undefined ? fixture.initialPath : undefined}
              initialRouterState={
                browserPath === undefined ? fixture.initialRouterState : undefined
              }
              fixtureIdentity={fixture.identity}
              api={fixture.api}
              trainUploads={fixture.trainUploads}
              onSignedOut={browserPath === undefined ? () => setSignedOut(true) : undefined}
              onLocaleChange={setLocale}
              // A failed switch must not turn into a separate bootstrap polling failure.
              entitlementPollMs={scenario === 'switch-error' ? 0 : 100}
              // Forty-two seconds past the frozen event clock: the counting
              // "thinking for 42s" line photographs as the same instant on
              // every run, and deliberately does not echo the settled turn's
              // "thought for 30s" — matching numbers read as a copy-paste bug.
              clock={() => FIXTURE_NOW + 42_000}
            />
          </AppFrameSourceProvider>
        </DriveFileIconClientProvider>
        {signedOut ? (
          <p
            role="status"
            className="fixed right-4 top-4 z-[60] rounded-xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-white shadow-xl"
          >
            Browser session revoked.
          </p>
        ) : null}
        <output className="sr-only" data-testid="backup-event">
          {JSON.stringify(lastBackupEvent ?? null)}
        </output>
        <output className="sr-only" data-testid="session-input-payload">
          {lastSessionInput === undefined ? 'No session input' : JSON.stringify(lastSessionInput)}
        </output>
        <output className="sr-only" data-testid="member-request-payload">
          {lastMemberRequest === undefined
            ? 'No member request'
            : JSON.stringify(lastMemberRequest)}
        </output>
        <output className="sr-only" data-testid="recovery-checkout-payload">
          {lastRecoveryCheckout === undefined
            ? 'No recovery checkout'
            : JSON.stringify(lastRecoveryCheckout)}
        </output>
        <output className="sr-only" data-testid="marketplace-mutation">
          {lastMarketplaceAgentMutation === undefined
            ? 'No official agent mutation'
            : JSON.stringify(lastMarketplaceAgentMutation)}
        </output>
        <output className="sr-only" data-testid="integration-policy-mutation">
          {lastIntegrationPolicyMutation === undefined
            ? 'No integration policy mutation'
            : JSON.stringify(lastIntegrationPolicyMutation)}
        </output>
        <output className="sr-only" data-testid="session-count">
          {sessionStore.current.sessions.length}
        </output>
        <output className="sr-only" data-testid="history-continuation-requests">
          {historyContinuationRequests}
        </output>
        <output className="sr-only" data-testid="onboarding-session-requests">
          {onboardingSessionRequests}
        </output>
        <output className="sr-only" data-testid="onboarding-app-lookups">
          {onboardingAppLookups}
        </output>
      </AttributionConfigProvider>
    </NextIntlClientProvider>
  )
}

const SCENARIOS = [
  'default',
  'build-jobs-errors',
  'build-jobs-loading',
  'invitations',
  'invitations-onboarding',
  'invitations-blocked',
  'invitations-low-credit',
  'team-space-home',
  'team-space-home-awaiting-id',
  'team-space-home-created-list-stale',
  'team-space-home-empty-apps',
  'team-space-home-overflow-apps',
  'team-space-home-empty-chats',
  'team-space-home-two-owners',
  'team-space-home-error',
  'team-space-chat',
  'team-space-chat-generated-title',
  'team-space-app',
  'team-space-build',
  'onboarding',
  'share-one',
  'share-server-normalized',
  'share-deep-link',
  'share-link-unavailable',
  'share-several',
  'share-multi-workspace',
  'share-expired',
  'share-origin-unavailable',
  'share-target-unavailable',
  'share-accept-loading',
  'share-accept-error',
  'sessions-loading',
  'sessions-detail-loading',
  'sessions-error',
  'sessions-detail-error',
  'sessions-pane-apps-loading',
  'sessions-pane-open',
  'sessions-pane-waiting',
  'sessions-pane-reconciling',
  'sessions-long',
  'sessions-prompt-behind-history',
  'sessions-event-only-tail',
  'sessions-history-continuation-error',
  'sessions-quality-paid',
  'sessions-quality-snapshot',
  'sessions-member',
  'locked-agent-session-owner',
  'locked-agent-session-editor',
  'locked-agent-session-viewer',
  'locked-agent-app-viewer',
  'onboarded-agent-session-viewer',
  'sessions-lifecycle-workspace-viewer',
  'sessions-lifecycle-workspace-editor',
  'sessions-lifecycle-specific-viewer',
  'sessions-lifecycle-specific-editor',
  'sessions-lifecycle-owner-override',
  'sessions-lifecycle-403',
  'sessions-lifecycle-delete-403',
  'sessions-lifecycle-404',
  'sessions-viewer',
  'sessions-input-pending',
  'sessions-input-error',
  'sessions-spend-blocked',
  'sessions-spend-blocked-create',
  'low-credit-lifecycle',
  'sessions-input-response-lost',
  'sessions-create-awaiting-id',
  'sessions-create-response-lost',
  'sessions-delete-response-lost',
  'sessions-mutation-error',
  'sessions-mutation-error-ask',
  'sessions-metadata-response-lost',
  'sessions-personal-response-lost',
  'sessions-create-error',
  'sessions-audience-invalid',
  'sessions-audience-invalid-es',
  'marketplace-bootstrap-loading',
  'marketplace-loading',
  'marketplace-detail-loading',
  'marketplace-refetch-error',
  'agent-detail-loading',
  'agent-sessions-pagination-error',
  'files-bootstrap-loading',
  'files-data-loading',
  'files-pagination',
  'loading',
  'error',
  'unauthorized',
  'empty',
  'workspace-arriving',
  'invalid-workspace',
  'not-found',
  'admin-denied',
  'admin-message',
  'switch-error',
  'create-error',
  'create-refused',
  'train-empty',
  'train-pagination-empty',
  'train-staged',
  'resume-note',
  'failed-retained',
  'done-toast',
  'agent-train-local',
  'agent-train-inherited',
  'agent-train-concurrent',
  'train-memory-detail',
  'agent-train-replica',
  'agent-train-mobile',
  'train-uploading-with-progress',
  'train-cancelled',
  'train-quota-full-rejection',
  'train-url-pending',
  'train-url-failed',
  'train-loading',
  'train-error',
  'train-uploads-error',
  'train-long',
  'train-spanish',
  'settings-viewer',
  'settings-members-refetch-error',
  'settings-default-tier-subscribed',
  'settings-backups-empty',
  'settings-backups-capturing',
  'settings-backups-uploading',
  'settings-backups-ready',
  'settings-backups-partial',
  'settings-backups-failed',
  'settings-backups-deleting',
  'settings-backups-archived',

  'settings-usage-tier-badges',
  'settings-oauth-grants',
  'settings-not-payer',
  'settings-error',
  'settings-billing-trial',
  'settings-billing-active-starter',
  'settings-billing-active-pro-overage',
  'settings-billing-canceling',
  'settings-billing-downgrade-scheduled',
  'settings-billing-lapsed',
  'settings-billing-past-due',
  'settings-billing-topup-error',
  'settings-billing-error',
  'settings-billing-payment-received',
  'telemetry-loading',
  'telemetry-error',
  'telemetry-empty',
  'settings-spanish',
  'settings-shares',
  'settings-shares-empty',
  'settings-shares-error',
  'settings-connected-providers',
  'settings-connected-providers-plan-ineligible',
  'settings-connected-providers-connecting',
  'settings-connected-providers-awaiting-code',
  'settings-connected-providers-failed',
  'settings-connected-providers-disconnecting',
  'publishes-live',
  'publishes-pausing',
  'publishes-frozen',
  'publishes-resuming',
  'publishes-error',
  'publishes-live-es',
  'publishes-pausing-es',
  'publishes-frozen-es',
  'publishes-resuming-es',
  'publishes-error-es',
  'shares-paused-incoming',
  'shares-paused-outgoing',
  'shares-busy',
  'shares-failure',
  'shares-paused-incoming-es',
  'shares-paused-outgoing-es',
  'shares-busy-es',
  'shares-failure-es',
  'integrations-loading',
  'integrations-error',
  'integrations-refetch-error',
  'integrations-empty',
  'integrations-pagination-empty',
  'integrations-connect-pending',
  'integrations-agent-access-pending',
  'integrations-agent-access-error',
  'integrations-agent-access-overflow',
  'integrations-callback-success',
  'integrations-callback-canceled',
  'integrations-callback-error',
  'integrations-callback-provider-failed',
  'integrations-mcp-states',
  'integrations-mcp-probing',
  'integrations-mcp-error',
  'integrations-spanish',
  'agent-app-menu',
  'agent-app-menu-es',
  'agent-app-installing',
  'agent-app-broken',
] as const

const WORK_DOCK_OVERFLOW_APPS: App[] = [
  ...APP_FIXTURES,
  ...(['Release notes', 'Support queue', 'Weekly metrics', 'Incident review'] as const).map(
    (name, index) => {
      const source = APP_FIXTURES[0]!
      const slug = `dock-overflow-${index}`
      return {
        ...source,
        id: `app_dock_overflow_${index}`,
        anchorId: `anchor_dock_overflow_${index}`,
        anchorPath: `apps/${slug}`,
        name,
        slug,
        canonicalUrl: source.canonicalUrl.replace(source.slug, slug),
      }
    },
  ),
]

/* Every address the product has, driven through the real router. There is no
   workspace-level session or app entry any more: a session belongs to an agent
   and an app belongs to whichever agent's folder encloses it, so both are
   reached through the agent that owns them. The fixture's sessions carry no
   agent, which makes them the drive's own — `root`. */
const BROWSER_ROUTES = [
  /* Work's home, and the same home with one agent selected: the composer that
     starts a conversation lives here now, so the audience captures that used to
     drive the jobs dialog's `…/sessions/new` drive this instead. */
  '/w/acme/home',
  '/w/acme/home?agent=research',
  '/w/acme/agents',
  '/w/acme/agents/graph',
  /* Every shape of the map, because every one of them is now a place a link can
     name — and this is the only harness that drives the real router. */
  '/w/acme/agents/research',
  /* The camera come closer to one agent's work, without unfolding it — the ring
     is still the surface, so these are the ring with a lens on it. */
  '/w/acme/agents?branch=research',
  '/w/acme/agents?branch=research&session=session_sleep',
  '/w/acme/agents/root',
  '/w/acme/agents/research/files',
  '/w/acme/agents/research/files/agents/research',
  '/w/acme/agents/research/files/agents/research/uploads',
  '/w/acme/agents/root/files',
  '/w/acme/agents/research/apps/reporting',
  /* The same shape on the carrier that actually reaches the app — Duet, whose
     folder encloses `apps/reporting`. The line above is the *other* case on
     purpose (an app this agent does not carry, which falls through to the
     reader's row), and having only that one meant no route here cold-loaded
     straight onto an app frame. */
  '/w/acme/agents/root/apps/reporting',
  '/w/acme/agents/research/sessions/session_live',
  // a session stamped with its agent's slug-era name: the live profile speaks
  '/w/acme/agents/research/sessions/session_stale_stamp',
  '/w/acme/agents/root/sessions/session_live',
  '/w/acme/agents/root/sessions/session_running',
  // A delegated conversation on its owner’s Work surface.
  '/w/acme/agents/research/sessions/session_sleep',
  '/w/acme/agents/research/sessions/session_sleep?workParent=wrong-parent',
  // A default chat resolves to its owner's Work Home.
  '/w/acme/agents/root/sessions/session_root_chat',
  /* The short session link an agent emits from the session API: not
     a surface, a redirect. The harness keeps proving it resolves onto the
     owning agent's own address instead of a 404. The bare path is the same
     redirect with nothing to resolve — it lands on the map. */
  '/w/acme/sessions',
  '/w/acme/sessions/session_live',
  // A short child-session link resolves to its owner's Work address.
  '/w/acme/sessions/session_sleep',
  '/w/acme/agents/reviewer',
  '/w/acme/agents/ghost',
  // a link naming a session this drive does not hold: said, never swapped
  '/w/acme/agents/research/sessions/session_not_here',
  '/w/acme/agents/research/settings',
  // a link to an agent this drive does not have: the ring, and it says so
  '/w/acme/agents/ghost-agent',
  '/w/acme/agents/marketplace/official-agents-hub/research',
  '/w/acme/agents/marketplace/official-agents-hub/brief-writer',
  '/w/acme/files',
  '/w/labs/files',
  '/w/acme/files/folder/report.txt',
  '/w/acme/train/root',
  '/w/acme/integrations',
  '/w/acme/settings/general',
  '/w/acme/settings/backups',
  '/w/acme/settings/members',
  // No door leads here — invitations are rows on the roster now — but an
  // owner who bookmarked the old page still has this address, so the harness
  // keeps proving it lands on the list rather than on a 404. (Invite mail
  // never carried it: those links go to `/invite/<token>`.)
  '/w/acme/settings/invites',
  '/w/acme/settings/shares',
  '/w/acme/settings/publishes',
  '/w/acme/settings/usage',
  '/w/acme/settings/audit',
  '/w/acme/settings/billing-user',
  '/w/acme/settings/unknown',
  '/settings/profile',
  '/settings/billing',
  '/settings/api-keys',
  '/settings/preferences',
  '/settings/unknown',
  '/internal-admin',
] as const

type Scenario = (typeof SCENARIOS)[number]

function identityForScenario(scenario: Scenario): WhoamiResponse {
  const identity =
    scenario === 'low-credit-lifecycle' ? withAcmeRecovery(IDENTITY, 'topup', 'active') : IDENTITY
  return {
    ...identity,
    workspaces: identity.workspaces.map(workspace => ({ ...workspace })),
    scopes: [...identity.scopes],
  }
}

function withAcmeRecovery(
  identity: WhoamiResponse,
  creditRecovery: WorkspaceSummary['creditRecovery'],
  servicingStatus: WorkspaceSummary['servicingStatus'],
): WhoamiResponse {
  return {
    ...identity,
    workspaces: identity.workspaces.map(workspace =>
      workspace.slug === 'acme'
        ? { ...workspace, creditRecovery, servicingStatus, billingUserId: 'user_owner' }
        : workspace,
    ),
  }
}

function outOfCreditsError(): DuetApiError {
  return new DuetApiError(402, 'insufficient_credits', 'insufficient_credits', {
    error: 'insufficient_credits',
    code: 'insufficient_credits',
    tier: 'account',
    balanceMicroUsd: 0,
    autoTopupScheduled: false,
    billingUrl: 'https://app.duet.so/settings/billing',
  })
}

function localeForScenario(scenario: Scenario): 'en' | 'es-419' {
  return scenario === 'train-spanish' ||
    scenario === 'settings-spanish' ||
    scenario === 'integrations-spanish' ||
    scenario.endsWith('-es')
    ? 'es-419'
    : 'en'
}

function scenarioFixture(
  scenario: Scenario,
  defaultApi: SpaApi,
  recordRecoveryCheckout: (request: unknown) => void,
  recordHistoryContinuation: () => number,
  onboardingRequests: {
    recordOnboardingSessionRequest: () => void
    recordOnboardingAppLookup: () => void
  },
): {
  initialPath: string
  initialRouterState?: unknown
  identity?: WhoamiResponse
  api: SpaApi
  trainUploads?: TrainUploadsClient
  armWorkspaceTransitionFailure?: () => void
} {
  if (scenario === 'build-jobs-loading') {
    return {
      initialPath: '/w/acme/agents/research',
      api: { ...defaultApi, listSessionChildren: () => new Promise(() => {}) },
    }
  }
  if (scenario === 'build-jobs-errors') {
    let initialFailed = false
    let continuationFailed = false
    return {
      initialPath: '/w/acme/agents/research',
      api: {
        ...defaultApi,
        listSessionChildren: async (...args) => {
          if (!args[2]?.cursor && !initialFailed) {
            initialFailed = true
            throw new Error('Fixture initial children read failed')
          }
          if (args[2]?.cursor && !continuationFailed) {
            continuationFailed = true
            throw new Error('Fixture continuation children read failed')
          }
          return defaultApi.listSessionChildren(...args)
        },
      },
    }
  }
  if (
    scenario === 'invitations' ||
    scenario === 'invitations-onboarding' ||
    scenario === 'invitations-blocked' ||
    scenario === 'invitations-low-credit'
  ) {
    let identity = identityForScenario(scenario)
    if (scenario === 'invitations-onboarding') {
      identity.workspaces = identity.workspaces.map(workspace => ({
        ...workspace,
        onboardedAt: undefined,
      }))
    }
    if (scenario === 'invitations-blocked') {
      identity.workspaces = identity.workspaces.map(workspace =>
        workspace.slug === 'acme' ? { ...workspace, servicingStatus: 'paused' } : workspace,
      )
    }
    if (scenario === 'invitations-low-credit') {
      identity.workspaces = identity.workspaces.map(workspace =>
        workspace.slug === 'acme' ? { ...workspace, creditRecovery: 'subscribe' } : workspace,
      )
    }
    const targets = [
      {
        ...IDENTITY.workspaces[0]!,
        id: 'workspace_newera',
        slug: 'newera',
        name: 'NewEra',
        role: 'editor' as const,
        onboardedAt: FIXTURE_NOW,
      },
      {
        ...IDENTITY.workspaces[0]!,
        id: 'workspace_studio',
        slug: 'studio',
        name: 'International Research Studio',
        role: 'viewer' as const,
        onboardedAt: FIXTURE_NOW,
      },
    ]
    let failNextAcceptance = scenario === 'invitations-onboarding'
    let invites = targets.map((workspace, index) => ({
      id: `invite_${index}`,
      workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
      inviter: {
        name: index === 0 ? 'Chris' : 'Grace',
        email: index === 0 ? 'chris@example.com' : 'grace@example.com',
      },
      role: workspace.role,
      expiresAt: Date.UTC(2099, 0, 1),
    }))
    return {
      initialPath: scenario === 'invitations-onboarding' ? '/w/acme/onboarding' : '/w/acme/home',
      identity,
      api: {
        ...defaultApi,
        whoami: async () => identity,
        listIncomingInvitations: async () => ({ items: invites, nextCursor: null }),
        completeWorkspaceOnboarding: async (...args) => {
          await new Promise<void>(resolve => {
            window.addEventListener('complete-invitation-onboarding', () => resolve(), {
              once: true,
            })
          })
          return await defaultApi.completeWorkspaceOnboarding(...args)
        },
        onboardingPaymentStatus: async () => ({ ready: true }),
        acceptInvitation: async inviteId => {
          if (failNextAcceptance) {
            failNextAcceptance = false
            throw new DuetApiError(503, 'unavailable')
          }
          const invite = invites.find(row => row.id === inviteId)
          const target = targets.find(row => row.id === invite?.workspace.id)
          if (target === undefined) throw new DuetApiError(404, 'invitation_unavailable')
          identity = { ...identity, workspaces: [...identity.workspaces, target] }
          invites = invites.filter(row => row.id !== inviteId)
          return { workspaceId: target.id, workspaceSlug: target.slug }
        },
      },
      trainUploads: createTrainUploadsFixture(),
    }
  }
  if (scenario.startsWith('team-space-')) {
    const initialPath =
      scenario === 'team-space-home' ||
      scenario === 'team-space-home-awaiting-id' ||
      scenario === 'team-space-home-created-list-stale' ||
      scenario === 'team-space-home-empty-apps' ||
      scenario === 'team-space-home-overflow-apps' ||
      scenario === 'team-space-home-empty-chats' ||
      scenario === 'team-space-home-two-owners' ||
      scenario === 'team-space-home-error'
        ? '/w/acme/home'
        : scenario === 'team-space-chat' || scenario === 'team-space-chat-generated-title'
          ? '/w/acme/agents/root/sessions/session_live'
          : scenario === 'team-space-app'
            ? '/w/acme/agents/root/apps/reporting?mode=work'
            : '/w/acme/agents/graph'
    return {
      initialPath,
      identity: IDENTITY,
      api:
        scenario === 'team-space-home-empty-apps'
          ? {
              ...defaultApi,
              listApps: async (workspaceSlug, options = {}) => ({
                ...(await defaultApi.listApps(workspaceSlug, options)),
                items: [],
                nextCursor: null,
              }),
            }
          : scenario === 'team-space-home-overflow-apps'
            ? {
                ...defaultApi,
                listApps: async (workspaceSlug, options = {}) => ({
                  ...(await defaultApi.listApps(workspaceSlug, options)),
                  items: WORK_DOCK_OVERFLOW_APPS,
                  nextCursor: null,
                }),
              }
            : scenario === 'team-space-home-awaiting-id'
              ? {
                  ...defaultApi,
                  createSession: () => new Promise(() => {}),
                }
              : scenario === 'team-space-home-created-list-stale'
                ? freezeSessionList(defaultApi)
                : scenario === 'team-space-home-empty-chats'
                  ? {
                      ...defaultApi,
                      listSessions: async () => ({ items: [], nextCursor: null }),
                      /* Production activity still returns an owner whose only
                         session is its default chat. Activity membership alone
                         therefore cannot put an owner in Other chats. */
                      listSessionActivity: async () => ({
                        owners: AGENT_FIXTURES.map((agent, index) => ({
                          agentId: agent.id,
                          /* Research also has child-only activity: it passes
                             the cheap activity prefilter but still must not
                             appear when the top-level list answers empty. */
                          sessions:
                            index === 0
                              ? [
                                  {
                                    id: 'session_research_child',
                                    title: 'Nested research task',
                                    bucket: 'running' as const,
                                    updatedAt: FIXTURE_NOW,
                                    unread: false,
                                  },
                                ]
                              : [],
                          truncated: false,
                          chat: {
                            id: `session_${agent.slug}_chat`,
                            title: `Chat with ${agent.name ?? agent.slug}`,
                            bucket: 'done' as const,
                            updatedAt: FIXTURE_NOW - index * 60_000,
                            unread: false,
                          },
                        })),
                      }),
                    }
                  : scenario === 'team-space-home-error'
                    ? {
                        ...defaultApi,
                        listAgents: async () => {
                          throw new Error('Fixture Team Space agents failure')
                        },
                        listApps: async () => {
                          throw new Error('Fixture Team Space apps failure')
                        },
                      }
                    : scenario === 'team-space-chat'
                      ? {
                          ...defaultApi,
                          sendSessionMessage: () => new Promise(() => {}),
                        }
                      : scenario === 'team-space-chat-generated-title'
                        ? generatedTitleAheadOfDetail(defaultApi)
                        : defaultApi,
      trainUploads: createTrainUploadsFixture(),
    }
  }
  if (scenario === 'files-pagination') {
    return {
      initialPath: '/w/acme/files',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listWorkspaceFiles: async (workspaceSlug, path = '', options = {}) => {
          if (path !== '') return defaultApi.listWorkspaceFiles(workspaceSlug, path, options)
          if (options.cursor === 'drive-page-3')
            return {
              items: [
                {
                  name: 'Archive',
                  path: 'Archive',
                  type: 'directory' as const,
                  size: 0,
                  mtime: '2026-07-15T08:00:00.000Z',
                },
              ],
              nextCursor: null,
            }
          if (options.cursor === 'drive-page-2')
            return {
              items: [
                {
                  name: 'Templates',
                  path: 'Templates',
                  type: 'directory' as const,
                  size: 0,
                  mtime: '2026-07-15T08:00:00.000Z',
                },
              ],
              nextCursor: 'drive-page-3',
            }
          return {
            items: [
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
            ],
            nextCursor: 'drive-page-2',
          }
        },
      },
    }
  }
  if (scenario === 'low-credit-lifecycle') {
    const initialIdentity = withAcmeRecovery(IDENTITY, 'topup', 'active')
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: initialIdentity,
      api: {
        ...defaultApi,
        // Distinct wrapper keeps the playground's dynamic identity ref in
        // charge after the initial fixture has hydrated the shell.
        whoami: async (...args) => await defaultApi.whoami(...args),
        createSubscriptionCheckout: async request => {
          const mode = (globalThis as { __lowCreditCheckoutMode?: 'ready' | 'pending' | 'error' })
            .__lowCreditCheckoutMode
          if (mode === 'pending') return await new Promise(() => {})
          if (mode === 'error') throw new Error('Fixture checkout failure')
          recordRecoveryCheckout(request)
          return { url: 'https://checkout.stripe.test/subscription' }
        },
        createBillingCheckout: async request => {
          const mode = (globalThis as { __lowCreditCheckoutMode?: 'ready' | 'pending' | 'error' })
            .__lowCreditCheckoutMode
          if (mode === 'pending') return await new Promise(() => {})
          if (mode === 'error') throw new Error('Fixture checkout failure')
          recordRecoveryCheckout(request)
          return { url: 'https://checkout.stripe.test/topup' }
        },
      },
    }
  }
  const pauseScene = scenario.endsWith('-es') ? scenario.slice(0, -3) : scenario
  if (scenario === 'onboarding') {
    return {
      initialPath: '/w/acme/agents/research',
      identity: {
        ...IDENTITY,
        workspaces: IDENTITY.workspaces.map(workspace =>
          workspace.slug === 'acme' ? { ...workspace, onboardedAt: undefined } : workspace,
        ),
      },
      api: defaultApi,
      trainUploads: createTrainUploadsFixture(),
    }
  }
  if (pauseScene.startsWith('publishes-')) {
    const frozen = pauseScene === 'publishes-frozen' || pauseScene === 'publishes-resuming'
    const publishes = PUBLISH_MANAGEMENT_FIXTURE.map(publish =>
      publish.slug === 'weekly' && frozen
        ? { ...publish, pausedAt: FIXTURE_NOW - 60_000, pauseGeneration: 'fixture-generation' }
        : publish,
    )
    return {
      initialPath: '/w/acme/settings/publishes',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listPublishes: async () => ({ items: publishes, nextCursor: null }),
        setPublishPaused:
          pauseScene === 'publishes-pausing' || pauseScene === 'publishes-resuming'
            ? () => new Promise(() => {})
            : pauseScene === 'publishes-error'
              ? async () => {
                  throw new Error('Fixture publish pause failure')
                }
              : async (_workspaceSlug, slug, paused) => ({
                  publish: {
                    ...publishes.find(publish => publish.slug === slug)!,
                    pausedAt: paused ? FIXTURE_NOW : undefined,
                  },
                }),
      },
    }
  }
  if (pauseScene.startsWith('shares-')) {
    const shares = structuredClone(SHARE_MANAGEMENT_FIXTURE)
    if (pauseScene === 'shares-paused-incoming') {
      const index = shares.items.findIndex(item => item.direction === 'incoming')
      shares.items[index] = pausedShare(shares.items[index]!)
    }
    if (pauseScene === 'shares-paused-outgoing') {
      const index = shares.items.findIndex(item => item.direction === 'outgoing')
      shares.items[index] = pausedShare(shares.items[index]!)
    }
    return {
      initialPath: '/w/acme/settings/shares',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listShares: async () => structuredClone(shares),
        setSharePaused:
          pauseScene === 'shares-busy'
            ? () => new Promise(() => {})
            : pauseScene === 'shares-failure'
              ? async () => {
                  throw new Error('Fixture share pause failure')
                }
              : async (_workspaceSlug, shareId, paused) => {
                  const share = shares.items.find(item => item.id === shareId)!
                  return { share: { ...share, pausedAt: paused ? FIXTURE_NOW : undefined } }
                },
      },
    }
  }
  if (scenario.startsWith('share-')) {
    const share =
      scenario === 'share-expired'
        ? { ...structuredClone(SHARE_REQUEST_FIXTURES[0]), state: 'expired' as const }
        : scenario === 'share-origin-unavailable'
          ? {
              ...structuredClone(SHARE_REQUEST_FIXTURES[0]),
              source: { ...SHARE_REQUEST_FIXTURES[0].source, originLive: false },
            }
          : structuredClone(SHARE_REQUEST_FIXTURES[0])
    const shares =
      scenario === 'share-link-unavailable'
        ? []
        : scenario === 'share-several' || scenario === 'share-deep-link'
          ? SHARE_REQUEST_FIXTURES.map(candidate => structuredClone(candidate))
          : [share]
    const scenarioIdentity =
      scenario === 'share-multi-workspace'
        ? {
            ...IDENTITY,
            workspaces: IDENTITY.workspaces.map(workspace => ({
              ...workspace,
              status: 'active' as const,
            })),
          }
        : scenario === 'share-target-unavailable'
          ? {
              ...IDENTITY,
              workspaces: IDENTITY.workspaces.map(workspace => ({
                ...workspace,
                role: 'viewer' as const,
              })),
            }
          : IDENTITY
    return {
      initialPath: `/w/acme/files?shareRequest=${share.id}`,
      identity: scenarioIdentity,
      api: {
        ...defaultApi,
        whoami: async () => scenarioIdentity,
        listShareRequests: async () => ({ items: shares, nextCursor: null }),
        listWorkspaceFiles: async (workspaceSlug, path = '', options = {}) => {
          if (path.endsWith('qbr-deck') || path.endsWith('server-qbr'))
            return {
              items: [
                {
                  name: 'fresh-share.txt',
                  path: `${path}/fresh-share.txt`,
                  type: 'file' as const,
                  size: 20,
                  mtime: '2026-07-18T08:00:00.000Z',
                },
              ],
              nextCursor: null,
            }
          return await defaultApi.listWorkspaceFiles(workspaceSlug, path, options)
        },
        statWorkspaceFile: async (_workspaceSlug, path) => ({
          entry: {
            name: path.split('/').at(-1) ?? '',
            path,
            type: 'directory',
            size: 0,
            mtime: '2026-07-15T08:00:00.000Z',
          },
          etag: null,
        }),
        consumePendingShare:
          scenario === 'share-deep-link'
            ? async () => structuredClone(share)
            : scenario === 'share-link-unavailable'
              ? async () => 'unavailable' as const
              : async () => null,
        acceptShare:
          scenario === 'share-accept-loading'
            ? async () => await new Promise(() => {})
            : scenario === 'share-accept-error'
              ? async () => {
                  throw new Error('Fixture accept failure')
                }
              : async (shareId, input) => {
                  const acceptedShare = shares.find(candidate => candidate.id === shareId)
                  if (acceptedShare === undefined) throw new DuetApiError(404, 'not_found')
                  return {
                    share: {
                      ...acceptedShare,
                      state: 'active' as const,
                      toWorkspaceId: input.toWorkspaceId,
                      mountPath:
                        scenario === 'share-server-normalized'
                          ? 'Shared/Finance/server-qbr'
                          : input.mountPath,
                    },
                  }
                },
      },
      ...(scenario === 'share-deep-link' || scenario === 'share-link-unavailable'
        ? { initialPath: '/?shared=1' }
        : {}),
    }
  }
  /* Work's home, because Work's rail is what a stalled session list now leaves
     waiting. This used to land on the jobs dialog's list pane, which went with
     the dialog — but the *states* did not: the rail draws its own skeleton and
     its own retry off the same read. */
  if (scenario === 'sessions-loading') {
    return {
      initialPath: '/w/acme/home',
      identity: IDENTITY,
      api: { ...defaultApi, listSessions: () => new Promise(() => {}) },
    }
  }
  if (scenario === 'sessions-detail-loading') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        getSession: () => new Promise(() => {}),
        getSessionHistory: () => new Promise(() => {}),
      },
    }
  }
  if (scenario === 'sessions-error') {
    return {
      initialPath: '/w/acme/home',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listSessions: async () => {
          throw new Error('Fixture session list failure')
        },
      },
    }
  }
  if (scenario === 'sessions-detail-error') {
    /* Fails until the driving test flips the flag, not for a fixed number of
       attempts: the dialog band and the conversation share one detail query,
       so how many observers consume how many failures is an implementation
       fact this fixture must not encode.

       Research's stale-stamped session, because this scene is about the read
       the dialog makes *by id*: that session is deliberately absent from every
       list (snapshot-only), so the dialog cannot answer from a row it holds and
       has to resolve it — which is the read being failed here. The drive's own
       chat used to stand in for that, back when a chat could be opened in the
       dialog at all; it cannot, and a scene resting on it would be resting on
       the defect. */
    const healed = () =>
      (globalThis as { __sessionDetailHealed?: boolean }).__sessionDetailHealed === true
    return {
      initialPath: '/w/acme/agents/research/sessions/session_stale_stamp',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        getSession: async (...args) => {
          if (!healed()) throw new Error('Fixture session detail failure')
          return defaultApi.getSession(...args)
        },
        getSessionHistory: async (...args) => {
          if (!healed()) throw new Error('Fixture session history failure')
          return defaultApi.getSessionHistory(...args)
        },
      },
    }
  }
  if (
    scenario === 'sessions-pane-open' ||
    scenario === 'sessions-pane-reconciling' ||
    scenario === 'sessions-pane-waiting'
  ) {
    return {
      // Same pane, two conversations: the running one is where an app is being
      // worked in, the waiting one is where the agent has asked for something.
      /* `prepareSessionPaneFixture` makes the running session a child of
         `session_complete`, so Work addresses it the way its Recent-jobs rail
         does — by owner and parent. The waiting one has no parent and keeps the
         top-level form. */
      initialPath:
        scenario === 'sessions-pane-waiting'
          ? '/w/acme/agents/root/sessions/session_live'
          : '/w/acme/agents/root/sessions/session_running',
      identity: IDENTITY,
      api: defaultApi,
    }
  }
  if (scenario === 'sessions-pane-apps-loading') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_running',
      identity: IDENTITY,
      api: { ...defaultApi, listApps: () => new Promise(() => {}) },
    }
  }
  if (scenario === 'sessions-prompt-behind-history') {
    /* The shape a long-running agent turn actually produces: the latest page is
       all of the agent's own work — reasoning and tool calls — and the prompt
       that started it has already fallen onto the page behind. One message
       lands, it does not fill the viewport, and there is nothing to scroll, so
       the reader is left looking at an answer with no question. */
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        getSessionHistory: async (...args) => {
          if (args[2]?.cursor !== undefined) {
            return {
              items: [
                {
                  seq: 1,
                  createdAt: FIXTURE_NOW - 900_000,
                  event: {
                    type: 'prompt_submitted' as const,
                    prompt: 'Value the S&P 500 against long-run earnings.',
                    inputKind: 'message' as const,
                    sender: FIXTURE_VIEWER_SENDER,
                  },
                },
              ],
              nextCursor: null,
            }
          }
          return {
            items: [
              {
                seq: 3,
                createdAt: FIXTURE_NOW - 40_000,
                event: {
                  type: 'step' as const,
                  step: {
                    type: 'tool_call' as const,
                    toolName: 'collect_valuation_multiples',
                    toolCallId: 'tool_multiples',
                    input: { index: 'sp500' },
                    isError: false,
                    output: [{ type: 'text' as const, text: 'Collected 12 series.' }],
                  },
                },
              },
              { seq: 2, createdAt: FIXTURE_NOW - 50_000, event: { type: 'turn_started' as const } },
            ],
            nextCursor: 'valuation-older',
          }
        },
      },
    }
  }
  if (scenario === 'sessions-long') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        getSessionHistory: async (...args) => {
          if (args[2]?.cursor !== undefined)
            return {
              items: [
                {
                  seq: 1,
                  createdAt: FIXTURE_NOW - 90_000,
                  event: {
                    type: 'agent_message' as const,
                    message: 'Earlier launch context: the original readiness brief is attached.',
                    createdAt: '2026-07-10T23:58:30.000Z',
                  },
                },
              ],
              nextCursor: null,
            }
          const history = await defaultApi.getSessionHistory(...args)
          const nextSeq = (history.items[0]?.seq ?? 0) + 1
          const tail = Array.from({ length: 14 }, (_, index) => {
            // Stay contiguous with the canonical fixture. A gap is meaningful:
            // the projector stops there instead of inventing missing history.
            const seq = nextSeq + index * 2
            const createdAt = FIXTURE_NOW - (28 - index * 2) * 1_000
            return [
              {
                seq,
                createdAt,
                event: {
                  type: 'prompt_submitted' as const,
                  prompt: `Review launch checkpoint ${index + 1}.`,
                  inputKind: 'message' as const,
                  behavior: 'steer' as const,
                  sender: FIXTURE_VIEWER_SENDER,
                },
              },
              {
                seq: seq + 1,
                createdAt: createdAt + 1_000,
                event: {
                  type: 'step' as const,
                  step: {
                    type: 'text' as const,
                    text: `Launch evidence ${index + 1}: the staging checkpoint is verified and ready for review.`,
                  },
                },
              },
            ]
          }).flat()
          return {
            items: [...tail.toReversed(), ...history.items],
            // Sequence 1 belongs to the cursor branch above. Without a cursor,
            // the page falsely claims this sequence-2 tail is complete.
            nextCursor: 'sessions-long-older',
          }
        },
      },
    }
  }
  if (scenario === 'sessions-event-only-tail') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        getSessionHistory: async (...args) =>
          args[2]?.cursor !== undefined
            ? {
                items: [
                  {
                    seq: 1,
                    createdAt: FIXTURE_NOW - 60_000,
                    event: {
                      type: 'agent_message' as const,
                      message: 'Visible history survived an event-only latest page.',
                      createdAt: '2026-07-10T23:59:00.000Z',
                    },
                  },
                ],
                nextCursor: null,
              }
            : {
                items: [
                  {
                    seq: 2,
                    createdAt: FIXTURE_NOW,
                    event: { type: 'todos' as const, todos: [] },
                  },
                ],
                nextCursor: 'older-events',
              },
      },
    }
  }
  if (scenario === 'sessions-history-continuation-error') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        getSessionHistory: async (...args) => {
          if (args[2]?.cursor === undefined) {
            return {
              ...(await defaultApi.getSessionHistory(...args)),
              nextCursor: 'history-retry',
            }
          }
          const attempt = recordHistoryContinuation()
          await new Promise(resolve => setTimeout(resolve, 75))
          if (attempt === 1) throw new Error('Fixture older history failure')
          return {
            items: [
              {
                seq: 1,
                createdAt: FIXTURE_NOW - 60_000,
                event: {
                  type: 'agent_message' as const,
                  message: 'Earlier retry context recovered.',
                  createdAt: '2026-07-10T23:59:00.000Z',
                },
              },
            ],
            nextCursor: null,
          }
        },
      },
    }
  }
  if (scenario === 'sessions-quality-paid') {
    return {
      initialPath: '/w/acme/agents/research',
      identity: IDENTITY,
      api: defaultApi,
    }
  }
  if (scenario === 'sessions-quality-snapshot') {
    return {
      initialPath: '/w/acme/agents/root',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        getSession: async (...args) => ({
          ...(await defaultApi.getSession(...args)),
          tier: 'frontier',
        }),
      },
    }
  }
  if (scenario === 'marketplace-loading') {
    const pending = () => new Promise<never>(() => {})
    return {
      initialPath: '/w/acme/agents/marketplace',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listMarketplaceCatalog: pending,
        listMarketplaceAgentSubscriptions: pending,
      },
    }
  }
  if (scenario === 'marketplace-detail-loading') {
    return {
      initialPath: '/w/acme/agents/marketplace/official-agents-hub/research',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        getMarketplaceListingDetail: () => new Promise<never>(() => {}),
      },
    }
  }
  if (scenario === 'marketplace-refetch-error') {
    let catalogReads = 0
    let subscriptionReads = 0
    let agentReads = 0
    return {
      initialPath: '/w/acme/agents/marketplace',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listMarketplaceCatalog: async (...args) => {
          if (catalogReads++ > 0) throw new Error('Fixture marketplace refresh failure')
          const page = await defaultApi.listMarketplaceCatalog(...args)
          return { ...page, items: page.items.slice(0, 1), nextCursor: null }
        },
        listMarketplaceAgentSubscriptions: async (...args) => {
          if (subscriptionReads++ > 0) throw new Error('Fixture subscription refresh failure')
          return await defaultApi.listMarketplaceAgentSubscriptions(...args)
        },
        listAgents: async (...args) => {
          if (agentReads++ > 0) throw new Error('Fixture agent refresh failure')
          return await defaultApi.listAgents(...args)
        },
      },
    }
  }
  if (scenario === 'agent-detail-loading') {
    return {
      initialPath: '/w/acme/agents/research/settings',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listAgents: () => new Promise(() => {}),
      },
    }
  }
  if (scenario === 'agent-sessions-pagination-error') {
    return {
      initialPath: '/w/acme/agents/research/settings',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listSessions: async (...args) => {
          const query = args[1] ?? {}
          if (query.cursor !== undefined) throw new Error('Fixture agent sessions page failure')
          const page = await defaultApi.listSessions(args[0], { limit: query.limit })
          return { ...page, items: page.items.slice(0, 1), nextCursor: 'agent-session-page-2' }
        },
      },
    }
  }
  if (scenario === 'marketplace-bootstrap-loading') {
    return {
      initialPath: '/w/acme/agents/marketplace',
      api: { ...defaultApi, whoami: () => new Promise(() => {}) },
    }
  }
  if (scenario.startsWith('sessions-lifecycle-')) {
    const all = {
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: false,
      personalArchive: true,
      globalArchive: true,
      delete: true,
    }
    const personalOnly = { ...all, globalArchive: false, delete: false }
    const archives = {
      'sessions-lifecycle-workspace-viewer': {
        globalArchivedAt: null,
        personalArchivedAt: null,
        reason: null,
      },
      'sessions-lifecycle-workspace-editor': {
        globalArchivedAt: null,
        personalArchivedAt: FIXTURE_NOW - 2_000,
        reason: 'personal' as const,
      },
      'sessions-lifecycle-specific-viewer': {
        globalArchivedAt: FIXTURE_NOW - 1_000,
        personalArchivedAt: null,
        reason: 'global' as const,
      },
      'sessions-lifecycle-specific-editor': {
        globalArchivedAt: FIXTURE_NOW - 1_000,
        personalArchivedAt: FIXTURE_NOW - 2_000,
        reason: 'global' as const,
      },
      'sessions-lifecycle-owner-override': {
        globalArchivedAt: null,
        personalArchivedAt: null,
        reason: null,
      },
    } as const
    const matrixScenario = scenario as keyof typeof archives
    let staleForbidden = false
    let staleDeleteForbidden = false
    let missing = false
    const archive = archives[matrixScenario] ?? archives['sessions-lifecycle-owner-override']
    const viewer = scenario.endsWith('-viewer')
    const specific = scenario.includes('-specific-') || scenario.includes('owner-override')
    const project = async (...args: Parameters<SpaApi['getSession']>) => {
      if (missing) throw new DuetApiError(404, 'not_found')
      const snapshot = await defaultApi.getSession(...args)
      return {
        ...snapshot,
        archive,
        permissions: staleDeleteForbidden
          ? { ...all, delete: false }
          : staleForbidden
            ? { ...all, personalArchive: false, globalArchive: false, delete: false }
            : viewer
              ? personalOnly
              : all,
        ...(specific
          ? {
              audience: {
                kind: 'specific' as const,
                count: 1,
                preview: [
                  {
                    memberId: 'member_ada',
                    userId: 'user_owner',
                    name: 'Ada Lovelace',
                    email: 'owner@duet.so',
                    role: 'owner' as const,
                  },
                ],
              },
            }
          : { audience: { kind: 'workspace' as const } }),
      }
    }
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        getSession: project,
        listSessions: async (...args) => {
          const page = await defaultApi.listSessions(...args)
          return missing
            ? { ...page, items: page.items.filter(session => session.id !== 'session_live') }
            : page
        },
        archiveSession:
          scenario === 'sessions-lifecycle-403'
            ? async () => {
                staleForbidden = true
                throw new DuetApiError(403, 'forbidden')
              }
            : scenario === 'sessions-lifecycle-404'
              ? async () => {
                  missing = true
                  throw new DuetApiError(404, 'not_found')
                }
              : defaultApi.archiveSession,
        deleteSession:
          scenario === 'sessions-lifecycle-delete-403'
            ? async () => {
                staleDeleteForbidden = true
                throw new DuetApiError(403, 'forbidden')
              }
            : defaultApi.deleteSession,
      },
    }
  }
  if (scenario === 'sessions-member') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: {
        ...IDENTITY,
        workspaces: IDENTITY.workspaces.map(workspace =>
          workspace.slug === 'acme' ? { ...workspace, role: 'editor' as const } : workspace,
        ),
        scopes: ['ws:acme:sessions'],
        internalAdmin: false,
      },
      api: defaultApi,
    }
  }
  /* Starting a conversation is Work's home now — the jobs dialog's composer was
     the other door and it is gone. The claim is unchanged: a viewer of an
     onboarded agent may open one. */
  if (scenario === 'onboarded-agent-session-viewer') {
    return {
      initialPath: '/w/acme/home?agent=research',
      identity: {
        ...IDENTITY,
        workspaces: IDENTITY.workspaces.map(workspace =>
          workspace.slug === 'acme' ? { ...workspace, role: 'viewer' as const } : workspace,
        ),
        scopes: ['ws:acme:files:read', 'ws:acme:sessions'],
        internalAdmin: false,
      },
      api: defaultApi,
    }
  }
  if (
    scenario === 'locked-agent-session-owner' ||
    scenario === 'locked-agent-session-editor' ||
    scenario === 'locked-agent-session-viewer' ||
    scenario === 'locked-agent-app-viewer'
  ) {
    const role =
      scenario === 'locked-agent-app-viewer'
        ? 'viewer'
        : (scenario.replace('locked-agent-session-', '') as 'owner' | 'editor' | 'viewer')
    return {
      initialPath: '/w/acme/agents/research',
      identity: {
        ...IDENTITY,
        workspaces: IDENTITY.workspaces.map(workspace =>
          workspace.slug === 'acme' ? { ...workspace, role } : workspace,
        ),
        scopes:
          role === 'owner'
            ? ['ws:acme:admin']
            : role === 'editor'
              ? ['ws:acme:sessions']
              : ['ws:acme:files:read', 'ws:acme:sessions'],
        internalAdmin: false,
      },
      api: {
        ...defaultApi,
        listApps: async (workspaceSlug, options = {}) => {
          if (options.cwd !== undefined) onboardingRequests.recordOnboardingAppLookup()
          return await defaultApi.listApps(workspaceSlug, options)
        },
        openAgentOnboardingSession: async (...args) => {
          onboardingRequests.recordOnboardingSessionRequest()
          return await defaultApi.openAgentOnboardingSession(...args)
        },
        readOptionalWorkspaceFile: async (workspaceSlug, path, options) => {
          if (path === 'agents/research/agent.json') {
            const data = new TextEncoder().encode(
              JSON.stringify({
                onboarding:
                  scenario === 'locked-agent-app-viewer'
                    ? { kind: 'app', app: 'setup' }
                    : { kind: 'chat' },
              }),
            )
            return { data, etag: null, contentType: 'application/json', size: data.byteLength }
          }
          return await defaultApi.readOptionalWorkspaceFile(workspaceSlug, path, options)
        },
      },
    }
  }
  if (scenario === 'sessions-viewer') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: {
        ...IDENTITY,
        workspaces: IDENTITY.workspaces.map(workspace =>
          workspace.slug === 'acme' ? { ...workspace, role: 'viewer' as const } : workspace,
        ),
        scopes: ['ws:acme:read'],
        internalAdmin: false,
      },
      api: defaultApi,
    }
  }
  if (scenario === 'sessions-input-pending') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_running',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        sendSessionMessage: () => new Promise(() => {}),
      },
    }
  }
  if (scenario === 'sessions-input-error') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        sendSessionMessage: async () => {
          throw new Error('Fixture send session message failure')
        },
        answerSession: async () => {
          throw new Error('Fixture answer session failure')
        },
      },
    }
  }
  /* The refusal a person can actually act on. Both scenarios reject with the
     shape the API really returns when the payer is out of credits — a 402
     carrying `insufficient_credits` — because the whole point of the surface
     under test is that it reads that body instead of shrugging. */
  if (scenario === 'sessions-spend-blocked') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        sendSessionMessage: async () => {
          throw outOfCreditsError()
        },
      },
    }
  }
  if (scenario === 'sessions-spend-blocked-create') {
    return {
      initialPath: '/w/acme/agents/research',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        sendDefaultSessionMessage: async () => {
          throw outOfCreditsError()
        },
      },
    }
  }
  if (scenario === 'sessions-input-response-lost') {
    return {
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        sendSessionMessage: async (...args) => {
          await defaultApi.sendSessionMessage(...args)
          throw new Error('Fixture response lost after durable acceptance')
        },
      },
    }
  }
  if (scenario === 'sessions-create-awaiting-id') {
    return {
      initialPath: '/w/acme/agents/research',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        /* The panel's first message goes through the owner's default-chat
           alias, so that is the request left hanging. */
        sendDefaultSessionMessage: () => new Promise(() => {}),
      },
    }
  }
  if (scenario === 'sessions-create-response-lost') {
    return {
      initialPath: '/w/acme/agents/research',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        createSession: async (...args) => {
          await defaultApi.createSession(...args)
          throw new Error('Fixture response lost after durable session creation')
        },
      },
    }
  }
  if (scenario === 'sessions-delete-response-lost') {
    return {
      // The jobs dialog, because the chrome under test (the actions menu)
      // lives on the dialog band now.
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        deleteSession: async (...args) => {
          await defaultApi.deleteSession(...args)
          throw new Error('Fixture response lost after durable session deletion')
        },
      },
    }
  }
  if (scenario === 'sessions-mutation-error' || scenario === 'sessions-mutation-error-ask') {
    return {
      // Two sessions reject the same mutations: the running one is where an
      // interrupt can be refused, the waiting one is where a rename and an
      // archive can be rolled back.
      initialPath:
        scenario === 'sessions-mutation-error-ask'
          ? '/w/acme/agents/root/sessions/session_live'
          : '/w/acme/agents/root/sessions/session_running',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        interruptSession: async () => {
          await new Promise(resolve => setTimeout(resolve, 250))
          throw new Error('Fixture interrupt failure')
        },
        renameSession: async () => {
          throw new Error('Fixture rename failure')
        },
        archiveSession: async () => {
          throw new Error('Fixture archive failure')
        },
        deleteSession: async () => {
          throw new Error('Fixture delete failure')
        },
      },
    }
  }
  if (
    scenario === 'sessions-metadata-response-lost' ||
    scenario === 'sessions-personal-response-lost'
  ) {
    return {
      // The jobs dialog, same reason as sessions-delete-response-lost above.
      initialPath: '/w/acme/agents/root/sessions/session_live',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        renameSession: async (...args) => {
          await defaultApi.renameSession(...args)
          throw new Error('Fixture rename response lost after durable acceptance')
        },
        archiveSession: async (...args) => {
          await defaultApi.archiveSession(...args)
          throw new Error('Fixture archive response lost after durable acceptance')
        },
      },
    }
  }
  if (scenario === 'sessions-create-error') {
    return {
      initialPath: '/w/acme/agents/research',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        /* The panel's first message goes through the owner's default-chat
           alias, so that is the request that fails. */
        sendDefaultSessionMessage: async () => {
          throw new Error('Fixture create session failure')
        },
      },
    }
  }
  /* The audience picker rides the shared composer, and the composer's one door
     is Work's home since the jobs dialog's went. Same claim, same failure: a
     create refused for a member who is no longer in the workspace. */
  if (scenario === 'sessions-audience-invalid' || scenario === 'sessions-audience-invalid-es') {
    return {
      initialPath: '/w/acme/home',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        createSession: async () => {
          throw new DuetApiError(400, 'invalid_audience_member')
        },
      },
    }
  }
  if (scenario === 'files-bootstrap-loading') {
    return {
      initialPath: '/w/acme/files',
      api: { ...defaultApi, whoami: () => new Promise(() => {}) },
    }
  }
  if (scenario === 'files-data-loading') {
    return {
      initialPath: '/w/acme/files',
      identity: IDENTITY,
      api: { ...defaultApi, listWorkspaceFiles: () => new Promise(() => {}) },
    }
  }
  if (scenario === 'loading') {
    return {
      initialPath: '/w/acme/agents/root',
      api: { ...defaultApi, whoami: () => new Promise(() => {}) },
    }
  }
  if (scenario === 'error' || scenario === 'unauthorized') {
    return {
      initialPath: '/w/acme/agents/research',
      api: {
        ...defaultApi,
        whoami: async () => {
          if (scenario === 'unauthorized') throw new DuetApiError(401, 'unauthorized')
          throw new Error('Fixture bootstrap failure')
        },
      },
    }
  }
  if (scenario === 'empty') {
    return {
      initialPath: '/',
      identity: { ...IDENTITY, workspaces: [], scopes: [], internalAdmin: false },
      api: defaultApi,
    }
  }
  if (scenario === 'workspace-arriving') {
    const freshIdentity = {
      ...IDENTITY,
      workspaces: IDENTITY.workspaces.map(workspace =>
        workspace.slug === 'acme' ? { ...workspace, onboardedAt: undefined } : workspace,
      ),
    }
    return {
      initialPath: '/w/acme/agents/research',
      identity: { ...freshIdentity, workspaces: [], scopes: [], internalAdmin: false },
      api: {
        ...defaultApi,
        whoami: async () => {
          await new Promise(resolve => setTimeout(resolve, 300))
          return freshIdentity
        },
      },
    }
  }
  if (scenario === 'admin-denied') {
    return {
      initialPath: '/internal-admin',
      identity: { ...IDENTITY, internalAdmin: false },
      api: defaultApi,
    }
  }
  if (scenario === 'admin-message') {
    return {
      initialPath: '/w/acme/agents/research',
      identity: {
        ...IDENTITY,
        workspaces: IDENTITY.workspaces.map(workspace =>
          workspace.slug === 'acme'
            ? {
                ...workspace,
                adminMessage:
                  'We are investigating delayed gateway reconnects. No action is required.',
              }
            : workspace,
        ),
      },
      api: defaultApi,
    }
  }
  if (scenario === 'create-error') {
    return {
      initialPath: '/w/acme/agents/research',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        createWorkspace: async () => {
          throw new Error('Fixture workspace creation failure')
        },
      },
    }
  }
  if (scenario === 'create-refused') {
    return {
      initialPath: '/w/acme/agents/research',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        /* What a 402 from POST /v1/workspaces becomes by the time the dialog
           sees it: a Pro payer already funds three live workspaces. */
        createWorkspace: async () => {
          throw new DuetApiError(402, 'workspace_limit_reached', 'workspace_limit_reached', {
            error: 'workspace_limit_reached',
            plan: 'pro',
            limit: 3,
          } satisfies WorkspaceCreateRefusal)
        },
      },
    }
  }
  if (scenario === 'switch-error') {
    let failureArmed = false
    return {
      initialPath: '/w/acme/agents/research',
      identity: IDENTITY,
      armWorkspaceTransitionFailure: () => {
        failureArmed = true
      },
      api: {
        ...defaultApi,
        whoami: async () => {
          if (failureArmed) throw new Error('Fixture workspace transition failure')
          return IDENTITY
        },
      },
    }
  }
  if (scenario === 'train-memory-detail') {
    const record = {
      slug: 'root-operations',
      memoryId: 'mem_root_operations',
      createdAt: '2026-07-16T09:30:00.000Z',
      observedDate: '2026-07-16',
      headline: 'Company-wide operating principles',
      model: 'gpt-5.6-luna',
      fileCount: 6,
      hasArchive: true,
      // Synthesis writes markdown and hard-wraps its prose, so the fixture
      // does too — a soft wrap rendered as a hard break is the defect this
      // shot is here to catch.
      content: [
        'Use explicit evidence grades, preserve dissenting signals, and name the',
        'decision each finding informs.',
        '',
        '## Operating trail',
        '',
        'Every operating decision should leave a short trail: what changed, who owns',
        'the next move, and which evidence would reopen it.',
        '',
        '| Grade | Means | Reopens on |',
        '| --- | --- | --- |',
        '| A | Measured | Contradicting measurement |',
        '| B | Reported | A first-party account |',
        '| C | Inferred | Any direct evidence |',
        '',
        '- **Dissent is kept** — a minority signal is recorded beside the finding.',
        '- **Exceptions are specific** — name the case, not the category.',
      ].join('\n'),
      sources: [
        {
          relPath: 'url-acme-com-handbook-3f21bb04.md',
          bytes: 22_528,
          url: 'https://acme.com/handbook',
        },
        { relPath: 'operating-review-2026.pdf', bytes: 318_464 },
        { relPath: 'evidence-grades.csv', bytes: 4_096 },
      ],
    }
    return {
      initialPath: `/w/acme/train/root/${record.slug}`,
      identity: IDENTITY,
      api: {
        ...defaultApi,
        // No running job: this scenario is about reading a memory, and the
        // shared fixture's running job would otherwise disable Retrain here
        // for a reason that has nothing to do with the record.
        listTrainJobs: async () => ({ items: [], nextCursor: null }),
        getTrainRecord: async () => ({ record }),
      },
    }
  }
  if (scenario.startsWith('agent-train-')) {
    const research = AGENT_FIXTURES[0]!
    const child: Agent = {
      id: 'agent_child',
      workspaceId: 'workspace_acme',
      anchorId: 'anchor_child',
      anchorPath: 'agents/research/child',
      anchorState: 'active',
      slug: 'child',
      name: 'Research Child',
      createdAt: 1_749_980_000_000,
      updatedAt: 1_750_000_080_000,
    }
    const replica: Agent = {
      id: 'agent_shared',
      workspaceId: 'workspace_acme',
      anchorId: 'anchor_shared',
      anchorPath: 'agents/shared-research',
      anchorState: 'active',
      slug: 'shared-research',
      name: 'Shared Research',
      sourceShareId: 'share_agent_research',
      sourceAgentId: 'agent_origin_research',
      createdAt: 1_749_990_000_000,
      updatedAt: 1_750_000_090_000,
    }
    const localRecords = [
      {
        slug: 'research-method',
        memoryId: 'mem_research_method',
        createdAt: '2026-07-16T09:30:00.000Z',
        observedDate: '2026-07-16',
        headline: 'Research method and evidence standards',
        fileCount: 6,
        hasArchive: true,
      },
      {
        slug: 'brief-format',
        memoryId: 'mem_brief_format',
        createdAt: '2026-07-15T14:20:00.000Z',
        observedDate: '2026-07-15',
        headline: 'Decision-ready brief format',
        fileCount: 3,
        hasArchive: true,
      },
    ]
    const childLocal = {
      ...localRecords[0]!,
      slug: 'child-interview-notes',
      memoryId: 'mem_child_interviews',
      headline: 'Interview synthesis conventions',
    }
    const inheritedRecords = [
      {
        ...localRecords[0]!,
        slug: 'root-operations',
        memoryId: 'mem_root_operations',
        headline: 'Company-wide operating principles',
        inherited: true,
      },
      {
        ...localRecords[1]!,
        slug: 'parent-evidence-bar',
        memoryId: 'mem_parent_evidence',
        headline: 'Parent research evidence bar',
        inherited: true,
        ownerAgentSlug: 'research',
      },
    ]
    const mobileExtra = [
      {
        ...inheritedRecords[0]!,
        slug: 'root-security',
        memoryId: 'mem_root_security',
        headline: 'Security escalation and disclosure rules',
      },
      {
        ...inheritedRecords[1]!,
        slug: 'parent-citations',
        memoryId: 'mem_parent_citations',
        headline: 'Citation and source-quality conventions',
      },
    ]
    const childScene = scenario === 'agent-train-inherited' || scenario === 'agent-train-mobile'
    const replicaScene = scenario === 'agent-train-replica'
    const records = replicaScene
      ? localRecords.slice(0, 1)
      : childScene
        ? [
            childLocal,
            ...inheritedRecords,
            ...(scenario === 'agent-train-mobile' ? mobileExtra : []),
          ]
        : localRecords
    const jobs: TrainJobStatus[] =
      scenario === 'agent-train-concurrent'
        ? [
            {
              jobId: 'train_competitor_landscape',
              userId: 'user_demo',
              workspaceId: 'workspace_acme',
              state: 'running',
              phase: 'training',
              createdAt: Date.UTC(2026, 6, 18, 8, 40),
              updatedAt: Date.UTC(2026, 6, 18, 8, 52),
              startedAt: Date.UTC(2026, 6, 18, 8, 41),
            },
            {
              jobId: 'train_customer_interviews',
              userId: 'user_demo',
              workspaceId: 'workspace_acme',
              state: 'running',
              phase: 'snapshotting',
              createdAt: Date.UTC(2026, 6, 18, 8, 45),
              updatedAt: Date.UTC(2026, 6, 18, 8, 51),
              startedAt: Date.UTC(2026, 6, 18, 8, 46),
            },
            {
              jobId: 'train_market_signals',
              userId: 'user_demo',
              workspaceId: 'workspace_acme',
              state: 'queued',
              phase: 'preparing',
              createdAt: Date.UTC(2026, 6, 18, 8, 50),
              updatedAt: Date.UTC(2026, 6, 18, 8, 50),
            },
          ]
        : []
    const agentSlug = replicaScene ? replica.slug : childScene ? child.slug : research.slug
    const agents = replicaScene ? [research, replica] : childScene ? [research, child] : [research]
    return {
      initialPath: `/w/acme/train/${agentSlug}`,
      identity: IDENTITY,
      api: {
        ...defaultApi,
        /* Narrowed by `id` and `slug` as the server narrows them: Train looks
           the scoped agent up by slug and takes the first row, so a list that
           ignored the filter titled the child agent's page with its parent's
           name (see `spa-fixture`'s `listAgents`). */
        listAgents: async (_workspaceSlug, options = {}) => ({
          items: agents.filter(
            agent =>
              (options.id === undefined || agent.id === options.id) &&
              (options.slug === undefined || agent.slug === options.slug),
          ),
          nextCursor: null,
        }),
        // The API emits an entry for every registered agent, so this scene's
        // extra agents need counts too — without them the rail would report an
        // agent as uncounted, which production never does.
        listTrainMemoryCounts: async () => ({
          rootCount: 2,
          trainableAgents: agents.map(agent => agent.slug),
          counts: Object.fromEntries(
            agents.map(agent => [agent.slug, agent.slug === 'research' ? 2 : 1]),
          ),
        }),
        listTrainJobs: async (_workspaceSlug, _scope, query) => ({
          items: query?.cursor === undefined ? jobs : [],
          nextCursor:
            scenario === 'agent-train-concurrent' && query?.cursor === undefined
              ? 'jobs-page-2'
              : null,
        }),
        listTrainRecords: async () => ({ items: records, nextCursor: null }),
        getTrainRecord: async (_workspaceSlug, slug) => {
          const record = records.find(candidate => candidate.slug === slug) ?? records[0]!
          return {
            record: {
              ...record,
              content:
                'Use explicit evidence grades, preserve dissenting signals, and name the decision each finding informs.\n\nInherited guidance stays visible here without becoming editable in the child agent.',
            },
          }
        },
      },
      trainUploads: createTrainUploadsFixture({
        listing:
          scenario === 'agent-train-concurrent'
            ? {
                files: [
                  {
                    filename: 'new-market-notes.pdf',
                    size: 1_572_864,
                    uploadedAt: Date.UTC(2026, 6, 18, 8, 55),
                  },
                ],
                totalBytes: 1_572_864,
                capBytes: TRAIN_UPLOADS_CAP_BYTES,
                running: true,
              }
            : undefined,
      }),
    }
  }
  if (scenario === 'train-empty') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listTrainJobs: async () => ({ items: [], nextCursor: null }),
        listTrainRecords: async () => ({ items: [], nextCursor: null }),
      },
      trainUploads: createTrainUploadsFixture(),
    }
  }
  if (scenario === 'train-pagination-empty') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listTrainJobs: async () => ({ items: [], nextCursor: 'jobs-page-2' }),
        listTrainRecords: async () => ({ items: [], nextCursor: 'records-page-2' }),
      },
      trainUploads: createTrainUploadsFixture(),
    }
  }
  if (scenario === 'train-staged') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: defaultApi,
      trainUploads: createTrainUploadsFixture({
        listing: {
          files: [
            {
              filename: 'research-notes.pdf',
              size: 2_621_440,
              uploadedAt: Date.UTC(2026, 6, 15, 8),
            },
            {
              filename: 'url-docs.md',
              size: 18_432,
              uploadedAt: Date.UTC(2026, 6, 15, 9),
              url: 'https://docs.example.com/handbook',
            },
          ],
          totalBytes: 2_639_872,
          capBytes: TRAIN_UPLOADS_CAP_BYTES,
          running: false,
        },
      }),
    }
  }
  if (scenario === 'resume-note') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: { ...defaultApi, listTrainJobs: async () => ({ items: [], nextCursor: null }) },
      trainUploads: createTrainUploadsFixture({
        listing: {
          files: [
            {
              filename: 'research-notes.pdf',
              size: 2_621_440,
              uploadedAt: Date.UTC(2026, 6, 14, 8),
            },
          ],
          totalBytes: 2_621_440,
          capBytes: TRAIN_UPLOADS_CAP_BYTES,
          running: false,
        },
      }),
    }
  }
  if (scenario === 'failed-retained') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listTrainJobs: async () => ({
          items: [
            {
              jobId: 'train_failed_retained',
              userId: 'user_demo',
              workspaceId: 'workspace_acme',
              state: 'failed',
              phase: 'failed',
              error: 'Training stopped before the retained sources were imported.',
              createdAt: Date.UTC(2026, 6, 15, 8, 15),
              updatedAt: Date.UTC(2026, 6, 15, 8, 17),
              completedAt: Date.UTC(2026, 6, 15, 8, 17),
            },
          ],
          nextCursor: null,
        }),
      },
      trainUploads: createTrainUploadsFixture({
        listing: {
          files: [
            {
              filename: 'retained-corpus.zip',
              size: 4_194_304,
              uploadedAt: Date.UTC(2026, 6, 15, 8),
            },
          ],
          totalBytes: 4_194_304,
          capBytes: TRAIN_UPLOADS_CAP_BYTES,
          running: false,
        },
      }),
    }
  }
  if (scenario === 'done-toast') {
    let jobsCalls = 0
    let recordsCalls = 0
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listTrainJobs: async () => {
          jobsCalls += 1
          const done = jobsCalls > 1
          return {
            items: [
              {
                jobId: 'train_done_toast',
                userId: 'user_demo',
                workspaceId: 'workspace_acme',
                state: done ? ('done' as const) : ('running' as const),
                phase: done ? ('done' as const) : ('training' as const),
                createdAt: Date.UTC(2026, 6, 15, 8, 15),
                updatedAt: Date.UTC(2026, 6, 15, 8, done ? 20 : 19),
                startedAt: Date.UTC(2026, 6, 15, 8, 16),
                completedAt: done ? Date.UTC(2026, 6, 15, 8, 20) : undefined,
              },
            ],
            nextCursor: null,
          }
        },
        listTrainRecords: async (...args) => {
          recordsCalls += 1
          const result = await defaultApi.listTrainRecords(...args)
          if (recordsCalls === 1) return result
          return {
            items: [
              {
                slug: 'fresh-completion-record',
                memoryId: 'mem_fresh_completion',
                createdAt: '2026-07-15T08:20:00.000Z',
                observedDate: '2026-07-15',
                headline: 'Freshly trained completion record',
                fileCount: 1,
                hasArchive: true,
              },
              ...result.items,
            ],
            nextCursor: null,
          }
        },
      },
      trainUploads: createTrainUploadsFixture(),
    }
  }
  if (scenario === 'train-uploading-with-progress' || scenario === 'train-cancelled') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: defaultApi,
      trainUploads: createTrainUploadsFixture({ uploadProgress: 43 }),
    }
  }
  if (scenario === 'train-quota-full-rejection') {
    const capBytes = TRAIN_UPLOADS_CAP_BYTES
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: defaultApi,
      trainUploads: createTrainUploadsFixture({
        listing: {
          files: [
            {
              filename: 'existing-corpus.bin',
              size: capBytes,
              uploadedAt: Date.UTC(2026, 6, 15, 8),
            },
          ],
          totalBytes: capBytes,
          capBytes,
          running: false,
        },
      }),
    }
  }
  if (scenario === 'train-url-pending' || scenario === 'train-url-failed') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: defaultApi,
      trainUploads: createTrainUploadsFixture({
        urlResult: scenario === 'train-url-pending' ? 'pending' : 'failed',
      }),
    }
  }
  if (scenario === 'train-loading') {
    const pending = () => new Promise<never>(() => {})
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listTrainJobs: pending,
        listTrainRecords: pending,
      },
      trainUploads: createTrainUploadsFixture(),
    }
  }
  if (scenario === 'train-error') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listTrainJobs: async () => {
          throw new Error('fixture jobs error')
        },
        listTrainRecords: async () => {
          throw new Error('fixture records error')
        },
      },
      trainUploads: createTrainUploadsFixture(),
    }
  }
  if (scenario === 'train-uploads-error') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: defaultApi,
      trainUploads: createTrainUploadsFixture({ listingError: true }),
    }
  }
  if (scenario === 'train-long') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listTrainRecords: async () => ({
          items: [
            {
              slug: 'an-extremely-long-training-slug-that-must-never-overflow-the-memory-library-card',
              memoryId: 'mem_long',
              createdAt: '2026-07-11T00:00:00.000Z',
              observedDate: '2026-07-11',
              headline:
                'A very long trained-memory headline covering customer support operations, incident escalation, launch planning, and every regional exception',
              fileCount: 200,
              hasArchive: true,
            },
          ],
          nextCursor: null,
        }),
      },
      trainUploads: createTrainUploadsFixture(),
    }
  }
  if (scenario === 'train-spanish') {
    return {
      initialPath: '/w/acme/train/root',
      identity: IDENTITY,
      api: defaultApi,
      trainUploads: createTrainUploadsFixture(),
    }
  }
  const listIntegrationConnectionsWithAllGmail = async () => {
    const { items } = await defaultApi.listIntegrationConnections('acme')
    return {
      items: items.map(connection => {
        if (connection.integration !== 'gmail') return connection
        const next = { ...connection }
        delete next.allowedAgentIds
        return next
      }),
      nextCursor: null,
    }
  }
  if (scenario === 'integrations-loading') {
    const pending = () => new Promise<never>(() => {})
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listIntegrationConnections: pending,
        listIntegrationCatalog: pending,
      },
    }
  }
  if (scenario === 'integrations-error') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listIntegrationConnections: async () => {
          throw new Error('Fixture integration connection failure')
        },
        listIntegrationCatalog: async () => {
          throw new Error('Fixture integration catalog failure')
        },
      },
    }
  }
  if (scenario === 'integrations-refetch-error') {
    let connectionReads = 0
    let catalogReads = 0
    let agentReads = 0
    let serverReads = 0
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listIntegrationConnections: async (...args) => {
          if (connectionReads++ > 0) throw new Error('Fixture connection refresh failure')
          return await defaultApi.listIntegrationConnections(...args)
        },
        listIntegrationCatalog: async (...args) => {
          if (catalogReads++ > 0) throw new Error('Fixture catalog refresh failure')
          return await defaultApi.listIntegrationCatalog(...args)
        },
        listAgents: async (...args) => {
          if (agentReads++ > 0) throw new Error('Fixture integration agent refresh failure')
          return await defaultApi.listAgents(...args)
        },
        listMcpServers: async (...args) => {
          if (serverReads++ > 0) throw new Error('Fixture MCP refresh failure')
          return await defaultApi.listMcpServers(...args)
        },
      },
    }
  }
  if (scenario === 'integrations-empty') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listIntegrationConnections: async () => ({ items: [], nextCursor: null }),
        listIntegrationCatalog: async () => ({ items: [], nextCursor: null }),
        listMcpServers: async () => ({ items: [], nextCursor: null }),
      },
    }
  }
  if (scenario === 'integrations-pagination-empty') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listIntegrationConnections: async () => ({ items: [], nextCursor: 'connections-page-2' }),
        listIntegrationCatalog: async () => ({ items: [], nextCursor: 'catalog-page-2' }),
        listMcpServers: async () => ({ items: [], nextCursor: null }),
      },
    }
  }
  if (scenario === 'integrations-mcp-states') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listMcpServers: async () => ({ items: MCP_SERVER_STATES, nextCursor: null }),
      },
    }
  }
  if (scenario === 'integrations-mcp-probing') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: { ...defaultApi, probeMcpServer: () => new Promise(() => {}) },
    }
  }
  if (scenario === 'integrations-mcp-error') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listMcpServers: async () => {
          throw new Error('Fixture custom MCP server listing failure')
        },
      },
    }
  }
  if (scenario === 'integrations-connect-pending') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: { ...defaultApi, connectIntegration: () => new Promise(() => {}) },
    }
  }
  if (scenario === 'integrations-agent-access-pending') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listIntegrationConnections: listIntegrationConnectionsWithAllGmail,
        setIntegrationAgentPolicy: () => new Promise(() => {}),
      },
    }
  }
  if (scenario === 'integrations-agent-access-error') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listIntegrationConnections: listIntegrationConnectionsWithAllGmail,
        setIntegrationAgentPolicy: async () => {
          await new Promise(resolve => window.setTimeout(resolve, 500))
          throw new Error('Fixture integration agent-policy failure')
        },
      },
    }
  }
  if (scenario === 'integrations-agent-access-overflow') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listAgents: async () => ({ items: INTEGRATION_OVERFLOW_AGENTS, nextCursor: null }),
        /* This scenario measures one editor against 501 principals. Leaving
           the custom servers in would put four more editors on the page and
           measure the sum instead. */
        listMcpServers: async () => ({ items: [], nextCursor: null }),
        listIntegrationConnections: async () => {
          const { items } = await defaultApi.listIntegrationConnections('acme')
          return {
            items: items.slice(0, 1).map(connection => ({
              ...connection,
              allowedAgentIds: ['root', 'agent_001', 'agent_250', 'agent_500'],
            })),
            nextCursor: null,
          }
        },
        setIntegrationAgentPolicy: async (workspaceSlug, integration, input) => {
          if (input.allowedAgentIds?.includes('agent_499')) {
            await new Promise(resolve => window.setTimeout(resolve, 500))
            throw new Error('Fixture integration agent-policy overflow failure')
          }
          return await defaultApi.setIntegrationAgentPolicy(workspaceSlug, integration, input)
        },
      },
    }
  }
  if (scenario === 'integrations-callback-success') {
    return {
      initialPath: '/w/acme/integrations?status=success',
      identity: IDENTITY,
      api: defaultApi,
    }
  }
  if (scenario === 'integrations-callback-canceled') {
    return {
      initialPath: '/w/acme/integrations?status=canceled',
      identity: IDENTITY,
      api: defaultApi,
    }
  }
  if (scenario === 'integrations-callback-error') {
    return {
      initialPath: '/w/acme/integrations?status=failed',
      identity: IDENTITY,
      api: defaultApi,
    }
  }
  if (scenario === 'integrations-callback-provider-failed') {
    return {
      initialPath: '/w/acme/integrations?status=failed',
      identity: IDENTITY,
      api: defaultApi,
    }
  }
  if (scenario === 'integrations-spanish') {
    return {
      initialPath: '/w/acme/integrations',
      identity: IDENTITY,
      api: defaultApi,
    }
  }

  /* One app, on the card of the agent that owns it — the only address an app
     has. The fixture app is re-anchored *inside* `research`'s folder because
     containment is the ownership rule: an app the drive holds at `apps/…` is
     nobody's agent's, and would not be on this card to have a menu.

     The whole app surface is under this one scenario now. It used to be
     fourteen, against a workspace-level page with a header bar of its own; the
     page is gone and its controls are the chip's ⋯ menu, so the states that
     survived are states *of the menu* rather than pages. `setAppVisibility`
     answers for real so the publish switch can be driven both ways. */
  if (scenario === 'agent-app-menu' || scenario === 'agent-app-menu-es') {
    const owned = new Map(
      APP_FIXTURES.map(app => [
        app.slug,
        { ...app, anchorPath: `agents/research/${app.anchorPath}` },
      ]),
    )
    const present = (app: App): App =>
      app.slug === 'reporting'
        ? { ...app, apiScopes: ['files:read', 'files:write', 'memory'] }
        : app
    return {
      initialPath: '/w/acme/agents/research/apps/reporting',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listApps: async () => ({
          items: [...owned.values()].map(present),
          nextCursor: null,
          meta: { capabilities: OWNER_APP_CAPABILITIES },
        }),
        getApp: async (_workspaceSlug, appSlug) => ({ app: present(owned.get(appSlug)!) }),
        setAppVisibility: async (_workspaceSlug, appSlug, visibility) => {
          const app = owned.get(appSlug)!
          const updated: App = { ...app, visibility, controls: appControls('owner', app) }
          owned.set(appSlug, updated)
          return { app: present(updated) }
        },
      },
    }
  }

  /* A subscription-owned app whose files have not landed yet. The row is
     written the moment the subscription installs and stays switched off until
     the first pull applies its content, so it sits on its agent's card with
     nothing to show: it cannot run, and publishing it would hand out an address
     with nothing behind it. Nor is deleting it on offer — it leaves by
     uninstalling the subscription that ships it, never by dropping this row
     while its siblings keep arriving. The only honest sentence says it is still
     coming, rather than inviting a switch back on that does not exist. */
  if (scenario === 'agent-app-installing') {
    const installing = {
      ...APP_FIXTURES[0]!,
      anchorPath: 'agents/research/apps/reporting',
      listingSubscriptionId: 'subscription_research',
      disabledAt: FIXTURE_NOW - 3_600_000,
      runtimeStatus: 'reconciled' as const,
    }
    const app: App = { ...installing, controls: appControls('owner', installing) }
    return {
      initialPath: '/w/acme/agents/research/apps/reporting',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listApps: async () => ({
          items: [app],
          nextCursor: null,
          meta: { capabilities: OWNER_APP_CAPABILITIES },
        }),
        getApp: async () => ({ app }),
        deleteApp: async () => ({ ok: true }),
      },
    }
  }

  /* An app whose folder is THERE but no longer recognizable — a marker that no
     longer matches, or a move we could not pair to one destination. That is the
     only thing `broken` means now: a folder that is genuinely gone takes its row
     with it, so the drive never has to draw a row for something that is not
     there. It stays the drive's own — nothing encloses `apps/reporting-broken` —
     so it is `root`'s app. */
  if (scenario === 'agent-app-broken') {
    const broken = {
      ...APP_FIXTURES[0]!,
      anchorState: 'broken' as const,
      anchorPath: 'apps/reporting-broken',
      runtimeStatus: 'reconciled' as const,
    }
    const app: App = { ...broken, controls: appControls('owner', broken) }
    return {
      initialPath: '/w/acme/agents/root',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listApps: async () => ({
          items: [app],
          nextCursor: null,
          meta: { capabilities: OWNER_APP_CAPABILITIES },
        }),
        getApp: async () => ({ app }),
        listWorkspaceFiles: async (_workspaceSlug, path = '') => ({
          items:
            path === ''
              ? [
                  {
                    name: 'apps',
                    path: 'apps',
                    type: 'directory' as const,
                    size: 0,
                    mtime: '2026-07-11T08:30:00.000Z',
                  },
                ]
              : path === 'apps'
                ? [
                    {
                      name: 'reporting-broken',
                      path: 'apps/reporting-broken',
                      type: 'directory' as const,
                      size: 0,
                      mtime: '2026-07-11T08:30:00.000Z',
                    },
                  ]
                : [],
          nextCursor: null,
        }),
        statWorkspaceFile: async (_workspaceSlug, path) => {
          if (path !== 'apps' && path !== 'apps/reporting-broken')
            throw new DuetApiError(404, 'not_found')
          return {
            entry: {
              name: path.split('/').at(-1)!,
              path,
              type: 'directory' as const,
              size: 0,
              mtime: '2026-07-11T08:30:00.000Z',
            },
            etag: null,
          }
        },
        deleteApp: async () => ({ ok: true }),
      },
    }
  }

  if (scenario === 'settings-viewer') {
    return {
      initialPath: '/w/acme/settings/members',
      identity: {
        ...IDENTITY,
        workspaces: IDENTITY.workspaces.map(workspace =>
          workspace.slug === 'acme' ? { ...workspace, role: 'viewer' as const } : workspace,
        ),
        scopes: ['ws:acme:files:read'],
        internalAdmin: false,
      },
      api: defaultApi,
    }
  }
  if (scenario === 'settings-members-refetch-error') {
    let memberReads = 0
    return {
      initialPath: '/w/acme/settings/members',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listWorkspaceMembers: async () => {
          if (memberReads++ > 0) throw new Error('Fixture member refresh failure')
          return {
            items: [
              {
                id: 'user_owner',
                email: 'owner@duet.so',
                name: 'Ada Lovelace',
                role: 'owner' as const,
                isBillingUser: true,
              },
            ],
            nextCursor: null,
          }
        },
      },
    }
  }
  if (scenario === 'settings-default-tier-subscribed') {
    return {
      initialPath: '/w/acme/settings/general',
      identity: IDENTITY,
      api: defaultApi,
    }
  }
  if (scenario === 'settings-usage-tier-badges') {
    return {
      initialPath: '/w/acme/settings/usage',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        workspaceLedger: async () => ({
          items: [
            {
              id: 'txn_usage_max',
              amountMicroUsd: -1_840_000,
              type: 'usage' as const,
              actorUserId: 'user_owner',
              tier: 'frontier' as const,
              createdAt: Date.UTC(2026, 6, 10, 18),
            },
            {
              id: 'txn_usage_standard',
              amountMicroUsd: -920_000,
              type: 'usage' as const,
              actorUserId: 'user_grace',
              tier: 'balanced' as const,
              createdAt: Date.UTC(2026, 6, 10, 16),
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
      },
    }
  }
  if (scenario === 'settings-oauth-grants') {
    return {
      initialPath: '/settings/api-keys',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listOAuthGrants: async options => {
          const page = await defaultApi.listOAuthGrants(options)
          return {
            ...page,
            nextCursor: options?.cursor === undefined ? 'older-connected-apps' : null,
          }
        },
      },
    }
  }
  if (scenario === 'settings-shares') {
    let shares: ShareListResponse = structuredClone(SHARE_MANAGEMENT_FIXTURE)
    return {
      initialPath: '/w/acme/settings/shares',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listShares: async () => structuredClone(shares),
        unlinkShare: async (_workspaceSlug, shareId) => {
          shares = {
            ...shares,
            items: shares.items.map(share =>
              share.direction === 'incoming' && share.id === shareId
                ? { ...share, state: 'unlinked' as const, syncStatus: undefined }
                : share,
            ),
          }
          return { ok: true, unlinkedShareIds: [shareId] }
        },
        revokeShare: async (_workspaceSlug, shareId) => {
          shares = {
            ...shares,
            items: shares.items.map(share =>
              share.direction === 'outgoing' && share.id === shareId
                ? { ...share, state: 'revoked' as const, syncStatus: undefined }
                : share,
            ),
          }
          return { ok: true, revokedShareIds: [shareId] }
        },
      },
    }
  }
  if (scenario === 'settings-shares-empty') {
    return {
      initialPath: '/w/acme/settings/shares',
      identity: IDENTITY,
      api: { ...defaultApi, listShares: async () => ({ items: [], nextCursor: null }) },
    }
  }
  if (scenario === 'settings-shares-error') {
    return {
      initialPath: '/w/acme/settings/shares',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listShares: async () => {
          throw new Error('Fixture share list failure')
        },
      },
    }
  }
  if (scenario === 'settings-connected-providers') {
    return {
      initialPath: '/w/acme/settings/connected-providers',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listConnectedProviders: async () => [
          {
            provider: 'openai-codex',
            state: 'connected',
            connectedAt: FIXTURE_NOW - 86_400_000,
            connectedByUserId: 'user_owner',
            connectedByLabel: 'Ada Lovelace',
            canDisconnect: true,
          },
          {
            provider: 'github-copilot',
            state: 'reconnect_needed',
            connectedAt: FIXTURE_NOW - 172_800_000,
            connectedByUserId: 'user_grace',
            connectedByLabel: 'Grace Hopper',
            canDisconnect: false,
          },
        ],
      },
    }
  }
  if (scenario === 'settings-connected-providers-plan-ineligible') {
    return {
      initialPath: '/w/acme/settings/connected-providers',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listConnectedProviders: async () => [
          {
            provider: 'github-copilot',
            state: 'plan_ineligible',
            connectedAt: FIXTURE_NOW - 3_600_000,
            connectedByUserId: 'user_owner',
            connectedByLabel: 'Ada Lovelace',
            canDisconnect: true,
          },
        ],
      },
    }
  }
  if (scenario === 'settings-connected-providers-connecting') {
    return {
      initialPath: '/w/acme/settings/connected-providers',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listConnectedProviders: async () => [],
        pollConnectedProvider: async () => ({ status: 'pending' }),
      },
    }
  }
  if (scenario === 'settings-connected-providers-awaiting-code') {
    return {
      initialPath: '/w/acme/settings/connected-providers',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listConnectedProviders: async () => [],
        pollConnectedProvider: async () => ({
          status: 'awaiting_code',
          userCode: 'DUET-CODE',
          verificationUri: 'https://provider.example.test/device',
          expiresAt: FIXTURE_NOW + 900_000,
        }),
      },
    }
  }
  if (scenario === 'settings-connected-providers-failed') {
    return {
      initialPath: '/w/acme/settings/connected-providers',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listConnectedProviders: async () => [],
        pollConnectedProvider: async () => ({ status: 'failed', reason: 'denied' }),
      },
    }
  }
  if (scenario === 'settings-connected-providers-disconnecting') {
    return {
      initialPath: '/w/acme/settings/connected-providers',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        listConnectedProviders: async () => [
          {
            provider: 'openai-codex',
            state: 'connected',
            connectedAt: FIXTURE_NOW - 86_400_000,
            connectedByUserId: 'user_owner',
            connectedByLabel: 'Ada Lovelace',
            canDisconnect: true,
          },
        ],
        disconnectConnectedProvider: () => new Promise(() => {}),
      },
    }
  }
  if (scenario === 'settings-not-payer') {
    return {
      initialPath: '/settings/billing',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        userBilling: async () => ({
          autoTopupEnabled: false,
          autoTopupThresholdMicroUsd: 5_000_000,
          autoTopupAmountMicroUsd: 20_000_000,
          monthlySpendMicroUsd: 0,
          balanceMicroUsd: 0,
          paidCreditBalanceMicroUsd: 0,
          monthlyCreditBalanceMicroUsd: 0,
          subscription: null,
          trial: { status: 'available' },
          consecutiveTopupFailures: 0,
          hasPaymentMethod: false,
          workspaces: [],
        }),
      },
    }
  }
  if (scenario === 'settings-error') {
    return {
      initialPath: '/settings/profile',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        userProfile: async () => {
          throw new Error('fixture profile failure')
        },
      },
    }
  }
  if (scenario === 'settings-billing-trial') {
    return {
      initialPath: '/settings/billing',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        userBilling: async () => ({
          ...(await defaultApi.userBilling()),
          autoTopupEnabled: false,
          monthlySpendMicroUsd: 1_250_000,
          balanceMicroUsd: 3_750_000,
          paidCreditBalanceMicroUsd: 3_750_000,
          monthlyCreditBalanceMicroUsd: 0,
          subscription: null,
          trial: { status: 'available' as const },
          firstPaidAt: undefined,
          hasPaymentMethod: false,
        }),
      },
    }
  }
  if (
    scenario === 'settings-billing-active-starter' ||
    scenario === 'settings-billing-active-pro-overage' ||
    scenario === 'settings-billing-canceling' ||
    scenario === 'settings-billing-downgrade-scheduled' ||
    scenario === 'settings-billing-lapsed' ||
    scenario === 'settings-billing-past-due' ||
    scenario === 'settings-billing-topup-error' ||
    scenario === 'settings-billing-error' ||
    scenario === 'settings-billing-payment-received'
  ) {
    const periodStart = Date.UTC(2026, 6, 1)
    const periodEnd = Date.UTC(2026, 7, 1)
    const pro =
      scenario === 'settings-billing-active-pro-overage' ||
      scenario === 'settings-billing-canceling' ||
      scenario === 'settings-billing-downgrade-scheduled' ||
      scenario === 'settings-billing-topup-error' ||
      scenario === 'settings-billing-error'
    const lapsed = scenario === 'settings-billing-lapsed'
    const pastDue = scenario === 'settings-billing-past-due'
    const topupError =
      scenario === 'settings-billing-topup-error' || scenario === 'settings-billing-error'
    // What the payer last saved. The real server remembers a save, so a
    // background refetch must hand back the saved numbers, not the seed.
    let savedTopup: Partial<UserBillingOverview> = {}
    const billingOverview = async (): Promise<UserBillingOverview> => ({
      ...(await defaultApi.userBilling()),
      autoTopupEnabled: true,
      balanceMicroUsd: lapsed ? 18_400_000 : pro ? 24_800_000 : 27_500_000,
      paidCreditBalanceMicroUsd: lapsed ? 18_400_000 : pro ? 24_800_000 : 12_500_000,
      monthlyCreditBalanceMicroUsd: lapsed ? 0 : pro ? 0 : 15_000_000,
      subscription: {
        plan: pro ? ('pro' as const) : ('starter' as const),
        status: lapsed
          ? ('canceled' as const)
          : pastDue
            ? ('past_due' as const)
            : ('active' as const),
        isActive: !lapsed && !pastDue,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        creditsExpireAt: periodEnd,
        cancelAtPeriodEnd: scenario === 'settings-billing-canceling',
        ...(scenario === 'settings-billing-downgrade-scheduled'
          ? { pendingPlan: 'starter' as const }
          : {}),
      },
      trial: { status: 'ended' as const },
      ...(topupError
        ? {
            lastTopupError: {
              code: 'card_declined',
              message: 'The payment method was declined. Update it in Stripe before retrying.',
              at: Date.UTC(2026, 6, 11, 8),
            },
            consecutiveTopupFailures: 3,
          }
        : { lastTopupError: undefined, consecutiveTopupFailures: 0 }),
      ...savedTopup,
    })
    return {
      // Entered the way Stripe hands the browser back, so the scene exercises
      // the real redirect wiring rather than a hand-set celebration flag.
      initialPath:
        scenario === 'settings-billing-payment-received'
          ? '/settings/billing?billing=success'
          : '/settings/billing',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        userBilling: billingOverview,
        // Slow enough for the pending state to be observed, fast enough not
        // to stall the scene.
        updateUserBilling: async input => {
          await new Promise(resolve => setTimeout(resolve, 250))
          savedTopup = {
            autoTopupEnabled: input.autoTopupEnabled,
            autoTopupThresholdMicroUsd: input.autoTopupThresholdMicroUsd ?? 5_000_000,
            autoTopupAmountMicroUsd: input.autoTopupAmountMicroUsd,
            maxMonthlySpendMicroUsd: input.maxMonthlySpendMicroUsd ?? undefined,
          }
          return await billingOverview()
        },
        billingHistory: async () => ({
          items: [
            {
              id: 'txn_subscription_grant',
              scope: 'account' as const,
              amountMicroUsd: pro ? 60_000_000 : 20_000_000,
              type: 'subscription_grant' as const,
              createdAt: periodStart,
            },
            {
              id: 'txn_subscription_expiry',
              scope: 'account' as const,
              amountMicroUsd: -2_000_000,
              type: 'subscription_expiry' as const,
              createdAt: periodStart - 1,
            },
            {
              id: 'txn_usage',
              scope: 'workspace' as const,
              workspaceId: 'workspace_acme',
              workspaceName: 'Acme Studio',
              amountMicroUsd: -8_420_000,
              type: 'usage' as const,
              createdAt: Date.UTC(2026, 6, 10, 18),
            },
            // The daily VM compute fee, next to the model spend it must not be
            // confused with. Both are `usage`; only the label separates them.
            {
              id: 'txn_vm_compute',
              scope: 'workspace' as const,
              workspaceId: 'workspace_acme',
              workspaceName: 'Acme Studio',
              amountMicroUsd: -142_000,
              type: 'usage' as const,
              usageKind: 'vm_compute' as const,
              createdAt: Date.UTC(2026, 6, 10, 6),
            },
          ],
          nextCursor: null,
        }),
        ...(scenario === 'settings-billing-canceling'
          ? {
              changeSubscriptionPlan: (async input => {
                if (!('resume' in input)) throw new Error('Expected resume request')
                return { ok: true as const }
              }) satisfies SpaApi['changeSubscriptionPlan'],
            }
          : {}),
        ...(topupError
          ? {
              changeSubscriptionPlan: async () => {
                await new Promise(resolve => setTimeout(resolve, 250))
                throw new Error('Fixture plan change failure')
              },
            }
          : {}),
      },
    }
  }
  if (scenario === 'telemetry-loading') {
    return {
      initialPath: '/w/acme/settings/usage',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        workspaceTelemetry: async () => await new Promise(() => {}),
      },
    }
  }
  if (scenario === 'telemetry-error') {
    return {
      initialPath: '/w/acme/settings/usage',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        workspaceTelemetry: async () => {
          throw new Error('fixture telemetry failure')
        },
      },
    }
  }
  if (scenario === 'telemetry-empty') {
    return {
      initialPath: '/w/acme/settings/usage',
      identity: IDENTITY,
      api: {
        ...defaultApi,
        workspaceTelemetry: async () => ({ samples: [] }),
      },
    }
  }

  if (scenario === 'settings-spanish') {
    return {
      initialPath: '/w/acme/settings/billing-user',
      identity: IDENTITY,
      api: defaultApi,
    }
  }
  /* An agent's own surface: where a person lands, and where every conversation
     starts — there is no workspace-level composer address any more. */
  return {
    initialPath:
      scenario === 'invalid-workspace'
        ? '/w/missing/agents/research'
        : scenario === 'not-found'
          ? '/w/acme/not-a-route'
          : '/w/acme/agents/research',
    identity: IDENTITY,
    api: defaultApi,
    trainUploads: createTrainUploadsFixture(),
  }
}

const frozenSessionLists = new WeakMap<SpaApi, ReturnType<SpaApi['listSessions']>>()

function freezeSessionList(api: SpaApi): SpaApi {
  return {
    ...api,
    listSessions: (...args) => {
      const existing = frozenSessionLists.get(api)
      if (existing !== undefined) return existing
      const firstResponse = api.listSessions(...args)
      frozenSessionLists.set(api, firstResponse)
      return firstResponse
    },
  }
}

function generatedTitleAheadOfDetail(api: SpaApi): SpaApi {
  return {
    ...api,
    listSessions: async (...args) => {
      const page = await api.listSessions(...args)
      return {
        ...page,
        items: page.items.map(session =>
          session.id === 'session_live'
            ? {
                ...session,
                title: 'Launch readiness overview',
                titleOrigin: 'auto' as const,
                titleStatus: 'complete' as const,
              }
            : session,
        ),
      }
    },
    getSession: async (...args) => {
      const snapshot = await api.getSession(...args)
      return snapshot.id === 'session_live'
        ? {
            ...snapshot,
            title: 'Build a launch readiness report from the staging checks',
            titleOrigin: 'excerpt' as const,
            titleStatus: 'generating' as const,
          }
        : snapshot
    },
    sendSessionMessage: () => new Promise(() => {}),
  }
}
