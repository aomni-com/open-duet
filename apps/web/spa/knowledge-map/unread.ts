/* ============================================================================
   The unread axis.

   Lifted out of `palette.ts`, whose subject is colour and whose own note on
   this mark said in so many words that unread is *not* a tone.

   ---- the rule ----
   **One mark, on the face, for the owner's own conversation.** Nothing else on
   this map says anything about unread:

   - an owner's **face** opens the agent view, whose conversation is that
     owner's own chat, so the face is where that chat asks for you;
   - the **Jobs seat** is organisational. It says an agent has work and opens
     that work in Work, the surface that lists it. It carries no unread and no
     state roll-up, because the list it opens answers both questions properly,
     per row, with room to name which row it is talking about;
   - a **job bead**, once an agent is unfolded, stands for one conversation of
     its own, so it wears that conversation's unread — as a ring, because a
     bead is too small to hang a dot off (see `BeadBody`);
   - **nothing else** wears a mark at all.

   Whatever its shape, the mark is one hue: `--unread`, the same amber every
   sidebar's unread dot wears (`ChatMarks`).

   ---- why a dot and not a count ----
   An owner has exactly one default chat, so the only honest count is one. A
   numeral that can only ever read `1` is a dot that costs more pixels and
   invites the reader to look for a second digit. The map's own history agrees
   from the other direction: a numeral was reserved for a *set*, and this is not
   one.
   ========================================================================= */
import type { Job, MapNode } from './types'

/**
 * Whether this node's own conversation has something the reader has not seen.
 *
 * A function of the node alone, and the only producer of the mark. Two draw
 * sites — a face on the ring and the face at the centre — would otherwise be
 * two places free to disagree about what the mark means.
 */
export function hasUnread(node: MapNode): boolean {
  switch (node.kind) {
    /* The owner's own conversation, never its work. The seat beside this face
       used to answer the second question and deliberately no longer does. */
    case 'core':
      return chatIsUnread(node.agent.chat)
    case 'agent':
      return chatIsUnread(node.data.chat)
    default:
      return false
  }
}

/**
 * Whether an owner's own conversation has something the reader has not seen.
 *
 * `some`, not a count: the set holds at most one, and asking whether anything
 * in it is unread is the question the mark actually draws. An absent set is an
 * owner whose pointer names nothing, or whose read has not answered — nothing to
 * say, not zero of something.
 *
 * Exported because the rule now has a second draw site. Build's roster column
 * is a list of the same owners the ring draws, and a row there *is* the
 * conversation with one — so it wears the same mark, from the same producer.
 * Two copies of "is this owner's chat unread" is exactly the drift `hasUnread`
 * was written to prevent, one surface further out.
 */
export function chatIsUnread(chat: readonly Job[] | undefined): boolean {
  return (chat ?? []).some(item => item.unread)
}
