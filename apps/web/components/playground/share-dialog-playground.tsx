'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'
import { useMemo, useRef, useState } from 'react'

import {
  appsUnderPath,
  canonicalAppUrl,
  DUET_EDGE_HOST,
  type App,
  type AppListResponse,
  type ListAppsQuery,
} from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { DuetApiError } from '../../spa/api/client'
import { WorkspaceAppsProvider } from '../../spa/files/apps-context'
import { AttributionConfigProvider } from '../../spa/files/attribution'
import { FilesSurface } from '../../spa/files/files-surface'
import { MockWorkspaceAppsSource } from '../../spa/files/lib/mock-apps-source'
import { MockAttributionSource } from '../../spa/files/lib/mock-attribution'
import { MockFileSystemProvider } from '../../spa/files/lib/mock-provider'
import type { ShareDialogApi } from '../../spa/files/share-dialog'

type ShareResponseMode = 'success' | 'submitting' | 'duplicate' | 'cap'

const CAPABILITIES: NonNullable<AppListResponse['meta']>['capabilities'] = { register: true }

const APPS = [
  fixtureApp('launch-dashboard', 'launch/dashboard'),
  fixtureApp('launch-reports', 'launch/tools/reports'),
  fixtureApp('shared-app', 'shared-app', {
    sourceShareId: 'share_source',
    sourceAppId: 'app_source',
  }),
]

export function ShareDialogPlayground() {
  const responseMode = useRef<ShareResponseMode>('success')
  const [path, setPath] = useState('/')
  const provider = useMemo(() => {
    const fixture = new MockFileSystemProvider()
    fixture.seed(
      [
        {
          path: '/readme.md',
          data: '# Share fixture\n',
          contentType: 'text/markdown',
        },
        {
          path: '/launch/brief.md',
          data: '# Launch brief\n',
          contentType: 'text/markdown',
        },
      ],
      ['/empty-folder', '/shared-app', '/launch/dashboard', '/launch/tools/reports'],
    )
    return fixture
  }, [])
  const appsSource = useMemo(() => {
    const source = new MockWorkspaceAppsSource()
    source.seed('acme', { items: APPS, nextCursor: null, meta: { capabilities: CAPABILITIES } })
    return source
  }, [])
  const attribution = useMemo(() => new MockAttributionSource(), [])
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
      }),
    [],
  )
  const shareApi = useMemo<ShareDialogApi>(
    () => ({
      listApps: async (_workspaceSlug: string, filterOrSignal?: ListAppsQuery | AbortSignal) => {
        const filter =
          filterOrSignal !== undefined && 'path' in filterOrSignal ? filterOrSignal : undefined
        const matching =
          filter?.path === undefined
            ? APPS
            : appsUnderPath(APPS, filter.path, filter.scope ?? 'subtree')
        const paged = new URL(window.location.href).searchParams.get('apps') === 'paged'
        return {
          items:
            paged && filter?.cursor === undefined
              ? matching.slice(0, 1)
              : paged
                ? matching.slice(1)
                : matching,
          nextCursor:
            paged && filter?.cursor === undefined && matching.length > 1 ? 'older-apps' : null,
          meta: { capabilities: CAPABILITIES },
        }
      },
      createShare: async (_workspaceSlug, input) => {
        if (responseMode.current === 'submitting') return await new Promise(() => {})
        if (responseMode.current === 'duplicate') {
          throw new DuetApiError(409, 'already_shared')
        }
        if (responseMode.current === 'cap') {
          throw new DuetApiError(429, 'rate_limited')
        }
        return {
          share: {
            id: 'share_fixture',
            anchorId: 'anchor_launch',
            originWorkspaceId: 'workspace_acme',
            fromWorkspaceId: 'workspace_acme',
            toEmail: input.toEmail,
            mode: input.mode,
            ignorePatterns: input.ignorePatterns ?? [],
            state: 'pending',
            createdByUserId: 'user_owner',
            createdAt: 1,
            expiresAt: 2,
            tokenPrefix: 'duet_share_fixture',
          },
        }
      },
    }),
    [],
  )

  return (
    <NextIntlClientProvider locale="en" messages={appEn}>
      <nav className="sr-only" aria-label="Share dialog fixture states">
        {(['success', 'submitting', 'duplicate', 'cap'] as const).map(mode => (
          <button key={mode} onClick={() => (responseMode.current = mode)}>
            Share response: {mode}
          </button>
        ))}
      </nav>
      <div className="h-[780px] min-h-0 overflow-hidden rounded-2xl border bg-background shadow-sm">
        <QueryClientProvider client={queryClient}>
          <WorkspaceAppsProvider
            source={appsSource}
            navigator={{ openApp() {} }}
            deleteApp={async () => {}}
          >
            <AttributionConfigProvider source={attribution} now={() => Date.UTC(2026, 6, 16, 9)}>
              <FilesSurface
                provider={provider}
                shareApi={shareApi}
                workspaceSlug="acme"
                path={path}
                onNavigate={setPath}
              />
            </AttributionConfigProvider>
          </WorkspaceAppsProvider>
        </QueryClientProvider>
      </div>
    </NextIntlClientProvider>
  )
}

function fixtureApp(slug: string, anchorPath: string, overrides: Partial<App> = {}): App {
  return {
    id: `app_${slug}`,
    workspaceId: 'workspace_acme',
    anchorId: `anchor_${slug}`,
    anchorPath,
    anchorState: 'active',
    command: 'bun run start',
    apiScopes: [],
    port: 42000,
    slug,
    visibility: 'folder',
    canonicalUrl: canonicalAppUrl('acme', slug, DUET_EDGE_HOST),
    runtimeStatus: 'reconciled',
    createdByUserId: 'user_owner',
    createdAt: 1,
    updatedAt: 1,
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
