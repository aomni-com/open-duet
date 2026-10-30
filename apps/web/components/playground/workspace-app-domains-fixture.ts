import { primaryAppUrl, type AppDomain, type WorkspaceAppDomainRow } from '@repo/contract'

import { DuetApiClient } from '../../spa/api/client'
import { createAppDomainsFixture } from './app-domains-fixture'

export const WORKSPACE_DOMAIN_STATES = ['ready', 'empty', 'loading', 'error', 'read-only'] as const
export type WorkspaceDomainFixtureState = (typeof WORKSPACE_DOMAIN_STATES)[number]

export function createWorkspaceAppDomainsFixture(
  state: WorkspaceDomainFixtureState,
  record: (request: { path: string; method: string }) => void,
) {
  const manager = createAppDomainsFixture(state === 'read-only' ? 'read-only' : 'verifying')
  let failContinuation = false
  let failRefresh = false
  let failOpen = false
  let failInitial = state === 'error'
  let holding = state === 'loading'
  let release: (() => void) | undefined
  let siteInitialized = false
  const rows: WorkspaceAppDomainRow[] = [
    row('site', 'Customer portal', 'portal.example.com', 'verifying'),
    row('reporting', 'Launch intelligence', 'reports.example.com', 'active'),
    row('billing', 'Billing dashboard', 'billing.example.com', 'failed'),
    row('team', 'Team workspace', 'team.example.com', 'removing', true),
    row(
      'sales',
      'International sales and customer success',
      'international-sales.customer-success.preview.example.com',
      'active',
    ),
    row('metrics', 'Metrics', 'metrics.example.com', 'pending'),
  ]
  const slots = new Map(rows.map(item => [item.app.slug, item.domain]))
  async function initializeSite() {
    if (!siteInitialized) {
      slots.set('site', (await manager.api.getAppDomain('acme', 'site')).domain!)
      siteInitialized = true
    }
  }
  function row(
    slug: string,
    name: string,
    hostname: string,
    status: AppDomain['status'],
    retryRequired?: boolean,
  ): WorkspaceAppDomainRow {
    return {
      domain: {
        id: `domain_${slug}`,
        appId: slug === 'site' ? 'app_site' : `app_${slug}`,
        workspaceId: 'workspace_acme',
        hostname,
        status,
        records: [],
        conflicts: [],
        createdAt: 1,
        updatedAt: 1,
        ...(retryRequired ? { retryRequired } : {}),
      },
      app: {
        id: slug === 'site' ? 'app_site' : `app_${slug}`,
        slug,
        name,
        controls: { manageDomain: state !== 'read-only' },
      },
    }
  }
  return {
    failContinuation() {
      failContinuation = true
    },
    failRefresh() {
      failRefresh = true
    },
    failOpen() {
      failOpen = true
    },
    completeRechecks() {
      for (const [slug, domain] of slots) {
        if (domain.checking)
          slots.set(slug, {
            ...domain,
            status: 'active',
            checking: undefined,
            lastError: undefined,
            records: [
              {
                type: 'CNAME',
                domain: domain.hostname,
                value: 'cname.vercel-dns.com',
              },
            ],
            lastCheckedAt: Date.UTC(2026, 8, 30, 12),
            updatedAt: Date.UTC(2026, 8, 30, 12),
          })
      }
    },
    finishCleanup(slug: string) {
      slots.delete(slug)
    },
    release() {
      release?.()
      release = undefined
      holding = false
    },
    api: new DuetApiClient(async (input, init) => {
      const path = String(input)
      const url = new URL(path, 'https://fixture.example')
      const method = init?.method ?? 'GET'
      record({ path, method })
      await initializeSite()
      const appSlug = decodeURIComponent(url.pathname.split('/apps/')[1]?.split('/')[0] ?? '')
      if (state === 'read-only' && method !== 'GET')
        return Response.json({ error: 'forbidden' }, { status: 403 })
      if (url.pathname.endsWith('/app-domains')) {
        if (holding)
          await new Promise<void>(resolve => {
            release = resolve
          })
        const cursor = url.searchParams.get('cursor')
        if (
          failInitial ||
          (cursor !== null && failContinuation) ||
          (cursor === null && failRefresh)
        ) {
          failInitial = false
          failContinuation = false
          failRefresh = false
          return Response.json({ error: 'unavailable' }, { status: 503 })
        }
        if (state === 'empty') return Response.json({ items: [], nextCursor: null })
        const current = rows.flatMap(item => {
          const domain = slots.get(item.app.slug)
          return domain === undefined ? [] : [{ ...item, domain }]
        })
        return Response.json(
          cursor === null
            ? {
                items: current.slice(0, 5),
                nextCursor: current.length > 5 ? 'page-two' : null,
              }
            : { items: current.slice(5), nextCursor: null },
        )
      }
      if (url.pathname.includes('/domain')) {
        const domain = slots.get(appSlug)
        if (method === 'DELETE' && domain !== undefined)
          slots.set(appSlug, {
            ...domain,
            status: 'removing',
            checking: undefined,
            records: [],
            conflicts: [],
          })
        if (url.pathname.endsWith('/recheck') && domain !== undefined)
          slots.set(appSlug, {
            ...domain,
            retryRequired: undefined,
            ...(['active', 'failed'].includes(domain.status) ? { checking: true as const } : {}),
          })
        return Response.json({ domain: slots.get(appSlug) ?? null })
      }

      if (url.pathname.endsWith('/agents'))
        return Response.json({
          items: [
            {
              id: 'agent_research',
              workspaceId: 'workspace_acme',
              slug: 'research',
              anchorId: 'anchor_research',
              anchorPath: 'agents/research',
              anchorState: 'active',
              createdByUserId: 'user_ada',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          nextCursor: null,
        })
      if (url.pathname.includes('/apps/')) {
        if (failOpen) {
          failOpen = false
          return Response.json({ error: 'unavailable' }, { status: 503 })
        }
        const subject = rows.find(item => item.app.slug === appSlug)?.app
        if (subject === undefined) return Response.json({ error: 'not_found' }, { status: 404 })
        return Response.json({
          app: {
            ...manager.app,
            ...subject,
            canonicalUrl: primaryAppUrl(
              'acme',
              appSlug,
              'edge-staging.duet.so',
              slots.get(appSlug),
            ),
            customDomain: slots.get(appSlug),
            anchorId: `anchor_${appSlug}`,
            anchorPath: `agents/research/apps/${appSlug}`,
            controls: { ...manager.app.controls, ...subject.controls },
          },
        })
      }

      throw new Error(`Unexpected workspace domain fixture request: ${method} ${path}`)
    }),
  }
}
