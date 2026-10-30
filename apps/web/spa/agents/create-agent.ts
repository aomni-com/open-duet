import {
  AppSlugSchema,
  MAX_SLUG_LENGTH,
  normalizeSlug,
  type RegisterAgentResponse,
} from '@repo/contract'

import type { SpaApi } from '../context'

/* ============================================================================
   Creating an agent from nothing but a name.

   The marketplace fills a seat somebody else authored; this fills an empty
   one. The user names it, we register the leanest agent that can hold a
   conversation, and the agent is then built FROM that conversation — its
   prompt, skills and apps grow through chat and the Train tab, not through a
   form. So the starter files are deliberately thin: a folder contract and a
   first message that says how to do the building, nothing pretending to be a
   role the user never wrote.
   ========================================================================= */

export type CreateAgentApi = Pick<SpaApi, 'writeWorkspaceFile' | 'registerAgent'>

/**
 * The slug a name earns, dodged around everything that would make it a lie.
 *
 * `taken` is the live roster's slugs. `marketplace` is excluded by hand: the
 * validator allows it, but `/agents/marketplace` is the catalog's address, so
 * an agent wearing it would exist and be unreachable. Validator-reserved words
 * (`root`, `api`, …) and grammar violations fall out of the same loop, because
 * a numbered suffix turns a reserved word into an ordinary one.
 */
export function agentSlugFromName(name: string, taken: ReadonlySet<string>): string {
  const base = normalizeSlug(name) || 'agent'
  const unavailable = (slug: string) =>
    taken.has(slug) || slug === 'marketplace' || !AppSlugSchema.safeParse(slug).success
  if (!unavailable(base)) return base
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const candidate = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '') + suffix
    if (!unavailable(candidate)) return candidate
  }
}

/**
 * The starter files, written before registration so the agent's folder is
 * never registered empty.
 *
 * The AGENTS.md is a scaffold that says it is one — the agent reads it every
 * turn, so its one real instruction is to help the user build it out rather
 * than role-play a seat nobody wrote. The suggested first message is where the
 * user learns the same thing from their side, train link included.
 */
export function starterAgentFiles(args: { name: string; workspaceSlug: string; slug: string }): {
  agentsMd: string
  agentJson: string
} {
  const { name, workspaceSlug, slug } = args
  const agentsMd = `# ${name}

A new agent, being built by its owner. It has no fixed role yet — its job,
skills and apps take shape through the conversations in this workspace.

## How to behave while being built

Help your owner shape you. When they describe work they want handled, do the
work AND propose what should become permanent: an instruction added to this
file, a skill worth writing, an app worth building. Make the proposal concrete
— say what you would add and where — and apply it when they agree.

Be honest about being new. If a request assumes expertise or context this file
does not yet carry, say so and ask for it rather than improvising a persona.

## Artifacts

Keep what you produce in this folder, organised by task. Update this file as
your role firms up, so the next session starts where this one ended.
`
  const suggestedFirstMessage = `Hi — I'm **${name}**, and I'm brand new. Right now I'm a blank seat: you get to decide what I do.

Tell me about the work you want me to own, and we'll build me up together:

- **Chat with me** to shape my role — I can write my own instructions, skills, and even build apps for the work you describe.
- **[Train me](/w/${workspaceSlug}/train/${slug})** — teach me facts, preferences, and context I should always remember.

What should I take off your plate first?`
  const agentJson = `${JSON.stringify({ triggers: [], suggestedFirstMessage }, null, 2)}\n`
  return { agentsMd, agentJson }
}

/**
 * Write the starter folder, then register it. Files first: registration
 * anchors the path, and anchoring an empty folder would race the writes
 * against the first sync's view of what the folder is.
 */
export async function createOwnAgent(
  api: CreateAgentApi,
  workspaceSlug: string,
  args: { name: string; slug: string },
): Promise<RegisterAgentResponse> {
  const path = `agents/${args.slug}`
  const files = starterAgentFiles({ name: args.name, workspaceSlug, slug: args.slug })
  const encoder = new TextEncoder()
  await api.writeWorkspaceFile(workspaceSlug, `${path}/AGENTS.md`, encoder.encode(files.agentsMd), {
    contentType: 'text/markdown',
  })
  await api.writeWorkspaceFile(
    workspaceSlug,
    `${path}/agent.json`,
    encoder.encode(files.agentJson),
    { contentType: 'application/json' },
  )
  return await api.registerAgent(workspaceSlug, { path, slug: args.slug, name: args.name })
}
