'use client'

/* Rename failures use the shell toast. Lifecycle failures stay in the menu
   or confirmation that started them, where retry preserves intent. */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'

import type { SessionSnapshot } from '@repo/contract'

import { DuetApiError } from '../api/client'
import { useSpa } from '../context'
import { useToast } from '../shell/toast'
import { commitRemovedSessionCache } from './session-cache'
import { EditableTitle, SessionMenu, shouldPutAwayAfterArchive } from './session-controls'
import { sessionKeys, sessionQueryOptions, useSessionActions } from './session-data'

/** The conversation's name, as the thing you click to change it. */
export function SessionTitleControl({
  workspaceSlug,
  sessionId,
  title,
}: {
  workspaceSlug: string
  sessionId: string
  title: string
}) {
  const t = useTranslations('duetApp.sessionProduct')
  const toast = useToast()
  const actions = useSessionActions(workspaceSlug, sessionId)
  return (
    <EditableTitle
      value={title}
      onSave={async nextTitle => {
        try {
          await actions.rename.mutateAsync(nextTitle)
        } catch (error) {
          if (actions.consumeReconciled(`rename:${nextTitle.trim()}`)) return
          toast({ message: t('actionError'), tone: 'warning' })
          throw error
        }
      }}
    />
  )
}

export function SessionLifecycleMenu({
  workspaceSlug,
  sessionId,
  onPutAway,
}: {
  workspaceSlug: string
  sessionId: string
  /**
   * The surface stays; the conversation it was showing is gone — land back on
   * the list. Deleting does this, and so does archiving: the list excludes
   * archived sessions, so leaving the URL on one would truthfully report "not
   * in this list" to the reader who just asked for exactly that.
   */
  onPutAway: () => void
}) {
  const { api } = useSpa()
  const t = useTranslations('duetApp.sessionProduct')
  const toast = useToast()
  const queryClient = useQueryClient()
  const actions = useSessionActions(workspaceSlug, sessionId)
  /* Deleting removes the thing the reader was reading and then moves them off
     it, so the surface that would normally confirm is the surface that just
     went away. Landing on Home with no word for it leaves them to infer from an
     empty column whether it worked — so the confirmation outlives the
     navigation, in the shell, which is the one place still on screen. Said once,
     wherever the delete came from and wherever it lands. */
  const putAwayDeleted = () => {
    onPutAway()
    toast({ message: t('deleted'), tone: 'success' })
  }
  /* The conversation under this header already holds the snapshot; the same key
     answers from cache, so asking again costs nothing and keeps this control
     self-contained. */
  const detail = useQuery(sessionQueryOptions.detail(api, workspaceSlug, sessionId))
  const refreshPermissionsOrExit = async () => {
    try {
      await queryClient.fetchQuery({
        ...sessionQueryOptions.detail(api, workspaceSlug, sessionId),
        staleTime: 0,
      })
    } catch (error) {
      if (error instanceof DuetApiError && error.status === 404) {
        commitRemovedSessionCache(queryClient, workspaceSlug, sessionId)
        onPutAway()
      }
    }
  }
  if (detail.data === undefined) return null
  return (
    <SessionMenu
      archive={detail.data.archive}
      permissions={detail.data.permissions}
      busy={actions.archive.isPending || actions.remove.isPending}
      onArchive={async (kind, archived) => {
        const previousReason = detail.data?.archive.reason ?? null
        try {
          const summary = await actions.archive.mutateAsync({ kind, archived })
          if (shouldPutAwayAfterArchive(previousReason, summary.archive.reason)) onPutAway()
        } catch (error) {
          if (actions.consumeReconciled(`archive:${kind}:${archived}`)) {
            const current = queryClient.getQueryData<SessionSnapshot>(
              sessionKeys.detail(workspaceSlug, sessionId),
            )
            if (shouldPutAwayAfterArchive(previousReason, current?.archive.reason ?? null)) {
              onPutAway()
            }
            return
          }
          if (error instanceof DuetApiError && error.status === 404) {
            /* Already gone — deleted from another surface, or by someone else
               while this dialog was open. The reader asked for it gone and it
               is gone, so they get the same word rather than an error about a
               conversation that no longer exists. */
            commitRemovedSessionCache(queryClient, workspaceSlug, sessionId)
            putAwayDeleted()
            return
          }
          if (error instanceof DuetApiError && error.status === 403) {
            await refreshPermissionsOrExit()
          }
          throw error
        }
      }}
      onDelete={async () => {
        try {
          await actions.remove.mutateAsync()
          putAwayDeleted()
        } catch (error) {
          if (actions.consumeReconciled('remove')) {
            putAwayDeleted()
            return
          }
          if (error instanceof DuetApiError && error.status === 404) {
            commitRemovedSessionCache(queryClient, workspaceSlug, sessionId)
            onPutAway()
            return
          }
          if (error instanceof DuetApiError && error.status === 403) {
            await refreshPermissionsOrExit()
          }
          throw error
        }
      }}
    />
  )
}
