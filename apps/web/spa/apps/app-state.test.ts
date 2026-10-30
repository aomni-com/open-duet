import { expect, test } from 'bun:test'

import { canonicalAppUrl, DUET_EDGE_HOST, type App } from '@repo/contract'

import { replaceApp, withAppVisibility, withoutApp } from './app-state'

const site: App = {
  id: 'app_1',
  workspaceId: 'workspace_1',
  anchorId: 'anchor_1',
  anchorPath: 'apps/site',
  anchorState: 'active',
  command: 'bun run start',
  apiScopes: [],
  port: 4173,
  slug: 'site',
  visibility: 'folder',
  canonicalUrl: canonicalAppUrl('acme', 'site', DUET_EDGE_HOST),
  runtimeStatus: 'reconciled',
  createdByUserId: 'user_1',
  createdAt: 1,
  updatedAt: 1,
  controls: {
    manageDomain: true,
    updateRuntime: true,
    makePublic: true,
    makePrivate: true,
    delete: true,
  },
}
const briefs: App = { ...site, id: 'app_2', slug: 'briefs', anchorPath: 'apps/briefs' }
const page = {
  items: [briefs, site],
  nextCursor: null,
  meta: { capabilities: { register: true } },
}
const data = { pages: [page], pageParams: [undefined] }

test('publishing edits the one app named and keeps every wire-owned field', () => {
  const published = withAppVisibility(data, 'site', 'public')!

  expect(published.pages[0]?.items).toEqual([briefs, { ...site, visibility: 'public' }])
  expect(published.pages[0]?.meta).toEqual(page.meta)
})

test('the app the wire answers with replaces the optimistic one, in slug order', () => {
  const landed: App = { ...site, visibility: 'public', updatedAt: 2 }

  expect(replaceApp(withAppVisibility(data, 'site', 'public'), landed)).toEqual({
    ...data,
    pages: [{ ...page, items: [briefs, landed] }],
  })
})

test('a deleted app leaves the list, and its neighbours stay', () => {
  expect(withoutApp(data, 'site')).toEqual({
    ...data,
    pages: [{ ...page, items: [briefs] }],
  })
})
