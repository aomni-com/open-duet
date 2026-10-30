'use client'

import {
  AppWindow,
  ArrowLeft,
  CaretRight,
  CheckCircle,
  DownloadSimple,
  SpinnerGap,
  WarningCircle,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'

import type { MarketplaceListingDetail } from '@repo/contract'
import { Markdown } from '@repo/ui/components/common/markdown'
import { Button } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar } from '../agents/agent-avatar'
import type { MarketplaceListingInstance, MarketplaceListingInstances } from './instance-projection'
import { VerifiedPublisherBadge } from './verified-publisher-badge'

export type MarketplaceListingDetailPageProps = {
  detail: MarketplaceListingDetail
  instances: MarketplaceListingInstances
  installing?: boolean
  canInstall?: boolean
  onBack?: () => void
  onInstall: (intent: 'initial' | 'additional') => void
  onOpenAgent?: (instance: MarketplaceListingInstance) => void
}

export function MarketplaceListingDetailPage({
  detail,
  instances,
  installing = false,
  canInstall = true,
  onBack,
  onInstall,
  onOpenAgent,
}: MarketplaceListingDetailPageProps) {
  const t = useTranslations('duetApp.marketplace')
  // "Degrade loudly" (map decision 7): an unavailable origin is stated and the
  // install disabled here; the mutation refuses independently, so the button is
  // presentation and never the gate.
  const unavailable = detail.availability === 'unavailable'
  const subscribed = instances.installedCount > 0
  const unread = instances.issueCount === 0 && instances.hasUnreadUpdate

  return (
    <article
      data-marketplace-detail
      data-marketplace-state={
        installing
          ? 'installing'
          : instances.issueCount > 0
            ? 'issues'
            : subscribed
              ? 'installed'
              : 'uninstalled'
      }
      data-listing-availability={detail.availability}
      className="overflow-hidden rounded-3xl border border-border/70 bg-background shadow-sm"
    >
      <header className="border-b border-border/60 bg-gradient-to-br from-brand/[0.08] via-background to-background px-5 py-6 sm:px-8 sm:py-8">
        {onBack ? (
          <Button type="button" variant="ghost" size="sm" className="mb-5 -ml-2" onClick={onBack}>
            <ArrowLeft aria-hidden className="mr-1.5" size={15} />
            {t('backToGallery')}
          </Button>
        ) : null}
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-4">
            <AgentAvatar
              avatarKey={detail.agentName}
              className="size-14 border border-white/45 shadow-[0_9px_20px_-12px_hsl(var(--brand)/0.8)] ring-1 ring-brand/15"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                  {detail.title}
                </h1>
                {detail.verifiedPublisher ? (
                  <VerifiedPublisherBadge label={t('official')} className="h-6 px-2 text-[11px]" />
                ) : (
                  <span
                    data-testid="marketplace-detail-publisher"
                    className="text-xs text-muted-foreground"
                  >
                    {t('byPublisher', { publisher: detail.publisherSlug })} ·{' '}
                    {t('unverifiedNotice')}
                  </span>
                )}
                {unread ? (
                  <span
                    data-testid="marketplace-update-badge"
                    className="rounded-full bg-brand px-2 py-1 text-[11px] font-semibold text-brand-foreground"
                  >
                    {t('newUpdate')}
                  </span>
                ) : null}
              </div>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                {detail.summary}
              </p>
            </div>
          </div>
          <div className="ml-[4.5rem] flex shrink-0 flex-wrap gap-2 sm:ml-0 sm:justify-end">
            {canInstall ? (
              <Button
                data-testid="marketplace-install"
                type="button"
                variant={subscribed ? 'outline' : 'default'}
                disabled={installing || unavailable}
                onClick={() => onInstall(subscribed ? 'additional' : 'initial')}
              >
                {installing ? (
                  <SpinnerGap aria-hidden className="mr-2 animate-spin" size={16} />
                ) : (
                  <DownloadSimple aria-hidden className="mr-2" size={16} />
                )}
                {subscribed ? t('addAnother') : t('install')}
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {unavailable ? (
        <div
          data-testid="marketplace-unavailable-notice"
          className="border-b border-border/60 bg-amber-500/10 px-5 py-3 text-sm text-amber-800 sm:px-8"
        >
          {t('noticeUnavailable')}
        </div>
      ) : null}
      {instances.installedCount > 0 ? (
        <section
          aria-labelledby="marketplace-installed-agents"
          className="border-b border-border/60 px-5 py-5 sm:px-8"
        >
          <h2 id="marketplace-installed-agents" className="text-sm font-semibold text-foreground">
            {t('installedAgents')}
          </h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {instances.instances.map(instance => {
              const content = (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {instance.displayName}
                    </span>
                    <span
                      className={cn(
                        'mt-0.5 flex items-center gap-1.5 text-xs',
                        instanceHealthTone(instance.health),
                      )}
                    >
                      <InstanceHealthIcon health={instance.health} />
                      {t(
                        instance.health === 'installing'
                          ? 'instanceInstalling'
                          : instance.health === 'needs-attention'
                            ? 'instanceNeedsAttention'
                            : 'instanceReady',
                      )}
                    </span>
                  </span>
                  {instance.agent !== undefined && onOpenAgent !== undefined ? (
                    <CaretRight aria-hidden size={15} className="shrink-0 text-muted-foreground" />
                  ) : null}
                </>
              )
              return (
                <li key={instance.subscription.id}>
                  {instance.agent !== undefined && onOpenAgent !== undefined ? (
                    <button
                      type="button"
                      data-testid="marketplace-instance-link"
                      data-agent-slug={instance.agent.slug}
                      className="flex w-full items-center gap-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpenAgent(instance)}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-2.5">
                      {content}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-8 px-5 py-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-12">
        <section aria-labelledby="marketplace-whats-new">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">
            {t('releaseNotes')}
          </p>
          <h2 id="marketplace-whats-new" className="mt-1 text-xl font-semibold text-foreground">
            {t('whatsNew')}
          </h2>
          <Markdown className="mt-5 text-sm leading-6">{detail.changelog}</Markdown>
        </section>
        <aside className="space-y-7">
          {/* Apps come first: they are what the installer actually gets to
              open. The block earns its space only when there are apps — an
              empty "Included apps" would read as a defect. */}
          {detail.appNames.length > 0 ? (
            <section aria-labelledby="marketplace-apps">
              <h2 id="marketplace-apps" className="text-sm font-semibold text-foreground">
                {t('apps')}
              </h2>
              <ul aria-label={t('apps')} className="mt-3 flex flex-wrap gap-2 lg:flex-col">
                {detail.appNames.map(app => (
                  <li
                    key={app}
                    className="flex items-center gap-2 rounded-xl border border-brand/25 bg-brand/[0.06] px-3 py-2 text-sm text-foreground"
                  >
                    <AppWindow aria-hidden size={15} className="shrink-0 text-brand" />
                    {app}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="marketplace-skills">
            <h2 id="marketplace-skills" className="text-sm font-semibold text-foreground">
              {t('skills')}
            </h2>
            <ul aria-label={t('skills')} className="mt-3 flex flex-wrap gap-2 lg:flex-col">
              {detail.skills.map(skill => (
                <li
                  key={skill}
                  className="rounded-xl border border-border/70 bg-muted/35 px-3 py-2 text-sm text-foreground"
                >
                  {skill}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </article>
  )
}

function instanceHealthTone(health: MarketplaceListingInstance['health']): string {
  if (health === 'needs-attention') return 'text-destructive'
  if (health === 'installing') return 'text-brand'
  return 'text-emerald-700'
}

function InstanceHealthIcon({ health }: { health: MarketplaceListingInstance['health'] }) {
  if (health === 'installing')
    return <SpinnerGap aria-hidden size={13} className="shrink-0 animate-spin text-brand" />
  if (health === 'needs-attention')
    return <WarningCircle aria-hidden size={13} className="shrink-0 text-destructive" />
  return <CheckCircle aria-hidden size={13} weight="fill" className="shrink-0 text-emerald-600" />
}
