'use client'

/* ============================================================================
   Archiving an owner's default chat.

   The gesture is one write and it is not an archive: the pointer on the owner's
   row — `agents.defaultSessionId`, or `workspaces.rootDefaultSessionId` for the
   drive — is set to nothing. Nothing is deleted, no `archiveState` moves, and
   the turn that was running keeps running. The conversation simply stops being
   the one this owner's panel opens on, which drops it back into the jobs list
   (that list withholds exactly the pointed-at row, under `excludeDefault`) and
   leaves the panel on its day-one empty state until the next message mints a
   fresh chat.
   ========================================================================= */
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useSpa } from '../context'
import { invalidateDefaultChatPointer } from './default-chat'

/**
 * Clear an owner's default-chat pointer. The argument is the owner token — an
 * agent slug, or `root` for the drive itself.
 *
 * Fail-closed, like agent deletion: nothing is invalidated until the server
 * confirms, so a failed write leaves the panel holding the conversation it
 * always had and the confirm dialog offers the same call again.
 */
export function useArchiveDefaultChat(workspaceSlug: string) {
  const { api } = useSpa()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agentSlug: string) => api.setDefaultSession(workspaceSlug, agentSlug, null),
    /* The refresh is the alias's own, shared with the gesture that moves the
       pointer the other way — the first message into an owner. See
       `invalidateDefaultChatPointer`. */
    onSuccess: () => invalidateDefaultChatPointer(queryClient, workspaceSlug),
  })
}

/** absent: nothing to archive · busy: a first message is landing · ready */
export type ArchiveDefaultChatState = 'absent' | 'busy' | 'ready'

/**
 * Whether this owner's chat can be archived right now.
 *
 * Absent beats busy, and absent means *not drawn at all*: an owner nobody has
 * written to yet has no conversation to demote, and a control whose only
 * outcome is a no-op is worse than no control.
 *
 * Busy is about the first message, not about the running turn — an archived
 * thread keeps working, which is the whole point of the copy. A send in flight
 * ends by stamping the owner's pointer at the session it just minted, so
 * archiving underneath it would clear a pointer that is about to be written
 * again and the panel would come back holding the chat the reader archived.
 */
export function archiveDefaultChatState(input: {
  /** the alias's answer: `null` is "no chat yet", `undefined` is not known yet */
  session?: { id: string } | null
  sending: boolean
}): ArchiveDefaultChatState {
  if (input.session == null) return 'absent'
  return input.sending ? 'busy' : 'ready'
}
