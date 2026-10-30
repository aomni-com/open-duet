/* ============================================================================
   What the last thing said in a conversation looks like on one line.

   The single owner of three facts, and deliberately nothing else knows any of
   them: which stored events are *messages*, how their markdown flattens into
   one line of prose, and where that line is cut.

   It is pure and it lives in the contract because both ends need the same
   answer for the same reason `bucketOf` does — the backend materializes the
   preview onto the row when an event is appended, and every reader of the wire
   is drawing what this function decided. A second implementation of "is this a
   message" would be a second answer to the question the row's whole point is
   to have settled once.
   ========================================================================= */
import { z } from 'zod'

import {
  SessionInputSenderSchema,
  type AgentSessionTimelineEvent,
  type SessionInputSender,
} from '../agent/index'
import { excerpt, sentMediaLabel, type SentMedia } from './excerpt'

/** The interior of a `step` event, named from the union rather than re-declared. */
type TurnStep = Extract<AgentSessionTimelineEvent, { type: 'step' }>['step']

/**
 * How wide a preview may be, in characters of flattened prose.
 *
 * One number for the server that cuts it, the row that draws it and the tests
 * that pin it. See the `lastMessage` column in the backend schema for what the
 * width costs a document and a write.
 */
export const CHAT_PREVIEW_MAX = 150

/**
 * Who said it — the identity, not a category.
 *
 * A two-value category — a person, or the agent — is true and useless here: a
 * workspace has several members, so it can say that somebody spoke and never
 * which of them, and a reader can honestly draw nothing from it.
 *
 * Every stored input event has carried a full `SessionInputSender` all along,
 * and the contract's rule for those is stated where they are declared: **ids
 * are stored, names are resolved at read time by their owners.** The preview
 * follows that rule rather than inventing a second, lossier one — so the same
 * `resolveSessionAuthor` the transcript uses for a bubble resolves the roster's
 * one-line row, and the two cannot disagree about what a person is called.
 *
 * The agent's own voice is not a sender: nothing submitted it, there is no id
 * behind it, and a reader draws no name for it — the row is already under the
 * agent's name. So it is a kind of its own beside the four.
 */
export const MessagePreviewAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent') }),
  ...SessionInputSenderSchema.options,
])
export type MessagePreviewAuthor = z.infer<typeof MessagePreviewAuthorSchema>

/** The agent's own voice: the one arm of that union with no identity to carry. */
const AGENT: MessagePreviewAuthor = { kind: 'agent' }

/**
 * The last human-readable thing said in a conversation, and who said it.
 *
 * No timestamp: the row that draws this already prints the moment it sorted
 * on, and two clocks on one line are two answers to one question.
 */
export const MessagePreviewSchema = z.object({
  /**
   * Flattened to one line and already cut to `CHAT_PREVIEW_MAX`.
   *
   * The width is deliberately not a bound here. It is a fact about what the
   * writer produced, not about what a reader may accept, and stamping it on
   * the wire would mean that lowering the constant rejects the whole activity
   * response for every row written before the change. Empty is bounded,
   * because nothing can ever make a stored preview become empty: the rule
   * answers `null` instead of writing one.
   */
  text: z.string().min(1),
  author: MessagePreviewAuthorSchema,
})
export type MessagePreview = z.infer<typeof MessagePreviewSchema>

/** Apply the materialization rule before a locally committed input becomes an event. */
export function messagePreviewFromInput(
  author: SessionInputSender,
  body: string,
  media: SentMedia = {},
): MessagePreview | null {
  return sentBy(author, body, media)
}

/**
 * This event as a line of prose, or `null` when it is not something anyone said.
 *
 * The message set is exactly what the browser's own transcript turns into
 * bubbles: the three input events, in a person's voice, and the agent's two —
 * the message it authors outside a turn, and a finished text step inside one.
 * Everything else a session journals — a tool call, a terminal marker, a todo
 * list, a reasoning trace — is work, not conversation, and answers `null`.
 *
 * The switch is exhaustive over the stored union on purpose. A new event type
 * cannot be added without someone here deciding whether it is a message; a
 * `default` arm would decide it for them, silently, and always the same way.
 */
export function messagePreviewOf(event: AgentSessionTimelineEvent): MessagePreview | null {
  switch (event.type) {
    case 'prompt_submitted':
      return sentBy(event.sender, event.prompt, event)
    case 'note_submitted':
      return sentBy(event.sender, event.note, event)
    case 'answer_submitted':
      return sentBy(event.sender, event.answer, event)
    case 'agent_message':
      return spokenBy(AGENT, event.message)
    case 'step':
      return stepPreview(event.step)
    // `session_created` carries the same prompt as the `prompt_submitted`
    // beside it, and previewing both would make the opening word of every
    // conversation the only one written twice.
    case 'session_created':
    case 'interrupt_requested':
    case 'turn_started':
    case 'task_started':
    case 'task_output':
    case 'task_settled':
    case 'heartbeat':
    case 'todos':
    case 'follow_up_queue':
    case 'state_machine':
    case 'memory':
    case 'usage':
    case 'system':
    case 'router_switch':
    case 'complete':
    case 'ask':
    case 'interrupted':
    case 'sleep':
      return null
  }
}

/**
 * A turn step as prose, by the same rule and for the same reason.
 *
 * Only finished text is a message. `reasoning` is the agent thinking rather
 * than speaking — the transcript draws it as a separate, collapsible thing —
 * and a tool call is work with a name, not a sentence.
 */
function stepPreview(step: TurnStep): MessagePreview | null {
  switch (step.type) {
    case 'text':
      return spokenBy(AGENT, step.text)
    case 'reasoning':
    case 'tool_call_start':
    case 'tool_call':
    case 'system':
    // The deltas are here because the union has them, not because this is
    // where they are stopped. They never reach a stored event at all — see
    // `classifyAgentTurnEvent`, which calls them ephemeral, and the relay,
    // whose store path cannot take one.
    case 'text_delta':
    case 'reasoning_delta':
      return null
  }
}

/**
 * A person's input: its prose, or — when it was files alone — the files. A
 * files-only send is still the newest thing said, and a row that skipped it
 * would go on showing the message before it as the last word.
 */
function sentBy(author: SessionInputSender, body: string, media: SentMedia): MessagePreview | null {
  return spokenBy(author, body) ?? spokenBy(author, sentMediaLabel(media))
}

/**
 * A raw message body as the one line a row can hold.
 *
 * `null` rather than an empty preview when there is nothing left after the
 * flatten: a message that was only a fenced diagram or only whitespace has no
 * prose to show, and a row drawing an empty band reads as a line that failed
 * rather than an agent nobody has written to.
 */
function spokenBy(author: MessagePreviewAuthor, body: string): MessagePreview | null {
  const text = excerpt(flattenMarkdown(body), CHAT_PREVIEW_MAX)
  return text.length === 0 ? null : { text, author }
}

/**
 * Markdown as the prose inside it.
 *
 * Not a parser and deliberately not one: this is a single line under a name in
 * a list, so the job is to stop syntax being *drawn* — a row that opens with
 * `## ` or `- [ ]` reads as a bug — rather than to render a document. What
 * survives is the words, in their order.
 *
 * Fenced code is dropped whole rather than flattened. A pasted stack trace or
 * a diff is the one kind of message whose first hundred characters say nothing
 * at all about it, and the prose around the fence is what the reader wanted.
 */
function flattenMarkdown(body: string): string {
  return (
    body
      .replace(/^[^\S\n]*```[^\n]*$[\s\S]*?^[^\S\n]*```[^\n]*$/gm, ' ')
      // An unterminated fence — the shape a message that is *only* code takes
      // while it is still being written — runs to the end.
      .replace(/^[^\S\n]*```[\s\S]*$/m, ' ')
      // Images before links: the syntax differs by one leading character, and
      // an image's alt text is the only prose it has.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Line-leading furniture: headings, quotes, bullets, ordinals, task
      // boxes, and the rules between sections.
      .replace(/^[^\S\n]*(?:#{1,6}[^\S\n]+|>[^\S\n]?|[-*+][^\S\n]+|\d+\.[^\S\n]+)/gm, '')
      .replace(/^[^\S\n]*(?:[-*_][^\S\n]*){3,}$/gm, ' ')
      .replace(/^\[[ xX]\][^\S\n]+/gm, '')
      // Inline emphasis and code, unwrapped rather than removed: the marks are
      // punctuation around words the reader still wants.
      .replace(/(\*\*|__|~~|\*|_|`)/g, '')
  )
}
