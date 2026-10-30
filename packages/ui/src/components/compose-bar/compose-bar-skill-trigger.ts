import type { MentionTagSpec } from './compose-bar-mention'
import { defineTrigger, type ComposeBarTrigger } from './compose-bar-mention-extension'
import type { ComposeBarSkill, ComposeBarSkills } from './types'

export const SKILL_TRIGGER_NODE = 'skillMention'

/**
 * The tag a picked skill becomes, exactly as the agent parses it.
 *
 * Exported because the composer is not its only reader: a sent message has to
 * render the same tag back as the same chip, and a second hand-written parser
 * there is precisely the divergence this shared grammar exists to prevent.
 */
export const SKILL_TAG: MentionTagSpec = { tag: 'Skill', attributes: ['name', 'path'] }

/**
 * `/` — the skills trigger.
 *
 * The agent runtime already reads `<Skill name="…" />` as an alias for the
 * `/name` a person could have typed, so the composer emits that tag rather than
 * inventing a second activation grammar. `path` rides along so the agent can
 * open the SKILL.md without a discovery step when the request is about the
 * skill itself.
 */
export function skillTrigger(read: () => ComposeBarSkills | undefined): ComposeBarTrigger {
  return defineTrigger<ComposeBarSkill>({
    node: SKILL_TRIGGER_NODE,
    char: '/',
    tag: SKILL_TAG,
    // The name is the whole of a skill's identity to a reader; its path is a
    // location, and matching on it would rank by folder depth.
    searchKeys: ['name'],
    getItems: () => read()?.items ?? [],
    toAttributes: skill => ({ name: skill.name, path: skill.path }),
    toLabel: attrs => `/${attrs.name ?? ''}`,
    onOpen: () => read()?.onOpen?.(),
  })
}
