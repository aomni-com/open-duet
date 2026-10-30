'use client'

import {
  AppWindow,
  CheckCircle,
  DownloadSimple,
  Sparkle,
  SpinnerGap,
  WarningCircle,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'

import type { MarketplaceListingSummary } from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { AgentAvatar } from '../agents/agent-avatar'
import type { MarketplaceListingInstances } from './instance-projection'
import { VerifiedPublisherBadge } from './verified-publisher-badge'

export type MarketplaceAgentGalleryCardProps = {
  listing: MarketplaceListingSummary
  instances: MarketplaceListingInstances
  installing?: boolean
  onSelect?: () => void
  /**
   * Starts the install flow for this listing. Rendered as a real Install
   * button in the card's foot while the listing is uninstalled and available —
   * every other state keeps its status line, because installing/installed/
   * unavailable are facts, not actions.
   */
  onInstall?: () => void
  selection?: {
    selected: boolean
    label: string
    onToggle: () => void
  }
  /**
   * A one-line personalized pitch (onboarding's "picked for you" rail). The
   * slot is rendering-neutral when absent — the marketplace surface shares
   * this card and must not change by a pixel without a reason.
   */
  reason?: string
  /**
   * Compact picker mode: name, description, and (when present) the reason —
   * the three things that answer "what is this and why me?". Skills, install
   * status, and the tall minimum height are browsing affordances; in a picker
   * they only push the next card off the fold. The marketplace's own browsing
   * grid keeps the full card.
   */
  compact?: boolean
}

export function MarketplaceAgentGalleryCard({
  listing,
  instances,
  installing = false,
  onSelect,
  onInstall,
  selection,
  reason,
  compact = false,
}: MarketplaceAgentGalleryCardProps) {
  const t = useTranslations('duetApp.marketplace')
  const unread = instances.issueCount === 0 && instances.hasUnreadUpdate
  // "Degrade loudly": an unavailable origin is stated on the card and the
  // install is refused server-side too, so the two can never disagree.
  const unavailable = listing.availability === 'unavailable'
  const status = galleryStatus(instances, { installing, unavailable })
  const StatusIcon = status.icon
  const displayName = listing.title
  // ONE chip list, apps first: apps are what the installer actually gets to
  // open, so they are never the ones a cap cuts. A single trailing counter
  // covers the combined remainder — two per-row "+n more" labels wrapped
  // ambiguously between the rows and read as belonging to the wrong one.
  const chips: { kind: 'app' | 'skill'; label: string }[] = [
    ...listing.appNames.map(label => ({ kind: 'app' as const, label })),
    ...listing.skills.map(skill => ({
      kind: 'skill' as const,
      label: marketplaceSlugLabel(skill),
    })),
  ]
  const visibleChips = chips.slice(0, 4)
  const hiddenChipCount = chips.length - visibleChips.length

  return (
    <article
      data-marketplace-state={status.kind}
      data-listing-availability={listing.availability}
      data-selected={selection?.selected || undefined}
      role={selection ? 'checkbox' : undefined}
      aria-checked={selection?.selected}
      aria-label={selection?.label}
      tabIndex={selection ? 0 : undefined}
      onClick={selection?.onToggle}
      onKeyDown={
        selection
          ? event => {
              if (event.key !== ' ' && event.key !== 'Enter') return
              event.preventDefault()
              selection.onToggle()
            }
          : undefined
      }
      className={cn(
        'group flex flex-col overflow-hidden rounded-2xl border bg-card transition-[border-color,background-color,box-shadow,transform]',
        compact ? 'p-4' : 'min-h-[17rem] p-5',
        selection &&
          'cursor-pointer outline-none hover:-translate-y-0.5 hover:border-brand/35 focus-visible:ring-2 focus-visible:ring-brand',
        /* `relative`, because the card *is* the hit area — see the stretched
           control at the foot of it. The ring is `has-[:focus-visible]` rather
           than the card's own `focus-visible` for the same reason: the thing
           that takes focus is inside, and the thing a reader sees framed should
           be the card they are about to open. */
        onSelect &&
          'relative cursor-pointer hover:-translate-y-0.5 hover:border-brand/35 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand',
        selection?.selected
          ? 'border-brand/60 bg-brand/[0.055] ring-1 ring-inset ring-brand/20'
          : unread
            ? 'border-brand/45 bg-brand/[0.035]'
            : 'border-border/70',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <MarketplaceAgentMark name={listing.agentName} />
        <div className="flex flex-wrap justify-end gap-2">
          {/* The badge asserts a VERIFIED publisher. Rendering it for everyone
              would tell the user a stranger's agent was reviewed by Duet — the
              exact claim the consent sheet exists to avoid making. */}
          {listing.verifiedPublisher ? <VerifiedPublisherBadge label={t('official')} /> : null}
          {/* Sized and centred by `h-7`/`items-center`, not by padding: this row
              stretches its children, so a padded span grows to the sibling
              badge's height with its text still pinned to the top. */}
          {unread ? (
            <span className="inline-flex h-7 items-center rounded-full bg-brand px-2 text-[11px] font-semibold text-brand-foreground">
              {t('newUpdate')}
            </span>
          ) : null}
          {selection ? (
            <span
              aria-hidden
              className={cn(
                'grid size-7 place-items-center rounded-full border transition-colors',
                selection.selected
                  ? 'border-brand bg-brand text-brand-foreground'
                  : 'border-foreground/20 bg-muted/70 text-transparent',
              )}
            >
              <CheckCircle size={18} weight="fill" />
            </span>
          ) : null}
        </div>
      </div>

      <div className={cn('min-w-0 flex-1', compact ? 'mt-3' : 'mt-5')}>
        <h2
          className={cn(
            'font-semibold tracking-tight text-foreground',
            compact ? 'text-base' : 'text-lg',
          )}
        >
          {displayName}
        </h2>
        {listing.verifiedPublisher ? null : (
          <p
            data-testid="marketplace-card-publisher"
            className="mt-1 text-xs text-muted-foreground"
          >
            {t('byPublisher', { publisher: listing.publisherSlug })}
          </p>
        )}
        <p
          className={cn(
            'mt-2 text-sm leading-6 text-muted-foreground',
            compact ? 'line-clamp-2' : 'line-clamp-3',
          )}
        >
          {listing.summary}
        </p>
        {reason === undefined ? null : (
          <p
            data-testid="marketplace-card-reason"
            className="mt-3 flex items-start gap-1.5 rounded-lg bg-brand/[0.07] px-2.5 py-2 text-xs leading-5 text-foreground/85"
          >
            <Sparkle aria-hidden size={14} weight="fill" className="mt-0.5 shrink-0 text-brand" />
            <span>{reason}</span>
          </p>
        )}
        {visibleChips.length > 0 && !compact ? (
          <ul aria-label={t('cardIncludes')} className="mt-4 flex flex-wrap gap-1.5">
            {visibleChips.map(chip => (
              <li
                key={`${chip.kind}:${chip.label}`}
                data-marketplace-chip={chip.kind}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium',
                  chip.kind === 'app' ? 'bg-brand/10 text-brand' : 'bg-muted/70 text-foreground/75',
                )}
              >
                {chip.kind === 'app' ? <AppWindow aria-hidden size={13} weight="bold" /> : null}
                {chip.label}
              </li>
            ))}
            {hiddenChipCount > 0 ? (
              /* Chip-shaped so it belongs to the set — bare text here read as
                 an orphaned caption — but outlined, not filled: it is a count,
                 not a control. */
              <li className="rounded-md border border-border/60 px-2 py-1 text-xs font-medium text-muted-foreground">
                {t('moreSkills', { count: hiddenChipCount })}
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>

      <div
        className={cn(
          'flex items-center justify-between gap-3',
          // In compact mode the status row only earns its space once there is
          // something to say — an install in flight, or a refusal.
          compact
            ? status.kind === 'uninstalled' && !unavailable
              ? 'hidden'
              : 'mt-3'
            : 'mt-5 border-t border-border/60 pt-4',
        )}
      >
        {onInstall !== undefined && status.kind === 'uninstalled' && !unavailable ? (
          /* A real control where "Ready to install" used to sit — text shaped
             like a button that did nothing. `relative z-10` lifts it above the
             stretched view-details hit area, so this click installs instead of
             opening the listing. */
          <Button
            type="button"
            size="sm"
            data-testid="marketplace-card-install"
            onClick={onInstall}
            className="relative z-10"
          >
            <DownloadSimple aria-hidden className="mr-1.5" size={15} />
            {t('install')}
          </Button>
        ) : (
          <div className={cn('flex min-w-0 items-center gap-1.5 text-xs font-medium', status.tone)}>
            <StatusIcon
              aria-hidden
              size={15}
              className={status.kind === 'installing' ? 'animate-spin' : undefined}
            />
            <span>
              {status.kind === 'installed'
                ? t('installedCount', { count: instances.installedCount })
                : status.kind === 'issues'
                  ? t('issueCount', { count: instances.issueCount })
                  : t(status.label)}
            </span>
          </div>
        )}
        {onSelect ? (
          /* One card, one destination, one control — and the control is the
             whole card. The button keeps its place in the corner because a
             reader scanning a grid looks for the call to action, but its hit
             area is stretched over the card by a pseudo-element, so the name,
             the summary and the skills all open the listing too. They looked
             clickable and were not.

             A pseudo-element rather than `role="button"` on the <article>: that
             role makes its descendants presentational, which would take the
             card's own heading out of the accessibility tree and leave a
             screen reader one long unstructured label where the listing used to
             be. This way the card stays a document and the button stays a
             button — there is still exactly one focus stop and no interactive
             element nested inside another. */
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onSelect}
            className="after:absolute after:inset-0 after:content-[''] group-hover:bg-accent group-hover:text-accent-foreground"
          >
            {t('viewDetails')}
          </Button>
        ) : null}
      </div>
    </article>
  )
}

export function MarketplaceAgentMark({ name, className }: { name: string; className?: string }) {
  return (
    <AgentAvatar
      avatarKey={name}
      className={cn(
        'size-12 border border-white/45 shadow-[0_7px_16px_-10px_hsl(var(--brand)/0.8)] ring-1 ring-brand/15',
        className,
      )}
    />
  )
}

export function marketplaceSlugLabel(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function galleryStatus(
  instances: MarketplaceListingInstances,
  options: { installing: boolean; unavailable: boolean },
):
  | {
      kind: 'uninstalled'
      label: 'stateUninstalled'
      tone: string
      icon: typeof DownloadSimple
    }
  | {
      kind: 'installing'
      label: 'stateInstalling'
      tone: string
      icon: typeof DownloadSimple
    }
  | {
      kind: 'unavailable'
      label: 'stateUnavailable'
      tone: string
      icon: typeof DownloadSimple
    }
  | {
      kind: 'installed'
      tone: string
      icon: typeof DownloadSimple
    }
  | {
      kind: 'issues'
      tone: string
      icon: typeof DownloadSimple
    } {
  if (options.unavailable)
    return {
      kind: 'unavailable',
      label: 'stateUnavailable',
      tone: 'text-muted-foreground',
      icon: WarningCircle,
    }
  if (options.installing)
    return { kind: 'installing', label: 'stateInstalling', tone: 'text-brand', icon: SpinnerGap }
  if (instances.issueCount > 0)
    return {
      kind: 'issues',
      tone: 'text-destructive',
      icon: WarningCircle,
    }
  if (instances.installedCount > 0)
    return {
      kind: 'installed',
      tone: 'text-emerald-600',
      icon: CheckCircle,
    }
  return {
    kind: 'uninstalled',
    label: 'stateUninstalled',
    tone: 'text-muted-foreground',
    icon: DownloadSimple,
  }
}
