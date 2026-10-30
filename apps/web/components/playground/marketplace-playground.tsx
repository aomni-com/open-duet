'use client'

import { NextIntlClientProvider, useTranslations } from 'next-intl'
import { useState } from 'react'

import type {
  Agent,
  MarketplaceListingDetail,
  MarketplaceAgentInstallRequest,
  MarketplaceAgentSubscription,
} from '@repo/contract'
import type { MarketplaceListingSummary } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import { MarketplaceListingDetailPage } from '../../spa/marketplace/detail-page'
import { MarketplaceAgentGalleryCard } from '../../spa/marketplace/gallery-card'
import { MarketplaceInstallNameDialog } from '../../spa/marketplace/install-name-dialog'
import {
  marketplaceNamedInstallRequest,
  nextMarketplaceInstanceName,
} from '../../spa/marketplace/instance-name'
import type {
  MarketplaceListingInstance,
  MarketplaceListingInstances,
} from '../../spa/marketplace/instance-projection'
import { MARKETPLACE_STATE_KINDS } from './marketplace-fixture-states'

type Locale = 'en' | 'es-419'

type MarketplaceFixtureState = {
  kind: (typeof MARKETPLACE_STATE_KINDS)[number]
  instances: MarketplaceListingInstances
  installing: boolean
}

export function MarketplaceAgentsPlayground() {
  const [locale, setLocale] = useState<Locale>('en')
  return (
    <NextIntlClientProvider
      key={locale}
      locale={locale}
      messages={locale === 'es-419' ? appEs : appEn}
      onError={() => {}}
    >
      <MarketplaceAgentsFixture locale={locale} onLocaleChange={setLocale} />
    </NextIntlClientProvider>
  )
}

function MarketplaceAgentsFixture({
  locale,
  onLocaleChange,
}: {
  locale: Locale
  onLocaleChange: (locale: Locale) => void
}) {
  const t = useTranslations('duetApp.marketplace')
  const [selection, setSelection] = useState<{
    detail: MarketplaceListingDetail
    state: MarketplaceFixtureState
  }>(() => selectedScene('update-unread'))
  const [lastRequest, setLastRequest] = useState<{
    action: 'install'
    input: MarketplaceAgentInstallRequest
  } | null>(null)

  const [pendingName, setPendingName] = useState<{
    listingId: string
    intent: 'initial' | 'additional'
    initialName: string
    collision: boolean
  } | null>(null)

  const onDetailInstall = (intent: 'initial' | 'additional') => {
    setPendingName({
      listingId: selection.detail.id,
      intent,
      initialName: '',
      collision: false,
    })
  }

  // A card install names the CARD's listing, not the selected detail's — the
  // dialog's slug placeholder must belong to the agent being installed.
  const pendingScene =
    pendingName === null
      ? null
      : GALLERY_SCENES.find(scene => scene.listing.id === pendingName.listingId)

  const install = (input: MarketplaceAgentInstallRequest) => {
    setLastRequest({ action: 'install', input })
    // Mary is the fixture's occupied instance name. Other pathless requests
    // exercise the ordinary first-install path.
    if (input.path === undefined && input.name === 'Mary') {
      setPendingName({
        listingId: input.listingId,
        intent: 'additional',
        initialName: nextMarketplaceInstanceName(input.name ?? selection.detail.agentName),
        collision: true,
      })
      return
    }
    setSelection(current => {
      return {
        detail: current.detail,
        state: state('installed', current.detail.agentName),
      }
    })
  }

  return (
    <main
      data-runtime-locale
      lang={locale}
      className="min-h-screen bg-muted/25 px-4 py-7 text-foreground sm:px-7 lg:px-10 lg:py-10"
    >
      <nav aria-label="Agent marketplace fixture controls" className="sr-only">
        {MARKETPLACE_STATE_KINDS.map(kind => (
          <button key={kind} type="button" onClick={() => setSelection(selectedScene(kind))}>
            State: {kind}
          </button>
        ))}
        <button type="button" onClick={() => onLocaleChange('en')}>
          English
        </button>
        <button type="button" onClick={() => onLocaleChange('es-419')}>
          Español
        </button>
      </nav>

      <div className="mx-auto max-w-7xl">
        <header className="mb-7 max-w-2xl">
          <h1 className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">
            {t('eyebrow')}
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
            {t('galleryDescription')}
          </p>
        </header>

        <section
          aria-label={t('sectionVerified')}
          data-testid="marketplace-verified-gallery"
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          {GALLERY_SCENES.map(scene => (
            <MarketplaceAgentGalleryCard
              key={scene.state.kind}
              listing={scene.listing}
              instances={scene.state.instances}
              installing={scene.state.installing}
              onSelect={() => setSelection({ detail: scene.detail, state: scene.state })}
              onInstall={() =>
                setPendingName({
                  listingId: scene.listing.id,
                  intent: 'initial',
                  initialName: '',
                  collision: false,
                })
              }
            />
          ))}
        </section>

        <section aria-label="Official agent detail fixture" className="mt-10">
          <MarketplaceListingDetailPage
            detail={selection.detail}
            instances={selection.state.instances}
            installing={selection.state.installing}
            onInstall={onDetailInstall}
          />
          <MarketplaceInstallNameDialog
            detail={pendingScene?.detail ?? selection.detail}
            open={pendingName !== null}
            intent={pendingName?.intent}
            initialName={pendingName?.initialName}
            collision={pendingName?.collision}
            onCancel={() => setPendingName(null)}
            onConfirm={name => {
              if (pendingName === null) return
              const request = marketplaceNamedInstallRequest(
                pendingName.intent,
                pendingName.listingId,
                name,
              )
              if (request === undefined) return
              setPendingName(null)
              install(request)
            }}
          />
        </section>

        <output data-testid="marketplace-last-request" className="sr-only">
          {lastRequest === null ? '' : JSON.stringify(lastRequest)}
        </output>
        <output
          data-testid="official-agent-fixture-state"
          data-playground-wait-for-frame
          data-playground-frame-ready="true"
          className="sr-only"
        >
          {JSON.stringify({
            locale,
            state: selection.state.kind,
            agent: selection.detail.agentName,
          })}
        </output>
      </div>
    </main>
  )
}

const DETAIL = {
  id: 'listing-research',
  publisherSlug: 'official-agents-hub',
  verifiedPublisher: true,
  agentName: 'research',
  title: 'Research',
  installs: 0,
  availability: 'available',
  apps: [],
  appNames: ['Insights Board'],
  summary:
    'Builds source-backed research briefs, compares evidence, and leaves a clear trail for review.',
  skills: ['Web research', 'Source comparison', 'Brief writing', 'Citation review'],
  tags: ['marketing', 'personal'],
  changelog:
    '### July 2026\n\n- Added a two-source verification pass before conclusions.\n- Made unresolved evidence gaps explicit in the final brief.\n\n### June 2026\n\n- Improved long-document review and citation grouping.',
} as const satisfies MarketplaceListingDetail

const FIXTURE_AGENTS = [
  {
    id: 'listing-research',
    appNames: ['Insights Board'],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'research',
    title: 'Research',
    summary: 'Turns open-ended questions into sourced research plans ready to run.',
    skills: DETAIL.skills.slice(0, 3),
    tags: ['marketing', 'personal'] as const,
    installs: 0,
    availability: 'available' as const,
  },
  {
    id: 'listing-market-watch',
    appNames: ['Insights Board', 'Scan Planner', 'Alert Feed'],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'market-watch',
    title: 'Market Watch',
    summary: 'Sets up recurring competitor scans while its first sources are prepared.',
    skills: DETAIL.skills,
    tags: ['marketing', 'personal'] as const,
    installs: 0,
    availability: 'available' as const,
  },
  {
    id: 'listing-brief-writer',
    appNames: [],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'brief-writer',
    title: 'Brief Writer',
    summary: 'Converts verified findings into concise executive briefs and decision memos.',
    skills: DETAIL.skills.slice(0, 3),
    installs: 0,
    tags: ['sales', 'marketing'] as const,
    availability: 'available' as const,
  },
  {
    id: 'listing-source-reviewer',
    appNames: ['Citation Audit'],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'source-reviewer',
    title: 'Source Reviewer',
    summary: 'Audits citations and evidence quality; its latest review improvements are ready.',
    skills: DETAIL.skills,
    installs: 0,
    tags: ['marketing', 'engineering'] as const,
    availability: 'available' as const,
  },
  {
    id: 'listing-evidence-repair',
    appNames: [],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'evidence-repair',
    title: 'Evidence Repair',
    summary: 'Restores official source checks while preserving divergent local review notes.',
    skills: DETAIL.skills.slice(0, 3),
    installs: 0,
    tags: ['engineering'] as const,
    availability: 'available' as const,
  },
  {
    id: 'listing-trend-monitor',
    appNames: ['Signal Tracker'],
    publisherSlug: 'official-agents-hub',
    verifiedPublisher: true,
    agentName: 'trend-monitor',
    title: 'Trend Monitor',
    summary: 'Tracks recurring signals and clearly surfaces sources that need another attempt.',
    skills: DETAIL.skills,
    installs: 0,
    tags: ['marketing', 'product', 'customer-support'] as const,
    availability: 'available' as const,
  },
] as const satisfies readonly MarketplaceListingSummary[]

const GALLERY_SCENES = MARKETPLACE_STATE_KINDS.map((kind, index) => ({
  listing: FIXTURE_AGENTS[index]!,
  detail: {
    ...DETAIL,
    agentName: FIXTURE_AGENTS[index]!.agentName,
    title: FIXTURE_AGENTS[index]!.title,
    summary: FIXTURE_AGENTS[index]!.summary,
    skills: [...FIXTURE_AGENTS[index]!.skills],
    tags: [...FIXTURE_AGENTS[index]!.tags],
  } satisfies MarketplaceListingDetail,
  state: state(kind, FIXTURE_AGENTS[index]!.agentName),
}))

function selectedScene(kind: (typeof MARKETPLACE_STATE_KINDS)[number]) {
  const scene = GALLERY_SCENES.find(candidate => candidate.state.kind === kind)
  if (scene === undefined) throw new Error(`Missing official-agent fixture state: ${kind}`)
  return {
    detail: scene.detail,
    state:
      kind === 'multiple' ? { ...scene.state, instances: multipleInstances(true) } : scene.state,
  }
}

function state(
  kind: (typeof MARKETPLACE_STATE_KINDS)[number],
  officialName: string,
): MarketplaceFixtureState {
  const empty = { instances: [], installedCount: 0, issueCount: 0, hasUnreadUpdate: false }
  switch (kind) {
    case 'uninstalled':
      return { kind, instances: empty, installing: false }
    case 'installing':
      return { kind, instances: empty, installing: true }
    case 'installed':
      return { kind, instances: projection([instance(officialName, 'ready')]), installing: false }
    case 'update-unread':
      return {
        kind,
        instances: {
          ...projection([
            instance(officialName, 'ready', {
              appliedEtag: 'etag-2',
              acknowledgedEtag: 'etag-1',
            }),
          ]),
          hasUnreadUpdate: true,
        },
        installing: false,
      }
    case 'error':
      return {
        kind,
        instances: projection([instance(officialName, 'needs-attention')]),
        installing: false,
      }
    case 'multiple':
      return {
        kind,
        instances: multipleInstances(false),
        installing: false,
      }
  }
}

function multipleInstances(mixedHealth: boolean): MarketplaceListingInstances {
  return {
    ...projection([
      instance('customer-portal', 'ready', {}, 'Customer Portal'),
      instance('marketing-site', mixedHealth ? 'installing' : 'ready', {}, 'Marketing Site'),
      instance('storefront', mixedHealth ? 'needs-attention' : 'ready', {}, 'Storefront'),
    ]),
    hasUnreadUpdate: mixedHealth,
  }
}

function projection(instances: MarketplaceListingInstance[]): MarketplaceListingInstances {
  return {
    instances,
    installedCount: instances.length,
    issueCount: instances.filter(candidate => candidate.health === 'needs-attention').length,
    hasUnreadUpdate: false,
  }
}

function instance(
  slug: string,
  health: MarketplaceListingInstance['health'],
  overrides: Partial<MarketplaceAgentSubscription> = {},
  displayName = slug,
): MarketplaceListingInstance {
  const row = agent(slug, displayName)
  return {
    subscription: subscription(slug, {
      state:
        health === 'installing' ? 'installing' : health === 'needs-attention' ? 'error' : 'active',
      ...overrides,
    }),
    agent: row,
    displayName,
    health,
  }
}

function agent(slug: string, name: string): Agent {
  return {
    id: `agent_${slug}`,
    workspaceId: 'workspace_acme',
    anchorId: `anchor_${slug}`,
    anchorPath: `agents/${slug}`,
    anchorState: 'active',
    slug,
    name,
    createdAt: 1,
    updatedAt: 1,
  }
}

function subscription(
  agentName: string,
  overrides: Partial<MarketplaceAgentSubscription> = {},
): MarketplaceAgentSubscription {
  return {
    id: `subscription_${agentName}`,
    agentId: `agent_${agentName}`,
    anchorId: `anchor_${agentName}`,
    listingId: `listing-${agentName}`,
    agentName,
    path: `agents/${agentName}`,
    mode: 'subscribe',
    state: 'active',
    appliedEtag: 'etag-1',
    acknowledgedEtag: 'etag-1',
    lastAppliedAt: Date.UTC(2026, 6, 22, 8),
    ...overrides,
  }
}
