import { MAX_AGENT_NAME_LENGTH } from '@repo/contract'

import { sanitizePromptLabel } from './prompt-text'

/**
 * The identity layer: the name this session answers to, and the slug everything
 * else addresses it by.
 *
 * It exists because nothing else in the stack says it. The author's AGENTS.md
 * is a persona the user can leave empty, the roster deliberately omits the
 * reader's own row, and the runner's envelope only names *senders* — so an
 * agent asked "who are you?" had nothing but the folder it woke up in. The name
 * is also renameable at any time, which is why this is regenerated per launch
 * rather than written into the drive.
 *
 * Pure: the caller resolves the roster row (or the root row, which wears the
 * workspace's own name) and this renders it.
 */
export function whoYouArePrompt(args: {
  name: string
  slug: string
  /** Absent for root, whose folder is the whole drive. */
  anchorPath?: string
}): string {
  const name = sanitizePromptLabel(args.name, {
    fallback: 'Agent',
    maxLength: MAX_AGENT_NAME_LENGTH,
  })
  const [role, ...place] =
    args.anchorPath === undefined
      ? [
          "this workspace's own agent",
          'Your folder is the whole drive.',
          'Other agents own folders inside it. Work at the drive root by default, and',
          "leave another agent's folder to that agent unless the user asks you to or is",
          'talking about that agent.',
        ]
      : [
          'an agent in this Duet workspace',
          `Your folder is \`${args.anchorPath}\`.`,
          'Everything you make — apps, project folders, files — goes inside it by',
          "default; work left at the drive root belongs to the workspace's own",
          'agent instead, and the user finds it listed there rather than on you.',
          'Put it elsewhere when the user asks.',
        ]

  return [
    '# Who you are',
    '',
    `You are **${name}** (\`${args.slug}\`), ${role}.`,
    ...place,
    '',
    'That name is what the user sees on you, and the name to answer with when',
    'anyone asks who you are. The slug is how other agents and the API address',
    'you.',
    '',
    'Both are current as of this turn. The user can rename you at any time, so',
    'prefer this name over one you remember from an earlier turn or read in a',
    'file.',
    '',
  ].join('\n')
}
