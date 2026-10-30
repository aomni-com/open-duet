import type { App, AppDomain } from '@repo/contract'
import { canonicalAppUrl, normalizeAppDomainHostname, primaryAppUrl } from '@repo/contract'

import { DuetApiClient } from '../../spa/api/client'

export const APP_DOMAIN_STATES = [
  'empty',
  'pending',
  'verifying',
  'conflicts',
  'active',
  'failed',
  'removing',
  'cleanup-retry',
  'operator-repair',
  'long-records',
  'read-only',
  'unavailable',
] as const
export type AppDomainFixtureState = (typeof APP_DOMAIN_STATES)[number]

export function createAppDomainsFixture(
  state: AppDomainFixtureState,
  record: (event: unknown) => void = () => {},
) {
  let domain = fixtureDomain(state)
  let hold = false
  let release: (() => void) | undefined
  let refusal: string | undefined
  const app: App = {
    id: 'app_site',
    workspaceId: 'workspace_acme',
    anchorId: 'anchor_site',
    anchorPath: 'apps/site',
    anchorState: state === 'unavailable' ? 'broken' : 'active',
    command: 'bun run start',
    apiScopes: [],
    port: 4173,
    slug: 'site',
    name: 'Customer portal',
    visibility: 'public',
    canonicalUrl: canonicalAppUrl('acme', 'site', 'edge-staging.duet.so'),
    runtimeStatus: 'reconciled',
    createdByUserId: 'user_ada',
    createdAt: 1,
    updatedAt: 1,
    controls: {
      updateRuntime: state !== 'read-only',
      makePublic: state !== 'read-only',
      makePrivate: state !== 'read-only',
      delete: state !== 'read-only',
      manageDomain: state !== 'read-only',
    },
  }
  function currentApp() {
    return {
      ...app,
      canonicalUrl: primaryAppUrl('acme', app.slug, 'edge-staging.duet.so', domain ?? undefined),
      ...(domain === null
        ? {}
        : { customDomain: { hostname: domain.hostname, status: domain.status } }),
    }
  }
  return {
    app,
    advance(next: AppDomainFixtureState) {
      domain = fixtureDomain(next)
    },
    completeRecheck() {
      if (domain !== null) domain = { ...domain, checking: undefined, updatedAt: 3 }
    },
    holdNextMutation() {
      hold = true
    },
    releaseMutation() {
      release?.()
      release = undefined
    },
    refuseNextMutation(code: string) {
      refusal = code
    },
    api: new DuetApiClient(async (input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      const mutating = ['PUT', 'POST', 'DELETE'].includes(method)
      if (mutating) {
        record({ path, method, body: init?.body })
        if (hold) {
          hold = false
          await new Promise<void>(resolve => {
            release = resolve
          })
        }
        if (refusal !== undefined) {
          const error = refusal
          refusal = undefined
          return Response.json({ error }, { status: 409 })
        }
      }
      if (path.endsWith('/domain/recheck')) {
        if (domain !== null)
          domain = {
            ...domain,
            retryRequired: undefined,
            ...(['active', 'failed'].includes(domain.status) ? { checking: true as const } : {}),
            updatedAt: 2,
          }
        return Response.json({ domain })
      }
      if (path.endsWith('/domain')) {
        if (method === 'PUT') {
          try {
            domain = {
              ...fixtureDomain('pending')!,
              hostname: normalizeAppDomainHostname(JSON.parse(String(init?.body)).hostname),
            }
          } catch {
            return Response.json({ error: 'invalid_request' }, { status: 400 })
          }
        }
        if (method === 'DELETE' && domain !== null)
          domain = {
            ...domain,
            status: 'removing',
            checking: undefined,
            records: [],
            conflicts: [],
            updatedAt: 2,
          }
        return Response.json({ domain })
      }
      if (path.includes('/app-domains'))
        return Response.json({
          items:
            domain === null
              ? []
              : [
                  {
                    domain,
                    app: {
                      id: app.id,
                      slug: app.slug,
                      name: app.name,
                      controls: { manageDomain: app.controls.manageDomain },
                    },
                  },
                ],
          nextCursor: null,
        })
      if (path.endsWith('/apps/site')) return Response.json({ app: currentApp() })
      if (path.endsWith('/apps'))
        return Response.json({
          items: [currentApp()],
          nextCursor: null,
          meta: { capabilities: { register: true } },
        })
      throw new Error(`Unexpected domain fixture request: ${method} ${path}`)
    }),
  }
}

function fixtureDomain(state: AppDomainFixtureState): AppDomain | null {
  if (state === 'empty') return null
  const status =
    state === 'conflicts' ||
    state === 'long-records' ||
    state === 'read-only' ||
    state === 'unavailable'
      ? 'verifying'
      : state === 'cleanup-retry' || state === 'operator-repair'
        ? 'removing'
        : state
  return {
    id: 'domain_portal',
    workspaceId: 'workspace_acme',
    appId: 'app_site',
    hostname: 'portal.example.com',
    status,
    records:
      status === 'verifying'
        ? [
            {
              type: 'TXT',
              domain: '_vercel.portal.example.com',
              value:
                state === 'long-records'
                  ? 'vc-domain-verify=portal.example.com,'.concat('a7f902d1'.repeat(40))
                  : 'vc-domain-verify=portal.example.com,7e240b',
              reason: 'pending-ownership',
            },
            {
              type: 'CNAME',
              domain: 'portal.example.com',
              value: 'cname.vercel-dns.com',
            },
          ]
        : [],
    conflicts:
      state === 'conflicts' ? [{ name: 'portal.example.com', type: 'A', value: '192.0.2.8' }] : [],
    ...(state === 'failed'
      ? {
          lastError:
            'Domain verification could not be completed. Check your DNS records and recheck.',
        }
      : {}),
    ...(state === 'cleanup-retry'
      ? { retryRequired: true, lastError: 'Provider cleanup is temporarily unavailable.' }
      : {}),
    ...(state === 'operator-repair'
      ? {
          operatorRepairRequired: true as const,
          lastError: 'A provider operation has an uncertain outcome.',
        }
      : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}
