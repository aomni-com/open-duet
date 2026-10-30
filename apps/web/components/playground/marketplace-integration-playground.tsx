'use client'

import { NextIntlClientProvider, useTranslations } from 'next-intl'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'

import type { App } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import type { DriveTab } from '../../spa/drive/drive-routes'
import { DRIVE_TOPBAR_CLEARANCE, DriveShell, DriveTopBar } from '../../spa/drive/drive-shell'
import { buildWorkspaceTabs } from '../../spa/drive/workspace-tabs'
import { projectFilesRows } from '../../spa/files/app-rows'
import { DriveBrowser } from '../../spa/files/drive-view'
import { MarketplaceAgentGalleryCard } from '../../spa/marketplace/gallery-card'

type Scene = 'hub' | 'drive'

export function MarketplaceAgentsIntegrationPlayground() {
  const [locale, setLocale] = useState<'en' | 'es-419'>('en')
  return (
    <NextIntlClientProvider
      key={locale}
      locale={locale}
      messages={locale === 'es-419' ? appEs : appEn}
      onError={() => {}}
    >
      <MemoryRouter initialEntries={['/w/acme/files']}>
        <MarketplaceAgentsIntegrationFixture locale={locale} onLocaleChange={setLocale} />
      </MemoryRouter>
    </NextIntlClientProvider>
  )
}

function MarketplaceAgentsIntegrationFixture({
  locale,
  onLocaleChange,
}: {
  locale: 'en' | 'es-419'
  onLocaleChange: (locale: 'en' | 'es-419') => void
}) {
  const t = useTranslations('duetApp')
  const officialT = useTranslations('duetApp.marketplace')
  const [scene, setScene] = useState<Scene>('drive')
  const [query, setQuery] = useState('')
  const activeTab: DriveTab = scene === 'hub' ? 'agents' : 'files'
  const tabs = buildWorkspaceTabs(destination => t(destination))
  return (
    <div data-runtime-locale lang={locale}>
      <nav aria-label="Official integration fixture controls" className="sr-only">
        <button type="button" onClick={() => setScene('hub')}>
          Scene: hub
        </button>
        <button type="button" onClick={() => setScene('drive')}>
          Scene: drive
        </button>
        <button type="button" onClick={() => onLocaleChange('en')}>
          English
        </button>
        <button type="button" onClick={() => onLocaleChange('es-419')}>
          Español
        </button>
      </nav>
      <DriveShell
        topBar={
          <DriveTopBar
            tabs={tabs}
            activeTab={activeTab}
            label={t('workspaceNavigation')}
            onSelectTab={tab => {
              if (tab === 'agents') setScene('hub')
              if (tab === 'files') setScene('drive')
            }}
            leftSlot={<span className="truncate text-sm font-semibold">Acme Studio</span>}
            rightSlot={<span className="text-xs text-header-foreground/65">Ada</span>}
          />
        }
      >
        <main className={`h-full overflow-auto bg-muted/15 ${DRIVE_TOPBAR_CLEARANCE}`}>
          {scene === 'hub' ? (
            <div className="mx-auto max-w-5xl px-4 py-7 sm:px-7 lg:px-10">
              <header className="mb-7 max-w-2xl">
                <h1 className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">
                  {officialT('eyebrow')}
                </h1>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {officialT('galleryDescription')}
                </p>
              </header>
              <div className="grid gap-4 sm:grid-cols-2">
                <MarketplaceAgentGalleryCard
                  listing={{
                    ...CATALOG[0],
                    skills: [...CATALOG[0].skills],
                    tags: [...CATALOG[0].tags],
                    appNames: [...CATALOG[0].appNames],
                  }}
                  instances={{
                    instances: [],
                    installedCount: 1,
                    issueCount: 0,
                    hasUnreadUpdate: true,
                  }}
                  onSelect={() => {}}
                />
                <MarketplaceAgentGalleryCard
                  listing={{
                    ...CATALOG[1],
                    skills: [...CATALOG[1].skills],
                    tags: [...CATALOG[1].tags],
                    appNames: [...CATALOG[1].appNames],
                  }}
                  instances={{
                    instances: [],
                    installedCount: 0,
                    issueCount: 0,
                    hasUnreadUpdate: false,
                  }}
                  onSelect={() => {}}
                  onInstall={() => {}}
                />
              </div>
            </div>
          ) : (
            <div data-testid="drive-files-and-apps-only">
              <DriveBrowser
                rows={DRIVE_ROWS}
                query={query}
                onQueryChange={setQuery}
                path="/"
                onNavigate={() => {}}
                onOpenDocument={() => {}}
                onOpenApp={() => {}}
                workspaceSlug="acme"
                capabilities={{
                  mode: 'authenticated',
                  onUpload: () => {},
                  onCreateFolder: () => {},
                  onCreateFile: () => {},
                  showHidden: false,
                  onToggleHidden: () => {},
                }}
              />
            </div>
          )}
          <output
            data-playground-wait-for-frame
            data-playground-frame-ready="true"
            className="sr-only"
          >
            {scene}:{locale}
          </output>
        </main>
      </DriveShell>
    </div>
  )
}

const CATALOG = [
  {
    id: 'listing-research',
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'research',
    title: 'Research',
    summary: 'Builds source-backed research briefs with a clear review trail.',
    skills: ['Web research', 'Source comparison'],
    tags: ['marketing', 'personal'] as const,
    appNames: ['Insights Board'] as const,
    installs: 0,
    availability: 'available' as const,
  },
  {
    id: 'listing-brief-writer',
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'brief-writer',
    title: 'Brief Writer',
    summary: 'Turns verified findings into concise decision-ready briefs.',
    skills: ['Brief writing'],
    tags: ['sales'] as const,
    appNames: [] as string[],
    installs: 0,
    availability: 'available' as const,
  },
] as const

const APP: App = {
  id: 'app-launch-control',
  workspaceId: 'workspace-acme',
  anchorId: 'anchor-launch-control',
  anchorPath: 'launch-control',
  anchorState: 'active',
  name: 'Launch Control',
  command: 'bun run start',
  apiScopes: [],
  port: 4173,
  slug: 'launch-control',
  visibility: 'folder',
  canonicalUrl: 'https://launch-control--acme.duet.so',
  runtimeStatus: 'reconciled',
  createdByUserId: 'user-ada',
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

const DRIVE_ROWS = projectFilesRows({
  entries: [
    {
      name: 'launch-control',
      path: '/launch-control',
      type: 'directory',
      isDirectory: true,
      modifiedAt: new Date('2026-07-11T08:30:00.000Z'),
    },
    {
      name: 'Briefs',
      path: '/Briefs',
      type: 'directory',
      isDirectory: true,
      modifiedAt: new Date('2026-07-11T08:30:00.000Z'),
    },
    {
      name: 'roadmap.md',
      path: '/roadmap.md',
      type: 'file',
      isDirectory: false,
      size: 2048,
      modifiedAt: new Date('2026-07-11T08:30:00.000Z'),
    },
  ],
  apps: [APP],
})
