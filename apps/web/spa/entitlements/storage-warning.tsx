'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'

import type { UserBillingOverview } from '@repo/contract'

import { useSpa } from '../context'
import { useToast } from '../shell/toast'
import {
  advanceStorageWarningEpisodes,
  storageFullToastForSignal,
  storageWarningToast,
  type StorageFullSignal,
} from './storage-surfaces'

export function StorageWarning({
  billing,
  activeWorkspaceSlug,
  onOpenBilling,
}: {
  billing: UserBillingOverview | undefined
  activeWorkspaceSlug: string | undefined
  onOpenBilling(): void
}) {
  const t = useTranslations('duetStorage')
  const format = useFormatter()
  const formatNumber = useCallback(
    (value: number) => format.number(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    [format],
  )
  const showToast = useToast()
  const episodes = useRef(new Map<string, number>())
  const workspace = billing?.workspaces.find(candidate => candidate.slug === activeWorkspaceSlug)

  useEffect(() => {
    if (workspace === undefined) return
    const next = advanceStorageWarningEpisodes(episodes.current, workspace.id, workspace.storage)
    episodes.current = next.episodes
    if (next.shouldShow) {
      showToast(storageWarningToast(workspace, t, formatNumber, onOpenBilling))
    }
  }, [formatNumber, onOpenBilling, showToast, t, workspace])

  return null
}

export function useStorageFullNotifier(workspaceSlug: string) {
  const { billingOverview } = useSpa()
  const navigate = useNavigate()
  const t = useTranslations('duetStorage')
  const showToast = useToast()
  const workspace = billingOverview?.workspaces.find(candidate => candidate.slug === workspaceSlug)
  return useCallback(
    (signal: StorageFullSignal) => {
      const toast = storageFullToastForSignal(signal, workspace, t, () =>
        navigate('/settings/billing'),
      )
      if (toast !== undefined) showToast(toast)
    },
    [navigate, showToast, t, workspace],
  )
}
