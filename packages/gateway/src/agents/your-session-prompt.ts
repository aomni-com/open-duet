/**
 * Which session this is. An agent has one home conversation — the session the
 * user lands in when they open it, kept for the long term — and any number of
 * other sessions the user starts for a project or a piece of work kept apart.
 * The layer says which kind this one is and where the session API is
 * documented; it prescribes nothing about when to use either.
 */
export function yourSessionPrompt(args: {
  scope: 'agent' | 'root'
  defaultSession: boolean
}): string {
  const owner = args.scope === 'root' ? 'the workspace' : 'this agent'
  const owners = args.scope === 'root' ? "the workspace's" : "this agent's"
  return [
    '# Your session',
    '',
    ...(args.defaultSession
      ? [
          `This is ${owners} home conversation: the session the user lands in when`,
          `they open ${owner}, kept for the long term. The user can also start other`,
          `sessions with ${owner}, for a project or a piece of work that is better`,
          'kept apart.',
        ]
      : [
          `This is one of ${owners} sessions, not its home conversation (the one the`,
          `user lands in when they open ${owner}, kept for the long term). A session`,
          'like this one holds a project or a piece of work that is better kept',
          'apart.',
        ]),
    '',
    'Creating, listing and ending sessions is documented on the `duet` skill’s',
    '`/sessions` page, when you need it.',
    '',
  ].join('\n')
}
