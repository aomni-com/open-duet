import { MAX_AGENT_NAME_LENGTH } from '@repo/contract'

import type { AgentRosterRow, ReachableAgentRoster } from './agent-roster-view'
import { sanitizePromptLabel } from './prompt-text'

/**
 * Who this session reports to and who works for it. Pure formatting — who is
 * reachable and how each one is related is `readReachableAgentRoster`'s
 * answer, rendered here exactly as given so no reader of that roster can
 * describe a different one.
 *
 * Only the parent and the children are listed; siblings are counted. Reaching
 * an agent, naming one in a message, and listing the rest are rare enough that
 * the recipes live in the `duet` skill's agents reference, which a session
 * reads when it needs them, rather than riding in every launch. What stays
 * here is the policy the list is read with and the one rule a session cannot
 * look up in time: a sender is blocked until this turn ends.
 */
export function yourAgentsPrompt(args: { roster: ReachableAgentRoster }): string {
  // Self is the row the prompt never renders: `who-you-are.md` already owns
  // identity, and an agent that read itself as a colleague would hand work to
  // its own default session and wait for a turn it cannot end.
  const colleagues = args.roster.rows.filter(row => row.relationship !== 'self')
  const listed = colleagues.filter(row => row.relationship !== 'sibling')
  const siblings = colleagues.length - listed.length

  const lines: string[] = ['# Your agents', '']

  if (colleagues.length === 0) {
    lines.push('No other agents are registered in this workspace yet.', '')
    return lines.join('\n')
  }

  if (listed.length > 0) {
    lines.push('The agents above and below you, as of this turn:', '', ...listed.map(renderRow), '')
  }
  if (siblings > 0) {
    lines.push(
      `You also have ${siblings} ${siblings === 1 ? 'sibling' : 'siblings'}: ${siblings === 1 ? 'an agent' : 'agents'} beside you under the same parent.`,
      '',
    )
  }
  lines.push(
    'Hand work down to a child. Go to your parent to report or to ask, never to',
    'hand it a task. Reaching another agent, naming one in a message so the',
    'reader can open it, or listing your siblings is rare: when you need it,',
    'read the `duet` skill’s `references/agents.md` first and follow it.',
    '',
    'A message from another agent arrives as `<session_message … agent_slug="…">`.',
    'Its sender is blocked until your turn ends, so answer by ending your turn —',
    'with a question, if you need something from it first.',
    '',
  )
  return lines.join('\n')
}

function renderRow(row: AgentRosterRow): string {
  const name = sanitizePromptLabel(row.name, {
    fallback: 'Agent',
    maxLength: MAX_AGENT_NAME_LENGTH,
  })
  return [
    `- **${name}** (\`${row.slug}\`)`,
    // The enum value IS the prompt copy — one vocabulary for the roster, the
    // policy paragraph, and the picker's badge, so an agent and the person
    // composing beside it use the same word.
    row.relationship,
    ...(row.anchorPath === undefined ? [] : [`\`${row.anchorPath}\``]),
    ...(row.locked ? ['awaiting onboarding; ask the user to set it up before delegating'] : []),
  ].join(' — ')
}
