import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { App } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { projectFilesRows } from './app-rows'
import { AttributionConfigProvider } from './attribution'
import { DriveBrowser, splitDriveCollection } from './drive-view'
import type { DirectoryEntry } from './lib/types'

const entries: DirectoryEntry[] = [
  { name: 'zeta-notes.md', path: '/zeta-notes.md', type: 'file', isDirectory: false, size: 120 },
  { name: 'beta', path: '/beta', type: 'directory', isDirectory: true },
  {
    name: 'reporting-dashboard',
    path: '/reporting-dashboard',
    type: 'directory',
    isDirectory: true,
  },
  { name: 'alpha', path: '/alpha', type: 'directory', isDirectory: true },
  { name: 'brief.pdf', path: '/brief.pdf', type: 'file', isDirectory: false, size: 2048 },
]

const app: App = {
  id: 'app_1',
  workspaceId: 'workspace_1',
  anchorId: 'anchor_1',
  anchorPath: 'reporting-dashboard',
  anchorState: 'active',
  name: 'Launch intelligence',
  icon: 'icon.svg',
  command: 'bun run start',
  apiScopes: [],
  port: 4173,
  slug: 'reporting',
  visibility: 'folder',
  canonicalUrl: 'https://reporting--acme.duet.so',
  runtimeStatus: 'reconciled',
  createdByUserId: 'user_1',
  createdAt: 1,
  updatedAt: 2,
  controls: {
    manageDomain: true,
    updateRuntime: true,
    makePublic: true,
    makePrivate: true,
    delete: true,
  },
}

const rows = projectFilesRows({
  entries,
  apps: [app],
})

const AUTHENTICATED = {
  mode: 'authenticated',
  onUpload: () => {},
  onCreateFolder: () => {},
  onCreateFile: () => {},
  showHidden: false,
  onToggleHidden: () => {},
} as const

function renderDrive(overrides: Partial<Parameters<typeof DriveBrowser>[0]> = {}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <DriveBrowser
        rows={rows}
        query=""
        onQueryChange={() => {}}
        path="/"
        onNavigate={() => {}}
        onOpenDocument={() => {}}
        onOpenApp={() => {}}
        workspaceSlug="acme"
        capabilities={AUTHENTICATED}
        {...overrides}
      />
    </NextIntlClientProvider>,
  )
}

test('splits rows into A-to-Z folders and documents and filters by query', () => {
  const all = splitDriveCollection(rows, '')
  expect(all.folders.map(row => row.entry.name)).toEqual(['alpha', 'beta', 'reporting-dashboard'])
  expect(all.documents.map(row => row.entry.name)).toEqual(['brief.pdf', 'zeta-notes.md'])

  const filtered = splitDriveCollection(rows, 'bet')
  expect(filtered.folders.map(row => row.entry.name)).toEqual(['beta'])
  expect(filtered.documents).toEqual([])
})

test('card-browser app markup names its status and folder chevron', () => {
  const html = renderDrive()

  // The app card itself opens the app, so its label carries the status —
  // same contract the Playwright app-target tests key on.
  expect(html).toContain('aria-label="reporting-dashboard, App is running"')
  // Entering the folder is the explicit chevron, not the card body.
  expect(html).toContain('aria-label="Open folder reporting-dashboard"')
  // A renamed app keeps its folder identity in the card meta.
  expect(html).toContain('App is running · reporting-dashboard')
})

test('card times come from the injected attribution clock, not the wall clock', () => {
  const modifiedAt = new Date('2026-07-11T08:30:00.000Z')
  const frozenNow = Date.UTC(2026, 6, 11, 9, 0)
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <AttributionConfigProvider now={() => frozenNow}>
        <DriveBrowser
          rows={[
            {
              entry: {
                name: 'beta',
                path: '/beta',
                type: 'directory',
                isDirectory: true,
                modifiedAt,
              },
            },
          ]}
          query=""
          onQueryChange={() => {}}
          path="/"
          onNavigate={() => {}}
          onOpenDocument={() => {}}
          onOpenApp={() => {}}
          workspaceSlug="acme"
          capabilities={AUTHENTICATED}
        />
      </AttributionConfigProvider>
    </NextIntlClientProvider>,
  )

  // 30 minutes between the entry's mtime and the frozen clock — the label
  // must come from the injected clock, not the drifting wall clock.
  expect(html).toContain('>30m ago<')
})

test('folder cards treat Unix-epoch mtimes as unavailable metadata', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <AttributionConfigProvider now={() => Date.UTC(2026, 6, 23)}>
        <DriveBrowser
          rows={[
            {
              entry: {
                name: 'restored-folder',
                path: '/restored-folder',
                type: 'directory',
                isDirectory: true,
                modifiedAt: new Date(0),
              },
            },
          ]}
          query=""
          onQueryChange={() => {}}
          path="/"
          onNavigate={() => {}}
          onOpenDocument={() => {}}
          onOpenApp={() => {}}
          workspaceSlug="acme"
          capabilities={AUTHENTICATED}
        />
      </AttributionConfigProvider>
    </NextIntlClientProvider>,
  )

  expect(html).toContain('>Folder<')
  expect(html).not.toContain('yr. ago')
})

test('empty authenticated card-browser markup keeps its hero and built-in actions', () => {
  const html = renderDrive({ rows: [] })

  expect(html).toContain('Drive')
  expect(html).toContain('Nothing here yet')
  // The actions are part of the drive itself, so an empty drive still
  // invites uploading and creating.
  expect(html).toContain('Upload</button>')
  expect(html).toContain('New folder</button>')
  expect(html).toContain('New file</button>')
})

test('renders the drive hero with folder cards, document tiles, and no root breadcrumb', () => {
  const html = renderDrive()

  expect(html).toContain('Drive')
  expect(html).toContain('Folders')
  expect(html).toContain('Documents')
  expect(html).toContain('alpha')
  expect(html).toContain('brief.pdf')
  expect(html).toContain('Launch intelligence')
  // At the root the hero is the identity; the breadcrumb only appears in
  // subfolders.
  expect(html).not.toContain('aria-label="Breadcrumb"')
})

test('subfolders get the in-drive breadcrumb trail with an up affordance', () => {
  const html = renderDrive({ path: '/exports/reports', rows: [] })

  expect(html).toContain('aria-label="Breadcrumb"')
  expect(html).toContain('aria-label="Go up one folder"')
  expect(html).toContain('>Drive</button>')
  expect(html).toContain('>exports</button>')
  expect(html).toContain('>reports</button>')
  // The open folder is the emphasized, aria-current crumb.
  const currentCrumb = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)].find(
    ([, , body]) => body === 'reports',
  )
  expect(currentCrumb).toBeDefined()
  expect(currentCrumb?.[1]).toContain('aria-current="location"')
})

test('authenticated mode carries the write chrome and the show-hidden toggle', () => {
  const html = renderDrive()

  expect(html).toContain('Upload</button>')
  expect(html).toContain('New folder</button>')
  expect(html).toContain('New file</button>')
  // The show-hidden affordance lives in the authenticated toolbar.
  expect(html).toContain('aria-label="Show hidden files"')
  // Row menus are supplied by the surface only in authenticated mode.
  const withMenu = renderDrive({
    capabilities: { ...AUTHENTICATED, renderMenu: () => <button>row-menu</button> },
  })
  expect(withMenu).toContain('row-menu')
})

test('public card-browser markup keeps read controls and omits write and show-hidden chrome', () => {
  const html = renderDrive({
    capabilities: { mode: 'public' },
    // A menu callback does not exist in the public contract, so even if the
    // surface tried to pass one the browser would never render it.
  })

  // The read affordances stay: search, cards, breadcrumb navigation.
  expect(html).toContain('Search this folder')
  expect(html).toContain('alpha')
  expect(html).toContain('brief.pdf')

  // None of the authenticated write/auth chrome appears.
  expect(html).not.toContain('Upload</button>')
  expect(html).not.toContain('New folder</button>')
  expect(html).not.toContain('New file</button>')
  expect(html).not.toContain('Show hidden files')
})

test('a hero override replaces the Drive heading and tagline (public publish identity)', () => {
  const html = renderDrive({
    capabilities: { mode: 'public' },
    hero: { heading: 'quarterly-reports', tagline: 'Browse this published folder.' },
  })
  expect(html).toContain('quarterly-reports')
  expect(html).toContain('Browse this published folder.')
  expect(html).not.toContain('>Drive<')
  expect(html).not.toContain('in this drive')
})

test('the breadcrumb root follows the hero heading off-root (publish never says Drive)', () => {
  const html = renderDrive({
    capabilities: { mode: 'public' },
    path: '/docs',
    hero: { heading: 'quarterly-reports', tagline: 'Browse this published folder.' },
  })
  expect(html).toContain('>quarterly-reports<')
  expect(html).not.toContain('>Drive<')
})
