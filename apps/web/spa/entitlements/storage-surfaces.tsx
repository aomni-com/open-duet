'use client'

import { useFormatter, useTranslations } from 'next-intl'

import { STORAGE_FULL_ERROR, STORAGE_WARNING_RATIO, type BillingWorkspace } from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

import { uploadErrorCode, uploadErrorStatus } from '../api/vm-uploads'
import type { ToastInput } from '../shell/toast'

const BYTES_PER_GB = 1_000_000_000

type StorageMessageKey =
  | 'label'
  | 'meterAriaLabel'
  | 'measuring'
  | 'usage'
  | 'warningTitle'
  | 'warningUsage'
  | 'warningCleanup'
  | 'fullTitle'
  | 'fullGeneric'
  | 'fullCleanup'
  | 'fullUpgrade'
  | 'upgrade'

export type StorageTranslator = (
  key: StorageMessageKey,
  values?: Record<string, string | number>,
) => string

export type StorageNumberFormatter = (value: number) => string

export function evaluateStorageWarning(
  latchedUsableGb: number | undefined,
  storage: BillingWorkspace['storage'],
): { latchedUsableGb: number | undefined; shouldShow: boolean } {
  if (storage.usedBytes === undefined || storage.usableGb <= 0) {
    return { latchedUsableGb, shouldShow: false }
  }
  const warning = storage.usedBytes / (storage.usableGb * BYTES_PER_GB) >= STORAGE_WARNING_RATIO
  if (!warning) return { latchedUsableGb: undefined, shouldShow: false }
  if (latchedUsableGb === storage.usableGb) return { latchedUsableGb, shouldShow: false }
  return { latchedUsableGb: storage.usableGb, shouldShow: true }
}

export function advanceStorageWarningEpisodes(
  current: ReadonlyMap<string, number>,
  workspaceId: string,
  storage: BillingWorkspace['storage'],
): { episodes: Map<string, number>; shouldShow: boolean } {
  const result = evaluateStorageWarning(current.get(workspaceId), storage)
  const episodes = new Map(current)
  if (result.latchedUsableGb === undefined) episodes.delete(workspaceId)
  else episodes.set(workspaceId, result.latchedUsableGb)
  return { episodes, shouldShow: result.shouldShow }
}

export type StorageFullSignal =
  | { kind: 'file'; error: unknown }
  | { kind: 'session'; event: unknown }

export function storageFullToastForSignal(
  signal: StorageFullSignal,
  workspace: BillingWorkspace | undefined,
  t: StorageTranslator,
  onUpgrade?: () => void,
): ToastInput | undefined {
  const storageFull =
    signal.kind === 'file'
      ? isStorageFullFileError(signal.error)
      : isStorageFullSystemEvent(signal.event)
  if (!storageFull) return undefined
  return storageFullToast(workspace, t, onUpgrade)
}

export function isStorageFullFileError(error: unknown): boolean {
  return uploadErrorStatus(error) === 507 && uploadErrorCode(error) === STORAGE_FULL_ERROR
}

function isStorageFullSystemEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false
  const candidate = event as { type?: unknown; metadata?: { code?: unknown } }
  return candidate.type === 'system' && candidate.metadata?.code === STORAGE_FULL_ERROR
}

export function storageFullToast(
  workspace: BillingWorkspace | undefined,
  t: StorageTranslator,
  onUpgrade?: () => void,
): ToastInput {
  const storage = workspace?.storage
  const description =
    storage === undefined
      ? t('fullGeneric')
      : storage.nextUsableGb === undefined
        ? t('fullCleanup', { usable: storage.usableGb })
        : t('fullUpgrade', { usable: storage.usableGb })
  return {
    tone: 'error',
    message: t('fullTitle'),
    description,
    ...(storage?.nextUsableGb === undefined
      ? {}
      : {
          action: {
            label: t('upgrade', { usable: storage.nextUsableGb }),
            ...(onUpgrade === undefined ? { href: '/settings/billing' } : { onClick: onUpgrade }),
          },
        }),
  }
}

export function storageWarningToast(
  workspace: BillingWorkspace,
  t: StorageTranslator,
  formatNumber: StorageNumberFormatter,
  onUpgrade?: () => void,
): ToastInput {
  const { storage } = workspace
  const usage = formatStorageUsage(storage, t, formatNumber)
  const description =
    storage.nextUsableGb === undefined
      ? t('warningCleanup', { usage })
      : t('warningUsage', { usage })
  return {
    tone: 'warning',
    message: t('warningTitle'),
    description,
    ...(storage.nextUsableGb === undefined
      ? {}
      : {
          action: {
            label: t('upgrade', { usable: storage.nextUsableGb }),
            ...(onUpgrade === undefined ? { href: '/settings/billing' } : { onClick: onUpgrade }),
          },
        }),
  }
}

export function formatStorageUsage(
  storage: BillingWorkspace['storage'],
  t: StorageTranslator,
  formatNumber: StorageNumberFormatter,
): string {
  if (storage.usedBytes === undefined) return t('measuring')
  const used = formatNumber(storage.usedBytes / BYTES_PER_GB)
  return t('usage', { used, usable: storage.usableGb })
}

export function StorageMeters({ workspaces }: { workspaces: readonly BillingWorkspace[] }) {
  const t = useTranslations('duetStorage')
  const format = useFormatter()
  const formatNumber: StorageNumberFormatter = value =>
    format.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return (
    <div className="mt-5">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('label')}
      </p>
      <div className="space-y-4">
        {workspaces.map(workspace => (
          <StorageMeter
            key={workspace.id}
            workspace={workspace}
            t={t}
            formatNumber={formatNumber}
          />
        ))}
      </div>
    </div>
  )
}

export function StorageMeter({
  workspace,
  t,
  formatNumber,
}: {
  workspace: BillingWorkspace
  t: StorageTranslator
  formatNumber: StorageNumberFormatter
}) {
  const { storage } = workspace
  const ratio =
    storage.usedBytes === undefined || storage.usableGb <= 0
      ? 0
      : storage.usedBytes / (storage.usableGb * BYTES_PER_GB)
  const percent = Math.max(0, Math.min(100, ratio * 100))
  return (
    <div data-storage-meter={workspace.slug}>
      <div className="mb-1.5 flex items-baseline justify-between gap-4 text-xs">
        <span className="min-w-0 truncate font-medium text-foreground">{workspace.name}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatStorageUsage(storage, t, formatNumber)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={t('meterAriaLabel', { workspace: workspace.name })}
        aria-valuemin={0}
        aria-valuemax={storage.usableGb}
        aria-valuenow={
          storage.usedBytes === undefined ? undefined : storage.usedBytes / BYTES_PER_GB
        }
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            'h-full rounded-full bg-primary transition-[width]',
            ratio >= 1 ? 'bg-destructive' : ratio >= 0.9 ? 'bg-amber-500' : undefined,
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
