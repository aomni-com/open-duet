'use client'

import { CircleNotch, Globe, Snowflake, WarningCircle } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'

import type { PublishRow } from '@repo/contract'

import { PauseSwitch } from '../settings/pause-switch'

export type PublishPauseTransition = { slug: string; paused: boolean }

export function PublishesManagement({
  publishes,
  transition,
  errorSlug,
  onSetPaused,
}: {
  publishes: PublishRow[]
  transition?: PublishPauseTransition
  errorSlug?: string
  onSetPaused(slug: string, paused: boolean): Promise<void>
}) {
  const t = useTranslations('duetSettings.workspace.publishes')
  if (publishes.length === 0)
    return (
      <div className="rounded-xl border bg-card px-6 py-10 text-center shadow-sm">
        <Globe size={24} className="mx-auto text-muted-foreground" />
        <p className="mt-3 font-medium">{t('emptyTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
      </div>
    )
  return (
    <div className="divide-y rounded-xl border bg-card px-5 shadow-sm sm:px-6">
      {publishes.map(publish => {
        const pending = transition?.slug === publish.slug
        const checked = pending ? transition.paused : publish.pausedAt !== undefined
        const state = pending
          ? transition.paused
            ? 'freezing'
            : 'resuming'
          : checked
            ? 'frozen'
            : 'live'
        return (
          <article
            key={publish.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 py-5"
            data-publish-state={state === 'freezing' ? 'pause_pending' : state}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate font-mono text-sm font-semibold">{publish.anchorPath}</p>
                <span className="rounded-full border px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                  /{publish.slug}
                </span>
              </div>
              <div className="mt-3 flex items-start gap-2">
                {state === 'freezing' || state === 'resuming' ? (
                  <CircleNotch size={18} className="mt-0.5 shrink-0 animate-spin text-primary" />
                ) : state === 'frozen' ? (
                  <Snowflake size={18} weight="fill" className="mt-0.5 shrink-0 text-sky-600" />
                ) : (
                  <Globe size={18} weight="fill" className="mt-0.5 shrink-0 text-emerald-600" />
                )}
                <div>
                  <p className="text-sm font-medium">{t(`states.${state}.label`)}</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {t(`states.${state}.help`)}
                  </p>
                </div>
              </div>
              {errorSlug === publish.slug ? (
                <p role="alert" className="mt-3 flex items-center gap-2 text-xs text-destructive">
                  <WarningCircle size={16} />
                  {t('mutationError')}
                </p>
              ) : null}
            </div>
            <PauseSwitch
              checked={checked}
              disabled={transition !== undefined}
              label={t(checked ? 'resumeLabel' : 'freezeLabel', { slug: publish.slug })}
              onCheckedChange={paused => void onSetPaused(publish.slug, paused)}
            />
          </article>
        )
      })}
    </div>
  )
}
