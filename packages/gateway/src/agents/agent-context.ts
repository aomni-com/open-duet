import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import {
  agentResolutionCandidate,
  resolveNearestAgent,
  type AgentResolutionCandidate,
  type GatewayAgentConfig,
  type GatewayAnchor,
  type GatewayAppConfig,
} from '@repo/contract'

import { resolveAgentPath } from '../runner/process-runner'
import { ensureMemoryStore } from './agent-folder'
import { readReachableAgentRoster, type AgentRosterScope } from './agent-roster-view'
import { containedDriveRealpath } from './contained-drive-file'
import { parentSessionPrompt } from './parent-session-prompt'
import { showingFilesPrompt } from './showing-files-prompt'
import { whoYouArePrompt } from './who-you-are-prompt'
import { yourAgentsPrompt } from './your-agents-prompt'
import { yourAppsPrompt } from './your-apps-prompt'
import { yourFolderPrompt } from './your-folder-prompt'
import { yourSessionPrompt } from './your-session-prompt'

// An anchorId is used as a path segment under the state dir; it must never be
// able to traverse. Convex ids are alphanumeric, but the VM boundary
// (`/v1/anchors/reconcile`) accepts arbitrary strings, so validate here.
export function assertSafeAnchorSegment(anchorId: string): void {
  if (
    anchorId.length === 0 ||
    anchorId.includes('/') ||
    anchorId.includes(sep) ||
    anchorId.includes('\0') ||
    anchorId === '.' ||
    anchorId === '..' ||
    anchorId.includes('..')
  ) {
    throw new Error('Invalid agent anchor id')
  }
}

/**
 * Where one agent's private state lives — generated prompts, its memory
 * database — outside the drive, so the agent can neither read nor edit it.
 */
export function agentStateDirPath(stateDir: string, anchorId: string): string {
  assertSafeAnchorSegment(anchorId)
  return join(stateDir, 'agents', anchorId)
}

/**
 * Two rails open this database — the session spawn that hands the runner its
 * `--db`, and the reflect pass that condenses it overnight — and they must
 * never disagree about which file an agent remembers into.
 */
export function agentMemoryDbPath(stateDir: string, anchorId: string): string {
  return join(agentStateDirPath(stateDir, anchorId), 'memory.db')
}

// An agent prompt is passed to the runner as its system prompt. A symlink inside
// the drive can point outside it (e.g. at gateway secrets under ~/.duet), so
// containment must hold for the real filesystem target, exactly as
// `resolveAgentCwd` enforces for the working directory. This is the sole owner
// of prompt path construction.
function containedSystemPromptFile(
  driveDir: string,
  agentRoot: string,
  promptName: 'AGENTS.md' | 'ONBOARDING.md',
): string | undefined {
  const promptFile = join(agentRoot, promptName)
  if (!existsSync(promptFile)) return undefined
  if (containedDriveRealpath(driveDir, promptFile) === undefined) return undefined
  return promptFile
}

// Written per-agent outside the drive so it never syncs, never publishes, and
// cannot be edited by the agent it instructs. The runner renders each
// `--system-prompt-file` as its own `<system_prompt_file>` block in the order
// given, so this arrives after the author's ONBOARDING.md rather than competing
// with it.
const ONBOARDING_COMPLETION_PROMPT_FILE = 'onboarding-completion.md'
const WHO_YOU_ARE_PROMPT_FILE = 'who-you-are.md'
const SHOWING_FILES_PROMPT_FILE = 'showing-files.md'
const YOUR_FOLDER_PROMPT_FILE = 'your-folder.md'
const YOUR_APPS_PROMPT_FILE = 'your-apps.md'
const YOUR_AGENTS_PROMPT_FILE = 'your-agents.md'
const YOUR_SESSION_PROMPT_FILE = 'your-session.md'
const PARENT_SESSION_PROMPT_FILE = 'parent-session.md'

function writeGeneratedPrompt(targetDir: string, fileName: string, content: string): string {
  mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  const file = join(targetDir, fileName)
  const temporaryFile = join(targetDir, `.${fileName}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporaryFile, content, { mode: 0o600, flag: 'wx' })
    renameSync(temporaryFile, file)
    chmodSync(file, 0o600)
  } finally {
    rmSync(temporaryFile, { force: true })
  }
  return file
}

function onboardingCompletionPrompt(anchorPath: string, workspaceSlug: string | undefined): string {
  // With the slug in hand this is one copy-pasteable call with nothing left to
  // derive. That is not cosmetic: the first version made the model resolve the
  // workspace and agent slugs itself (whoami + list + jq), and a live e2e run
  // showed a real runner finishing its interview, announcing "Onboarding
  // complete.", and never attempting the ceremony — leaving the user locked out
  // of an agent that believed it was configured. The fallback keeps the
  // derivation for a gateway that does not know its slug yet, where completion
  // must remain possible even if less reliable.
  const completionCall =
    workspaceSlug === undefined
      ? [
          'WORKSPACE_SLUG="$(curl -sS "$DUET_API_URL/v1/whoami" \\',
          '  -H "Authorization: Bearer $DUET_API_KEY" | jq -er \'.workspaces[0].slug\')"',
          '',
          `AGENT_SLUG="$(curl -sS "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/agents" \\`,
          '  -H "Authorization: Bearer $DUET_API_KEY" \\',
          `  | jq -er '.items[] | select(.anchorPath == "${anchorPath}") | .slug')"`,
          '',
          'curl -sS -X POST \\',
          '  "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/agents/$AGENT_SLUG/onboarded" \\',
          '  -H "Authorization: Bearer $DUET_API_KEY" \\',
          "  -H 'Content-Type: application/json' \\",
          '  -d \'{"onboarded":true}\'',
        ]
      : [
          'curl -sS -X POST \\',
          `  "$DUET_API_URL/v1/ws/${workspaceSlug}/agent/sessions/$DUET_SESSION_ID/onboarded" \\`,
          '  -H "Authorization: Bearer $DUET_API_KEY" \\',
          "  -H 'Content-Type: application/json' \\",
          '  -d \'{"onboarded":true}\'',
        ]
  return [
    '# Finishing onboarding',
    '',
    "You are running this workspace's onboarding for the agent anchored at",
    `\`${anchorPath}\`. The user stays locked out of this agent until you mark`,
    'it onboarded, and exactly one thing performs that step: the call below.',
    'Finishing the interview, writing files, or telling the user onboarding is',
    'complete does NOT unlock anything on its own — if you end the session',
    'without running this call, the user is left stuck behind a locked card',
    'whose only button they already pressed.',
    '',
    'When, and only when, everything the instructions above ask for is actually',
    'done, run exactly this (every variable in it is already set in your',
    'environment):',
    '',
    '```bash',
    ...completionCall,
    '```',
    '',
    'Two hard rules about when.',
    '',
    'Never mark it onboarded on your first turn. The message that opened this',
    'session came from Duet, not from a person — so at minimum, ask the user',
    'something, wait, and let them write back at least once. An agent that',
    'unlocks itself before the user has said a word has onboarded nobody, and',
    'the user gets an agent that looks configured and is not.',
    '',
    'Beyond that first exchange, do not call it until the user has actually',
    'supplied what the instructions above ask for. If those instructions are',
    'missing or say nothing specific, ask the user what they want this agent to',
    'know, and take their answer as the thing to be supplied.',
    '',
    'Never ask the user to run the call themselves.',
  ].join('\n')
}

function writeOnboardingCompletionPrompt(
  agentStateDir: string,
  anchorPath: string,
  workspaceSlug: string | undefined,
): string {
  const file = join(agentStateDir, ONBOARDING_COMPLETION_PROMPT_FILE)
  writeFileSync(file, `${onboardingCompletionPrompt(anchorPath, workspaceSlug)}\n`, { mode: 0o600 })
  return file
}

/**
 * The folder layer renders for every launch, roster or no roster: the paths it
 * names come from the drive, not from a projection. Where an agent's notes and
 * skills go is not something a cold boot may leave unsaid.
 */
function writeYourFolderPrompt(
  args: Pick<ResolveAgentContextArgs, 'driveDir'>,
  targetDir: string,
  scope: { kind: 'agent'; agentRoot: string } | { kind: 'root' },
): string {
  return writeGeneratedPrompt(
    targetDir,
    YOUR_FOLDER_PROMPT_FILE,
    yourFolderPrompt({
      agentRoot: scope.kind === 'root' ? args.driveDir : scope.agentRoot,
      driveDir: args.driveDir,
      scope: scope.kind,
    }),
  )
}

function writeYourAppsPrompt(
  args: Pick<ResolveAgentContextArgs, 'apps' | 'workspaceSlug'>,
  targetDir: string,
  scope: { kind: 'agent'; agentId: string } | { kind: 'root' },
  candidates: readonly AgentResolutionCandidate[],
): string | undefined {
  const workspaceSlug = args.workspaceSlug?.()
  if (args.apps === undefined || workspaceSlug === undefined) return undefined
  return writeGeneratedPrompt(
    targetDir,
    YOUR_APPS_PROMPT_FILE,
    yourAppsPrompt({ apps: args.apps(), scope, candidates, workspaceSlug }),
  )
}

/**
 * The reader's own roster row — the one `writeYourAgentsPrompt` deliberately
 * withholds, because the roster answers "who can I reach" and this answers "who
 * am I". Root has no agents row and takes the workspace's own name from the
 * roster's root member. A scope the roster does not carry (disabled, or a stale
 * roster) gets no identity layer rather than a name guessed from its folder.
 */
function writeWhoYouArePrompt(
  args: Pick<ResolveAgentContextArgs, 'agents'>,
  targetDir: string,
  scope: AgentRosterScope,
): string | undefined {
  const roster = args.agents?.()
  if (roster === undefined) return undefined
  const self =
    scope.kind === 'root'
      ? roster.find(member => member.kind === 'root')
      : roster.find(member => member.kind === 'agent' && member.agentId === scope.agentId)
  if (self === undefined) return undefined
  return writeGeneratedPrompt(
    targetDir,
    WHO_YOU_ARE_PROMPT_FILE,
    whoYouArePrompt({
      name: self.name,
      slug: self.slug,
      ...(self.kind === 'agent' ? { anchorPath: self.anchorPath } : {}),
    }),
  )
}

/**
 * A session with no roster to read gets no agents layer at all. A bound agent
 * the roster does not carry (disabled, or the roster is stale) and a gateway
 * that has never synced both land here: silence beats a prompt that tells a
 * session it has no colleagues when nobody has looked yet.
 */
function writeYourAgentsPrompt(
  args: Pick<ResolveAgentContextArgs, 'agents' | 'driveDir'>,
  targetDir: string,
  scope: AgentRosterScope,
): string | undefined {
  const roster = readReachableAgentRoster({
    members: args.agents?.(),
    scope,
    driveDir: args.driveDir,
  })
  if (roster === undefined) return undefined

  return writeGeneratedPrompt(
    targetDir,
    YOUR_AGENTS_PROMPT_FILE,
    yourAgentsPrompt({ roster }),
  )
}

function writeYourSessionPrompt(
  args: Pick<ResolveAgentContextArgs, 'defaultSession'>,
  targetDir: string,
  scope: 'agent' | 'root',
): string {
  return writeGeneratedPrompt(
    targetDir,
    YOUR_SESSION_PROMPT_FILE,
    yourSessionPrompt({ scope, defaultSession: args.defaultSession === true }),
  )
}

function writeParentSessionPrompt(
  args: Pick<ResolveAgentContextArgs, 'createdBySessionId' | 'workspaceSlug'>,
  targetDir: string,
): string | undefined {
  if (args.createdBySessionId === undefined) return undefined
  return writeGeneratedPrompt(
    targetDir,
    PARENT_SESSION_PROMPT_FILE,
    parentSessionPrompt({
      parentSessionId: args.createdBySessionId,
      workspaceSlug: args.workspaceSlug?.(),
    }),
  )
}

export interface ResolveAgentContextArgs {
  cwd?: string
  onboarding?: boolean
  defaultSession?: true
  createdBySessionId?: string
  driveDir: string
  stateDir: string
  defaultMemoryDbPath: string
  anchors: readonly GatewayAnchor[]
  apps?: () => readonly GatewayAppConfig[]
  /** `undefined` while no roster has arrived — never flatten it to an empty one. */
  agents?: () => readonly GatewayAgentConfig[] | undefined
  workspaceSlug?: () => string | undefined
}

export interface AgentContext {
  agentId?: string
  anchorId?: string
  agentRoot: string
  memoryDbPath: string
  systemPromptFiles: readonly string[]
}

export function resolveAgentContext(args: ResolveAgentContextArgs): AgentContext {
  const cwd = resolvedRelativeCwd(args.driveDir, args.cwd)
  const candidates = agentCandidates(args.anchors)
  const agent = resolveNearestAgent(cwd, candidates)
  if (agent === null) return defaultAgentContext(args)

  return contextForAgent(args, agent, candidates)
}

export const resolveFresh = resolveAgentContext

export function resolveBound(
  args: ResolveAgentContextArgs,
  anchorId: string | undefined,
): AgentContext {
  const cwd = resolvedRelativeCwd(args.driveDir, args.cwd)
  if (anchorId === undefined) return defaultAgentContext(args)
  const anchor = args.anchors.find(candidate => candidate.id === anchorId)
  if (anchor === undefined) throw new Error('Bound agent anchor is unavailable')
  const agent = resolveNearestAgent(cwd, [
    agentResolutionCandidate({
      id: anchor.agentId ?? anchor.id,
      anchorId: anchor.id,
      anchorPath: anchor.path,
    }),
  ])
  if (agent === null) throw new Error('Bound agent anchor no longer contains the session cwd')
  return contextForAgent(
    args,
    {
      ...(anchor.agentId === undefined ? {} : { agentId: anchor.agentId }),
      anchorId: anchor.id,
      rootPath: anchor.path,
    },
    agentCandidates(args.anchors),
  )
}

function agentCandidates(anchors: readonly GatewayAnchor[]): AgentResolutionCandidate[] {
  return anchors.flatMap(anchor =>
    anchor.agentId === undefined
      ? []
      : [
          agentResolutionCandidate({
            id: anchor.agentId,
            anchorId: anchor.id,
            anchorPath: anchor.path,
          }),
        ],
  )
}

function resolvedRelativeCwd(driveDir: string, cwd?: string): string {
  const resolvedCwd = resolveAgentPath(driveDir, cwd)
  return relative(driveDir, resolvedCwd).split(sep).join('/')
}

export function defaultAgentContext(
  args: Pick<
    ResolveAgentContextArgs,
    | 'driveDir'
    | 'stateDir'
    | 'defaultMemoryDbPath'
    | 'onboarding'
    | 'defaultSession'
    | 'createdBySessionId'
    | 'apps'
    | 'agents'
    | 'workspaceSlug'
  > & { anchors?: readonly GatewayAnchor[] },
): AgentContext {
  // The drive root is the default agent: it has no agents row, so it can never
  // be locked and has nothing to onboard. An onboarding launch here is a
  // no-meaning request rather than an error — it simply gets the ordinary
  // context.
  ensureMemoryStore(args.driveDir, args.driveDir)
  const identityPrompt = writeWhoYouArePrompt(args, args.stateDir, { kind: 'root' })
  const folderPrompt = writeYourFolderPrompt(args, args.stateDir, { kind: 'root' })
  const mediaPrompt = writeGeneratedPrompt(
    args.stateDir,
    SHOWING_FILES_PROMPT_FILE,
    showingFilesPrompt({ driveDir: args.driveDir }),
  )
  const appsPrompt = writeYourAppsPrompt(
    args,
    args.stateDir,
    { kind: 'root' },
    agentCandidates(args.anchors ?? []),
  )
  const agentsPrompt = writeYourAgentsPrompt(args, args.stateDir, { kind: 'root' })
  const sessionPrompt =
    args.onboarding === true
      ? undefined
      : writeYourSessionPrompt(args, args.stateDir, 'root')
  const parentPrompt =
    args.onboarding === true ? undefined : writeParentSessionPrompt(args, args.stateDir)
  return {
    agentRoot: args.driveDir,
    memoryDbPath: args.defaultMemoryDbPath,
    systemPromptFiles: [
      ...(identityPrompt === undefined ? [] : [identityPrompt]),
      folderPrompt,
      ...(appsPrompt === undefined ? [] : [appsPrompt]),
      ...(agentsPrompt === undefined ? [] : [agentsPrompt]),
      ...(sessionPrompt === undefined ? [] : [sessionPrompt]),
      ...(parentPrompt === undefined ? [] : [parentPrompt]),
      mediaPrompt,
    ],
  }
}

function contextForAgent(
  args: Pick<
    ResolveAgentContextArgs,
    | 'driveDir'
    | 'stateDir'
    | 'onboarding'
    | 'defaultSession'
    | 'createdBySessionId'
    | 'apps'
    | 'agents'
    | 'workspaceSlug'
  >,
  agent: { agentId?: string; anchorId: string; rootPath: string },
  candidates: readonly AgentResolutionCandidate[],
): AgentContext {
  const agentRoot = join(args.driveDir, agent.rootPath)
  ensureMemoryStore(args.driveDir, agentRoot)
  const agentStateDir = agentStateDirPath(args.stateDir, agent.anchorId)
  mkdirSync(agentStateDir, { recursive: true, mode: 0o700 })
  chmodSync(agentStateDir, 0o700)
  const memoryDbPath = agentMemoryDbPath(args.stateDir, agent.anchorId)
  // Identity leads — it is the frame every later layer fills in, and the only
  // layer an onboarding session shares with an ordinary one. Then the product
  // layers (apps, then agents), the session layer, parent lineage, and
  // last the authored prompt. Onboarding replaces that product stack with the optional
  // authored ONBOARDING.md and the completion instruction: an agent that
  // finishes its interview without calling the endpoint strands the user behind
  // a card whose only button they already pressed.
  const mediaPrompt = writeGeneratedPrompt(
    agentStateDir,
    SHOWING_FILES_PROMPT_FILE,
    showingFilesPrompt({ driveDir: args.driveDir }),
  )
  const identityPrompt = writeWhoYouArePrompt(args, agentStateDir, {
    kind: 'agent',
    agentId: agent.agentId ?? agent.anchorId,
  })
  const folderPrompt = writeYourFolderPrompt(args, agentStateDir, { kind: 'agent', agentRoot })
  const authored = containedSystemPromptFile(
    args.driveDir,
    agentRoot,
    args.onboarding === true ? 'ONBOARDING.md' : 'AGENTS.md',
  )
  // The apps layer is withheld from onboarding sessions. It teaches sessions to
  // relocate their cwd into an app folder, and a live e2e run showed an
  // onboarding agent doing exactly that as its very first act — wandering off to
  // the seeded app and burning its opening turn recovering. The interview's one
  // job is to stay in the anchor folder, collect what the author asked, and run
  // the completion call; the agent learns its apps in every session after.
  const appsPrompt =
    args.onboarding === true
      ? undefined
      : writeYourAppsPrompt(
          args,
          agentStateDir,
          { kind: 'agent', agentId: agent.agentId ?? agent.anchorId },
          candidates,
        )
  // Withheld from onboarding for the same reason as apps: the interview's one
  // job is to stay put and finish, not to discover colleagues.
  const agentsPrompt =
    args.onboarding === true
      ? undefined
      : writeYourAgentsPrompt(args, agentStateDir, {
          kind: 'agent',
          agentId: agent.agentId ?? agent.anchorId,
        })
  const sessionPrompt =
    args.onboarding === true
      ? undefined
      : writeYourSessionPrompt(args, agentStateDir, 'agent')
  const parentPrompt =
    args.onboarding === true ? undefined : writeParentSessionPrompt(args, agentStateDir)
  // The authored prompt comes last: it is the most specific layer and the one
  // the developer prompt names as overriding, so nothing generated follows it
  // except the completion contract an onboarding interview must end with.
  const systemPromptFiles = [
    ...(identityPrompt === undefined ? [] : [identityPrompt]),
    folderPrompt,
    ...(appsPrompt === undefined ? [] : [appsPrompt]),
    ...(agentsPrompt === undefined ? [] : [agentsPrompt]),
    ...(sessionPrompt === undefined ? [] : [sessionPrompt]),
    ...(parentPrompt === undefined ? [] : [parentPrompt]),
    mediaPrompt,
    ...(authored === undefined ? [] : [authored]),
    ...(args.onboarding === true
      ? [writeOnboardingCompletionPrompt(agentStateDir, agent.rootPath, args.workspaceSlug?.())]
      : []),
  ]
  return {
    ...(agent.agentId === undefined ? {} : { agentId: agent.agentId }),
    anchorId: agent.anchorId,
    agentRoot,
    memoryDbPath,
    systemPromptFiles,
  }
}
