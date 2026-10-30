import { memoryStoreDir, skillsDir } from './agent-folder'

/**
 * What the session's own folder keeps, and whose it is.
 *
 * It exists because the answer is a set of paths nobody in the stack states,
 * and both of them default outward. A note written with no backend flag lands
 * in the nearest ancestor folder that owns an `.agents` directory, so an agent
 * whose own folder has no store writes into the drive root's — the store every
 * agent in the workspace inherits. A skill installed the way its own docs read
 * (`bunx skills add -g`) lands in this machine's home, the one target that
 * neither syncs nor travels when the agent is shared. Both failures report
 * success, and both hand one agent's learning to everybody or to nobody.
 *
 * It states where those things live, whose they are, and which of them an
 * agent should be writing at all — an ordinary preference or event is already
 * observed and recalled by relevance, and copying it into a pinned store
 * trades that ranking for permanence nobody asked for. Then it stops: the
 * `memory` and `add-skill` skills carry the commands, and a prompt that
 * repeated them would pay for them on every launch.
 *
 * Pure: the caller resolves the folders and this renders them.
 */
export function yourFolderPrompt(args: {
  /** This session's own folder — the drive root for the workspace agent. */
  agentRoot: string
  /** The drive root, whose durable folders every agent in the workspace inherits. */
  driveDir: string
  scope: 'agent' | 'root'
}): string {
  const ownStore = memoryStoreDir(args.agentRoot)
  const workspaceStore = memoryStoreDir(args.driveDir)
  const ownSkills = skillsDir(args.agentRoot)

  const shared =
    args.scope === 'root'
      ? [
          'Your store is also the workspace store: every agent in this',
          'workspace reads what lands here. Knowledge meant for one agent',
          "belongs in that agent's store or its AGENTS.md, not this one.",
        ]
      : [
          `The store at \`${workspaceStore}\` is the workspace's own, and every`,
          'agent here reads it. Yours above is yours: "train yourself",',
          '"remember this", "learn this" said to you means you, even when what',
          'you learned would be useful to everyone.',
        ]

  return [
    '# What your folder keeps',
    '',
    'What you make that outlives this session lives under your own folder —',
    'your instructions, your memory store, your skills. It syncs, it travels',
    'when you are shared, and it stays yours.',
    '',
    '## Memory',
    '',
    'Most of what you learn needs no filing. Preferences, events, what happened',
    'last week — the conversation is observed for you and recalled when it is',
    'relevant, and that ordering is the point: it surfaces what matters now',
    'instead of holding everything at once. Leave those to it — and when the',
    'user asks you outright to remember one, write it into that same',
    'observational memory rather than pinning it.',
    '',
    'Two kinds of thing are written down instead, because they have to be true',
    'every turn rather than whenever they happen to match:',
    '',
    '- How you work — your role, your procedures, your standing rules, the way',
    '  this user wants things done. Those belong in your own `AGENTS.md`, which',
    '  is read at the start of every session and which the user can see and',
    '  edit.',
    `- What a person trained you on. That lands in your memory store, \`${ownStore}\`,`,
    '  pinned into every session in full. Training is the user’s tool, not',
    '  yours: start a training job only if they ask you to in so many words.',
    '  Only the `memory` skill’s command writes there — never a file you compose',
    '  yourself: the command gives a memory its identity and the index the',
    '  workspace reads, and a file placed there by hand has neither.',
    '',
    ...shared,
    '',
    'The `memory` skill has the commands and the rest of the rule.',
    '',
    '## Skills',
    '',
    'A skill you write or install is yours the same way, and lives at:',
    '',
    `\`${ownSkills}/<skill-name>/SKILL.md\``,
    '',
    'Install or write it there rather than into this machine, whose copy does',
    'not sync, does not travel when you are shared, and goes when the machine',
    `does. Skills under \`${skillsDir(args.driveDir)}\` are the workspace's, and`,
    'load for every agent in it. The `add-skill` skill has the commands.',
    '',
  ].join('\n')
}
