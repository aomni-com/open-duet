'use client'

import { Check, CircleNotch, Copy, GithubLogo, Sparkle, WarningCircle } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'

import type { ConnectedProviderId } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import type { ConnectedProviderPresentation } from './connected-provider-presentation'

export function ConnectedProvidersManagement({
  providers,
  onConnect,
  onDisconnect,
}: {
  providers: ConnectedProviderPresentation[]
  onConnect(provider: ConnectedProviderId): void
  onDisconnect(provider: ConnectedProviderId): void
}) {
  const t = useTranslations('duetSettings.workspace.connectedProviders')

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="border-b px-5 py-4 sm:px-6">
        <h3 className="font-semibold">{t('cardTitle')}</h3>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{t('caveat')}</p>
      </header>
      <div className="divide-y px-5 sm:px-6">
        {providers.map((provider, index) => (
          <ProviderRow
            key={`${provider.provider}-${index}`}
            provider={provider}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        ))}
      </div>
    </section>
  )
}

function ProviderRow({
  provider,
  onConnect,
  onDisconnect,
}: {
  provider: ConnectedProviderPresentation
  onConnect(provider: ConnectedProviderId): void
  onDisconnect(provider: ConnectedProviderId): void
}) {
  const t = useTranslations('duetSettings.workspace.connectedProviders')
  const [copied, setCopied] = useState(false)
  const isOpenAiCodex = provider.provider === 'openai-codex'
  const Icon = isOpenAiCodex ? Sparkle : GithubLogo
  const canDisconnect =
    (provider.state === 'connected' ||
      provider.state === 'plan_ineligible' ||
      provider.state === 'reconnect_needed') &&
    provider.canDisconnect

  return (
    <div
      data-provider={provider.provider}
      data-provider-state={provider.state}
      className="py-5 first:pt-5 last:pb-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
            <Icon size={21} weight="duotone" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {isOpenAiCodex ? t('providers.openAiCodex') : t('providers.copilot')}
            </p>
            <ProviderStatus provider={provider} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-13 sm:pl-0">
          {provider.state === 'disconnected' || provider.state === 'failed' ? (
            <button
              type="button"
              onClick={() => onConnect(provider.provider)}
              className={buttonVariants({ variant: 'outline' })}
            >
              {provider.state === 'failed' ? t('actions.retry') : t('actions.connect')}
            </button>
          ) : null}
          {provider.state === 'plan_ineligible' || provider.state === 'reconnect_needed' ? (
            <button
              type="button"
              onClick={() => onConnect(provider.provider)}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('actions.reconnect')}
            </button>
          ) : null}
          {canDisconnect ? (
            <button
              type="button"
              onClick={() => onDisconnect(provider.provider)}
              className={cn(
                buttonVariants({ variant: 'outline' }),
                'text-muted-foreground hover:border-destructive/40 hover:text-destructive',
              )}
            >
              {t('actions.disconnect')}
            </button>
          ) : null}
          {provider.state === 'connecting' || provider.state === 'disconnecting' ? (
            <span className="inline-flex h-9 items-center gap-2 px-3 text-sm text-muted-foreground">
              <CircleNotch className="animate-spin" size={16} />
              {provider.state === 'connecting' ? t('states.connecting') : t('states.disconnecting')}
            </span>
          ) : null}
        </div>
      </div>
      {provider.state === 'awaiting_code' ? (
        <div className="mt-4 rounded-lg border bg-muted/30 p-4 sm:ml-13">
          <p className="text-sm font-medium">{t('states.awaitingCode')}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('deviceCodeHelp')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="rounded-md border bg-background px-3 py-2 font-mono text-base font-semibold tracking-[0.12em]">
              {provider.userCode}
            </code>
            <button
              type="button"
              aria-label={t('actions.copyCode')}
              onClick={() => {
                void navigator.clipboard.writeText(provider.userCode).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }}
              className={buttonVariants({ variant: 'outline', size: 'icon' })}
            >
              {copied ? <Check size={17} /> : <Copy size={17} />}
            </button>
            <a
              href={provider.verificationUri}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants()}
            >
              {t('actions.openVerification')}
            </a>
            <button
              type="button"
              onClick={() => onDisconnect(provider.provider)}
              className={cn(buttonVariants({ variant: 'ghost' }), 'text-muted-foreground')}
            >
              {t('actions.cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ProviderStatus({ provider }: { provider: ConnectedProviderPresentation }) {
  const t = useTranslations('duetSettings.workspace.connectedProviders')
  if (provider.state === 'connected') {
    return (
      <p className="mt-0.5 text-xs text-muted-foreground">
        {provider.connectedByLabel
          ? t('states.connectedBy', { name: provider.connectedByLabel })
          : t('states.connected')}
      </p>
    )
  }
  if (provider.state === 'plan_ineligible') {
    return <WarningStatus>{t('states.planNotEligible')}</WarningStatus>
  }
  if (provider.state === 'reconnect_needed') {
    return <WarningStatus>{t('states.reconnectNeeded')}</WarningStatus>
  }
  if (provider.state === 'failed') return <WarningStatus>{t('states.failed')}</WarningStatus>
  if (provider.state === 'awaiting_code') {
    return <p className="mt-0.5 text-xs text-muted-foreground">{t('states.awaitingApproval')}</p>
  }
  if (provider.state === 'connecting' || provider.state === 'disconnecting') return null
  return <p className="mt-0.5 text-xs text-muted-foreground">{t('states.disconnected')}</p>
}

function WarningStatus({ children }: { children: string }) {
  return (
    <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
      <WarningCircle size={13} weight="fill" />
      {children}
    </p>
  )
}
