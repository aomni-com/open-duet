import { expect, test } from 'bun:test'

import { appControls, canonicalAppUrl, DUET_EDGE_HOST, type App } from '@repo/contract'

import { appMenuItems } from './app-menu-items'

const baseApp: App = {
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

/* Controls are projected exactly as the API projects them, so a fixture can
   never offer the menu a control the server would refuse. */
function menuOf(app: Partial<App>) {
  const subject = { ...baseApp, ...app }
  return appMenuItems({ ...subject, controls: appControls('owner', subject) })
}

test('domain management remains available for disabled and broken apps when the server allows it', () => {
  for (const app of [{ disabledAt: 1 }, { anchorState: 'broken' as const }]) {
    expect(menuOf(app)).toContainEqual({ kind: 'custom-domains' })
  }
  expect(
    appMenuItems({ ...baseApp, controls: { ...baseApp.controls, manageDomain: false } }),
  ).toContainEqual({ kind: 'custom-domains' })
})

/* The bug this pins: a private app's public URL answers 403 to everyone,
   including the workspace members allowed to use the app. Only a public app
   has a link worth offering — a private one is reachable through the frame. */
test('a private app offers publishing and no link at all', () => {
  expect(menuOf({})).toEqual([{ kind: 'publish' }, { kind: 'custom-domains' }, { kind: 'delete' }])
})

test('a public app offers its link both ways, and the switch back', () => {
  expect(menuOf({ visibility: 'public' })).toEqual([
    { kind: 'open-in-new-tab', url: baseApp.canonicalUrl },
    { kind: 'copy-link', url: baseApp.canonicalUrl },
    { kind: 'make-private' },
    { kind: 'custom-domains' },
    { kind: 'delete' },
  ])
})

/* A replica writes through to somebody else's app: the recipient may switch
   nothing about it and leaves by dropping the share, never by deleting a row
   they do not own. */
test('an app shared read-only offers inspection without runtime changes', () => {
  expect(menuOf({ sourceShareId: 'share_1', sourceShareMode: 'read' })).toEqual([
    { kind: 'custom-domains' },
  ])
})

/* An app whose folder is gone can never answer its public URL, so publishing
   it would mint a link that is dead on arrival. Its domain is still inspectable and removable while its runtime is
   unavailable. */
test('an app with a broken folder link keeps domain management and deletion', () => {
  expect(menuOf({ anchorState: 'broken' })).toEqual([
    { kind: 'custom-domains' },
    { kind: 'delete' },
  ])
  // Including one that was published before its folder went missing: the record
  // still says `public`, and the address it names now serves nothing.
  expect(menuOf({ anchorState: 'broken', visibility: 'public' })).toEqual([
    { kind: 'custom-domains' },
    { kind: 'delete' },
  ])
})

/* An editor may publish nothing — that stays the owner's call — but the app is
   still theirs to unpublish and to remove. */
test('an editor may withdraw a published app without being able to publish one', () => {
  const published = { ...baseApp, visibility: 'public' as const }
  expect(appMenuItems({ ...published, controls: appControls('editor', published) })).toEqual([
    { kind: 'open-in-new-tab', url: baseApp.canonicalUrl },
    { kind: 'copy-link', url: baseApp.canonicalUrl },
    { kind: 'make-private' },
    { kind: 'custom-domains' },
    { kind: 'delete' },
  ])
  expect(appMenuItems({ ...baseApp, controls: appControls('editor', baseApp) })).toEqual([
    { kind: 'custom-domains' },
    { kind: 'delete' },
  ])
})
