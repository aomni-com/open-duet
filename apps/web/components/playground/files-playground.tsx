'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'
import { useMemo, useState } from 'react'

import {
  canonicalAppUrl,
  DUET_EDGE_HOST,
  shareIgnorePatterns,
  type App,
  type AppListResponse,
} from '@repo/contract'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import { DuetApiError } from '../../spa/api/client'
import { DriveFileIconClientProvider } from '../../spa/drive/drive-file-icon'
import { ActivityFeed } from '../../spa/files/activity-feed'
import { WorkspaceAppsProvider, type AppNavigator } from '../../spa/files/apps-context'
import { AttributionConfigProvider } from '../../spa/files/attribution'
import type { DriveChrome } from '../../spa/files/drive-toolbar'
import { FilesSurface } from '../../spa/files/files-surface'
import type { IWorkspaceAppsSource } from '../../spa/files/lib/apps-source'
import type { FileActivityPageOptions } from '../../spa/files/lib/attribution-source'
import { MockWorkspaceAppsSource } from '../../spa/files/lib/mock-apps-source'
import { MockAttributionSource } from '../../spa/files/lib/mock-attribution'
import { MockFileSystemProvider } from '../../spa/files/lib/mock-provider'
import type { Result, VersionedFile } from '../../spa/files/lib/types'
import type { ShareDialogApi } from '../../spa/files/share-dialog'
import { DRIVE_FILE_ICON_SVG, driveFileIconFixtureClient } from './drive-file-icon-fixture'

const SCENARIOS = [
  'browse',
  'apps',
  'apps-paginated',
  'apps-es',
  'empty',
  'load-error',
  'unhealthy',
  'attribution-error',
  'not-found',
  'nested-folder',
  'dotfile-folder',
  'malformed',
  'stale-load',
  'deep-file',
  'dotfile-file',
  'missing-file',
] as const
type Scenario = (typeof SCENARIOS)[number]

// Frozen playground clock: relative "edited 2h ago" labels must not drift
// between screenshot runs.
const FIXTURE_NOW = Date.UTC(2026, 6, 11, 9, 0)
const HOUR = 60 * 60 * 1000
const FILES_SHARE_API: ShareDialogApi = {
  listApps: async () => ({
    items: [],
    nextCursor: null,
    meta: { capabilities: APP_CAPABILITIES },
  }),
  createShare: async (_workspaceSlug, input) => ({
    share: {
      id: 'share_files_fixture',
      anchorId: 'anchor_files_fixture',
      originWorkspaceId: 'workspace_acme',
      fromWorkspaceId: 'workspace_acme',
      toEmail: input.toEmail,
      mode: input.mode,
      ignorePatterns: shareIgnorePatterns(input.ignorePatterns),
      state: 'pending',
      createdByUserId: 'user_owner',
      createdAt: FIXTURE_NOW,
      expiresAt: FIXTURE_NOW + 7 * 24 * HOUR,
      tokenPrefix: 'duet_share_fixture',
    },
  }),
}

export function FilesPlayground({
  chrome = 'page',
  initialScenario = 'browse',
  activity,
  incompleteSeenBy = false,
}: {
  chrome?: DriveChrome
  initialScenario?: Scenario
  activity?: 'root' | 'scoped'
  incompleteSeenBy?: boolean
} = {}) {
  const [scenario, setScenario] = useState<Scenario>(initialScenario)
  const [appNavigation, setAppNavigation] = useState('')
  const [appNavigationCount, setAppNavigationCount] = useState(0)
  const [deferredReadReady, setDeferredReadReady] = useState(false)
  const [activitySelection, setActivitySelection] = useState<{
    label: string
    path: string
    scope: 'exact' | 'subtree'
  }>({ label: 'Moved folder', path: '/new/box', scope: 'subtree' })
  const provider = useMemo(() => fixtureProvider(scenario, setDeferredReadReady), [scenario])
  const driveIconClient = useMemo(() => driveFileIconFixtureClient(provider), [provider])
  const apps = useMemo(() => fixtureAppsSource(scenario), [scenario])
  const appNavigator = useMemo<AppNavigator>(
    () => ({
      openApp: app => {
        setAppNavigation(`app ${app.slug}`)
        setAppNavigationCount(count => count + 1)
      },
    }),
    [],
  )
  const locale = scenario === 'apps-es' ? 'es-419' : 'en'
  // One fresh query cache per scenario so switching scenarios never reuses
  // another scenario's attribution results.
  const { attribution, queryClient } = useMemo(
    () => ({
      attribution: fixtureAttribution(scenario, incompleteSeenBy),
      queryClient: new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
      }),
    }),
    [incompleteSeenBy, scenario],
  )

  return (
    <NextIntlClientProvider
      key={locale}
      locale={locale}
      messages={locale === 'es-419' ? appEs : appEn}
    >
      <nav className="sr-only" aria-label="Files fixture scenarios">
        {SCENARIOS.map(value => (
          <button key={value} onClick={() => setScenario(value)}>
            Files scenario: {value}
          </button>
        ))}
        <button
          /* Seeded, not written: this stands for someone else's change landing
             on the drive, so it must not queue behind a held write of ours —
             holding one is exactly how a scenario pins the moment a conflict
             is discovered. */
          onClick={() => provider.seed([{ path: '/Welcome.md', data: 'A newer server version.' }])}
        >
          Cause file conflict
        </button>
        <button
          onClick={() => {
            provider.failNextOperation = 'move'
          }}
        >
          Fail next move
        </button>
        <button
          onClick={() => {
            provider.failNextOperation = 'delete'
          }}
        >
          Fail next delete
        </button>
        <button onClick={() => provider.pauseNext('write')}>Pause next upload</button>
        <button onClick={() => provider.completePaused('write')}>Complete upload</button>
        <button onClick={() => provider.pauseNext('list')}>Pause next listing</button>
        <button onClick={() => provider.completePaused('list')}>Complete listing</button>
        {apps instanceof PaginatedAppsSource ? (
          <button onClick={() => apps.allowContinuation()}>Allow app continuation</button>
        ) : null}
        {provider instanceof LiveFixtureProvider ? (
          <>
            {/* The workspace changing a file underneath the reader. Seeded for
                the same reason as the conflict control above: it stands for
                someone else's change and must not queue behind a write the
                browser is holding. "Update" restores the same bytes under a new
                identity; "rewrite" is the one that actually changes them. */}
            <button
              onClick={() =>
                provider.seed([
                  {
                    path: '/Welcome.md',
                    data: '# Updated from workspace\n',
                    contentType: 'text/markdown',
                  },
                ])
              }
            >
              Live update Welcome
            </button>
            <button
              onClick={() =>
                provider.seed([
                  {
                    path: '/Welcome.md',
                    data: '# Rewritten in the workspace\n',
                    contentType: 'text/markdown',
                  },
                ])
              }
            >
              Live rewrite Welcome
            </button>
            <button
              onClick={() => {
                provider.failNextOperation = 'stat'
              }}
            >
              Live fail next stat
            </button>
            <button onClick={() => void provider.delete('/Welcome.md')}>Live delete Welcome</button>
            <button
              onClick={() =>
                void provider.write(
                  '/Welcome.md',
                  new TextEncoder().encode('# Restored from workspace\n'),
                  { contentType: 'text/markdown' },
                )
              }
            >
              Live restore Welcome
            </button>
            <button
              onClick={() =>
                void provider.write(
                  '/brand-assets/logo.svg',
                  new TextEncoder().encode(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="160"><rect width="280" height="160" rx="16" fill="#0f172a"/><path d="M30 120 L140 24 L250 120" fill="#f59e0b"/></svg>',
                  ),
                  { contentType: 'image/svg+xml' },
                )
              }
            >
              Live update image
            </button>
            <button
              onClick={() =>
                void provider.write(
                  '/exports/launch-plan.xls',
                  new TextEncoder().encode('Plan,Owner,Status\nLive refresh,Maya,Ready\n'),
                  { contentType: 'application/vnd.ms-excel' },
                )
              }
            >
              Live update spreadsheet
            </button>
            <button
              onClick={() =>
                void provider.write(
                  '/exports/customer-data.bin',
                  new Uint8Array([0xff, 0xee, 0xdd, 0xcc]),
                )
              }
            >
              Live update binary
            </button>
            <button
              onClick={() =>
                void provider.write(
                  '/product-brief.pdf',
                  new Uint8Array([37, 80, 68, 70, 45, 50]),
                  { contentType: 'application/pdf' },
                )
              }
            >
              Live update PDF
            </button>
            <button onClick={() => provider.deferNextWelcomeRead()}>Live defer next read</button>
            <button disabled={!deferredReadReady} onClick={() => provider.releaseDeferredRead()}>
              Live release deferred read
            </button>
          </>
        ) : null}
        <span>App navigation: {appNavigation}</span>
        <span>App navigation count: {appNavigationCount}</span>
      </nav>
      <div className="h-dvh min-h-0 overflow-hidden rounded-2xl border bg-background shadow-sm">
        <DriveFileIconClientProvider client={driveIconClient}>
          <QueryClientProvider client={queryClient}>
            <WorkspaceAppsProvider
              source={apps}
              navigator={appNavigator}
              deleteApp={async (workspaceSlug, appSlug) => apps.deleteApp(workspaceSlug, appSlug)}
            >
              <AttributionConfigProvider source={attribution} now={() => FIXTURE_NOW}>
                {activity === undefined ? (
                  <FilesScenarioSurface
                    chrome={chrome}
                    key={scenario}
                    scenario={scenario}
                    provider={provider}
                    initialFilePath={incompleteSeenBy ? '/Welcome.md' : undefined}
                  />
                ) : (
                  <main className="min-h-screen bg-muted/30 p-6">
                    {activity === 'scoped' ? (
                      <nav
                        className="mb-4 flex flex-wrap gap-2"
                        aria-label="Moved folder activity scopes"
                      >
                        {[
                          { label: 'Moved folder', path: '/new/box', scope: 'subtree' as const },
                          { label: 'Old parent', path: '/old', scope: 'subtree' as const },
                          { label: 'New parent', path: '/new', scope: 'subtree' as const },
                          {
                            label: 'Selected descendant',
                            path: '/new/box/nested/a.md',
                            scope: 'exact' as const,
                          },
                        ].map(selection => (
                          <button
                            key={selection.label}
                            type="button"
                            className="rounded-full border bg-background px-3 py-1.5 text-sm font-medium shadow-sm"
                            aria-pressed={activitySelection.label === selection.label}
                            onClick={() => setActivitySelection(selection)}
                          >
                            {selection.label}
                          </button>
                        ))}
                      </nav>
                    ) : null}
                    <ActivityFeed
                      key={activity === 'scoped' ? activitySelection.path : 'root'}
                      workspaceSlug="acme"
                      {...(activity === 'scoped'
                        ? { path: activitySelection.path, scope: activitySelection.scope }
                        : {})}
                      control={{ open: true, onOpenChange: () => {} }}
                    />
                  </main>
                )}
              </AttributionConfigProvider>
            </WorkspaceAppsProvider>
          </QueryClientProvider>
        </DriveFileIconClientProvider>
      </div>
    </NextIntlClientProvider>
  )
}

function FilesScenarioSurface({
  chrome,
  scenario,
  provider,
  initialFilePath,
}: {
  chrome: DriveChrome
  scenario: Scenario
  provider: MockFileSystemProvider
  initialFilePath?: string
}) {
  const initialPath =
    initialFilePath ??
    (scenario === 'malformed'
      ? null
      : scenario === 'load-error'
        ? '/research'
        : scenario === 'unhealthy'
          ? '/'
          : scenario === 'stale-load'
            ? '/slow'
            : scenario === 'deep-file'
              ? '/research/notes/deep-link.txt'
              : scenario === 'dotfile-file'
                ? '/.env'
                : scenario === 'missing-file'
                  ? '/research/notes/missing.txt'
                  : scenario === 'nested-folder'
                    ? '/research/notes'
                    : scenario === 'dotfile-folder'
                      ? '/.vault'
                      : scenario === 'not-found'
                        ? '/retired/research'
                        : '/')
  const [history, setHistory] = useState<{
    entries: Array<string | null>
    index: number
  }>({ entries: [initialPath], index: 0 })
  const [fixtureMutation, setFixtureMutation] = useState('idle')
  const path = history.entries[history.index]!
  const navigate = (nextPath: string, options?: { replace?: boolean }) => {
    setHistory(current => {
      if (options?.replace === true) {
        return {
          ...current,
          entries: current.entries.map((entry, index) =>
            index === current.index ? nextPath : entry,
          ),
        }
      }
      const entries = current.entries.slice(0, current.index + 1)
      entries.push(nextPath)
      return { entries, index: entries.length - 1 }
    })
  }

  return (
    <>
      <nav className="sr-only" aria-label="Files fixture history">
        <button
          disabled={history.index === 0}
          onClick={() => setHistory(current => ({ ...current, index: current.index - 1 }))}
        >
          Files fixture Back
        </button>
        <button
          disabled={history.index === history.entries.length - 1}
          onClick={() => setHistory(current => ({ ...current, index: current.index + 1 }))}
        >
          Files fixture Forward
        </button>
      </nav>
      {provider instanceof StaleResolutionProvider ? (
        <nav className="sr-only" aria-label="Stale resolution controls">
          <button onClick={() => navigate('/fast')}>Navigate fixture: /fast</button>
          <button onClick={() => provider.releaseSlowResolution()}>Release stale resolution</button>
        </nav>
      ) : null}
      {scenario === 'deep-file' ? (
        <nav className="sr-only" aria-label="File resolution controls">
          <button
            onClick={() => {
              void provider.delete('/research/notes/deep-link.txt').then(() => {
                setFixtureMutation('deleted')
              })
            }}
          >
            Delete addressed fixture file
          </button>
        </nav>
      ) : null}
      {scenario === 'nested-folder' ? (
        <nav className="sr-only" aria-label="External folder controls">
          <button
            onClick={() => {
              void Promise.all([
                provider.mkdir('/incoming-root'),
                provider.mkdir('/research/uploads'),
                provider.mkdir('/research/notes/evidence'),
              ]).then(() => setFixtureMutation('external-folders-created'))
            }}
          >
            Create folders outside the browser
          </button>
        </nav>
      ) : null}
      <span className="sr-only" data-testid="files-fixture-path">
        {path ?? 'malformed'}
      </span>
      <span className="sr-only" data-testid="files-fixture-history">
        {history.index + 1}/{history.entries.length}
      </span>
      <span className="sr-only" data-testid="files-fixture-mutation">
        {fixtureMutation}
      </span>
      <FilesSurface
        chrome={chrome}
        provider={provider}
        shareApi={FILES_SHARE_API}
        workspaceSlug="acme"
        path={path}
        onNavigate={navigate}
      />
    </>
  )
}

function fixtureProvider(
  scenario: Scenario,
  onDeferredReadChange: (ready: boolean) => void,
): MockFileSystemProvider {
  if (scenario === 'stale-load') {
    const provider = new StaleResolutionProvider()
    provider.seed(
      [
        { path: '/slow/stale.txt', data: 'stale' },
        { path: '/fast/fresh.txt', data: 'fresh' },
      ],
      ['/slow', '/fast'],
    )
    return provider
  }
  const provider = new LiveFixtureProvider(onDeferredReadChange)
  if (scenario === 'unhealthy') return new UnhealthyFixtureProvider()
  if (scenario === 'load-error') {
    provider.failNextOperation = 'list'
  }
  if (scenario === 'empty') return provider
  if (scenario === 'apps' || scenario === 'apps-paginated' || scenario === 'apps-es') {
    provider.seed(
      [
        { path: '/readme.md', data: '# App folders\n', contentType: 'text/markdown' },
        {
          path: '/hello/icon.svg',
          data: DRIVE_FILE_ICON_SVG,
          contentType: 'image/svg+xml',
        },
      ],
      [
        '/hello',
        '/reconciling-lab',
        '/failed-runtime',
        '/broken-folder',
        '/disabled-replica',
        '/normal-folder',
        '/page-two-dashboard',
      ],
    )
    return provider
  }
  provider.seed(
    [
      {
        path: '/Welcome.md',
        data: '# Welcome to Duet\n\nFiles are shared by your team and every AI session.\n',
        contentType: 'text/markdown',
      },
      {
        path: '/quarterly-plan.md',
        data: '## Q3 priorities\n\n- Launch API docs\n- Invite design partners\n- Measure activation\n',
        contentType: 'text/markdown',
      },
      {
        path: '/meeting-recap.md',
        data: '## Recap\n\nSynced in from the design workstation.\n',
        contentType: 'text/markdown',
      },
      {
        path: '/competitive-teardown-and-go-to-market-experiments-2026-planning.md',
        data: '# Teardown\n\nLong names must truncate, not break the row grid.\n',
        contentType: 'text/markdown',
      },
      {
        // A root-level PDF so the drive-status usage bar shows more than one
        // file kind. The bytes are padded so the PDF slice reads clearly.
        path: '/product-brief.pdf',
        data: (() => {
          const bytes = new Uint8Array(4096).fill(32)
          bytes.set([37, 80, 68, 70, 45]) // %PDF-
          return bytes
        })(),
        contentType: 'application/pdf',
      },
      {
        path: '/brand-assets/logo.svg',
        data: '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="160" viewBox="0 0 280 160"><rect width="280" height="160" rx="16" fill="#0f172a"/><circle cx="70" cy="80" r="34" fill="#38bdf8"/><rect x="130" y="52" width="110" height="16" rx="8" fill="#e2e8f0"/><rect x="130" y="86" width="80" height="12" rx="6" fill="#64748b"/></svg>',
        contentType: 'image/svg+xml',
      },
      {
        path: '/exports/customer-data.bin',
        data: new Uint8Array(Array.from({ length: 96 }, (_, index) => index)),
      },
      {
        path: '/exports/launch-plan.xls',
        data: 'Plan,Owner,Status\nAPI docs,Maya,Ready\nApps launch,Leo,In progress\nSpanish SEO,Ana,Complete\n',
        contentType: 'application/vnd.ms-excel',
      },
      {
        path: '/exports/site-copy.html',
        data: '<h1>Duet</h1>',
        contentType: 'text/html',
      },
      {
        path: '/research/market-notes.txt',
        data: 'Design partners consistently ask for durable workspace context.',
        contentType: 'text/plain',
      },
      {
        path: '/research/notes/deep-link.txt',
        data: 'This folder was opened directly from a durable URL.',
        contentType: 'text/plain',
      },
      {
        path: '/.vault/.secret',
        data: 'hidden',
        contentType: 'text/plain',
      },
      {
        path: '/.env',
        data: 'DUET_MODE=deep-link',
        contentType: 'text/plain',
      },
      {
        path: '/research/notes/100%.txt',
        data: 'literal percent',
        contentType: 'text/plain',
      },
      {
        path: '/research/notes/a%2Fb.txt',
        data: 'literal encoded slash text',
        contentType: 'text/plain',
      },
    ],
    ['/empty-folder'],
  )
  return provider
}

class UnhealthyFixtureProvider extends MockFileSystemProvider {
  override async list(): Promise<Result<never>> {
    return {
      success: false,
      error: new DuetApiError(503, 'workspace_unhealthy'),
    }
  }
}

class LiveFixtureProvider extends MockFileSystemProvider {
  private deferWelcomeRead = false
  private deferredRelease: (() => void) | null = null

  constructor(private readonly onDeferredReadChange: (ready: boolean) => void) {
    super()
  }

  deferNextWelcomeRead(): void {
    this.deferWelcomeRead = true
    this.onDeferredReadChange(false)
  }

  releaseDeferredRead(): void {
    this.deferredRelease?.()
  }

  override async readVersioned(
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<VersionedFile>> {
    if (path === '/Welcome.md' && this.deferWelcomeRead) {
      this.deferWelcomeRead = false
      await new Promise<void>(resolve => {
        const finish = () => {
          options.signal?.removeEventListener('abort', finish)
          this.deferredRelease = null
          this.onDeferredReadChange(false)
          resolve()
        }
        this.deferredRelease = finish
        this.onDeferredReadChange(true)
        options.signal?.addEventListener('abort', finish, { once: true })
      })
    }
    return super.readVersioned(path, options)
  }
}

class StaleResolutionProvider extends MockFileSystemProvider {
  private releaseSlow!: () => void
  private readonly slowResolution = new Promise<void>(resolve => {
    this.releaseSlow = resolve
  })

  releaseSlowResolution(): void {
    this.releaseSlow()
  }

  override async stat(path: string, options: { signal?: AbortSignal } = {}) {
    if (path !== '/slow') return super.stat(path, options)
    await this.slowResolution
    return super.stat(path)
  }

  override async list(path: string, options: { signal?: AbortSignal } = {}) {
    return path === '/slow' ? super.list(path) : super.list(path, options)
  }
}

const APP_CAPABILITIES: NonNullable<AppListResponse['meta']>['capabilities'] = { register: true }

type FixtureWorkspaceAppsSource = IWorkspaceAppsSource & {
  deleteApp(workspaceSlug: string, appSlug: string): void
}

function fixtureAppsSource(scenario: Scenario): FixtureWorkspaceAppsSource {
  if (scenario === 'apps-paginated') return new PaginatedAppsSource()
  const source = new MockWorkspaceAppsSource()
  source.seed('acme', {
    items: scenario === 'apps' || scenario === 'apps-es' ? APP_STATE_FIXTURES : [],
    nextCursor: null,
    meta: { capabilities: APP_CAPABILITIES },
  })
  return source
}

class PaginatedAppsSource implements FixtureWorkspaceAppsSource {
  private continuationAllowed = false

  allowContinuation(): void {
    this.continuationAllowed = true
  }

  async listApps(
    _workspaceSlug: string,
    options: { cursor?: string } = {},
  ): Promise<AppListResponse> {
    if (options.cursor === undefined) {
      return {
        items: [fixtureApp('hello', { name: 'Launch Control', icon: 'icon.svg' })],
        nextCursor: 'page-2',
        meta: { capabilities: APP_CAPABILITIES },
      }
    }
    if (!this.continuationAllowed) throw new Error('continuation failed')
    return {
      items: [fixtureApp('page-two-dashboard', { name: 'Page two dashboard' })],
      nextCursor: null,
      meta: { capabilities: APP_CAPABILITIES },
    }
  }

  deleteApp(): void {}
}

function fixtureApp(slug: string, overrides: Partial<App> = {}): App {
  return {
    id: `app_${slug}`,
    workspaceId: 'workspace_acme',
    anchorId: `anchor_${slug}`,
    anchorPath: slug,
    anchorState: 'active',
    command: 'bun run start',
    apiScopes: [],
    port: 41000,
    slug,
    visibility: 'folder',
    canonicalUrl: canonicalAppUrl('acme', slug, DUET_EDGE_HOST),
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
    ...overrides,
  }
}

const APP_STATE_FIXTURES: App[] = [
  fixtureApp('hello', { name: 'Launch Control', icon: 'icon.svg' }),
  fixtureApp('reconciling-lab', { runtimeStatus: 'reconciling', port: 41001 }),
  fixtureApp('failed-runtime', {
    name: 'Customer readiness, launch analytics, and incident response command center',
    icon: 'missing-icon.svg',
    runtimeStatus: 'reconcile_failed',
    reconciliationError: 'gateway_unavailable',
    port: 41002,
  }),
  fixtureApp('broken-folder', { anchorState: 'broken', port: 41003 }),
  fixtureApp('orphaned-app', { anchorState: 'broken', port: 41004 }),
  fixtureApp('disabled-replica', {
    sourceShareId: 'share_1',
    sourceAppId: 'source_app_1',
    disabledAt: 1_750_000_100_000,
    disabledByUserId: 'user_owner',
    port: 41005,
  }),
]

function fixtureAttribution(scenario: Scenario, incompleteSeenBy: boolean): MockAttributionSource {
  const source =
    scenario === 'browse' ? new ActivityContinuationErrorSource() : new MockAttributionSource()
  if (scenario === 'attribution-error') {
    source.failAll = true
    return source
  }
  source.seed({
    members: [
      {
        id: 'u-maya',
        email: 'maya@acme.dev',
        name: 'Maya Chen',
        role: 'editor',
        isBillingUser: false,
      },
      {
        id: 'u-leo',
        email: 'leo@acme.dev',
        name: 'Leo Okafor',
        role: 'editor',
        isBillingUser: false,
      },
      {
        id: 'u-max',
        email: 'max@acme.dev',
        name: 'Maximiliano Featherstonehaugh-Villanueva',
        role: 'editor',
        isBillingUser: false,
      },
    ],
    seenBy: {
      '/Welcome.md': [
        {
          actor: 'session:ses_1',
          userId: 'u-maya',
          firstAt: FIXTURE_NOW - 26 * HOUR,
          lastAt: FIXTURE_NOW - 2 * HOUR,
          lastWriteAt: FIXTURE_NOW - 2 * HOUR,
          readCount: 6,
          writeCount: 3,
        },
        {
          actor: 'web:u-maya',
          userId: 'u-maya',
          firstAt: FIXTURE_NOW - 30 * HOUR,
          lastAt: FIXTURE_NOW - 3 * HOUR,
          readCount: 9,
          writeCount: 0,
        },
        {
          actor: 'web:u-leo',
          userId: 'u-leo',
          firstAt: FIXTURE_NOW - 20 * HOUR,
          lastAt: FIXTURE_NOW - 5 * HOUR,
          readCount: 2,
          writeCount: 0,
        },
        {
          actor: 'terminal',
          firstAt: FIXTURE_NOW - 8 * HOUR,
          lastAt: FIXTURE_NOW - 8 * HOUR,
          readCount: 1,
          writeCount: 0,
        },
        {
          actor: 'api-key:key_1',
          userId: 'u-leo',
          firstAt: FIXTURE_NOW - 11 * HOUR,
          lastAt: FIXTURE_NOW - 11 * HOUR,
          readCount: 1,
          writeCount: 0,
        },
        {
          actor: 'sync:share_1',
          firstAt: FIXTURE_NOW - 15 * HOUR,
          lastAt: FIXTURE_NOW - 15 * HOUR,
          readCount: 1,
          writeCount: 0,
        },
      ].slice(0, incompleteSeenBy ? 3 : undefined),
      '/quarterly-plan.md': [
        {
          actor: 'web:u-maya',
          userId: 'u-maya',
          firstAt: FIXTURE_NOW - 4 * HOUR,
          lastAt: FIXTURE_NOW - 0.75 * HOUR,
          lastWriteAt: FIXTURE_NOW - 0.75 * HOUR,
          readCount: 4,
          writeCount: 2,
        },
      ],
      '/exports/launch-plan.xls': [
        {
          actor: 'terminal',
          firstAt: FIXTURE_NOW - 3 * HOUR,
          lastAt: FIXTURE_NOW - 3 * HOUR,
          lastWriteAt: FIXTURE_NOW - 3 * HOUR,
          readCount: 0,
          writeCount: 1,
        },
        {
          actor: 'web:u-maya',
          userId: 'u-maya',
          firstAt: FIXTURE_NOW - 2 * HOUR,
          lastAt: FIXTURE_NOW - 2 * HOUR,
          readCount: 1,
          writeCount: 0,
        },
      ],
      // exports/customer-data.bin: nobody has seen it — the strip shows "—".
    },
    seenByNextCursor: incompleteSeenBy ? { '/Welcome.md': 'older-readers' } : undefined,
    // Dense per-file history (drives the drawer + its pagination): create,
    // a collapsed same-bucket read pair, an agent write, a rename with both
    // paths, a workspace restore, a member write — reads inline throughout.
    history: {
      '/Welcome.md': [
        {
          seq: 1,
          event: {
            kind: 'create',
            entryKind: 'file',
            path: 'Welcome.md',
            actor: 'api-key:key_1',
            userId: 'u-leo',
            at: FIXTURE_NOW - 30 * HOUR,
          },
        },
        {
          seq: 2,
          event: {
            kind: 'read',
            path: 'Welcome.md',
            actor: 'web:u-maya',
            userId: 'u-maya',
            at: FIXTURE_NOW - 28 * HOUR,
          },
        },
        {
          seq: 3,
          event: {
            kind: 'read',
            path: 'Welcome.md',
            actor: 'web:u-maya',
            userId: 'u-maya',
            at: FIXTURE_NOW - 27.5 * HOUR,
          },
        },
        {
          // Several saves inside one bucket. The count is logical saves, so
          // the row can say how many without repeating the syscall stream the
          // watcher actually reported.
          seq: 4,
          event: {
            kind: 'write',
            path: 'Welcome.md',
            actor: 'session:ses_1',
            userId: 'u-maya',
            count: 6,
            at: FIXTURE_NOW - 26 * HOUR,
          },
        },
        {
          seq: 5,
          event: {
            kind: 'read',
            path: 'Welcome.md',
            actor: 'web:u-leo',
            userId: 'u-leo',
            at: FIXTURE_NOW - 20 * HOUR,
          },
        },
        {
          seq: 6,
          event: {
            kind: 'rename',
            entryKind: 'file',
            path: 'Welcome.md',
            fromPath: 'welcome-draft.md',
            actor: 'session:ses_1',
            userId: 'u-maya',
            at: FIXTURE_NOW - 12 * HOUR,
          },
        },
        {
          seq: 7,
          event: {
            kind: 'restore',
            actor: 'web:u-maya',
            userId: 'u-maya',
            at: FIXTURE_NOW - 8 * HOUR,
          },
        },
        {
          seq: 8,
          event: {
            kind: 'write',
            path: 'Welcome.md',
            actor: 'web:u-maya',
            userId: 'u-maya',
            at: FIXTURE_NOW - 2 * HOUR,
          },
        },
      ],
      // Sparse history — a single write and one read, no pagination.
      '/quarterly-plan.md': [
        {
          seq: 20,
          event: {
            kind: 'write',
            path: 'quarterly-plan.md',
            actor: 'web:u-maya',
            userId: 'u-maya',
            at: FIXTURE_NOW - 4 * HOUR,
          },
        },
        {
          seq: 21,
          event: {
            kind: 'read',
            path: 'quarterly-plan.md',
            actor: 'session:ses_1',
            userId: 'u-maya',
            at: FIXTURE_NOW - 1 * HOUR,
          },
        },
      ],
      // exports/customer-data.bin has no history — the drawer's empty state.
    },
    // Mixed seven-actor workspace feed, served newest first, with a mirror write and a
    // terminal write kept visible (honesty firewall) and an agent burst that
    // groups into one "edited 3 files" row.
    activity: [
      {
        seq: 1,
        event: {
          kind: 'create',
          entryKind: 'file',
          path: 'exports/pipeline.csv',
          actor: 'api-key:key_1',
          userId: 'u-leo',
          at: FIXTURE_NOW - 26 * HOUR,
        },
      },
      {
        seq: 2,
        event: {
          kind: 'write',
          // Saved several times inside one bucket — a script rewriting the file
          // rather than a stream, so the count is worth stating.
          count: 4,
          path: 'deploy-notes.txt',
          actor: 'terminal',
          at: FIXTURE_NOW - 24 * HOUR,
        },
      },
      {
        seq: 3,
        event: {
          kind: 'write',
          path: 'exports/site-copy.html',
          actor: 'sync:share_1',
          at: FIXTURE_NOW - 22 * HOUR,
        },
      },
      {
        seq: 4,
        event: {
          kind: 'write',
          path: 'meeting-recap.md',
          actor: 'mirror:dev_1',
          at: FIXTURE_NOW - 18 * HOUR,
        },
      },
      {
        seq: 5,
        event: {
          kind: 'write',
          path: 'Welcome.md',
          actor: 'session:ses_1',
          userId: 'u-maya',
          at: FIXTURE_NOW - 12 * HOUR,
        },
      },
      {
        seq: 6,
        event: {
          kind: 'write',
          path: 'quarterly-plan.md',
          actor: 'session:ses_1',
          userId: 'u-maya',
          at: FIXTURE_NOW - 12 * HOUR,
        },
      },
      {
        seq: 7,
        event: {
          kind: 'write',
          path: 'research/market-notes.txt',
          actor: 'session:ses_1',
          userId: 'u-maya',
          at: FIXTURE_NOW - 12 * HOUR,
        },
      },
      {
        seq: 8,
        event: {
          kind: 'rename',
          entryKind: 'file',
          path: 'quarterly-plan.md',
          fromPath: 'q3-plan.md',
          actor: 'web:u-maya',
          userId: 'u-maya',
          at: FIXTURE_NOW - 6 * HOUR,
        },
      },
      {
        seq: 9,
        event: {
          kind: 'delete',
          entryKind: 'file',
          path: 'old-draft.md',
          actor: 'system',
          at: FIXTURE_NOW - 3 * HOUR,
        },
      },
      {
        seq: 10,
        event: {
          kind: 'changed-summary',
          path: '.git',
          actor: 'terminal',
          at: FIXTURE_NOW - 2 * HOUR,
          count: 487,
        },
      } as never,
      {
        seq: 11,
        event: {
          kind: 'viewed-summary',
          path: 'research/node_modules',
          actor: 'session:ses_1',
          userId: 'u-maya',
          at: FIXTURE_NOW - HOUR,
          count: 93,
        },
      } as never,
    ],
    scopedActivity: movedFolderActivity(),
  })
  return source
}

class ActivityContinuationErrorSource extends MockAttributionSource {
  private failed = false

  override async workspaceActivity(workspaceSlug: string, options: FileActivityPageOptions = {}) {
    if (options.cursor !== undefined && !this.failed) {
      this.failed = true
      throw new Error('fixture_activity_page_failed')
    }
    return await super.workspaceActivity(workspaceSlug, options)
  }
}

function movedFolderActivity() {
  const older = {
    seq: 30,
    event: {
      kind: 'write' as const,
      path: 'old/box/nested/a.md',
      actor: 'session:ses_1',
      userId: 'u-maya',
      at: FIXTURE_NOW - 6 * HOUR,
    },
  }
  const moved = {
    seq: 31,
    event: {
      kind: 'rename' as const,
      entryKind: 'folder' as const,
      fromPath: 'old/box',
      path: 'new/box',
      actor: 'web:u-maya',
      userId: 'u-maya',
      at: FIXTURE_NOW - 3 * HOUR,
    },
  }
  const newer = {
    seq: 32,
    event: {
      kind: 'write' as const,
      path: 'new/box/nested/a.md',
      actor: 'session:ses_1',
      userId: 'u-maya',
      at: FIXTURE_NOW - HOUR,
    },
  }
  // A burst folded to the folder it happened in: one row standing for many
  // files, which is what a build or an automation produces. Marked
  // entryKind: 'folder' because a SERVER fold counts distinct files, where a
  // gateway fold of a regenerable tree counts raw events.
  const folded = {
    seq: 33,
    event: {
      kind: 'changed-summary' as const,
      path: 'new/box',
      entryKind: 'folder' as const,
      count: 103,
      actor: 'session:ses_1',
      userId: 'u-maya',
      at: FIXTURE_NOW - 30 * 60 * 1000,
    },
  }
  return {
    '/new/box': [older, moved, newer, folded],
    '/old': [older, moved],
    '/new': [moved, newer, folded],
    '/new/box/nested/a.md': [older, newer],
  }
}
