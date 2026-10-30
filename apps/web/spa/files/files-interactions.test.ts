import { expect, test } from 'bun:test'

import type { App } from '@repo/contract'

import type { FilesRow } from './app-rows'
import { activateFilesRow } from './files-interactions'

const app: App = {
  id: 'app_hello',
  workspaceId: 'workspace_acme',
  anchorId: 'anchor_hello',
  anchorPath: 'hello',
  anchorState: 'active',
  command: 'bun run start',
  apiScopes: [],
  port: 41000,
  slug: 'hello',
  visibility: 'folder',
  canonicalUrl: 'https://hello--acme.edge.duet.so/',
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
}

// A running app used to leave the product for its public URL, which a private
// app's viewer is never allowed to reach. Every app now opens in its own route.
test('a running app row hands its app to host navigation', () => {
  const calls: string[] = []
  const row = {
    entry: { name: 'hello', path: '/hello', type: 'directory', isDirectory: true },
    app: {
      app,
      displayName: 'hello',
      status: 'reconciled',
    },
  } satisfies FilesRow

  activateFilesRow(row, {
    navigator: { openApp: app => calls.push(`app:${app.slug}`) },
    openEntry: entry => calls.push(`entry:${entry.path}`),
  })

  expect(calls).toEqual(['app:hello'])
})

test('plain file rows retain the existing file-entry activation', () => {
  const calls: string[] = []
  const row = {
    entry: { name: 'readme.md', path: '/readme.md', type: 'file', isDirectory: false },
  } satisfies FilesRow

  activateFilesRow(row, {
    navigator: { openApp: app => calls.push(`app:${app.slug}`) },
    openEntry: entry => calls.push(`entry:${entry.path}`),
  })

  expect(calls).toEqual(['entry:/readme.md'])
})
