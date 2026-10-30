'use client'

/* ============================================================================
   The control that archives an owner's default chat, and the confirm in front
   of it.

   Split three ways on purpose. The button is presentation and nothing else, so
   its words can be rendered in every shipped locale by a test. The action
   around it owns the two reads that decide whether the button is drawn at all —
   both of them React Query's, shared with the panel beside it rather than
   fetched a second time. The dialog is mounted by the host, away from the
   trigger: archiving is exactly the thing that makes the trigger disappear, and
   a dialog closing inside a subtree that is being unmounted is how a modal
   leaves its scroll lock behind.
   ========================================================================= */
import { ArchiveIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useIsMutating, useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useState } from 'react'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/shadcn/alert-dialog'
import { Button } from '@repo/ui/components/shadcn/button'

import { duetMutationKeys } from '../api/query-keys'
import { useSpa } from '../context'
import { archiveDefaultChatState, useArchiveDefaultChat } from './archive-default-chat'
import { defaultChatQueryOptions } from './default-chat'

/** The owner whose chat is being archived. `root` is the drive itself. */
export type ArchiveDefaultChatTarget = { agentSlug: string; agentName: string }

/**
 * Words and a glyph, and no plate around them.
 *
 * The CHAT header carries no chrome at all, and the agent's three doors stand a
 * few pixels above it — a second glass button here would read as a fourth door.
 * So it is set in the header's own quiet type, one line tall, and truncates
 * rather than pushing the column wider than the panel it is in.
 */
export function ArchiveDefaultChatButton({
  disabled,
  onClick,
}: {
  disabled: boolean
  onClick: () => void
}) {
  const t = useTranslations('duetApp.agentSurface')
  const label = t('archiveChat')
  return (
    <button
      type="button"
      className="km-chat-act"
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <ArchiveIcon aria-hidden size={12} />
      <span>{label}</span>
    </button>
  )
}

/**
 * The button, once the route's reads say there is something to press it about.
 *
 * Both reads are already in flight for this surface — the alias is what the
 * panel beside this mounted from, and the send is that panel's own mutation —
 * so this joins them rather than asking again.
 */
export function ArchiveDefaultChatAction({
  workspaceSlug,
  agentSlug,
  onArchive,
}: {
  workspaceSlug: string
  /** the owner token: an agent's slug, or `root` for the drive */
  agentSlug: string
  onArchive: () => void
}) {
  const { api } = useSpa()
  const chat = useQuery(defaultChatQueryOptions(api, workspaceSlug, agentSlug))
  const sending =
    useIsMutating({
      mutationKey: duetMutationKeys.workspaces.sessions.defaultMessage(workspaceSlug, agentSlug),
    }) > 0
  const state = archiveDefaultChatState({ session: chat.data, sending })
  if (state === 'absent') return null
  return <ArchiveDefaultChatButton disabled={state === 'busy'} onClick={onArchive} />
}

/**
 * The confirm. Nothing is destroyed here, so nothing about it is dressed as
 * destruction: an ordinary button, and copy that says where the conversation
 * goes and what keeps running.
 */
export function ArchiveDefaultChatDialog({
  workspaceSlug,
  target,
  onOpenChange,
  onArchived,
}: {
  workspaceSlug: string
  /** the owner being archived, or `null` while the dialog is shut */
  target: ArchiveDefaultChatTarget | null
  onOpenChange: (open: boolean) => void
  onArchived: () => void
}) {
  const t = useTranslations('duetApp.agentSurface.archive')
  const archive = useArchiveDefaultChat(workspaceSlug)
  const [failed, setFailed] = useState(false)

  const confirm = () => {
    if (target === null) return
    setFailed(false)
    archive.mutate(target.agentSlug, {
      onSuccess: () => {
        onOpenChange(false)
        onArchived()
      },
      /* Fail-closed: nothing was invalidated, so the panel still holds the
         conversation it always had. The dialog stays open and offers the same
         call again rather than reporting a failure somewhere the reader has
         already navigated away from. */
      onError: () => setFailed(true),
    })
  }

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={open => {
        if (archive.isPending) return
        if (!open) setFailed(false)
        onOpenChange(open)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('body', { name: target?.agentName ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t('error')}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={archive.isPending}>{t('cancel')}</AlertDialogCancel>
          {/* A plain button, not `AlertDialogAction`: the action one closes on
              click, which would take the dialog down before the write is known
              to have landed and leave a failure with nowhere to be said. */}
          <Button onClick={confirm} disabled={archive.isPending}>
            {archive.isPending ? <SpinnerGapIcon className="mr-2 size-4 animate-spin" /> : null}
            {failed ? t('retry') : t('confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
