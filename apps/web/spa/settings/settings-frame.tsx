'use client'

import { ArrowLeft, Gear, UserCircle } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation, useParams } from 'react-router'

import { microUsdToDollars } from '@repo/contract'

import { useSpa } from '../context'
import { USER_SETTINGS, WORKSPACE_SETTINGS } from '../routes/route-metadata'
import { settingsReturnDestination } from './settings-navigation'

export function SettingsFrame({
  kind,
  children,
}: {
  kind: 'workspace' | 'user'
  children: ReactNode
}) {
  const t = useTranslations('duetApp')
  const { workspaceSlug } = useParams()
  const location = useLocation()
  const { activeWorkspaceSlug } = useSpa()
  const returnTo = settingsReturnDestination(location.state, workspaceSlug ?? activeWorkspaceSlug)
  const settings = kind === 'workspace' ? WORKSPACE_SETTINGS : USER_SETTINGS
  const base = kind === 'workspace' ? `/w/${workspaceSlug}/settings` : '/settings'

  return (
    <section className="grid min-h-[calc(100dvh-4rem)] min-w-0 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[17rem_minmax(0,1fr)] md:grid-rows-none">
      <aside className="min-w-0 border-b border-border/70 bg-sidebar p-3 md:border-b-0 md:border-r">
        <Link
          to={returnTo}
          className="flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('backToWorkspace')}
        </Link>
        <div className="mb-3 mt-3 flex min-w-0 items-center gap-2 px-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-brand/[0.08] text-brand ring-1 ring-inset ring-brand/10 [&_svg]:size-4">
            {kind === 'workspace' ? <Gear weight="duotone" /> : <UserCircle weight="duotone" />}
          </span>
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">
            {kind === 'workspace' ? t('workspaceSettings') : t('userSettings')}
          </span>
        </div>
        <nav className="flex max-w-full flex-wrap gap-1.5 pb-1 md:block md:space-y-1">
          {settings.map(([route, label]) => (
            <NavLink
              key={route}
              to={`${base}/${route}`}
              state={location.state}
              className={({ isActive }) =>
                `flex min-h-11 md:min-h-9 items-center rounded-md px-3 text-sm transition-colors ${isActive ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'}`
              }
            >
              {t(label)}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 bg-background p-4 sm:p-6 lg:p-8">{children}</div>
    </section>
  )
}

export function SettingsHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <header className="mx-auto mb-6 flex max-w-4xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">{eyebrow}</p>
        <h1 className="mt-1 text-2xl font-semibold leading-tight tracking-tight">{title}</h1>
        <p className="mt-2 max-w-[68ch] text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  )
}

export function SettingsCard({
  title,
  description,
  children,
}: {
  title?: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      {title || description ? (
        <header className="border-b px-5 py-4 sm:px-6">
          {title ? <h3 className="font-semibold">{title}</h3> : null}
          {description ? (
            <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
          ) : null}
        </header>
      ) : null}
      <div className="p-5 sm:p-6">{children}</div>
    </section>
  )
}

export function SettingsState({
  title,
  body,
  busy,
  action,
}: {
  title: string
  body: string
  busy?: boolean
  action?: ReactNode
}) {
  return (
    <SettingsCard>
      {busy ? <div className="mb-4 h-2 w-24 animate-pulse rounded-full bg-primary" /> : null}
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
      {action === undefined ? null : <div className="mt-4">{action}</div>}
    </SettingsCard>
  )
}

export function SettingsPage({
  group,
  surface,
  children,
}: {
  group: 'workspace' | 'user'
  surface: string
  children: ReactNode
}) {
  const t = useTranslations('duetSettings')
  return (
    <>
      <SettingsHeader
        eyebrow={t(`${group}.eyebrow`)}
        title={t(`${group}.${surface}.title`)}
        description={t(`${group}.${surface}.description`)}
      />
      <div className="mx-auto max-w-4xl">{children}</div>
    </>
  )
}

export function SettingsMutationStatus({
  mutation,
}: {
  mutation: { isError: boolean; isSuccess: boolean }
}) {
  const t = useTranslations('duetSettings')
  if (mutation.isError) return <p className="mt-4 text-sm text-destructive">{t('saveError')}</p>
  if (mutation.isSuccess) return <p className="mt-4 text-sm text-emerald-600">{t('saved')}</p>
  return null
}

export function formatMicroUsd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    microUsdToDollars(value),
  )
}
