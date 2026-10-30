'use client'

/* ============================================================================
   The product with its network taken away.

   This is the one fixture that mounts `DuetSpa` with its query cache actually
   persisted, so the claim `api/query-persistence.ts` makes can be walked rather
   than argued: read a workspace once, take the network away, and every surface
   already read is still there.

   Three things make it different from `spa-shell`, and each is load-bearing:

   - **Its own IndexedDB database** — see `FIXTURE_CACHE_DATABASE` for why a
     fixture may not share the product's.
   - **A fake API that can be cut off.** The fake answers from memory, so
     `context.setOffline(true)` alone would not stop it and the walk would
     prove nothing. See `offlineAware` for the two ways it is cut and why a
     single-page app needs both.
   - **The destination comes from the address bar** (`?path=…`), so a reload
     lands back where it was. The router is still the memory one every fixture
     uses; what survives the reload is the cache, which is the point.
   ========================================================================= */
import { NextIntlClientProvider } from 'next-intl'
import { useEffect, useRef, useState } from 'react'

import type { App, OAuthGrant, SyncMachine, UserApiKey, WhoamiResponse } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { AppFrameSourceProvider } from '../../spa/apps/app-frame'
import type { SpaApi } from '../../spa/context'
import { DriveFileIconClientProvider } from '../../spa/drive/drive-file-icon'
import { AttributionConfigProvider } from '../../spa/files/attribution'
import { DuetSpa } from '../../spa/root'
import { FIXTURE_CACHE_DATABASE, RENAMED_FIRST_AGENT } from './cache-continuity-fixture'
import { createDriveFileIconFixture } from './drive-file-icon-fixture'
import {
  APP_FIXTURES,
  createFixtureApi,
  createSessionStore,
  fixtureAppFrameSource,
  FIXTURE_NOW,
  IDENTITY,
} from './spa-fixture'

/**
 * Refuse every read while the fixture is cut off.
 *
 * Two ways to cut it, because a browser gives a single-page app two different
 * outages and only one of them is reachable with `context.setOffline`:
 *
 * - **The browser goes offline mid-sitting.** `navigator.onLine` says so, the
 *   reader keeps navigating, and nothing reloads. This is the ordinary one.
 * - **The page loads but the API does not answer.** `?offline=1` on the
 *   fixture's own URL, because `setOffline` would refuse the document too and
 *   there would be no app to test. This is the reload case: the restored cache
 *   is the only thing that can draw the workspace.
 *
 * A rejected promise rather than a hang, because that is what `fetch` does, and
 * the difference decides whether a surface with nothing cached says "could not
 * load" or waits forever.
 */
function offlineAware(api: SpaApi, isCut: () => boolean): SpaApi {
  return new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (isCut()) return Promise.reject(new TypeError('Failed to fetch'))
        return (value as (...rest: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

export function CacheContinuityPlayground() {
  const [initialPath, setInitialPath] = useState<string>()
  const identity = useRef<WhoamiResponse>({
    ...IDENTITY,
    workspaces: [...IDENTITY.workspaces],
    scopes: [...IDENTITY.scopes],
  })
  const sessionStore = useRef(createSessionStore())
  const apps = useRef<App[]>(APP_FIXTURES.map(app => ({ ...app })))
  const members = useRef([
    {
      id: 'user_owner',
      email: 'owner@duet.so',
      name: 'Ada Lovelace',
      role: 'owner' as const,
      isBillingUser: true,
    },
  ])
  const profile = useRef({
    id: 'user_owner',
    email: 'owner@duet.so',
    firstName: 'Ada',
    lastName: 'Lovelace',
    name: 'Ada Lovelace',
  })
  const userKeys = useRef<UserApiKey[]>([])
  const oauthGrants = useRef<OAuthGrant[]>([])
  const syncMachines = useRef<SyncMachine[]>([])
  const [driveIcons] = useState(() => createDriveFileIconFixture([]))
  /* Written by the effect below, read by every API call. A ref rather than
     state because the API is built once, before the address bar has been
     read. */
  const apiCut = useRef(false)
  /* What this fixture's "server" has learned since the cache was written. The
     reader must see the cached name while cut off and this one the moment the
     network is back — which is the whole of the seamless-catch-up claim. */
  const renamedFirstAgent = useRef<string | undefined>(undefined)
  const apiRef = useRef<SpaApi | null>(null)
  if (apiRef.current === null) {
    const base = createFixtureApi(
      identity,
      sessionStore,
      apps,
      members,
      profile,
      userKeys,
      oauthGrants,
      syncMachines,
      () => {},
      () => {},
      () => {},
    )
    apiRef.current = offlineAware(
      {
        ...base,
        listAgents: async (workspaceSlug, options) => {
          const roster = await base.listAgents(workspaceSlug, options)
          const renamed = renamedFirstAgent.current
          if (renamed === undefined) return roster
          return {
            ...roster,
            items: roster.items.map((agent, at) =>
              at === 0 ? { ...agent, name: renamed } : agent,
            ),
          }
        },
      },
      () => apiCut.current || !navigator.onLine,
    )
  }

  /* Read after mount, never during render: the server has no address bar, and a
     path guessed on one side of hydration and read on the other is a mismatch. */
  useEffect(() => {
    const search = new URLSearchParams(window.location.search)
    apiCut.current = search.get('offline') === '1'
    // The map, which is where a signed-in reader lands and what most of the walk is about.
    setInitialPath(search.get('path') ?? '/w/acme/agents')
  }, [])

  if (initialPath === undefined) return null
  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <AttributionConfigProvider now={() => FIXTURE_NOW}>
        {/* The one thing here that is not the product: a way to move the
            fixture's server on while the browser is not listening, so the
            catch-up on reconnect is a real difference and not a re-render. */}
        <nav aria-label="Playground controls" className="sr-only">
          <button onClick={() => (renamedFirstAgent.current = RENAMED_FIRST_AGENT)}>
            Rename the first agent
          </button>
        </nav>
        <DriveFileIconClientProvider client={driveIcons.client}>
          <AppFrameSourceProvider source={fixtureAppFrameSource}>
            <DuetSpa
              initialPath={initialPath}
              fixtureIdentity={identity.current}
              api={apiRef.current}
              cachePersistence={{
                userId: identity.current.user.id,
                databaseName: FIXTURE_CACHE_DATABASE,
              }}
            />
          </AppFrameSourceProvider>
        </DriveFileIconClientProvider>
      </AttributionConfigProvider>
    </NextIntlClientProvider>
  )
}
