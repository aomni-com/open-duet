import type { Agent } from '@repo/contract'

// One owner for "what an agent row is called on screen". Kept in the SPA on
// purpose: the map (slice 05) deliberately rejected a contract-level display
// adapter — naming is presentation, and the server's own display rule lives in
// its model.
export function agentDisplayName(agent: Pick<Agent, 'name' | 'slug'>): string {
  return agent.name ?? agent.slug
}

// …and what is said under it. The slug is the name every other part of the
// product uses — the folder, the URL, the `@` — so an agent that has been given
// a name of its own is the one place the two diverge and both are worth having.
// `undefined` when they have not diverged: `agentDisplayName` has already
// returned the slug, and a line repeating it is one line of noise under every
// face on a fresh drive.
export function agentSubtitle(agent: Pick<Agent, 'name' | 'slug'>): string | undefined {
  return agent.name === undefined ? undefined : agent.slug
}
