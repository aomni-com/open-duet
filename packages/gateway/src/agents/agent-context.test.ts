import { afterEach, describe, expect, test } from 'bun:test'
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveSources } from '@repo/agent/memory/store/sources'
import type { GatewayAnchor } from '@repo/contract'

import { resolveAgentContext, resolveBound } from './agent-context'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('agent launch context', () => {
  test('chooses the deepest projected agent, including a share-mount anchor', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'shared', 'reviewer', 'security', 'audit'), { recursive: true })
    writeFileSync(join(driveDir, 'shared', 'reviewer', 'security', 'AGENTS.md'), '# Security')
    const anchors = [
      gatewayAnchor('outer', 'shared/reviewer', 'agent_outer'),
      gatewayAnchor('inner', 'shared/reviewer/security', 'agent_inner', 'share-mount'),
    ]

    const context = resolveAgentContext({
      cwd: 'shared/reviewer/security/audit',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors,
    })

    expect(context).toEqual({
      agentId: 'agent_inner',
      anchorId: 'inner',
      agentRoot: join(driveDir, 'shared', 'reviewer', 'security'),
      memoryDbPath: join(stateDir, 'agents', 'inner', 'memory.db'),
      systemPromptFiles: [
        expect.stringContaining('your-folder.md'),
        expect.stringContaining('your-session.md'),
        expect.stringContaining('showing-files.md'),
        join(driveDir, 'shared', 'reviewer', 'security', 'AGENTS.md'),
      ],
    })
    expect(statSync(join(stateDir, 'agents', 'inner')).mode & 0o777).toBe(0o700)
  })

  test('derives agent context from logical cwd when the fresh VM has no agent folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-missing-root-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(driveDir, { recursive: true })

    const context = resolveAgentContext({
      cwd: 'agents/reviewer/deleted-project',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('reviewer', 'agents/reviewer', 'agent_reviewer')],
    })

    expect(context.anchorId).toBe('reviewer')
    expect(context.agentId).toBe('agent_reviewer')
  })

  test('omits the boundary prompt when AGENTS.md symlinks outside the drive', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-escape-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'agents', 'evil'), { recursive: true })
    // A host secret outside the drive root.
    writeFileSync(join(root, 'host-secret'), 'PROVIDER_KEY')
    symlinkSync(join(root, 'host-secret'), join(driveDir, 'agents', 'evil', 'AGENTS.md'))

    const context = resolveAgentContext({
      cwd: 'agents/evil',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('evil', 'agents/evil', 'agent_evil')],
    })

    // The escaping prompt file must be dropped, not passed to the runner.
    expect(context.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('your-session.md'),
      expect.stringContaining('showing-files.md'),
    ])
  })

  test('drops an ONBOARDING.md that escapes the drive but still injects completion', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-onboarding-escape-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    const agentRoot = join(driveDir, 'agents', 'evil')
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(agentRoot, 'AGENTS.md'), '# Ordinary prompt')
    writeFileSync(join(root, 'host-secret'), 'PROVIDER_KEY')
    symlinkSync(join(root, 'host-secret'), join(agentRoot, 'ONBOARDING.md'))
    const context = resolveAgentContext({
      cwd: 'agents/evil',
      onboarding: true,
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('evil', 'agents/evil', 'agent_evil')],
    })

    // The symlink is dropped — it must never reach the runner — and it must not
    // silently fall back to AGENTS.md either, which would run the agent's
    // ordinary persona while the user believes they are being onboarded.
    expect(context.systemPromptFiles.some(file => file.endsWith('ONBOARDING.md'))).toBe(false)
    expect(context.systemPromptFiles.some(file => file.endsWith('AGENTS.md'))).toBe(false)
    // The completion contract still ships, so the session can still finish.
    expect(context.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('showing-files.md'),
      expect.stringContaining('onboarding-completion.md'),
    ])
  })

  test('an onboarding agent with no ONBOARDING.md still gets the completion contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-onboarding-unreadable-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    const agentRoot = join(driveDir, 'agents', 'broken')
    // A directory where the file should be is the same situation as no file at
    // all: ONBOARDING.md is optional, so onboarding proceeds on the product's
    // completion contract alone rather than failing the session.
    mkdirSync(join(agentRoot, 'ONBOARDING.md'), { recursive: true })

    const context = resolveAgentContext({
      cwd: 'agents/broken',
      onboarding: true,
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('broken', 'agents/broken', 'agent_broken')],
    })

    expect(context.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('showing-files.md'),
      expect.stringContaining('onboarding-completion.md'),
    ])
    expect(readFileSync(onboardingCompletionPromptFile(context), 'utf8')).toContain('agents/broken')
  })

  // The live e2e caught a real runner finishing its interview, announcing
  // "Onboarding complete.", and never running the completion call — the first
  // prompt asked it to derive the workspace and agent slugs through a whoami +
  // list + jq pipeline before it could POST. The gateway knows the workspace
  // slug and the runner exports $DUET_SESSION_ID, so when the slug is known the
  // prompt must be one copy-pasteable call with nothing left to derive.
  test('the completion contract is a single session-scoped call when the workspace slug is known', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-onboarding-session-call-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'agents', 'scout'), { recursive: true })

    const context = resolveAgentContext({
      cwd: 'agents/scout',
      onboarding: true,
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('scout', 'agents/scout', 'agent_scout')],
      workspaceSlug: () => 'my-team',
    })

    const prompt = readFileSync(onboardingCompletionPromptFile(context), 'utf8')
    expect(prompt).toContain('/v1/ws/my-team/agent/sessions/$DUET_SESSION_ID/onboarded')
    // Nothing left to resolve: no whoami hop, no agent listing, no jq.
    expect(prompt).not.toContain('whoami')
    expect(prompt).not.toContain('jq')
  })

  test('the completion contract falls back to deriving slugs when the workspace slug is unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-onboarding-fallback-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'agents', 'scout'), { recursive: true })

    const context = resolveAgentContext({
      cwd: 'agents/scout',
      onboarding: true,
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('scout', 'agents/scout', 'agent_scout')],
    })

    // No slug provider at all (older callers): the derivation ceremony is worse
    // but self-sufficient, and completion must never become impossible.
    const prompt = readFileSync(onboardingCompletionPromptFile(context), 'utf8')
    expect(prompt).toContain('whoami')
    expect(prompt).toContain('$DUET_API_URL')
    expect(prompt).toContain('\'.items[] | select(.anchorPath == "agents/scout") | .slug\'')
    expect(prompt).not.toContain('.agents[]')
  })

  test('writes the scoped apps layer outside the drive with exact normal and onboarding order', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-apps-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    const agentRoot = join(driveDir, 'agents', 'writer')
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(agentRoot, 'AGENTS.md'), '# Writer')
    writeFileSync(join(agentRoot, 'ONBOARDING.md'), '# Meet the writer')
    const anchor = gatewayAnchor('writer-anchor', 'agents/writer', 'writer-agent')
    const providers = {
      apps: () => [
        {
          appId: 'app-writer',
          slug: 'writer-app',
          command: 'bun run dev',
          port: 3000,
          anchorPath: 'agents/writer/app',
          apiScopes: [],
          visibility: 'folder' as const,
        },
      ],
      workspaceSlug: () => 'acme',
    }

    const normal = resolveAgentContext({
      cwd: 'agents/writer',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [anchor],
      ...providers,
    })
    const onboarding = resolveAgentContext({
      cwd: 'agents/writer',
      onboarding: true,
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [anchor],
      ...providers,
    })
    const appsFile = join(stateDir, 'agents', 'writer-anchor', 'your-apps.md')

    expect(normal.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      appsFile,
      expect.stringContaining('your-session.md'),
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'AGENTS.md'),
    ])
    // No apps layer during onboarding. A live e2e run showed why: the layer
    // teaches sessions to move their cwd into an app folder, and the onboarding
    // agent's very first act was exactly that — it relocated to the seeded app,
    // went hunting for ONBOARDING.md there, and burned its opening turn
    // recovering. The interview's one job is to stay in the anchor folder,
    // collect what the author asked, and run the completion call.
    expect(onboarding.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'ONBOARDING.md'),
      join(stateDir, 'agents', 'writer-anchor', 'onboarding-completion.md'),
    ])
    expect(readFileSync(appsFile, 'utf8')).toContain('`writer-app`')
    expect(statSync(appsFile).mode & 0o777).toBe(0o600)
    expect(appsFile.startsWith(`${driveDir}/`)).toBe(false)
  })

  test('writes the agents layer at both assembly sites, scoped to the session’s family', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-agents-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    const writerRoot = join(driveDir, 'agents', 'writer')
    mkdirSync(join(writerRoot, 'drafter'), { recursive: true })
    // Drafter declares onboarding and has no completion stamp — the one
    // combination that reads as locked. Writer has no agent.json at all,
    // which must read as unlocked, not as broken.
    writeFileSync(
      join(writerRoot, 'drafter', 'agent.json'),
      JSON.stringify({ onboarding: { kind: 'chat' } }),
    )
    const providers = {
      workspaceSlug: () => 'acme',
      apps: () => [],
      agents: () => [
        { kind: 'root' as const, slug: 'root' as const, name: 'HQ' },
        {
          kind: 'agent' as const,
          agentId: 'writer-agent',
          anchorId: 'writer-anchor',
          anchorPath: 'agents/writer',
          slug: 'writer',
          name: 'Writer',
        },
        {
          kind: 'agent' as const,
          agentId: 'drafter-agent',
          anchorId: 'drafter-anchor',
          anchorPath: 'agents/writer/drafter',
          slug: 'drafter',
          name: 'Drafter',
        },
      ],
    }
    const shared = {
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [
        gatewayAnchor('writer-anchor', 'agents/writer', 'writer-agent'),
        gatewayAnchor('drafter-anchor', 'agents/writer/drafter', 'drafter-agent'),
      ],
      ...providers,
    }

    const bound = resolveAgentContext({ cwd: 'agents/writer', ...shared })
    const boundFile = join(stateDir, 'agents', 'writer-anchor', 'your-agents.md')
    expect(bound.systemPromptFiles).toEqual([
      join(stateDir, 'agents', 'writer-anchor', 'who-you-are.md'),
      join(stateDir, 'agents', 'writer-anchor', 'your-folder.md'),
      join(stateDir, 'agents', 'writer-anchor', 'your-apps.md'),
      boundFile,
      join(stateDir, 'agents', 'writer-anchor', 'your-session.md'),
      expect.stringContaining('showing-files.md'),
    ])
    const boundRendered = readFileSync(boundFile, 'utf8')
    // Writer sees the agent above it (root, wearing the workspace's name) and
    // the one below (drafter, flagged), each wearing its relationship, and
    // never itself.
    expect(boundRendered).toContain('- **HQ** (`root`) — parent')
    expect(boundRendered).toContain(
      '- **Drafter** (`drafter`) — child — `agents/writer/drafter` — awaiting onboarding',
    )
    expect(boundRendered).not.toContain('- **Writer**')
    expect(statSync(boundFile).mode & 0o777).toBe(0o600)
    expect(boundFile.startsWith(`${driveDir}/`)).toBe(false)

    // The drive root is the second assembly site — the one a missed wiring
    // would silently skip. Root sees only its direct children: writer, not the
    // grandchild drafter, and no parent section.
    const rootContext = resolveAgentContext({ cwd: '.', ...shared })
    const rootFile = join(stateDir, 'your-agents.md')
    expect(rootContext.systemPromptFiles).toEqual([
      join(stateDir, 'who-you-are.md'),
      join(stateDir, 'your-folder.md'),
      join(stateDir, 'your-apps.md'),
      rootFile,
      join(stateDir, 'your-session.md'),
      expect.stringContaining('showing-files.md'),
    ])
    const rootRendered = readFileSync(rootFile, 'utf8')
    expect(rootRendered).toContain('- **Writer** (`writer`) — child')
    expect(rootRendered).not.toContain('- **Drafter**')

    // Onboarding keeps its stack clean, and a gateway with no roster closure
    // (unit-test gateways, cold boots) writes nothing rather than broken curl.
    const onboarding = resolveAgentContext({ cwd: 'agents/writer', onboarding: true, ...shared })
    expect(onboarding.systemPromptFiles.some(file => file.endsWith('your-agents.md'))).toBe(false)
    const { agents: _omitted, ...withoutRoster } = shared
    const rosterless = resolveAgentContext({ cwd: 'agents/writer', ...withoutRoster })
    expect(rosterless.systemPromptFiles.some(file => file.endsWith('your-agents.md'))).toBe(false)

    // A gateway that has not synced yet knows nothing about this session's
    // colleagues — which is not the same as knowing it has none. Writing "no
    // agents are registered" here would state as fact something nobody has
    // asked about yet.
    const unsynced = resolveAgentContext({
      cwd: 'agents/writer',
      ...withoutRoster,
      agents: () => undefined,
    })
    expect(unsynced.systemPromptFiles.some(file => file.endsWith('your-agents.md'))).toBe(false)

    // Same rule for an agent the roster does not carry (disabled, or the roster
    // is stale): no parent, no colleagues, and no guess.
    const unknown = resolveAgentContext({
      cwd: 'agents/writer',
      ...shared,
      anchors: [gatewayAnchor('writer-anchor', 'agents/writer', 'ghost-agent')],
    })
    expect(unknown.systemPromptFiles.some(file => file.endsWith('your-agents.md'))).toBe(false)
  })

  test('tells the session its own name at both assembly sites, onboarding included', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-identity-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    const writerRoot = join(driveDir, 'agents', 'writer')
    mkdirSync(writerRoot, { recursive: true })
    writeFileSync(join(writerRoot, 'AGENTS.md'), '# Writer')
    writeFileSync(join(writerRoot, 'ONBOARDING.md'), '# Meet the writer')
    const shared = {
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('writer-anchor', 'agents/writer', 'writer-agent')],
      workspaceSlug: () => 'acme',
      agents: () => [
        { kind: 'root' as const, slug: 'root' as const, name: 'HQ' },
        {
          kind: 'agent' as const,
          agentId: 'writer-agent',
          anchorId: 'writer-anchor',
          anchorPath: 'agents/writer',
          // The wire always carries a resolved name; when the user set none the
          // projection already collapsed it to the slug, so this layer never
          // has to invent one.
          slug: 'writer',
          name: 'Writer',
        },
      ],
    }

    const bound = resolveAgentContext({ cwd: 'agents/writer', ...shared })
    const boundFile = join(stateDir, 'agents', 'writer-anchor', 'who-you-are.md')
    // Identity frames every other layer, so it leads the stack — including the
    // author's own AGENTS.md, which fills that frame in rather than setting it.
    expect(bound.systemPromptFiles[0]).toBe(boundFile)
    const boundRendered = readFileSync(boundFile, 'utf8')
    expect(boundRendered).toContain('You are **Writer** (`writer`)')
    expect(boundRendered).toContain('`agents/writer`')
    expect(statSync(boundFile).mode & 0o777).toBe(0o600)
    expect(boundFile.startsWith(`${driveDir}/`)).toBe(false)

    // An onboarding interview is exactly when the user is deciding who this
    // agent is; it keeps its name even though the roster and apps layers are
    // withheld.
    const onboarding = resolveAgentContext({ cwd: 'agents/writer', onboarding: true, ...shared })
    expect(onboarding.systemPromptFiles[0]).toBe(boundFile)

    // The drive root is the second assembly site, wearing the workspace's name.
    const rootContext = resolveAgentContext({ cwd: '.', ...shared })
    const rootFile = join(stateDir, 'who-you-are.md')
    expect(rootContext.systemPromptFiles[0]).toBe(rootFile)
    expect(readFileSync(rootFile, 'utf8')).toContain('You are **HQ** (`root`)')

    // No roster closure (unit-test gateways, cold boots) means no name to
    // claim — silence beats guessing one from a folder.
    const { agents: _omitted, ...withoutRoster } = shared
    const rosterless = resolveAgentContext({ cwd: 'agents/writer', ...withoutRoster })
    expect(rosterless.systemPromptFiles.some(file => file.endsWith('who-you-are.md'))).toBe(false)
  })

  test('writes the session layer outside the drive for an agent default session', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-default-session-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    const agentRoot = join(driveDir, 'agents', 'writer')
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(agentRoot, 'AGENTS.md'), '# Writer')

    const context = resolveAgentContext({
      cwd: 'agents/writer',
      defaultSession: true,
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('writer-anchor', 'agents/writer', 'writer-agent')],
    })

    const defaultSessionFile = join(stateDir, 'agents', 'writer-anchor', 'your-session.md')
    expect(context.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      defaultSessionFile,
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'AGENTS.md'),
    ])
    expect(defaultSessionFile.startsWith(`${driveDir}/`)).toBe(false)
    expect(statSync(defaultSessionFile).mode & 0o777).toBe(0o600)
  })

  test('every launch but onboarding says which session it is', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-non-default-session-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    const agentRoot = join(driveDir, 'agents', 'writer')
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(agentRoot, 'AGENTS.md'), '# Writer')
    writeFileSync(join(agentRoot, 'ONBOARDING.md'), '# Meet the writer')
    const common = {
      cwd: 'agents/writer',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('writer-anchor', 'agents/writer', 'writer-agent')],
    }

    const ordinary = resolveAgentContext(common)
    const onboarding = resolveAgentContext({
      ...common,
      onboarding: true,
      defaultSession: true,
    })

    expect(ordinary.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('your-session.md'),
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'AGENTS.md'),
    ])
    expect(onboarding.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'ONBOARDING.md'),
      join(stateDir, 'agents', 'writer-anchor', 'onboarding-completion.md'),
    ])
    expect(onboarding.systemPromptFiles.some(file => file.endsWith('your-session.md'))).toBe(false)
  })

  test('renders the parent-session layer when a launch names its parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-parent-session-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    const agentRoot = join(driveDir, 'agents', 'writer')
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(agentRoot, 'AGENTS.md'), '# Writer')

    const args = {
      cwd: 'agents/writer',
      createdBySessionId: 'parent-123',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('writer-anchor', 'agents/writer', 'writer-agent')],
      workspaceSlug: () => 'acme',
    }
    const context = resolveAgentContext(args)

    const parentSessionFile = join(stateDir, 'agents', 'writer-anchor', 'parent-session.md')
    expect(context.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('your-session.md'),
      parentSessionFile,
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'AGENTS.md'),
    ])
    const prompt = readFileSync(parentSessionFile, 'utf8')
    expect(prompt).toContain('`parent-123`')
    expect(prompt).toContain('WAIT_PATH="/v1/ws/acme/agent/sessions/parent-123/messages/wait"')
    expect(prompt).toContain(
      '"$DUET_API_URL/v1/ws/acme/agent/sessions/parent-123/history?order=asc&afterSeq=$INPUT_SEQ"',
    )
    expect(parentSessionFile.startsWith(`${driveDir}/`)).toBe(false)
    expect(statSync(parentSessionFile).mode & 0o777).toBe(0o600)
    const repeated = resolveAgentContext(args)
    expect(readFileSync(promptLayer(repeated, 'parent-session.md'), 'utf8')).toBe(prompt)
  })

  test('omits the parent-session layer from unparented and onboarding launches', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-no-parent-session-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    const agentRoot = join(driveDir, 'agents', 'writer')
    mkdirSync(agentRoot, { recursive: true })
    writeFileSync(join(agentRoot, 'AGENTS.md'), '# Writer')
    writeFileSync(join(agentRoot, 'ONBOARDING.md'), '# Meet the writer')
    const common = {
      cwd: 'agents/writer',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('writer-anchor', 'agents/writer', 'writer-agent')],
      workspaceSlug: () => 'acme',
    }

    const unparented = resolveAgentContext(common)
    const onboarding = resolveAgentContext({
      ...common,
      onboarding: true,
      createdBySessionId: 'parent-123',
    })

    expect(unparented.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('your-session.md'),
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'AGENTS.md'),
    ])
    expect(onboarding.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'ONBOARDING.md'),
      join(stateDir, 'agents', 'writer-anchor', 'onboarding-completion.md'),
    ])
    expect(
      [...unparented.systemPromptFiles, ...onboarding.systemPromptFiles].some(file =>
        file.endsWith('parent-session.md'),
      ),
    ).toBe(false)
  })

  test('rejects an anchor id that would traverse the agent state dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-traverse-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'agents', 'x'), { recursive: true })

    expect(() =>
      resolveAgentContext({
        cwd: 'agents/x',
        driveDir,
        stateDir,
        defaultMemoryDbPath: join(stateDir, 'memory.db'),
        anchors: [gatewayAnchor('../../victim', 'agents/x', 'agent_x')],
      }),
    ).toThrow('Invalid agent anchor id')
  })

  test('keeps the default-agent paths unchanged and omits a boundary prompt flag', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-default-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    const defaultMemoryDbPath = join(stateDir, 'memory.db')
    mkdirSync(driveDir, { recursive: true })
    writeFileSync(join(driveDir, 'AGENTS.md'), '# Default')

    expect(
      resolveAgentContext({ cwd: '/', driveDir, stateDir, defaultMemoryDbPath, anchors: [] }),
    ).toEqual({
      agentRoot: driveDir,
      memoryDbPath: defaultMemoryDbPath,
      systemPromptFiles: [
        expect.stringContaining('your-folder.md'),
        expect.stringContaining('your-session.md'),
        expect.stringContaining('showing-files.md'),
      ],
    })
  })

  test('writes the root apps layer even when the scoped catalog is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-root-apps-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(driveDir, { recursive: true })

    const context = resolveAgentContext({
      cwd: '/',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [],
      apps: () => [],
      workspaceSlug: () => 'acme',
    })

    expect(context.systemPromptFiles).toEqual([
      join(stateDir, 'your-folder.md'),
      join(stateDir, 'your-apps.md'),
      join(stateDir, 'your-session.md'),
      expect.stringContaining('showing-files.md'),
    ])
  })

  test('a root default session gets the session layer at the drive root', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-root-default-session-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(driveDir, { recursive: true })

    const context = resolveAgentContext({
      cwd: '/',
      defaultSession: true,
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [],
    })

    expect(context.systemPromptFiles).toEqual([
      join(stateDir, 'your-folder.md'),
      join(stateDir, 'your-session.md'),
      expect.stringContaining('showing-files.md'),
    ])
  })

  test('omits the boundary prompt when the projected agent has no AGENTS.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-no-prompt-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'agents', 'writer'), { recursive: true })

    const context = resolveAgentContext({
      cwd: 'agents/writer',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('writer-anchor', 'agents/writer', 'writer-agent')],
    })

    expect(context.systemPromptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('your-session.md'),
      expect.stringContaining('showing-files.md'),
    ])
    expect(context.memoryDbPath).toBe(join(stateDir, 'agents', 'writer-anchor', 'memory.db'))
  })

  test('rejects a cwd whose symlink escapes the drive before resolving an agent', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-escape-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const outside = join(root, 'outside')
    mkdirSync(driveDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(driveDir, 'escape'))

    expect(() =>
      resolveAgentContext({
        cwd: 'escape',
        driveDir,
        stateDir: join(root, 'state'),
        defaultMemoryDbPath: join(root, 'state', 'memory.db'),
        anchors: [gatewayAnchor('escaped', 'escape', 'escaped-agent')],
      }),
    ).toThrow('Invalid agent cwd')
  })

  test('a bound default session does not switch when a nested agent later appears', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-bound-default-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'projects', 'nested'), { recursive: true })

    expect(
      resolveBound(
        {
          cwd: 'projects/nested',
          driveDir,
          stateDir,
          defaultMemoryDbPath: join(stateDir, 'memory.db'),
          anchors: [gatewayAnchor('nested', 'projects/nested', 'nested-agent')],
        },
        undefined,
      ),
    ).toEqual({
      agentRoot: driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      systemPromptFiles: [
        expect.stringContaining('your-folder.md'),
        expect.stringContaining('your-session.md'),
        expect.stringContaining('showing-files.md'),
      ],
    })
  })

  test('a removed bound anchor fails closed instead of switching memory owners', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-removed-bound-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'agents', 'reviewer', 'work'), { recursive: true })

    expect(() =>
      resolveBound(
        {
          cwd: 'agents/reviewer/work',
          driveDir,
          stateDir,
          defaultMemoryDbPath: join(stateDir, 'memory.db'),
          anchors: [],
        },
        'removed-anchor',
      ),
    ).toThrow('Bound agent anchor is unavailable')
  })

  test('a bound session keeps anchor-keyed memory after the agent projection is removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-disabled-bound-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'agents', 'reviewer', 'work'), { recursive: true })
    const anchor = gatewayAnchor('reviewer-anchor', 'agents/reviewer', 'reviewer-agent')
    delete anchor.agentId

    expect(
      resolveBound(
        {
          cwd: 'agents/reviewer/work',
          driveDir,
          stateDir,
          defaultMemoryDbPath: join(stateDir, 'memory.db'),
          anchors: [anchor],
        },
        anchor.id,
      ),
    ).toEqual({
      anchorId: 'reviewer-anchor',
      agentRoot: join(driveDir, 'agents', 'reviewer'),
      memoryDbPath: join(stateDir, 'agents', 'reviewer-anchor', 'memory.db'),
      systemPromptFiles: [
        expect.stringContaining('your-folder.md'),
        expect.stringContaining('your-session.md'),
        expect.stringContaining('showing-files.md'),
      ],
    })
  })

  test('gives the agent its own memory store so a flagless note stays on the agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-memory-store-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    // The drive root owns `.agents`, exactly as a workspace whose default agent
    // has been trained does. Without a store of its own, the agent's own
    // `duet memory add` walks past its folder and teaches every agent here.
    mkdirSync(join(driveDir, '.agents', 'memories'), { recursive: true })
    mkdirSync(join(driveDir, 'agents', 'ugc', 'campaign'), { recursive: true })

    resolveAgentContext({
      cwd: 'agents/ugc/campaign',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('ugc', 'agents/ugc', 'agent_ugc')],
    })

    const store = join(driveDir, 'agents', 'ugc', '.agents', 'memories')
    expect(statSync(store).isDirectory()).toBe(true)
    expect(
      (await resolveSources({ stores: [], dbs: [] }, join(driveDir, 'agents', 'ugc', 'campaign')))
        .writeTarget,
    ).toEqual({ kind: 'store', path: store })
  })

  test('gives the workspace agent a store at the drive root, not in the folder it sat in', async () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-root-store-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'projects', 'q3'), { recursive: true })

    resolveAgentContext({
      cwd: 'projects/q3',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [],
    })

    expect(statSync(join(driveDir, '.agents', 'memories')).isDirectory()).toBe(true)
    expect(
      (await resolveSources({ stores: [], dbs: [] }, join(driveDir, 'projects', 'q3'))).writeTarget,
    ).toEqual({ kind: 'store', path: join(driveDir, '.agents', 'memories') })
  })

  test('names the agent its own durable folders, and the workspace ones as shared', () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-agent-context-memory-prompt-'))
    roots.push(root)
    const driveDir = join(root, 'drive')
    const stateDir = join(root, 'state')
    mkdirSync(join(driveDir, 'agents', 'ugc'), { recursive: true })
    writeFileSync(join(driveDir, 'agents', 'ugc', 'AGENTS.md'), '# UGC')

    const context = resolveAgentContext({
      cwd: 'agents/ugc',
      driveDir,
      stateDir,
      defaultMemoryDbPath: join(stateDir, 'memory.db'),
      anchors: [gatewayAnchor('ugc', 'agents/ugc', 'agent_ugc')],
      workspaceSlug: () => 'acme',
      agents: () => [
        { kind: 'root' as const, slug: 'root' as const, name: 'HQ' },
        {
          kind: 'agent' as const,
          agentId: 'agent_ugc',
          anchorId: 'ugc',
          anchorPath: 'agents/ugc',
          slug: 'ugc-content',
          name: 'UGC',
        },
      ],
    })

    // Identity, then where this agent's own durable state lives, then the
    // author's persona: both are facts about the folder the session woke up in.
    expect(context.systemPromptFiles.slice(0, 2)).toEqual([
      join(stateDir, 'agents', 'ugc', 'who-you-are.md'),
      join(stateDir, 'agents', 'ugc', 'your-folder.md'),
    ])
    expect(context.systemPromptFiles.at(-1)).toBe(join(driveDir, 'agents', 'ugc', 'AGENTS.md'))
    const prose = readFileSync(join(stateDir, 'agents', 'ugc', 'your-folder.md'), 'utf8')
    expect(prose).toContain(join(driveDir, 'agents', 'ugc', '.agents', 'memories'))
    expect(prose).toContain(join(driveDir, '.agents', 'memories'))
    expect(prose).toContain(join(driveDir, 'agents', 'ugc', '.agents', 'skills'))
  })
})

function gatewayAnchor(
  id: string,
  path: string,
  agentId: string,
  kind: GatewayAnchor['kind'] = 'agent',
): GatewayAnchor {
  return {
    id,
    agentId,
    workspaceId: 'workspace_1',
    path,
    kind,
    settings: {},
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    markerNonce: `nonce-${id}`,
  }
}

/**
 * A layer by name rather than by position: prompt layers get added, and a test
 * that reads index 0 silently starts asserting about a different layer when
 * they do.
 */
function promptLayer(context: { systemPromptFiles: readonly string[] }, name: string): string {
  const file = context.systemPromptFiles.find(candidate => candidate.endsWith(name))
  if (file === undefined) throw new Error(`no ${name} prompt in this context`)
  return file
}

function onboardingCompletionPromptFile(context: { systemPromptFiles: readonly string[] }): string {
  return promptLayer(context, 'onboarding-completion.md')
}
