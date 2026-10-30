import { describe, expect, test } from 'bun:test'

import type { App } from '@repo/contract'

import type { AppDisplayStatus } from '../status/entity-status'
import { projectFilesRows } from './app-rows'
import type { DirectoryEntry } from './lib/types'

const baseApp: App = {
  id: 'app-1',
  workspaceId: 'workspace-1',
  anchorId: 'anchor-1',
  anchorPath: 'projects/reporting',
  anchorState: 'active',
  command: 'bun run start',
  apiScopes: [],
  port: 41000,
  slug: 'reporting',
  visibility: 'folder',
  canonicalUrl: 'https://reporting--acme.edge.duet.so/',
  runtimeStatus: 'reconciled',
  createdByUserId: 'user-1',
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

function app(overrides: Partial<App> = {}): App {
  return { ...baseApp, ...overrides }
}

function entry(path: string, isDirectory = true): DirectoryEntry {
  const projected = {
    name: path.split('/').at(-1)!,
    path,
  }
  return isDirectory
    ? { ...projected, type: 'directory', isDirectory: true }
    : { ...projected, type: 'file', isDirectory: false }
}

describe('projectFilesRows', () => {
  test('projects the custom display name without replacing the directory entry name', () => {
    const folder = entry('/projects/reporting')
    const [row] = projectFilesRows({
      entries: [folder],
      apps: [app({ name: 'Quarterly reporting' })],
    })

    expect(row).toMatchObject({
      entry: { name: 'reporting', path: '/projects/reporting' },
      app: { displayName: 'Quarterly reporting' },
    })
  })

  test('adapts browser paths and decorates only the exact anchor entry', () => {
    const exact = entry('/projects/reporting')
    const ancestor = entry('/projects')
    const descendant = entry('/projects/reporting/archive')

    expect(
      projectFilesRows({
        entries: [ancestor, exact, descendant],
        apps: [app()],
      }),
    ).toEqual([
      { entry: ancestor },
      {
        entry: exact,
        app: {
          app: baseApp,
          displayName: 'reporting',
          status: 'reconciled',
        },
      },
      { entry: descendant },
    ])
  })

  test('keeps literal percent entry identities exact', () => {
    const percentFile = entry('/100%.pdf', false)

    expect(projectFilesRows({ entries: [percentFile], apps: [] })).toEqual([{ entry: percentFile }])
  })

  // The listing IS the row set. An app whose folder is not in the listing
  // contributes no row of its own — it used to synthesize a "phantom" row so a
  // permanently stranded app stayed reachable, but the anchor rail now reaps a
  // row whose folder stays gone, so the two converge without the drive
  // inventing anything.
  test('an app with no entry in the listing contributes no row', () => {
    const broken = app({ anchorPath: 'projects/missing', anchorState: 'broken' })

    expect(projectFilesRows({ entries: [], apps: [broken] })).toEqual([])
  })

  test('an existing broken folder is still decorated, and a file at the path is not', () => {
    const broken = app({ anchorState: 'broken' })
    const folder = entry('/projects/reporting', true)

    expect(projectFilesRows({ entries: [folder], apps: [broken] })).toEqual([
      {
        entry: folder,
        app: {
          app: broken,
          displayName: 'reporting',
          status: 'broken',
          pill: 'broken',
          pillClass: 'bg-destructive/10 text-destructive',
        },
      },
    ])

    const file = entry('/projects/reporting', false)
    expect(projectFilesRows({ entries: [file], apps: [broken] })).toEqual([{ entry: file }])
  })

  test('keeps the listing order it was given', () => {
    const rows = projectFilesRows({
      entries: [entry('/projects/z-real'), entry('/projects/alpha'), entry('/projects/beta')],
      apps: [],
    })

    expect(rows.map(row => row.entry.name)).toEqual(['z-real', 'alpha', 'beta'])
  })

  test('projects the shared status for every app state and preserves its app identity', () => {
    const cases: Array<{ overrides: Partial<App>; status: AppDisplayStatus }> = [
      { overrides: {}, status: 'reconciled' },
      { overrides: { runtimeStatus: 'reconciling' }, status: 'reconciling' },
      { overrides: { runtimeStatus: 'reconcile_failed' }, status: 'failed' },
      { overrides: { anchorState: 'broken' }, status: 'broken' },
      { overrides: { disabledAt: 1 }, status: 'disabled' },
    ]

    for (const testCase of cases) {
      const row = projectFilesRows({
        entries: [entry('/projects/reporting')],
        apps: [app(testCase.overrides)],
      })[0]

      expect(row?.app?.status).toBe(testCase.status)
      /* The row carries the app, not a URL: where an app opens is the host's to
         decide, because it needs the agent roster to know whose app it is. */
      expect(row?.app?.app.slug).toBe('reporting')
    }
  })
})
