import { chatLandingOf, type MapPlace } from '../drive/agents-map-url'
import { workHomeUrl, workSessionUrl } from '../team-space/work-destination'

export type SessionLineageChip = {
  label: string
  href?: string
  deleted: boolean
}

/**
 * The "started by" badge: which conversation minted this one.
 *
 * The link is the parent's permission-safe Work address. A lineage chip can be
 * opened by people who have Work access without Build access, so it must never
 * make Build the required way back to the conversation that delegated a job.
 * `ownerSlug` is that agent (`root` for a session no agent owns); until the
 * caller has resolved it, or when the parent is deleted, the chip stays
 * visible but unlinked — a badge that says who started this is true even when
 * there is nowhere to go.
 *
 * `chatId` is that owner's own chat, and it is the common case here rather than
 * an edge one: a session an agent spawned was usually spawned from the
 * conversation you have with it. Build represents that chat at the agent root;
 * Work represents it at the selected-agent home, so the fallback lands there.
 * Every other parent keeps its agent-scoped session path and opts into Work
 * explicitly. Absent — no chat, or nobody has answered yet — the ordinary Work
 * session address stands.
 */
export function sessionLineageChip(input: {
  workspaceSlug: string
  parentId: string
  parent?: { title: string }
  ownerSlug?: string
  chatId?: string
  deleted?: boolean
}): SessionLineageChip {
  const deleted = input.deleted === true && input.parent === undefined
  const ownerSlug = input.ownerSlug
  const place: Extract<MapPlace, { kind: 'sessions' }> | undefined =
    ownerSlug === undefined
      ? undefined
      : { kind: 'sessions', agentSlug: ownerSlug, sessionId: input.parentId }
  const chatLanding = place === undefined ? null : chatLandingOf(place, input.chatId)
  const href =
    deleted || place === undefined
      ? undefined
      : chatLanding !== null
        ? workHomeUrl(input.workspaceSlug, ownerSlug)
        : workSessionUrl(input.workspaceSlug, place.agentSlug, input.parentId)
  return {
    label: sessionDisplayLabel(input.parentId, input.parent?.title),
    ...(href === undefined ? {} : { href }),
    deleted,
  }
}

/**
 * What a session is called when it is named as itself — its own title, or the
 * durable handle its owner can still look up. The lineage chip and the
 * transcript author both land here, so the fallback has exactly one home.
 *
 * A transcript author does not always get this far: a session that belongs to
 * an agent is named by that agent instead, because "who messaged me" is a
 * question about the author and not about the conversation they wrote from.
 * That rule is one level up, in `resolveSessionAuthor` — the lineage chip
 * deliberately does not share it, since "started by" names the conversation
 * this one was minted from, which is the thing it links to.
 */
export function sessionDisplayLabel(sessionId: string, title: string | undefined): string {
  return title !== undefined && title.trim() !== '' ? title : shortIdLabel(sessionId)
}

/** The stable fallback for any identity whose current name is unavailable. */
export function shortIdLabel(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 12)}…`
}
