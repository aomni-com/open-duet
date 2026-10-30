'use client'

import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CopyIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'

import type { App, AppDomain } from '@repo/contract'
import { Button } from '@repo/ui/components/shadcn/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/shadcn/dialog'
import { Input } from '@repo/ui/components/shadcn/input'
import { Label } from '@repo/ui/components/shadcn/label'

import { appDomainMutationOptions, useAppDomain } from '../api/app-domains'
import { DuetApiError } from '../api/client'
import { useSpa } from '../context'

export type AppDomainSubject = Pick<App, 'id' | 'slug' | 'name'> & {
  controls: Pick<App['controls'], 'manageDomain'>
  disabledAt?: App['disabledAt']
  anchorState?: App['anchorState']
  runtimeStatus?: App['runtimeStatus']
}

export function AppDomainDialog({
  workspaceSlug,
  app,
  onClose,
}: {
  workspaceSlug: string
  app: AppDomainSubject
  onClose: () => void
}) {
  const t = useTranslations('duetApp.appsSurface.domains')
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        data-app-domain-dialog={app.slug}
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description', { name: app.name ?? app.slug })}</DialogDescription>
        </DialogHeader>
        <AppDomainPanel workspaceSlug={workspaceSlug} app={app} />
      </DialogContent>
    </Dialog>
  )
}

export function AppDomainPanel({
  workspaceSlug,
  app,
}: {
  workspaceSlug: string
  app: AppDomainSubject
}) {
  const { api } = useSpa()
  const t = useTranslations('duetApp.appsSurface.domains')
  const queryClient = useQueryClient()
  const query = useAppDomain(api, workspaceSlug, app.slug)
  const domain = query.data?.domain
  const [hostname, setHostname] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const id = useId()
  const mutation = useMutation({
    mutationFn: (action: 'attach' | 'recheck' | 'remove') =>
      action === 'attach'
        ? api.attachAppDomain(workspaceSlug, app.slug, { hostname })
        : action === 'recheck'
          ? api.recheckAppDomain(workspaceSlug, app.slug)
          : api.removeAppDomain(workspaceSlug, app.slug),
    ...appDomainMutationOptions(queryClient, workspaceSlug, app.slug),
  })
  const busy = mutation.isPending
  const rechecking = domain?.checking === true || (busy && mutation.variables === 'recheck')
  const unavailable =
    app.disabledAt !== undefined ||
    app.anchorState === 'broken' ||
    app.runtimeStatus === 'reconcile_failed'
  return (
    <div className="space-y-4" data-app-domain-panel={app.slug}>
      {unavailable && (
        <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t('unavailable')}
        </p>
      )}
      {!app.controls.manageDomain && (
        <p className="text-sm text-muted-foreground">{t('readOnly')}</p>
      )}
      {query.isPending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <SpinnerGapIcon className="animate-spin" />
          {t('loading')}
        </p>
      ) : query.isError && query.data === undefined ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-red-700 dark:text-red-300">{t('loadError')}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : domain === null ? (
        app.controls.manageDomain ? (
          <form
            className="space-y-3"
            onSubmit={event => {
              event.preventDefault()
              mutation.mutate('attach')
            }}
          >
            <div className="space-y-2">
              <Label htmlFor={id}>{t('hostname')}</Label>
              <Input
                id={id}
                value={hostname}
                onChange={event => setHostname(event.target.value)}
                placeholder="app.example.com"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
              />
            </div>
            <p className="text-sm text-muted-foreground">{t('emptyDescription')}</p>
            <Button type="submit" disabled={busy || hostname.trim() === ''}>
              {busy && <SpinnerGapIcon aria-hidden className="animate-spin" />}
              {busy ? t('attaching') : t('attach')}
            </Button>
          </form>
        ) : (
          <p className="text-sm">{t('empty')}</p>
        )
      ) : domain !== undefined ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="break-all font-medium">{domain.hostname}</p>
            <DomainStatus domain={domain} />
            <p className="text-sm text-muted-foreground">
              {t(
                domain.operatorRepairRequired
                  ? 'operatorRepairBody'
                  : domain.retryRequired
                    ? 'cleanupRetryBody'
                    : domain.checking
                      ? 'checkingBody'
                      : `${domain.status}Body`,
              )}
            </p>
          </div>
          {domain.status === 'active' && (
            <a
              className="inline-flex items-center gap-1 break-all text-sm text-primary underline underline-offset-4"
              href={`https://${domain.hostname}`}
              target="_blank"
              rel="noreferrer"
            >
              {t('visit')}
              <ArrowSquareOutIcon aria-hidden />
            </a>
          )}
          {domain.records.length > 0 && (
            <section className="space-y-2" aria-label={t('dnsRecords')}>
              <h3 className="text-sm font-medium">{t('dnsRecords')}</h3>
              <p className="text-xs text-muted-foreground">{t('dnsHelp')}</p>
              {domain.records.map((record, index) => (
                <DnsRecord key={`${record.type}:${record.domain}:${index}`} record={record} />
              ))}
            </section>
          )}
          {domain.conflicts.length > 0 && (
            <section
              className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3"
              aria-label={t('conflicts')}
            >
              <h3 className="text-sm font-medium text-red-700 dark:text-red-300">
                {t('conflicts')}
              </h3>
              <p className="text-xs text-muted-foreground">{t('conflictsBody')}</p>
              {domain.conflicts.map((record, index) => (
                <p key={index} className="break-all font-mono text-xs">
                  {record.type} · {record.name} · {record.value}
                </p>
              ))}
            </section>
          )}
          {domain.lastError && (
            <p
              className="break-words rounded-md border border-destructive/30 p-3 text-sm text-red-700 dark:text-red-300"
              role="alert"
            >
              {domain.checking && <span className="mb-1 block font-medium">{t('previousCheck')}</span>}
              {domain.lastError}
            </p>
          )}
          {app.controls.manageDomain && !domain.operatorRepairRequired && (
            <div className="space-y-3">
              {confirmRemove && domain.status !== 'removing' && (
                <p className="text-sm text-muted-foreground">{t('removeConfirmation')}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {(domain.status !== 'removing' || domain.retryRequired) && (
                  <Button
                    variant="outline"
                    disabled={busy || rechecking}
                    onClick={() => mutation.mutate('recheck')}
                  >
                    {rechecking && <SpinnerGapIcon aria-hidden className="animate-spin" />}
                    {domain.retryRequired
                      ? t('retryCleanup')
                      : rechecking
                        ? t('rechecking')
                        : t('recheck')}
                  </Button>
                )}
                {domain.status !== 'removing' && (
                  <Button
                    variant={confirmRemove ? 'destructive' : 'outline'}
                    className={
                      confirmRemove
                        ? 'bg-red-700 text-white hover:bg-red-800 dark:bg-red-700 dark:hover:bg-red-800'
                        : undefined
                    }
                    disabled={busy}
                    onClick={() => {
                      if (!confirmRemove) setConfirmRemove(true)
                      else mutation.mutate('remove', { onSuccess: () => setConfirmRemove(false) })
                    }}
                  >
                    {busy && mutation.variables === 'remove'
                      ? t('removing')
                      : confirmRemove
                        ? t('confirmRemove')
                        : t('remove')}
                  </Button>
                )}
                {confirmRemove && !busy && (
                  <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                    {t('cancel')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      ) : null}
      {query.isError && query.data !== undefined && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-red-700 dark:text-red-300">{t('loadError')}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {t('retry')}
          </Button>
        </div>
      )}
      {mutation.isError && (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {t(domainErrorMessage(mutation.error))}
        </p>
      )}
    </div>
  )
}

export function DomainStatus({ domain }: { domain: AppDomain }) {
  const t = useTranslations('duetApp.appsSurface.domains')
  const checking =
    domain.checking === true && !domain.operatorRepairRequired && !domain.retryRequired
  const Icon = checking
    ? SpinnerGapIcon
    : domain.status === 'active' && !domain.operatorRepairRequired
      ? CheckCircleIcon
      : domain.status === 'failed' || domain.retryRequired || domain.operatorRepairRequired
        ? WarningCircleIcon
        : SpinnerGapIcon
  return (
    <p className="flex items-center gap-2 text-sm" role="status">
      <Icon
        aria-hidden
        className={
          (checking || ['pending', 'verifying', 'removing'].includes(domain.status)) &&
          !domain.retryRequired &&
          !domain.operatorRepairRequired
            ? 'animate-spin'
            : ''
        }
      />
      {t(
        domain.operatorRepairRequired
          ? 'operatorRepair'
          : domain.retryRequired
            ? 'cleanupRetry'
            : checking
              ? 'rechecking'
              : domain.status,
      )}
    </p>
  )
}

function DnsRecord({ record }: { record: AppDomain['records'][number] }) {
  const t = useTranslations('duetApp.appsSurface.domains')
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{record.type}</span>
        <span className="min-w-0 break-all text-xs">
          <span className="text-muted-foreground">{t('recordName')}: </span>
          <span className="font-mono">{record.domain}</span>
        </span>
      </div>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs text-muted-foreground">{t('recordValue')}</p>
          <code className="break-all text-xs leading-relaxed">{record.value}</code>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          aria-label={t(copied ? 'copied' : 'copyValue', { type: record.type })}
          onClick={() => {
            void navigator.clipboard
              .writeText(record.value)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }}
        >
          <CopyIcon aria-hidden size={14} />
        </Button>
      </div>
      {record.reason && (
        <p className="break-words text-xs text-muted-foreground">{record.reason}</p>
      )}
    </div>
  )
}

function domainErrorMessage(error: Error) {
  const code = error instanceof DuetApiError ? error.code : undefined
  return [
    'invalid_request',
    'domain_occupied',
    'hostname_in_use',
    'domain_cleanup_pending',
    'domain_not_configured',
    'not_found',
    'forbidden',
  ].includes(code ?? '')
    ? `errors.${code}`
    : 'errors.generic'
}
