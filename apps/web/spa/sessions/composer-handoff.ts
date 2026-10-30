/**
 * Words written into a conversation's composer before the conversation had an
 * address.
 *
 * The first message is sent from a composer the creation flow owns, and the
 * reader keeps typing while the session is minted. The conversation that
 * finally opens owns a different composer — sometimes on a different route,
 * after the creating surface has unmounted — so the draft crosses by session
 * id rather than through either component's state.
 */
const drafts = new Map<string, string>()

function handoffKey(workspaceSlug: string, sessionId: string): string {
  return `${workspaceSlug}:${sessionId}`
}

export function handOffComposerDraft(workspaceSlug: string, sessionId: string, text: string) {
  if (text.trim().length === 0) return
  drafts.set(handoffKey(workspaceSlug, sessionId), text)
}

/**
 * The handed-off draft, released once the current task ends. Not on first
 * read: a development double mount reads it twice in one commit, and the
 * second mount is the one that stays.
 */
export function takeComposerDraft(workspaceSlug: string, sessionId: string): string | undefined {
  const key = handoffKey(workspaceSlug, sessionId)
  const text = drafts.get(key)
  if (text !== undefined) {
    setTimeout(() => {
      if (drafts.get(key) === text) drafts.delete(key)
    }, 0)
  }
  return text
}
