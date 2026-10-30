'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { filterDriveEntries, type ViewerDescriptor } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import type { FilesRow } from '../../spa/files/app-rows'
import { AttributionConfigProvider } from '../../spa/files/attribution'
import { DriveBrowser } from '../../spa/files/drive-view'
import { MockFileSystemProvider } from '../../spa/files/lib/mock-provider'
import type { DirectoryEntry } from '../../spa/files/lib/types'
import { PreviewPane } from '../../spa/files/preview-pane'
import { READONLY_SOURCE_PREVIEW_MODE } from '../../spa/files/preview-presentation'
import type { PublishViewerState } from '../../spa/publish/publish-viewer-controller'
import { PublishBanner, PublishViewerShell } from '../../spa/publish/publish-viewer-shell'
import { MEDIA_PNG_BASE64 } from './publish-media-fixture'

// Frozen clock so "edited …" labels never drift between screenshot runs.
const FIXTURE_NOW = Date.UTC(2026, 6, 11, 9, 0)
const MODIFIED_AT = new Date('2026-07-11T08:30:00.000Z')

function entry(name: string, over: Partial<DirectoryEntry> = {}): DirectoryEntry {
  const projected = {
    name,
    path: `/${name}`,
    size: 1024,
    modifiedAt: MODIFIED_AT,
  }
  return over.type === 'directory'
    ? { ...projected, ...over, type: 'directory', isDirectory: true }
    : { ...projected, ...over, type: over.type ?? 'file', isDirectory: false }
}

function rows(entries: DirectoryEntry[]): FilesRow[] {
  return entries.map(value => ({ kind: 'entry', entry: value }))
}

// A published folder as it appears to an anonymous visitor: ordinary source
// files and one subfolder, no apps, no dotfiles.
const PUBLIC_ENTRIES: DirectoryEntry[] = [
  entry('docs', { type: 'directory', isDirectory: true, size: 0 }),
  entry('index.html', { size: 640 }),
  entry('style.css', { size: 320 }),
  entry('logo.svg', { size: 512 }),
  entry('brief.pdf', { size: 2048 }),
]

// The same folder plus the dotfiles the authenticated Drive can reveal.
const ENTRIES_WITH_HIDDEN: DirectoryEntry[] = [
  entry('.duet-anchor', { size: 48 }),
  entry('.env', { size: 96 }),
  entry('.notes', { size: 120 }),
  ...PUBLIC_ENTRIES,
]

function Frame({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <AttributionConfigProvider now={() => FIXTURE_NOW}>
        <div className="bg-background p-6">{children}</div>
      </AttributionConfigProvider>
    </NextIntlClientProvider>
  )
}

function Column({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="overflow-hidden rounded-2xl border bg-card">{children}</div>
    </div>
  )
}

const COMMON = {
  query: '',
  onQueryChange: () => {},
  path: '/',
  onNavigate: () => {},
  onOpenDocument: () => {},
  onOpenApp: () => {},
  workspaceSlug: 'acme',
} as const

/**
 * Slice 07 — the one `DriveBrowser` renders both surfaces. Left: the
 * authenticated Drive with its full write/auth toolbar (upload, create,
 * show-hidden). Right: the public read-only viewer of the same folder, with
 * none of that chrome. The diff between the two columns is exactly the omitted
 * write/auth controls.
 */
export function PublishBrowserPlayground() {
  return (
    <Frame>
      <div className="flex flex-col gap-6 lg:flex-row">
        <Column label="Authenticated Drive">
          <DriveBrowser
            {...COMMON}
            rows={rows(PUBLIC_ENTRIES)}
            capabilities={{
              mode: 'authenticated',
              onUpload: () => {},
              onCreateFolder: () => {},
              onCreateFile: () => {},
              showHidden: false,
              onToggleHidden: () => {},
            }}
          />
        </Column>
        <Column label="Public viewer (read-only)">
          <DriveBrowser {...COMMON} rows={rows(PUBLIC_ENTRIES)} capabilities={{ mode: 'public' }} />
        </Column>
      </div>
    </Frame>
  )
}

/**
 * Slice 03 — the authenticated Drive's show-hidden toggle. Left is the default
 * (hidden-off): dotfiles are filtered out. Right is the toggle revealed: the
 * same folder now lists `.duet-anchor`, `.env`, `.notes`. The public viewer
 * offers the same vocabulary from its banner toggle (its serving floor never
 * reaches the client at all).
 */
export function ShowHiddenTogglePlayground() {
  const hiddenOff = filterDriveEntries(ENTRIES_WITH_HIDDEN, 'exclude')
  const hiddenOn = filterDriveEntries(ENTRIES_WITH_HIDDEN, 'include')
  return (
    <Frame>
      <div className="flex flex-col gap-6 lg:flex-row">
        <Column label="Default — hidden off">
          <DriveBrowser
            {...COMMON}
            rows={rows(hiddenOff)}
            capabilities={{
              mode: 'authenticated',
              onUpload: () => {},
              onCreateFolder: () => {},
              onCreateFile: () => {},
              showHidden: false,
              onToggleHidden: () => {},
            }}
          />
        </Column>
        <Column label="Toggled — hidden revealed">
          <DriveBrowser
            {...COMMON}
            rows={rows(hiddenOn)}
            capabilities={{
              mode: 'authenticated',
              onUpload: () => {},
              onCreateFolder: () => {},
              onCreateFile: () => {},
              showHidden: true,
              onToggleHidden: () => {},
            }}
          />
        </Column>
      </div>
    </Frame>
  )
}

const MARKDOWN_ENTRY = entry('README.md', { size: 180 })
const SVG_ENTRY = entry('logo.svg', { size: 260 })

/**
 * Slice 07 — the read-only/source `PreviewPane`. Markdown and SVG are shown as
 * their raw source (never a rendered page — that would be the script-in-SVG
 * hole). No Save, no history, no seen-by: the mode suppresses every
 * write/attribution affordance; only Download remains. (Media still routes to
 * its viewer in this mode — that path is pinned by the preview-presentation
 * unit test and by the media glyphs in the publish-browser fixture; an opened
 * image is not screenshot here because its async decode is non-deterministic
 * in the static harness.)
 */
export function PublishPreviewPlayground() {
  const provider = useMemo(() => {
    const mock = new MockFileSystemProvider()
    mock.seed([
      {
        path: '/README.md',
        data: '# Duet\n\nPublished **source**, shown verbatim — not rendered as a page.\n',
        contentType: 'text/markdown',
      },
      {
        path: '/logo.svg',
        data: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" rx="8" fill="#0f172a"/><circle cx="30" cy="30" r="14" fill="#38bdf8"/></svg>',
        contentType: 'image/svg+xml',
      },
    ])
    return mock
  }, [])

  return (
    <Frame>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {[
          { label: 'Markdown → source', entry: MARKDOWN_ENTRY },
          { label: 'SVG → source', entry: SVG_ENTRY },
        ].map(item => (
          <Column key={item.entry.path} label={item.label}>
            <PreviewPane
              entry={item.entry}
              provider={provider}
              workspaceSlug="acme"
              mode={READONLY_SOURCE_PREVIEW_MODE}
              live={{ enabled: false }}
            />
          </Column>
        ))}
      </div>
    </Frame>
  )
}

// ── Slice 09: the composed public viewer chrome ──────────────────────────────
//
// These fixtures render the production `PublishViewerShell` — banner + layout +
// the bare read-only surface — in each settled state the route can present, so
// the whole viewer gallery is reviewable at desktop and mobile widths.

const FOLDER_DESCRIPTOR: ViewerDescriptor = {
  workspaceName: 'Acme Studio',
  ownerName: 'Ada Lovelace',
  rootName: 'marketing-site',
  kind: 'folder',
}

const FILE_DESCRIPTOR: ViewerDescriptor = {
  workspaceName: 'Acme Studio',
  ownerName: 'Ada Lovelace',
  rootName: 'annual-report.md',
  kind: 'file',
}

/**
 * A full-bleed frame for the composed-shell fixtures: it supplies the same
 * `NextIntlClientProvider` + frozen `AttributionConfigProvider` as `Frame`, but
 * no padding, so the shell's `min-h-[100dvh]` banner-over-surface layout reads
 * exactly as the route renders it.
 */
function ShellFrame({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <AttributionConfigProvider now={() => FIXTURE_NOW}>{children}</AttributionConfigProvider>
    </NextIntlClientProvider>
  )
}

/**
 * A static render of the production `PublishViewerShell` at a fixed state — the
 * folder/preview surfaces and every callback are inert so the shot is hermetic.
 */
function StaticShell({
  descriptor,
  state,
  provider = null,
}: {
  descriptor: ViewerDescriptor
  state: PublishViewerState
  provider?: MockFileSystemProvider | null
}) {
  return (
    <ShellFrame>
      <PublishViewerShell
        descriptor={descriptor}
        state={state}
        query=""
        onQueryChange={() => {}}
        onNavigate={() => {}}
        onRetry={() => {}}
        provider={provider}
        workspaceSlug="acme"
        // Deterministic same-shape URL the production provider would build;
        // the anchor is inert in a static shot.
        archiveUrl={path => `https://edge.duet.so/acme/q2${path === '/' ? '' : path}?zip`}
      />
    </ShellFrame>
  )
}

/**
 * The identity banner on its own, so its hierarchy and truncation are reviewable
 * as a crop: the short case, a long workspace+owner case that must truncate
 * without overflow, and the same banner in dark theme.
 */
export function PublishViewerBannerPlayground() {
  const longNames: ViewerDescriptor = {
    workspaceName: 'Northwind Trading & Logistics Cooperative of Greater Metropolitan Area',
    ownerName: 'Alexandria Bartholomew-Fitzgerald',
    rootName: 'quarterly-investor-update',
    kind: 'folder',
  }
  return (
    <ShellFrame>
      <div className="flex flex-col gap-4 bg-muted/40 p-6">
        <div className="overflow-hidden rounded-xl border border-border bg-background">
          <PublishBanner descriptor={FOLDER_DESCRIPTOR} />
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-background">
          <PublishBanner descriptor={longNames} />
        </div>
        <div className="dark overflow-hidden rounded-xl border border-border bg-background">
          <PublishBanner descriptor={FOLDER_DESCRIPTOR} />
        </div>
      </div>
    </ShellFrame>
  )
}

/** Folder publish at its root: banner over the bare read-only Drive browser. */
export function PublishViewerFolderRootPlayground() {
  return (
    <StaticShell
      descriptor={FOLDER_DESCRIPTOR}
      state={{ status: 'folder', path: '/', entries: PUBLIC_ENTRIES }}
    />
  )
}

/**
 * A deep folder: the publish-scoped breadcrumb roots at the publish (never above
 * it), and long segment + file names truncate rather than overflow.
 */
export function PublishViewerDeepFolderPlayground() {
  const deepEntries: DirectoryEntry[] = [
    entry('a-remarkably-long-document-filename-that-should-truncate-cleanly.md', { size: 4096 }),
    entry('hero-illustration-final-v3-approved.png', { size: 81920 }),
    entry('notes', { type: 'directory', isDirectory: true, size: 0 }),
  ]
  return (
    <StaticShell
      descriptor={FOLDER_DESCRIPTOR}
      state={{
        status: 'folder',
        path: '/campaigns/2026-spring-brand-refresh/creative-assets',
        entries: deepEntries,
      }}
    />
  )
}

function seededProvider(
  seed: Array<{ path: string; data: Uint8Array | string; contentType?: string }>,
): MockFileSystemProvider {
  const mock = new MockFileSystemProvider()
  mock.seed(seed)
  return mock
}

/** A text-like file (HTML) opened as verbatim source — never rendered as a page. */
export function PublishViewerTextSourcePlayground() {
  const provider = useMemo(
    () =>
      seededProvider([
        {
          path: '/index.html',
          data: '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>Acme — Marketing Site</title>\n    <link rel="stylesheet" href="style.css" />\n  </head>\n  <body>\n    <h1>Welcome to Acme</h1>\n    <p>Published source, shown as text — not executed.</p>\n  </body>\n</html>\n',
          contentType: 'text/html',
        },
      ]),
    [],
  )
  return (
    <StaticShell
      descriptor={FOLDER_DESCRIPTOR}
      provider={provider}
      state={{ status: 'file', path: '/index.html', entry: entry('index.html', { size: 320 }) }}
    />
  )
}

/** An SVG opened as source (the script-in-SVG hole stays closed for publish). */
export function PublishViewerSvgSourcePlayground() {
  const provider = useMemo(
    () =>
      seededProvider([
        {
          path: '/logo.svg',
          data: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">\n  <rect width="120" height="60" rx="8" fill="#0f172a" />\n  <circle cx="30" cy="30" r="14" fill="#38bdf8" />\n</svg>\n',
          contentType: 'image/svg+xml',
        },
      ]),
    [],
  )
  return (
    <StaticShell
      descriptor={FOLDER_DESCRIPTOR}
      provider={provider}
      state={{ status: 'file', path: '/logo.svg', entry: entry('logo.svg', { size: 220 }) }}
    />
  )
}

/**
 * Holds the playground's ready signal until every `<img>` the child actually
 * rendered has finished decoding. The media viewer paints its image `opacity-0`
 * until the browser fires `onLoad`, so without this gate the shot races and
 * captures the "Opening file…" spinner instead of the sized image (the
 * non-determinism slice 07 flagged for opened raster media). Watching the real
 * rendered element — not a preload — guarantees the viewer's own `onLoad` has
 * fired before the frame is deemed ready.
 */
function ImageDecodeGate({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let frame = 0
    const poll = () => {
      const images = Array.from(containerRef.current?.querySelectorAll('img') ?? [])
      if (images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)) {
        setReady(true)
        return
      }
      frame = requestAnimationFrame(poll)
    }
    frame = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div
      ref={containerRef}
      data-playground-wait-for-frame
      data-playground-frame-ready={ready ? 'true' : 'false'}
      className="contents"
    >
      {children}
    </div>
  )
}

/**
 * A mock provider whose `downloadUrl` hands the media viewer a blob URL rather
 * than a data URI. A data URI can be `complete` the instant it is assigned, so
 * the viewer's `<img onLoad>` may never fire and the image stays hidden behind
 * its spinner; a blob URL always loads asynchronously, firing `onLoad` so the
 * decoded image actually paints.
 */
class MediaBlobProvider extends MockFileSystemProvider {
  blobUrl = ''
  override downloadUrl(): string {
    return this.blobUrl
  }
}

/** A raster image routes to the media viewer even in read-only mode. */
export function PublishViewerMediaPlayground() {
  const provider = useMemo(() => {
    const bytes = Uint8Array.from(atob(MEDIA_PNG_BASE64), character => character.charCodeAt(0))
    const mock = new MediaBlobProvider()
    mock.seed([{ path: '/hero.png', data: bytes, contentType: 'image/png' }])
    mock.blobUrl =
      typeof window === 'undefined'
        ? ''
        : URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
    return mock
  }, [])
  return (
    <ImageDecodeGate>
      <StaticShell
        descriptor={FOLDER_DESCRIPTOR}
        provider={provider}
        state={{ status: 'file', path: '/hero.png', entry: entry('hero.png', { size: 4096 }) }}
      />
    </ImageDecodeGate>
  )
}

/** A single-file publish opens its preview stack directly — no folder chrome. */
export function PublishViewerSingleFilePlayground() {
  const provider = useMemo(
    () =>
      seededProvider([
        {
          path: '/annual-report.md',
          data: '# Annual Report 2026\n\nA single published file opens straight into its viewer.\n\n- Revenue: up and to the right\n- Headcount: growing\n',
          contentType: 'text/markdown',
        },
      ]),
    [],
  )
  return (
    <StaticShell
      descriptor={FILE_DESCRIPTOR}
      provider={provider}
      state={{
        status: 'file',
        path: '/annual-report.md',
        entry: entry('annual-report.md', { size: 180 }),
      }}
    />
  )
}

/** An empty published folder: the calm empty state, still under the banner. */
export function PublishViewerEmptyFolderPlayground() {
  return (
    <StaticShell
      descriptor={FOLDER_DESCRIPTOR}
      state={{ status: 'folder', path: '/', entries: [] }}
    />
  )
}

/** The transient loading notice (spinner stilled under reduced motion). */
export function PublishViewerLoadingPlayground() {
  return <StaticShell descriptor={FOLDER_DESCRIPTOR} state={{ status: 'loading' }} />
}

/** A path that does not resolve to a published entry. */
export function PublishViewerNotFoundPlayground() {
  return (
    <StaticShell descriptor={FOLDER_DESCRIPTOR} state={{ status: 'not-found', path: '/missing' }} />
  )
}

/** A transient fetch failure: a friendly message plus a Retry affordance. */
export function PublishViewerErrorPlayground() {
  return (
    <StaticShell
      descriptor={FOLDER_DESCRIPTOR}
      state={{ status: 'error', path: '/', message: 'request_failed' }}
    />
  )
}
