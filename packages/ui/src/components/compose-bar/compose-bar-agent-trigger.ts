import type { MentionTagSpec } from './compose-bar-mention'
import { defineTrigger, type ComposeBarTrigger } from './compose-bar-mention-extension'
import type { ComposeBarAgent, ComposeBarAgents } from './types'

export const AGENT_TRIGGER_NODE = 'agentMention'

/**
 * The tag a named agent becomes.
 *
 * Exported for the same reason the skill tag is: a sent message has to render
 * the tag back as the chip it was composed from, and a second hand-written
 * parser there is the divergence this shared grammar exists to prevent.
 *
 * `slug` is the load-bearing attribute — it is the address every agent API
 * takes. `name` rides along so the message still reads like the conversation
 * it was written in, and `path` so the agent can act on the folder without a
 * lookup. Both are omitted when there is nothing to write: an agent may have
 * no display name of its own, and the drive root has no folder.
 */
export const AGENT_TAG: MentionTagSpec = { tag: 'Agent', attributes: ['name', 'slug', 'path'] }

/**
 * `@` — the agents trigger.
 *
 * The tag is a pointer, not a command: the agent reading it already has these
 * colleagues and the recipes for reaching them in its prompt, so naming one
 * tells it which slug the request is about and nothing more. Nothing is
 * invoked by mentioning it.
 */
export function agentTrigger(read: () => ComposeBarAgents | undefined): ComposeBarTrigger {
  return defineTrigger<ComposeBarAgent>({
    node: AGENT_TRIGGER_NODE,
    char: '@',
    tag: AGENT_TAG,
    // Two colleagues may share a display name, so the slug has to be typeable
    // — it is the only thing that tells them apart.
    searchKeys: ['name', 'slug'],
    // Tighter than the matcher's default, because `@` is a character people
    // type in ordinary prose about people who are not agents. At the default
    // looseness a subsequence was enough: `@sarah` offered "Cartographer" and
    // `@dave` offered "Duet", so a reflexive Enter inserted a colleague nobody
    // named. This is the loosest setting at which those stop matching while
    // every real abbreviation still does.
    searchThreshold: 0.4,
    getItems: () => read()?.items ?? [],
    toAttributes: agent => ({
      // An agent with no name of its own answers to its slug; writing the slug
      // as a name would invent one.
      ...(agent.name === agent.slug ? {} : { name: agent.name }),
      slug: agent.slug,
      ...(agent.path === undefined ? {} : { path: agent.path }),
    }),
    toLabel: attrs => `@${attrs.name || attrs.slug || ''}`,
    onOpen: () => read()?.onOpen?.(),
  })
}
