import {
  DEFAULT_AGENT_NAME,
  ROOT_AGENT_SCOPE,
  type AgentInputEvent,
  type SessionInputSender,
} from '@repo/contract'

import type { Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'

// The identity the model is allowed to see, resolved from the durable
// identity-only sender at composition time. A human's internal user id is
// deliberately absent: names and emails are the useful current identity, and
// the id is an internal handle no model turn should learn.
export type ResolvedModelSender =
  | { kind: 'user'; email: string; fullName?: string }
  | { kind: 'app'; appId: string; slug?: string }
  | { kind: 'session'; sessionId: string; agentSlug?: string; agentName?: string }
  | { kind: 'system' }

// A durable input row plus the identity resolved for this one composition.
// The whole row travels so the renderer reads the sequence and the row's own
// `createdAt` rather than a projection that has already lost them.
export type AttributedInputRow = {
  seq: number
  createdAt: number
  event: AgentInputEvent
  sender: ResolvedModelSender
}

// Current identity, read fresh for this one composition. Nothing here is
// persisted back onto the durable row: a rename must show up in the next
// delivery, and a stale copy in the timeline would be a second source of truth.
export async function resolveCurrentModelSender(
  ctx: QueryCtx,
  workspaceId: Id<'workspaces'>,
  sender: SessionInputSender,
): Promise<ResolvedModelSender> {
  if (sender.kind === 'system') return { kind: 'system' }
  if (sender.kind === 'session') {
    const sessionId = ctx.db.normalizeId('agentSessions', sender.sessionId)
    const session = sessionId === null ? null : await ctx.db.get(sessionId)
    if (session === null || session.workspaceId !== workspaceId) {
      return { kind: 'session', sessionId: sender.sessionId }
    }
    if (session.agentId === undefined) {
      const workspace = await ctx.db.get(workspaceId)
      return {
        kind: 'session',
        sessionId: sender.sessionId,
        agentSlug: ROOT_AGENT_SCOPE,
        agentName: workspace?.duetName ?? DEFAULT_AGENT_NAME,
      }
    }
    const agent = await ctx.db.get(session.agentId)
    return agent === null || agent.workspaceId !== workspaceId
      ? { kind: 'session', sessionId: sender.sessionId }
      : {
          kind: 'session',
          sessionId: sender.sessionId,
          agentSlug: agent.slug,
          ...(agent.name === undefined ? {} : { agentName: agent.name }),
        }
  }
  if (sender.kind === 'app') {
    const appId = ctx.db.normalizeId('apps', sender.appId)
    const app = appId === null ? null : await ctx.db.get(appId)
    // A deleted app — or one named from outside this workspace — degrades to
    // the durable id rather than borrowing another workspace's slug.
    return app === null || app.workspaceId !== workspaceId
      ? { kind: 'app', appId: sender.appId }
      : { kind: 'app', appId: sender.appId, slug: app.slug }
  }
  const userId = ctx.db.normalizeId('users', sender.userId)
  const user = userId === null ? null : await ctx.db.get(userId)
  // A human author with no row is a durable invariant failure: there is no
  // truthful identity left to render, and the internal id is not an acceptable
  // substitute, so the whole delivery fails rather than half-attributing it.
  if (user === null) throw new Error('Session input author not found')
  const fullName = user.name?.trim()
  return {
    kind: 'user',
    email: user.email,
    ...(fullName === undefined || fullName === '' ? {} : { fullName }),
  }
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

// One single-pass escaper for both attribute values and element bodies, so a
// body that spells an envelope, a closing tag, or a system reminder arrives as
// inert text. Single pass is what keeps `&lt;` from becoming `&amp;lt;`.
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, character => XML_ESCAPES[character]!)
}

function attribute(name: string, value: string): string {
  return ` ${name}="${escapeXml(value)}"`
}

function identityAttributes(sender: ResolvedModelSender): string {
  switch (sender.kind) {
    case 'user':
      return (
        (sender.fullName === undefined ? '' : attribute('user_full_name', sender.fullName)) +
        attribute('user_email', sender.email)
      )
    case 'app':
      return (
        attribute('app_id', sender.appId) +
        (sender.slug === undefined ? '' : attribute('app_slug', sender.slug))
      )
    case 'session':
      return (
        attribute('session_id', sender.sessionId) +
        (sender.agentSlug === undefined ? '' : attribute('agent_slug', sender.agentSlug)) +
        (sender.agentName === undefined ? '' : attribute('agent_name', sender.agentName))
      )
    case 'system':
      return ''
  }
}

function bodyText(event: AgentInputEvent): string {
  if (event.type === 'prompt_submitted') return event.prompt
  if (event.type === 'note_submitted') return event.note
  return event.answer
}

function renderAttachments(event: AgentInputEvent): string {
  if (event.attachments === undefined || event.attachments.length === 0) return ''
  const files = event.attachments
    .map(
      attachment =>
        `    <file${attribute('path', attachment.path)}${attribute('bytes', String(attachment.bytes))}${attachment.mimeType === undefined ? '' : attribute('mime_type', attachment.mimeType)}/>`,
    )
    .join('\n')
  return `\n  <attached_files note="Files the sender attached to this message, saved into your folder. Read them and organize them into your own structure.">\n${files}\n  </attached_files>`
}

function renderElement(row: AttributedInputRow, role: 'message' | 'note'): string {
  const name = `${row.sender.kind}_${role}`
  // Attribute order is contract behavior: sequence, the row's own clock, the
  // answer marker, then whatever current identity the sender kind exposes.
  const attributes =
    attribute('seq', String(row.seq)) +
    attribute('timestamp', new Date(row.createdAt).toISOString()) +
    (row.event.type === 'answer_submitted' ? attribute('kind', 'answer') : '') +
    identityAttributes(row.sender)
  return `<${name}${attributes}>${escapeXml(bodyText(row.event))}${renderAttachments(row.event)}</${name}>`
}

// The only place a durable input becomes model-visible bytes. Notes are grouped
// ahead of the primary input because that is the delivery semantic; their own
// `seq` and `timestamp` keep the chronology truthful even when a note landed
// after the prompt it now precedes.
export function renderRunnerInput(args: {
  notes: AttributedInputRow[]
  input: AttributedInputRow
  // The agent's own materialized first message. It precedes everything: it
  // was on screen before the user typed, and the user's prompt is often an
  // answer to it.
  agentFirstMessage?: string
}): string {
  const opening =
    args.agentFirstMessage === undefined
      ? ''
      : `<agent_first_message>${escapeXml(args.agentFirstMessage)}</agent_first_message>\n`
  const primary = renderElement(args.input, 'message')
  if (args.notes.length === 0) return `${opening}${primary}`
  const notes = [...args.notes]
    .sort((left, right) => left.seq - right.seq)
    .map(row => `  ${renderElement(row, 'note')}`)
    .join('\n')
  return `${opening}<queued_notes>\n${notes}\n</queued_notes>\n${primary}`
}
