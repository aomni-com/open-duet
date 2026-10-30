import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Hono } from 'hono'

import { serializeMemoryFile } from '@repo/agent/memory-store'
import {
  AppReconciliationReportSchema,
  DUET_ACTOR_CONTEXT_HEADER,
  DUET_COLLECTION_SUBJECT_HEADER,
  DRIVE_UPLOAD_MAX_BYTES,
  DUET_ANCHOR_MARKER_FILE,
  DUET_APP_SLUG_HEADER,
  DUET_ORIGINAL_HOST_HEADER,
  FORWARDED_HOST_HEADER,
  DUET_PUBLISH_ANCHOR_PATH_HEADER,
  DUET_PUBLISH_KIND_HEADER,
  DUET_TRAIN_SOURCE_URL_HEADER,
  MAX_MIRROR_DEVICES_PER_WORKSPACE,
  serializeScrapedUrlFrontmatter,
  tunnelTokenDigest,
  type AgentTurnEvent,
  type AnchorMoveCandidatesReport,
  type AppApiCapability,
  type DriveFileEvent,
  type GatewayAnchor,
  type GatewayAppConfig,
  type GatewayRunnerInputRequest,
  type ModelSelectionId,
  type AppDeclaration,
  type VmSyncResponse,
} from '@repo/contract'
import { buildSeedArchive } from '@repo/seed-drive'
import { seedAppRegistrations } from '@repo/seed-drive/manifest'
import { decodeTunnelFrame, encodeTunnelFrame, tunnelHeaders } from '@repo/sync-tunnel'

const RUNNING_TURN_STATE = {
  status: 'running' as const,
  mode: 'agent' as const,
  agent: { status: 'running' as const, messages: [] },
}
const COMPLETED_TURN_STATE = {
  status: 'completed' as const,
  mode: 'agent' as const,
  agent: { status: 'completed' as const, messages: [] },
}
const INTERRUPTED_TURN_STATE = {
  status: 'interrupted' as const,
  mode: 'agent' as const,
  agent: { status: 'cancelled' as const, messages: [] },
}
const WAITING_TURN_STATE = {
  status: 'waiting_for_human' as const,
  mode: 'agent' as const,
  agent: { status: 'waiting' as const, messages: [] },
}

import { resolveAnchorRenameDecisions } from '../../backend/convex/domains/anchors/renameDecision'
import { createAgentSessionsController } from './agent-sessions/coordinator'
import { deliverPrompt } from './agent-sessions/test-input.test-helper'
import { appCredentialsPath, createAppCredentialStore } from './app-credentials'
import type { HelperChild, SpawnHelper } from './attribution/helper-supervisor'
import { BOOT_STATE_FILE, readBootState } from './boot-health'
import type {
  ConnectCommandChild,
  ConnectCommandRunner,
} from './connected-providers/connect-session'
import { createDesiredStateStore } from './desired-state'
import type { DuetCliRunner } from './duet-cli'
import { modelCredentialsPath } from './model-credentials'
import { REDACTION_MASK, redactText, registerRedactionSecret } from './redaction'
import { createAnchorReconciler, type AnchorReconcileTelemetry } from './routes/anchors'
import { AppSupervisor, createAppsRoutes } from './routes/apps'
import { handleTunnelUpgrade, tunnelWebSocketHandlers } from './routes/tunnel'
import { DEVELOPER_SYSTEM_PROMPT } from './runner/developer-system-prompt'
import { RUNNER_OWNER_ENV, RUNNER_RPC_FLAG, sweepOrphanRunners } from './runner/orphan-sweep'
import {
  defaultRunnerFactory,
  resolveAgentCwd,
  type AgentRunner,
  type AgentRunnerFactoryArgs,
  type ProcessRunnerOptions,
} from './runner/process-runner'
import type {
  AgentRunnerCommand,
  AgentRunnerEvent,
  AgentRunnerStartedEvent,
} from './runner/protocol'
import type { LiveFrame } from './runner/session-event-buffer'
import * as bootIdentity from './runtime/boot-identity'
import {
  GATEWAY_AUTH_ALLOWLIST,
  createGatewayRuntime as createProductionGatewayRuntime,
} from './runtime/http'
import { MockMemoryCli } from './test-fixtures/mock-memory-cli'
import { runtimeFixture } from './testing/runtime-release-fixture'
import { runDuetTrain, type TrainRunnerInput } from './train-runner'

let tempDir: string
const tempDirs = new Set<string>()

function createGatewayRuntime(
  env: Parameters<typeof createProductionGatewayRuntime>[0] = {},
): ReturnType<typeof createProductionGatewayRuntime> {
  return createProductionGatewayRuntime({
    ...env,
    connectedProviderRunCommand:
      env.connectedProviderRunCommand ?? emptyConnectedProviderStatusCommand,
    // The memory warm-up rail spawns the agent CLI unprompted at the first
    // anchor reconcile. A developer machine has a real `duet` on PATH, and a
    // test that did not ask for one must not have it building databases in
    // the background — an absent CLI is the seam's own honest answer.
    duetRunner: env.duetRunner ?? absentDuetCli,
  })
}

async function absentDuetCli(): ReturnType<DuetCliRunner> {
  throw new Error('no agent CLI in this test')
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'duet-gateway-'))
  tempDirs.add(tempDir)
})

describe('gateway agent session runner seam', () => {
  test('default runner command uses the configured memory database', async () => {
    const memoryDbPath = join(tempDir, '.duet', 'shared-memory.db')
    await mkdir(join(tempDir, 'drive', 'project'), { recursive: true })
    const runner = defaultRunnerFactory(
      {
        sessionId: 'sess_command',
        cwd: 'project',
        tier: 'balanced',
        memoryDbPath,
        systemPromptFiles: [],
      },
      join(tempDir, 'drive'),
    )

    expect((runner as unknown as { options: ProcessRunnerOptions }).options).toMatchObject({
      command: 'duet',
      args: [
        RUNNER_RPC_FLAG,
        '--session',
        'sess_command',
        '--workdir',
        join(tempDir, 'drive', 'project'),
        '--db',
        memoryDbPath,
        '--model',
        'balanced',
        '--system-prompt',
        DEVELOPER_SYSTEM_PROMPT,
      ],
    })
  })

  test('a failed delivery records why, instead of a bare 503', async () => {
    // A 503 that discards the runner's own account of the failure is how a
    // wedged start becomes indistinguishable from a slow one from the outside.
    const stateDir = join(tempDir, '.duet-runner-failure')
    const driveDir = join(tempDir, 'drive-runner-failure')
    await mkdir(driveDir, { recursive: true })
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      stateDir,
      driveDir,
      agentRunnerFactory: () => {
        throw new Error('Timeout waiting for turn_started. Stderr: model gateway refused')
      },
      agentRelayEvent: async () => undefined,
      fetch: async () => Response.json(syncResponse()),
    })

    const started = await runtime.app.request('/v1/agent/sessions/sess_wedged/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_wedged',
          prompt: 'go',
          behavior: 'steer',
          tier: 'balanced',
        }),
      ),
    })
    expect(started.status).toBe(503)
    expect(await started.json()).toEqual({ error: 'runner_unavailable' })

    const logged = await readFile(join(stateDir, 'logs', 'gateway.log'), 'utf8')
    const failure = logged
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { label: string; event?: string; exception?: unknown })
      .find(entry => entry.event === 'runner_input_failed')
    expect(failure).toBeDefined()
    expect(JSON.stringify(failure)).toContain('Timeout waiting for turn_started')
    expect(JSON.stringify(failure)).toContain('sess_wedged')
  })

  test('every registered agent owns a memory store before it has ever run', async () => {
    const stateDir = join(tempDir, '.duet-anchor-stores')
    const driveDir = join(tempDir, 'drive-anchor-stores')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    await mkdir(agentRoot, { recursive: true })
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      stateDir,
      driveDir,
      agentRelayEvent: async () => undefined,
      fetch: async () => Response.json(syncResponse()),
    })

    const reconciled = await runtime.app.request('/v1/anchors/reconcile', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        anchors: [
          {
            id: 'anchor-reviewer',
            agentId: 'agent-reviewer',
            workspaceId: 'workspace-1',
            path: 'agents/reviewer',
            kind: 'agent',
            settings: {},
            state: 'active',
            markerNonce: 'nonce-reviewer',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    })

    expect(reconciled.status).toBe(200)
    // No session has resolved this agent, and none needs to: a note written
    // from its folder must land on it from the first turn, and the Train page
    // must have somewhere to install into.
    expect(existsSync(join(agentRoot, '.agents', 'memories'))).toBe(true)
    expect(existsSync(join(driveDir, '.agents', 'memories'))).toBe(true)
    // A folder the drive has not synced yet is never fabricated by this pass.
    expect(existsSync(join(driveDir, 'agents', 'absent'))).toBe(false)
  })

  test('registering an agent builds its memory database in the background, ahead of its first turn', async () => {
    const stateDir = join(tempDir, '.duet-anchor-warmup')
    const driveDir = join(tempDir, 'drive-anchor-warmup')
    await mkdir(join(driveDir, 'agents', 'reviewer'), { recursive: true })
    const argvs: string[][] = []
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      stateDir,
      driveDir,
      duetRunner: async argv => {
        argvs.push(argv)
        const dbPath = argv[argv.indexOf('--db') + 1]!
        await mkdir(dbPath, { recursive: true })
        await writeFile(join(dbPath, 'PG_VERSION'), '17')
        return { exitCode: 0, stdout: '[]\n', stderr: '' }
      },
      agentRelayEvent: async () => undefined,
      fetch: async () => Response.json(syncResponse()),
    })

    const reconciled = await runtime.app.request('/v1/anchors/reconcile', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        anchors: [
          {
            id: 'anchor-reviewer',
            agentId: 'agent-reviewer',
            workspaceId: 'workspace-1',
            path: 'agents/reviewer',
            kind: 'agent',
            settings: {},
            state: 'active',
            markerNonce: 'nonce-reviewer',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    })
    expect(reconciled.status).toBe(200)

    // The stores the runner will be handed as `--db` on the first turn — the
    // drive root's for the default agent, then the new agent's — are the ones
    // the background build produced; nobody has spoken to either.
    const memoryDb = join(stateDir, 'agents', 'anchor-reviewer', 'memory.db')
    await waitFor(() => existsSync(join(memoryDb, 'PG_VERSION')))
    expect(existsSync(join(stateDir, 'memory.db', 'PG_VERSION'))).toBe(true)
    // Each build ran in a scratch directory beside the store it produced.
    expect(argvs.map(argv => [...argv.slice(0, 3), dirname(argv[3]!)])).toEqual([
      ['memory', '--json', '--db', stateDir],
      ['memory', '--json', '--db', dirname(memoryDb)],
    ])
    // A second reconcile of the same anchors spends nothing.
    const again = await runtime.app.request('/v1/anchors/reconcile', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ anchors: [] }),
    })
    expect(again.status).toBe(200)
    expect(argvs).toHaveLength(2)
  })

  test('direct anchor reconcile makes an agent context available to an immediate start', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    await mkdir(join(agentRoot, 'work'), { recursive: true })
    await writeFile(join(agentRoot, 'AGENTS.md'), '# Reviewer')
    const factoryArgs: AgentRunnerFactoryArgs[] = []
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      stateDir,
      driveDir,
      agentRunnerFactory: args => {
        factoryArgs.push(args)
        return new MockAgentRunner()
      },
      agentRelayEvent: async () => undefined,
      fetch: async () => Response.json(syncResponse()),
    })
    const anchor: GatewayAnchor = {
      id: 'anchor-reviewer',
      agentId: 'agent-reviewer',
      workspaceId: 'workspace-1',
      path: 'agents/reviewer',
      kind: 'agent',
      settings: {},
      state: 'active',
      markerNonce: 'nonce-reviewer',
      createdAt: 1,
      updatedAt: 1,
    }

    const reconciled = await runtime.app.request('/v1/anchors/reconcile', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ anchors: [anchor] }),
    })
    const started = await runtime.app.request('/v1/agent/sessions/sess_agent_context/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_agent_context',
          prompt: 'review',
          behavior: 'steer',
          cwd: 'agents/reviewer/work',
          tier: 'balanced',
        }),
      ),
    })

    expect(reconciled.status).toBe(200)
    expect(started.status).toBe(200)
    expect(factoryArgs[0]).toMatchObject({
      memoryDbPath: join(stateDir, 'agents', 'anchor-reviewer', 'memory.db'),
      systemPromptFiles: [
        join(stateDir, 'agents', 'anchor-reviewer', 'your-folder.md'),
        join(stateDir, 'agents', 'anchor-reviewer', 'your-session.md'),
        join(stateDir, 'agents', 'anchor-reviewer', 'showing-files.md'),
        join(agentRoot, 'AGENTS.md'),
      ],
    })

    await runtime.syncOnce()
    const defaultStarted = await runtime.app.request(
      '/v1/agent/sessions/sess_default_after_poll/input',
      {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify(
          runnerInputBody({
            sessionId: 'sess_default_after_poll',
            prompt: 'review',
            behavior: 'steer',
            cwd: 'agents/reviewer/work',
            tier: 'balanced',
          }),
        ),
      },
    )
    expect(defaultStarted.status).toBe(200)
    expect(factoryArgs[1]).toMatchObject({ memoryDbPath: join(stateDir, 'memory.db') })
    expect(factoryArgs[1]).toMatchObject({
      systemPromptFiles: [
        join(stateDir, 'your-folder.md'),
        join(stateDir, 'your-session.md'),
        join(stateDir, 'showing-files.md'),
      ],
    })
  })

  test('onboarding without ONBOARDING.md launches on the completion contract, never AGENTS.md', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'AGENTS.md'), '# Reviewer')
    const factoryArgs: AgentRunnerFactoryArgs[] = []
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      stateDir,
      driveDir,
      agentRunnerFactory: args => {
        factoryArgs.push(args)
        return new MockAgentRunner()
      },
      agentRelayEvent: async () => undefined,
      fetch: async () => Response.json(syncResponse()),
    })
    const anchor: GatewayAnchor = {
      id: 'anchor-reviewer',
      agentId: 'agent-reviewer',
      workspaceId: 'workspace-1',
      path: 'agents/reviewer',
      kind: 'agent',
      settings: {},
      state: 'active',
      markerNonce: 'nonce-reviewer',
      createdAt: 1,
      updatedAt: 1,
    }
    await runtime.app.request('/v1/anchors/reconcile', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ anchors: [anchor] }),
    })

    const response = await runtime.app.request('/v1/agent/sessions/sess_missing_onboarding/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_missing_onboarding',
          prompt: 'Introduce yourself',
          behavior: 'steer',
          cwd: 'agents/reviewer',
          tier: 'balanced',
          onboarding: true,
        }),
      ),
    })

    // ONBOARDING.md is optional, so the session starts. What it must NOT do is
    // fall back to the agent's ordinary persona: the user believes they are
    // being onboarded, and AGENTS.md would quietly run a different agent.
    expect(response.status).toBe(200)
    expect(factoryArgs).toHaveLength(1)
    const promptFiles = factoryArgs[0]?.systemPromptFiles ?? []
    expect(promptFiles.some(file => file.endsWith('AGENTS.md'))).toBe(false)
    expect(promptFiles).toEqual([
      expect.stringContaining('your-folder.md'),
      expect.stringContaining('showing-files.md'),
      expect.stringContaining('onboarding-completion.md'),
    ])
  })

  test('launch lineage fields resolve generated layers before the runner is created', async () => {
    const stateDir = join(tempDir, '.duet-prompt-layers')
    const driveDir = join(tempDir, 'drive-prompt-layers')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    await mkdir(agentRoot, { recursive: true })
    await writeFile(join(agentRoot, 'AGENTS.md'), '# Reviewer')
    const factoryArgs: AgentRunnerFactoryArgs[] = []
    const anchor: GatewayAnchor = {
      id: 'reviewer',
      agentId: 'agent_reviewer',
      workspaceId: 'workspace-1',
      path: 'agents/reviewer',
      kind: 'agent',
      settings: {},
      state: 'active',
      markerNonce: 'nonce-reviewer',
      createdAt: 1,
      updatedAt: 1,
    }
    const controller = createAgentSessionsController({
      stateDir,
      driveDir,
      memoryDbPath: join(stateDir, 'memory.db'),
      anchors: () => [anchor],
      apps: () => [
        {
          appId: 'review-app',
          slug: 'review-app',
          command: 'bun run dev',
          port: 3000,
          anchorPath: 'agents/reviewer/app',
          apiScopes: [],
          visibility: 'folder',
        },
      ],
      workspaceSlug: () => 'acme',
      getVmToken: async () => null,
      runnerFactory: args => {
        factoryArgs.push(args)
        return new MockAgentRunner()
      },
      relayEvent: async () => ({ seq: 1 }),
      ensureRunner: async () => undefined,
      cgroup: { place: async () => undefined, removeWhenDrained: async () => undefined },
    })

    await controller.deliverInput('sess_child', {
      attemptId: 'attempt-child',
      throughSeq: 1,
      input: {
        kind: 'prompt',
        message: 'Start delegated work',
        behavior: 'steer',
      },
      launch: {
        cwd: 'agents/reviewer',
        tier: 'balanced',
        defaultSession: true,
        createdBySessionId: 'sess_parent',
      },
    })

    expect(factoryArgs[0]?.systemPromptFiles).toEqual([
      join(stateDir, 'agents', 'reviewer', 'your-folder.md'),
      join(stateDir, 'agents', 'reviewer', 'your-apps.md'),
      join(stateDir, 'agents', 'reviewer', 'your-session.md'),
      join(stateDir, 'agents', 'reviewer', 'parent-session.md'),
      expect.stringContaining('showing-files.md'),
      join(agentRoot, 'AGENTS.md'),
    ])
  })

  test('the pull-now route synchronously materializes accepted official-agent desired state', async () => {
    const hubDriveDir = join(tempDir, 'hub-drive')
    await mkdir(join(hubDriveDir, 'official-agents', 'research-assistant'), { recursive: true })
    await writeFile(
      join(hubDriveDir, 'official-agents', 'research-assistant', 'AGENTS.md'),
      '# Official research assistant\n',
    )
    const hub = new Hono()
    const { createPublishesRoutes } = await import('./routes/publishes')
    hub.route(
      '/public/publish',
      createPublishesRoutes({
        driveDir: hubDriveDir,
        stateDir: join(tempDir, 'hub-state'),
      }),
    )
    const desired = {
      subscriptions: [
        {
          subscriptionId: 'subscription-1',
          listingId: 'listing-1',
          sourceUrl:
            'https://edge-staging.duet.so/hub-workspace/official-agents/research-assistant?zip',
          agentName: 'research-assistant',
          path: 'agents/research-assistant',
          anchorId: 'anchor-1',
          mode: 'subscribe' as const,
        },
      ],
    }
    const fetched: string[] = []
    const runtime = await registeredRuntime({
      fetch: async (input, init) => {
        const request = new Request(input, init)
        fetched.push(request.url)
        const headers = new Headers(request.headers)
        headers.set(DUET_PUBLISH_KIND_HEADER, 'folder')
        headers.set(DUET_PUBLISH_ANCHOR_PATH_HEADER, 'official-agents')
        const source = new URL(request.url)
        const nested = source.pathname.split('/').filter(Boolean).slice(2).join('/')
        const local = new URL(`http://gateway.local/public/publish/${nested}`)
        local.search = source.search
        return hub.request(local.toString(), { method: request.method, headers })
      },
    })
    const arbitraryUpstream = await runtime.app.request('/v1/marketplace/pull', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ ...desired, upstreamUrl: 'http://attacker.test/archive.zip' }),
    })
    const response = await runtime.app.request('/v1/marketplace/pull', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(desired),
    })

    // The property that matters is where the bytes come from, not which status
    // a caller gets: the hub base URL is server-owned, so an attacker-supplied
    // `upstreamUrl` must never be fetched. It is dropped rather than rejected —
    // asserting the 400 pinned the mechanism, and would have gone red on a
    // schema change that left the security property perfectly intact.
    expect(fetched.some(url => url.includes('attacker.test'))).toBe(false)
    expect(
      fetched.every(url => url.startsWith('https://edge-staging.duet.so/hub-workspace/')),
    ).toBe(true)
    expect(arbitraryUpstream.status).toBe(200)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      reports: [{ subscriptionId: 'subscription-1', state: 'active' }],
    })
    expect(
      await readFile(join(tempDir, 'drive', 'agents', 'research-assistant', 'AGENTS.md'), 'utf8'),
    ).toBe('# Official research assistant\n')
  })

  test('agent cwd rejects escapes, missing dirs, and files; allows internal symlinks', async () => {
    const drive = join(tempDir, 'drive')
    const outside = join(tempDir, 'outside')
    await mkdir(join(drive, 'real'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(drive, 'notes.txt'), 'plain file')
    await symlink(outside, join(drive, 'escape'))
    await symlink(join(drive, 'real'), join(drive, 'alias'))

    expect(() => resolveAgentCwd(drive, 'escape')).toThrow('Invalid agent cwd')
    expect(() => resolveAgentCwd(drive, 'escape/nested')).toThrow('Invalid agent cwd')
    expect(() => resolveAgentCwd(drive, 'missing/dir')).toThrow('Invalid agent cwd')
    expect(() => resolveAgentCwd(drive, 'notes.txt')).toThrow('Invalid agent cwd')
    expect(resolveAgentCwd(drive, 'alias')).toBe(join(drive, 'alias'))
    expect(resolveAgentCwd(drive, 'real')).toBe(join(drive, 'real'))
  })

  test('cooperative interrupt sends an interrupt command and relays interrupted terminal state', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n')
    await seedModelCredentials(stateDir)
    const runner = new MockAgentRunner()
    const relayed: Array<{ sessionId: string; event: AgentRunnerEvent }> = []
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir: join(tempDir, 'drive'),
      agentRunnerFactory: () => runner,
      agentRelayEvent: async (sessionId, _relayId, event) => {
        relayed.push({ sessionId, event: event as AgentRunnerEvent })
      },
    })

    const start = await runtime.app.request('/v1/agent/sessions/sess_interrupt/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_interrupt',
          prompt: 'work',
          behavior: 'steer',
          tier: 'balanced',
        }),
      ),
    })
    expect(start.status).toBe(200)
    expect(runner.commands.map(command => command.type)).toEqual(['start', 'prompt'])

    const interrupted = await runtime.app.request('/v1/agent/sessions/sess_interrupt/interrupt', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({}),
    })
    expect(interrupted.status).toBe(200)
    expect(runner.commands.map(command => command.type)).toEqual(['start', 'prompt', 'interrupt'])
    await waitFor(() => relayed.some(row => row.event.type === 'interrupted'))
    expect(runner.killed).toBe(true)
  })

  test('an interrupt the gateway cannot deliver answers undeliverable, not a server error', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n')
    await seedModelCredentials(stateDir)
    const askRunner = new MockAgentRunner(true)
    const runners: MockAgentRunner[] = [askRunner]
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir: join(tempDir, 'drive'),
      // The stop press lands after the turn's runner is gone, so honouring it
      // means hydrating the checkpoint into a fresh spawn — and a VM that
      // cannot spawn (credentials not yet delivered, agent install broken)
      // fails that hydration. The press must still get an answer.
      agentRunnerFactory: () => {
        const next = runners.shift()
        if (next === undefined) throw new Error('Model credentials have not arrived yet')
        return next
      },
      agentRelayEvent: async () => undefined,
    })

    const start = await runtime.app.request('/v1/agent/sessions/sess_stuck/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_stuck',
          prompt: 'work',
          behavior: 'steer',
          tier: 'balanced',
        }),
      ),
    })
    expect(start.status).toBe(200)
    await waitFor(() => askRunner.killed)

    const interrupted = await runtime.app.request('/v1/agent/sessions/sess_stuck/interrupt', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({}),
    })
    expect(interrupted.status).toBe(200)
    expect(await interrupted.json()).toEqual({ ok: true, interrupted: false })
  })

  test('SUBS-IMPL-07 quiesce persists before interrupting agents without blocking sync', async () => {
    let releaseInterrupt!: () => void
    const interruptMayFinish = new Promise<void>(resolve => {
      releaseInterrupt = resolve
    })
    const runner = new (class extends MockAgentRunner {
      override async send(command: AgentRunnerCommand): Promise<void> {
        if (command.type !== 'interrupt') return super.send(command)
        this.commands.push(command)
        await interruptMayFinish
        this.emitEvent({ type: 'interrupted', state: INTERRUPTED_TURN_STATE })
      }
    })()
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      agentRunnerFactory: () => runner,
      agentRelayEvent: async () => undefined,
      fetch: async () => Response.json(syncResponse({ quiesce: true })),
    })
    const start = await runtime.app.request('/v1/agent/sessions/sess_quiesce/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_quiesce',
          prompt: 'work',
          behavior: 'steer',
          tier: 'balanced',
        }),
      ),
    })
    expect(start.status).toBe(200)

    let syncSettled = false
    const sync = runtime.syncOnce().then(() => {
      syncSettled = true
    })
    try {
      await waitFor(() => runner.commands.some(command => command.type === 'interrupt'))
      expect(runtime.desiredState.current().quiesced).toBe(true)
      await waitFor(() => syncSettled)
      expect(runner.killed).toBe(false)
      expect(runner.commands.map(command => command.type)).toEqual(['start', 'prompt', 'interrupt'])
    } finally {
      releaseInterrupt()
      await sync
      await waitFor(() => runner.killed)
    }
  })

  test('a quiesced sync still awaits anchor reconciliation before it can settle healthy', async () => {
    let releaseMoveReport!: () => void
    const moveReportMayFinish = new Promise<void>(resolve => {
      releaseMoveReport = resolve
    })
    let moveReportStarted = false
    const missingApp = {
      ...gatewayAnchorFixture('anchor-quiesced-health', 'apps/missing', 'agent-unused'),
      kind: 'app' as const,
      agentId: undefined,
    }
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      fetch: async input => {
        const url = String(input)
        if (url.endsWith('/v1/vm/sync')) {
          return Response.json(syncResponse({ quiesce: true, anchors: [missingApp] }))
        }
        if (url.endsWith('/v1/vm/anchors/move-candidates')) {
          moveReportStarted = true
          await moveReportMayFinish
          return Response.json({ ok: true })
        }
        throw new Error(`unexpected request: ${url}`)
      },
    })

    let syncSettled = false
    const sync = runtime.syncOnce().then(() => {
      syncSettled = true
    })
    await waitFor(() => moveReportStarted)
    await Promise.resolve()
    expect(syncSettled).toBe(false)

    releaseMoveReport()
    await sync
    expect(syncSettled).toBe(true)
  })

  test('Chrome maintenance refuses a new runner until the browser update finishes', async () => {
    let releaseInstall!: () => void
    const installMayFinish = new Promise<void>(resolve => {
      releaseInstall = resolve
    })
    let installStarted = false
    const runners: MockAgentRunner[] = []
    const runtime = await registeredRuntime({
      agentRelayEvent: async () => undefined,
      agentRunnerFactory: () => {
        const runner = new MockAgentRunner()
        runners.push(runner)
        return runner
      },
      systemCommand: async argv => {
        if (argv.includes('/opt/duet/bin/update-shared-chrome')) {
          installStarted = true
          await installMayFinish
        }
        return { exitCode: argv.includes('is-active') ? 3 : 0 }
      },
    })

    const update = runtime.app.request('/v1/internal-admin/chrome-update', {
      method: 'POST',
      headers: authHeaders(),
    })
    await waitFor(() => installStarted)

    const input = JSON.stringify(
      runnerInputBody({
        sessionId: 'sess_chrome_maintenance',
        prompt: 'wait for browser maintenance',
        behavior: 'steer',
        tier: 'balanced',
      }),
    )
    const blocked = await runtime.app.request('/v1/agent/sessions/sess_chrome_maintenance/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: input,
    })
    expect({ status: blocked.status, body: await blocked.json(), runners: runners.length }).toEqual(
      {
        status: 503,
        body: { error: 'runner_unavailable' },
        runners: 0,
      },
    )

    releaseInstall()
    expect((await update).status).toBe(200)
    const accepted = await runtime.app.request('/v1/agent/sessions/sess_chrome_maintenance/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: input,
    })
    expect({ status: accepted.status, runners: runners.length }).toEqual({
      status: 200,
      runners: 1,
    })
  })

  test('real turn_started shape is accepted before the prompt is sent', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n')
    await seedModelCredentials(stateDir)
    const runner = new MockAgentRunner()
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir: join(tempDir, 'drive'),
      agentRunnerFactory: () => runner,
      agentRelayEvent: async () => undefined,
    })

    const response = await runtime.app.request('/v1/agent/sessions/sess_bad_protocol/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_bad_protocol',
          prompt: 'work',
          behavior: 'follow_up',
          tier: 'balanced',
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(runner.commands).toEqual([
      { type: 'start', options: { model: 'balanced' }, mode: 'auto' },
      {
        type: 'prompt',
        requestId: expect.any(String),
        message: 'work',
        behavior: 'follow_up',
      },
    ])
    expect(runner.killed).toBe(false)
  })

  test('agent session prompt forwards images verbatim to the runner', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n')
    await seedModelCredentials(stateDir)
    const runner = new MockAgentRunner()
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir: join(tempDir, 'drive'),
      agentRunnerFactory: () => runner,
      agentRelayEvent: async () => undefined,
    })

    const response = await runtime.app.request('/v1/agent/sessions/sess_images/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_images',
          prompt: 'inspect',
          behavior: 'steer',
          tier: 'balanced',
          images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
        }),
      ),
    })

    expect(response.status).toBe(200)
    expect(runner.commands[1]).toEqual({
      type: 'prompt',
      requestId: expect.any(String),
      message: 'inspect',
      behavior: 'steer',
      images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
    })
  })

  test('ask kills its runner and the answer rehydrates the checkpoint into a fresh spawn', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n')
    await seedModelCredentials(stateDir)
    const askRunner = new MockAgentRunner(true)
    const answerRunner = new MockAgentRunner()
    const runners = [askRunner, answerRunner]
    const relayed: AgentRunnerEvent[] = []
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir: join(tempDir, 'drive'),
      agentRunnerFactory: () => runners.shift()!,
      agentRelayEvent: async (_sessionId, _relayId, event) => {
        relayed.push(event as AgentRunnerEvent)
      },
    })

    const start = await runtime.app.request('/v1/agent/sessions/sess_ask/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_ask',
          prompt: 'question',
          behavior: 'steer',
          tier: 'balanced',
        }),
      ),
    })
    expect(start.status).toBe(200)
    await waitFor(() => relayed.some(event => event.type === 'ask'))

    const answer = await runtime.app.request('/v1/agent/sessions/sess_ask/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        attemptId: 'sess_ask:2',
        throughSeq: 2,
        input: {
          kind: 'answer',
          answer: 'approved',
          images: [{ data: 'YW5zd2VyLWltZw==', mimeType: 'image/webp' }],
        },
        launch: { tier: 'balanced' },
      }),
    })
    expect(answer.status).toBe(200)
    // Terminal means terminal: the ask killed its runner; the answer spawns a
    // fresh one that resumes from the durable ask checkpoint.
    expect(askRunner.killed).toBe(true)
    expect(askRunner.commands.map(command => command.type)).toEqual(['start', 'prompt'])
    expect(answerRunner.commands.map(command => command.type)).toEqual(['start', 'prompt'])
    expect(answerRunner.commands[1]).toEqual({
      type: 'prompt',
      requestId: expect.any(String),
      message: 'approved',
      behavior: 'follow_up',
      images: [{ data: 'YW5zd2VyLWltZw==', mimeType: 'image/webp' }],
    })
  })

  test('session event buffer tails live frames, durable acks, and turn resets', async () => {
    const firstRunner = new MockAgentRunner()
    const secondRunner = new MockAgentRunner()
    const runners = [firstRunner, secondRunner]
    let runnerIndex = 0
    let nextSeq = 0
    const relayedEvents: string[] = []
    const controller = createAgentSessionsController({
      stateDir: join(tempDir, '.duet'),
      driveDir: join(tempDir, 'drive'),
      memoryDbPath: join(tempDir, '.duet', 'memory.db'),
      getVmToken: async () => null,
      runnerFactory: () => runners[runnerIndex++]!,
      relayEvent: async (_sessionId, _relayId, event) => {
        relayedEvents.push(event.type === 'step' ? event.step.type : event.type)
        return { seq: (nextSeq += 1) }
      },
      ensureRunner: async () => undefined,
    })

    const live = controller.subscribeToEvents('sess_buffer', 0)
    await deliverPrompt(controller, {
      sessionId: 'sess_buffer',
      prompt: 'work',
      behavior: 'steer',
      tier: 'balanced',
      throughSeq: 0,
    })
    firstRunner.emitEvent({ type: 'step', step: { type: 'text_delta', delta: 'par' } })
    firstRunner.emitEvent({
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: 'read_file',
        toolCallId: 'call-1',
        input: { path: 'README.md' },
        isError: false,
        output: [{ type: 'text', text: 'ok' }],
      },
    })
    firstRunner.emitEvent({
      type: 'complete',
      state: COMPLETED_TURN_STATE,
      status: 'completed',
      result: 'done',
    })

    // Clean wire: canonical steps (turn_started/tool_call/complete) appear ONCE as
    // their durable id:-tagged frame after the relay acks; only ephemerals
    // (text_delta) carry a no-id live frame. turn_started is relayed during the
    // awaited startTurn, so its durable frame lands before the runner's deltas.
    const liveFrames = await collectFrames(live, 4)
    expect(liveFrames.map(frameSummary)).toEqual([
      ['turn_started', 1],
      ['text_delta', null],
      ['tool_call', 2],
      ['complete', 3],
    ])
    expect(relayedEvents).toEqual(['turn_started', 'tool_call', 'complete'])

    // Reconnect since=2: the client already has everything through tool_call(2), so
    // only the still-unseen durable complete(3) replays — NOT the text_delta, whose
    // step finalized before the client's cursor.
    const sinceToolCall = controller.subscribeToEvents('sess_buffer', 2)
    expect((await collectFrames(sinceToolCall, 1)).map(frameSummary)).toEqual([['complete', 3]])

    await waitFor(() => !controller.has('sess_buffer'))
    await deliverPrompt(controller, {
      sessionId: 'sess_buffer',
      prompt: 'next',
      behavior: 'steer',
      tier: 'balanced',
      throughSeq: 3,
    })
    const afterReset = controller.subscribeToEvents('sess_buffer', 0)
    expect((await collectFrames(afterReset, 1)).map(frameSummary)).toEqual([['turn_started', 4]])

    live.close()
    sinceToolCall.close()
    afterReset.close()
  })

  test('agent session events stream live ephemerals, durable SSE ids, cursors, and terminal close', async () => {
    const runner = new MockAgentRunner()
    let nextSeq = 0
    const relayedEvents: string[] = []
    const runtime = await registeredRuntime({
      agentRunnerFactory: () => runner,
      agentRelayEvent: async (_sessionId, _relayId, event) => {
        relayedEvents.push(event.type === 'step' ? event.step.type : event.type)
        return { seq: (nextSeq += 1) }
      },
    })

    const unauthorized = await runtime.app.request('/v1/agent/sessions/sess_sse/events')
    expect(unauthorized.status).toBe(401)

    const start = await runtime.app.request('/v1/agent/sessions/sess_sse/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_sse',
          prompt: 'work',
          behavior: 'steer',
          tier: 'balanced',
          throughSeq: 0,
        }),
      ),
    })
    expect(start.status).toBe(200)
    await waitFor(() => nextSeq >= 1)

    const liveResponse = await runtime.app.request('/v1/agent/sessions/sess_sse/events?since=1', {
      headers: authHeaders(),
    })
    expect(liveResponse.status).toBe(200)
    expect(liveResponse.headers.get('content-type')).toBe('text/event-stream')
    expect(liveResponse.headers.get('cache-control')).toBe('no-cache')
    const liveBodyPromise = liveResponse.text()

    runner.emitEvent({ type: 'step', step: { type: 'text_delta', delta: 'hel' } })
    runner.emitEvent({
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: 'read_file',
        toolCallId: 'call-1',
        input: { path: 'README.md' },
        isError: false,
        output: [{ type: 'text', text: 'ok' }],
      },
    })
    await waitFor(() => nextSeq >= 2)
    runner.emitEvent({
      type: 'complete',
      state: COMPLETED_TURN_STATE,
      status: 'completed',
      result: 'done',
    })

    const liveFrames = parseSseFrames(await withTimeout(liveBodyPromise, 1_000))
    expect(liveFrames[0]).toMatchObject({
      event: 'step',
      data: { event: { type: 'step', step: { type: 'text_delta', delta: 'hel' } } },
    })
    expect(liveFrames[0]?.id).toBeUndefined()
    expect(
      liveFrames.some(
        frame =>
          frame.id === '2' &&
          frame.data.seq === 2 &&
          frame.data.event.type === 'step' &&
          frame.data.event.step.type === 'tool_call',
      ),
    ).toBe(true)
    expect(liveFrames.at(-1)?.data.event.type).toBe('complete')
    expect(relayedEvents).toEqual(['turn_started', 'tool_call', 'complete'])
    await waitFor(() => nextSeq >= 3)

    const replayResponse = await runtime.app.request('/v1/agent/sessions/sess_sse/events?since=2', {
      headers: authHeaders(),
    })
    expect(replayResponse.status).toBe(200)
    const replayFrames = parseSseFrames(await withTimeout(replayResponse.text(), 1_000))
    // Reconnect since=2: only the unseen durable complete(3) replays. The earlier
    // text_delta belongs to a step that finalized before the cursor, so it is not
    // re-streamed; nor are the already-seen durables 1/2.
    expect(
      replayFrames.some(
        frame =>
          frame.id === undefined &&
          frame.data.event.type === 'step' &&
          frame.data.event.step.type === 'text_delta',
      ),
    ).toBe(false)
    expect(replayFrames.some(frame => frame.id === '1' || frame.id === '2')).toBe(false)
    expect(
      replayFrames.some(frame => frame.id === '3' && frame.data.event.type === 'complete'),
    ).toBe(true)
  })

  test('agent cwd cannot escape the workspace drive', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n')
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir: join(tempDir, 'drive'),
    })

    const response = await runtime.app.request('/v1/agent/sessions/sess_cwd/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_cwd',
          prompt: 'work',
          behavior: 'steer',
          tier: 'balanced',
          cwd: '/tmp',
        }),
      ),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_request' })
  })

  test('orphan-runner sweep kills only dead-owner rpc runners', async () => {
    const procDir = join(tempDir, 'proc')
    await writeProc(procDir, '101', {
      environ: [`${RUNNER_OWNER_ENV}=999`],
      cmdline: ['duet', RUNNER_RPC_FLAG, '--workdir', '/drive'],
    })
    await writeProc(procDir, '102', {
      environ: [`${RUNNER_OWNER_ENV}=123`],
      cmdline: ['duet', RUNNER_RPC_FLAG, '--workdir', '/drive'],
    })
    await writeProc(procDir, '103', {
      environ: [`${RUNNER_OWNER_ENV}=999`],
      cmdline: ['bun', 'dev'],
    })
    const killed: number[] = []

    expect(
      sweepOrphanRunners({
        procDir,
        isPidAlive: pid => pid === 123,
        killPid: pid => killed.push(pid),
      }),
    ).toEqual([101])
    expect(killed).toEqual([101])
  })
})

describe('train record index failures stay out of the sync rail', () => {
  // The index feeds the train tab. Anchor state is release-health evidence and
  // stays fatal; the index is not, because a failed sync cycle marks the
  // workspace unhealthy and takes the Files pane and every app with it.
  test('an index that cannot open does not fail the sync cycle', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'agents', 'reviewer', '.agents', 'memories'), { recursive: true })
    // Occupy the index path with a directory so SQLite can never open it.
    await mkdir(join(stateDir, 'train', 'record-index.sqlite'), { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const anchor: GatewayAnchor = {
      id: 'anchor-reviewer',
      agentId: 'agent-reviewer',
      workspaceId: 'workspace-1',
      path: 'agents/reviewer',
      kind: 'agent',
      settings: {},
      state: 'active',
      markerNonce: 'nonce-reviewer',
      createdAt: 1,
      updatedAt: 1,
    }
    const backend = new Hono()
    backend.post('/v1/vm/sync', c => c.json(syncResponse({ anchors: [anchor] })))
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir,
      apiUrl: 'http://backend',
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    await runtime.syncOnce()

    const logs = await readFile(join(stateDir, 'logs', 'gateway.log'), 'utf8')
    expect(logs).toContain('record_index_reconcile_failed')
  })
})

afterAll(async () => {
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })))
})

describe('gateway upload auth and CORS seam', () => {
  test('agent train mounts return 404 until the anchor registry projects the scope', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const agentRoot = join(driveDir, 'agents', 'reviewer')
    const storeDir = join(agentRoot, '.agents', 'memories')
    await Promise.all([mkdir(storeDir, { recursive: true }), mkdir(stateDir, { recursive: true })])
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    await writeFile(
      join(storeDir, 'review-guide.md'),
      serializeMemoryFile({
        version: 1,
        id: 'mem_review_guide',
        kind: 'train',
        createdAt: Date.parse('2026-07-23T00:00:00.000Z'),
        content: 'review carefully',
      }),
    )
    const runtime = createGatewayRuntime({ stateDir, driveDir })
    const recordsPath = '/v1/train/agents/anchor-reviewer/records'

    const unknown = await runtime.app.request(recordsPath, { headers: authHeaders() })
    const reconciled = await runtime.app.request('/v1/anchors/reconcile', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        anchors: [
          {
            id: 'anchor-reviewer',
            agentId: 'agent-reviewer',
            workspaceId: 'workspace-1',
            path: 'agents/reviewer',
            kind: 'agent',
            settings: {},
            state: 'active',
            createdAt: 1,
            updatedAt: 1,
            markerNonce: 'nonce-reviewer',
          },
        ],
      }),
    })
    const known = await runtime.app.request(recordsPath, { headers: authHeaders() })
    const rootRecords = await runtime.app.request('/v1/train/records', {
      headers: authHeaders(),
    })

    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'not_found' })
    expect(reconciled.status).toBe(200)
    expect(await known.json()).toMatchObject({
      items: [{ slug: 'review-guide' }],
      nextCursor: null,
    })
    expect(await rootRecords.json()).toEqual({ items: [], nextCursor: null })
  })

  test('stores binary bytes and lists frontmattered markdown through the real upload routes', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir, now: () => 1_000 })
    const binary = new Uint8Array([0, 255, 1, 128, 2, 64])

    const uploaded = await runtime.app.request('/v1/train/uploads/fixture.bin', {
      method: 'PUT',
      headers: authHeaders(),
      body: binary,
    })
    const markdown = serializeScrapedUrlFrontmatter(
      {
        url: 'https://example.com/source',
        title: 'Source',
        scrapedAt: '2026-07-15T00:00:00.000Z',
      },
      '# Exact markdown',
    )
    const uploadedMarkdown = await runtime.app.request('/v1/train/uploads/source.md', {
      method: 'PUT',
      headers: {
        ...authHeaders(),
        [DUET_TRAIN_SOURCE_URL_HEADER]: 'https://example.com/source',
      },
      body: markdown,
    })
    const listed = await runtime.app.request('/v1/train/uploads', {
      headers: authHeaders(),
    })

    expect(uploaded.status).toBe(201)
    expect(uploadedMarkdown.status).toBe(201)
    expect(await uploadedMarkdown.json()).toMatchObject({
      file: { filename: 'source.md', url: 'https://example.com/source' },
    })
    expect(
      createHash('sha256')
        .update(await readFile(join(stateDir, 'train', 'uploads', 'root', 'fixture.bin')))
        .digest('hex'),
    ).toBe(createHash('sha256').update(binary).digest('hex'))
    expect(await listed.json()).toMatchObject({
      nextCursor: null,
      meta: {
        capBytes: 1024 * 1024 * 1024,
        fileCount: 2,
        running: false,
      },
      items: [
        { filename: 'fixture.bin', size: binary.byteLength },
        {
          filename: 'source.md',
          size: Buffer.byteLength(markdown),
          url: 'https://example.com/source',
        },
      ],
    })

    const removed = await runtime.app.request('/v1/train/uploads/fixture.bin', {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(removed.status).toBe(200)
    expect(
      (await runtime.app.request('/v1/train/uploads', { headers: authHeaders() })).json(),
    ).resolves.toMatchObject({
      items: [{ filename: 'source.md' }],
    })
  })

  test('reports running state, accepts next-run uploads, and blocks deletes during training', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    let started = false
    let finish!: () => void
    const finished = new Promise<void>(resolve => {
      finish = resolve
    })
    const runtime = createGatewayRuntime({
      stateDir,
      trainRunner: async input => {
        started = true
        await writeFakeTrainOutput(input)
        await finished
        return { record: null, stdout: '', stderr: '' }
      },
    })
    await runtime.app.request('/v1/train/uploads/kept.bin', {
      method: 'PUT',
      headers: authHeaders(),
      body: 'kept',
    })
    const training = runtime.app.request('/v1/train', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ files: [{ filename: 'inline.txt', content: 'train me' }] }),
    })
    await waitFor(() => started)

    const [put, remove, list] = await Promise.all([
      runtime.app.request('/v1/train/uploads/new.bin', {
        method: 'PUT',
        headers: authHeaders(),
        body: 'new',
      }),
      runtime.app.request('/v1/train/uploads/kept.bin', {
        method: 'DELETE',
        headers: authHeaders(),
      }),
      runtime.app.request('/v1/train/uploads', { headers: authHeaders() }),
    ])

    expect(put.status).toBe(201)
    expect(await put.json()).toMatchObject({ file: { filename: 'new.bin', size: 3 } })
    expect(await remove.json()).toEqual({ error: 'train_running' })
    expect(remove.status).toBe(409)
    expect(await list.json()).toMatchObject({ meta: { running: true } })
    finish()
    expect((await training).status).toBe(202)
    await waitForAsync(async () => {
      const response = await runtime.app.request('/v1/train/uploads', { headers: authHeaders() })
      return ((await response.json()) as { meta: { running: boolean } }).meta.running === false
    })
    const remaining = await runtime.app.request('/v1/train/uploads', { headers: authHeaders() })
    expect(await remaining.json()).toMatchObject({ items: [{ filename: 'new.bin', size: 3 }] })
  })

  test('sweeps orphaned upload temp files from every scoped inbox at gateway boot', async () => {
    const stateDir = join(tempDir, '.duet')
    const uploadTemp = join(stateDir, 'train', 'temp')
    const scopeDirs = ['root', 'anchor-a', 'anchor-b'].map(scope => join(uploadTemp, scope))
    await Promise.all(scopeDirs.map(scopeDir => mkdir(scopeDir, { recursive: true })))
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    await Promise.all(
      scopeDirs.map(scopeDir => writeFile(join(scopeDir, 'upload-orphan'), 'partial')),
    )
    await createGatewayRuntime({ stateDir }).app.request('/v1/train/uploads', {
      headers: authHeaders(),
    })

    expect(await Promise.all(scopeDirs.map(scopeDir => readdir(scopeDir)))).toEqual([[], [], []])
  })

  test('sweeps orphaned drive-write temp files at gateway boot', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const uploadTemp = join(driveDir, '.duet', 'uploads')
    await Promise.all([
      mkdir(uploadTemp, { recursive: true }),
      mkdir(stateDir, { recursive: true }),
    ])
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    await Promise.all([
      writeFile(join(uploadTemp, 'upload-orphan-a'), 'partial'),
      writeFile(join(uploadTemp, 'upload-orphan-b'), 'partial'),
      writeFile(join(uploadTemp, 'keep-me'), 'unrelated'),
      mkdir(join(uploadTemp, 'upload-undeletable')),
    ])

    const runtime = createGatewayRuntime({ stateDir, driveDir })
    const response = await runtime.app.request('/v1/files/missing', { headers: authHeaders() })

    expect(response.status).toBe(404)
    expect((await readdir(uploadTemp)).sort()).toEqual(['keep-me', 'upload-undeletable'])
  })

  test('keeps Files available when the drive temp path cannot be swept', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const driveStateDir = join(driveDir, '.duet')
    await Promise.all([
      mkdir(driveStateDir, { recursive: true }),
      mkdir(stateDir, { recursive: true }),
    ])
    await writeFile(join(driveStateDir, 'uploads'), 'not a directory')
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })

    const runtime = createGatewayRuntime({ stateDir, driveDir })
    const response = await runtime.app.request('/v1/files/missing', { headers: authHeaders() })

    expect(response.status).toBe(404)
  })

  test('answers unauthenticated upload preflights for the configured web origin', async () => {
    const runtime = createGatewayRuntime({
      stateDir: join(tempDir, '.duet'),
      webAppOrigin: 'https://app-staging.duet.so',
    })

    const response = await runtime.app.request('/v1/train/uploads/probe.bin', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app-staging.duet.so',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app-staging.duet.so')
    expect(response.headers.get('access-control-allow-methods')).toContain('PUT')
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  test('extends upload CORS only to the agent-scoped upload subtree', async () => {
    const runtime = createGatewayRuntime({
      stateDir: join(tempDir, '.duet'),
      webAppOrigin: 'https://app-staging.duet.so',
    })
    const headers = {
      origin: 'https://app-staging.duet.so',
      'access-control-request-method': 'PUT',
    }

    const [upload, neighboringTrainPath] = await Promise.all([
      runtime.app.request('/v1/train/agents/anchor-a/uploads/probe.bin', {
        method: 'OPTIONS',
        headers,
      }),
      runtime.app.request('/v1/train/agents/anchor-a/records', {
        method: 'OPTIONS',
        headers,
      }),
    ])

    expect(upload.status).toBe(204)
    expect(upload.headers.get('access-control-allow-origin')).toBe('https://app-staging.duet.so')
    expect(neighboringTrainPath.status).toBe(401)
    expect(neighboringTrainPath.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('does not approve a disallowed browser origin', async () => {
    const runtime = createGatewayRuntime({
      stateDir: join(tempDir, '.duet'),
      webAppOrigin: 'https://app-staging.duet.so',
    })

    const responses = await Promise.all(
      ['/v1/train/uploads/probe.bin', '/v1/files/uploads/probe.bin'].map(path =>
        runtime.app.request(path, {
          method: 'OPTIONS',
          headers: {
            origin: 'https://attacker.example',
            'access-control-request-method': 'PUT',
          },
        }),
      ),
    )

    expect(responses.map(response => response.status)).toEqual([401, 401])
    expect(responses.map(response => response.headers.get('access-control-allow-origin'))).toEqual([
      null,
      null,
    ])
  })

  test('answers drive-upload preflights with the actor attribution header', async () => {
    const runtime = createGatewayRuntime({
      stateDir: join(tempDir, '.duet'),
      webAppOrigin: 'https://app-staging.duet.so',
    })

    const response = await runtime.app.request('/v1/files/example.bin', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app-staging.duet.so',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type,x-duet-actor-context',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app-staging.duet.so')
    expect(response.headers.get('access-control-allow-headers')).toContain('x-duet-actor-context')
  })

  // The entire point of putting the cap in the route rather than in the
  // transport. Bun's own refusal carries no CORS headers, so a browser reads it
  // as a network failure with no status; this one is readable, which is the
  // difference between "your file is too big" and an unexplained error.
  test('an oversize upload is refused readably, with CORS headers', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir,
      webAppOrigin: 'https://app-staging.duet.so',
    })

    const response = await runtime.app.request('/v1/files/enormous.bin', {
      method: 'PUT',
      headers: {
        ...authHeaders(),
        origin: 'https://app-staging.duet.so',
        'content-length': String(DRIVE_UPLOAD_MAX_BYTES + 1),
      },
      body: 'bytes',
    })

    expect(response.status).toBe(413)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app-staging.duet.so')
    expect(await response.json()).toEqual({
      error: 'file_too_large',
      limitBytes: DRIVE_UPLOAD_MAX_BYTES,
    })
  })

  test('a VM-authenticated caller mints a path grant that writes through the drive handler', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir, driveDir, now: () => 1_000 })
    const events: DriveFileEvent[] = []
    runtime.fileEvents.onEvent(event => events.push(event))

    const grantResponse = await runtime.app.request('/v1/drive-grants', {
      method: 'POST',
      headers: {
        authorization: 'Bearer vm-token',
        'content-type': 'application/json',
        [DUET_ACTOR_CONTEXT_HEADER]: 'api-key:key_123',
      },
      body: JSON.stringify({ kind: 'upload', pathPrefix: 'agents/a/uploads' }),
    })

    expect(grantResponse.status).toBe(200)
    const grant = (await grantResponse.json()) as {
      uploadPath: string
      uploadToken: string
      expiresAt: number
    }
    expect(grant.uploadPath).toBe('/v1/files/agents/a/uploads')
    expect(grant.expiresAt).toBe(901_000)

    const response = await runtime.app.request(`${grant.uploadPath}/notes.txt`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${grant.uploadToken}`,
        [DUET_ACTOR_CONTEXT_HEADER]: 'web:spoofed',
      },
      body: 'attachment bytes',
    })
    const unattributed = await runtime.app.request(`${grant.uploadPath}/system.txt`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant.uploadToken}` },
      body: 'system bytes',
    })
    const statResponse = await runtime.app.request(`${grant.uploadPath}/notes.txt?stat=1`, {
      headers: authHeaders(),
    })
    const statBody = (await statResponse.json()) as { etag: string }

    expect(response.status).toBe(200)
    expect(unattributed.status).toBe(200)
    expect(response.headers.get('etag')).toBe(statBody.etag)
    expect(await readFile(join(driveDir, 'agents/a/uploads/notes.txt'), 'utf8')).toBe(
      'attachment bytes',
    )
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'write',
        path: 'agents/a/uploads/notes.txt',
        actor: 'api-key:key_123',
      }),
      expect.objectContaining({
        kind: 'write',
        path: 'agents/a/uploads/system.txt',
        actor: 'api-key:key_123',
      }),
    ])
  })

  // The Drive's own root is a folder like any other, and the files tab uploads
  // into it constantly. A grant that cannot name it would leave the browser no
  // way to send a file anywhere but a subfolder.
  test('a path grant covers the drive root and stays inside it', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir, driveDir })

    const grantResponse = await runtime.app.request('/v1/drive-grants', {
      method: 'POST',
      headers: {
        authorization: 'Bearer vm-token',
        'content-type': 'application/json',
        [DUET_ACTOR_CONTEXT_HEADER]: 'web:user1',
      },
      body: JSON.stringify({ kind: 'upload', pathPrefix: '' }),
    })

    expect(grantResponse.status).toBe(200)
    const grant = (await grantResponse.json()) as { uploadPath: string; uploadToken: string }
    expect(grant.uploadPath).toBe('/v1/files')

    const atRoot = await runtime.app.request(`${grant.uploadPath}/backup.zip`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant.uploadToken}` },
      body: 'root bytes',
    })
    const inFolder = await runtime.app.request(`${grant.uploadPath}/docs/nested.txt`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant.uploadToken}` },
      body: 'nested bytes',
    })
    const escaping = await runtime.app.request(`${grant.uploadPath}/../outside.txt`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant.uploadToken}` },
      body: 'escaping bytes',
    })

    expect(atRoot.status).toBe(200)
    expect(inFolder.status).toBe(200)
    expect(escaping.status).toBe(401)
    expect(await readFile(join(driveDir, 'backup.zip'), 'utf8')).toBe('root bytes')
    expect(await readFile(join(driveDir, 'docs/nested.txt'), 'utf8')).toBe('nested bytes')
  })

  test('an exact Drive read grant serves headerless HEAD and attributes GET to its actor', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await Promise.all([
      mkdir(stateDir, { recursive: true }),
      mkdir(join(driveDir, 'docs'), { recursive: true }),
    ])
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    await writeFile(join(driveDir, 'docs/report.txt'), 'durable bytes')
    let now = 1_000
    const runtime = createGatewayRuntime({ stateDir, driveDir, now: () => now })
    const events: DriveFileEvent[] = []
    runtime.fileEvents.onEvent(event => events.push(event))

    const grantResponse = await runtime.app.request('/v1/drive-grants', {
      method: 'POST',
      headers: {
        ...jsonAuthHeaders(),
        [DUET_ACTOR_CONTEXT_HEADER]: 'web:user1',
      },
      body: JSON.stringify({ kind: 'download', path: 'docs/report.txt' }),
    })
    expect(grantResponse.status).toBe(200)
    const grant = (await grantResponse.json()) as { downloadPath: string; expiresAt: number }

    const response = await runtime.app.request(grant.downloadPath, { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('content-length')).toBe('13')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const firstEtag = response.headers.get('etag')
    expect(await response.arrayBuffer()).toHaveLength(0)
    expect(events).toEqual([])

    const read = await runtime.app.request(grant.downloadPath, {
      headers: { [DUET_ACTOR_CONTEXT_HEADER]: 'web:spoofed' },
    })

    expect(read.status).toBe(200)
    expect(await read.text()).toBe('durable bytes')
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'read',
        path: 'docs/report.txt',
        actor: 'web:user1',
      }),
    ])

    const ranged = await runtime.app.request(grant.downloadPath, {
      headers: { range: 'bytes=0-6' },
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 0-6/13')
    expect(await ranged.text()).toBe('durable')

    await writeFile(join(driveDir, 'docs/report.txt'), 'replacement bytes')
    const replaced = await runtime.app.request(grant.downloadPath)
    expect(replaced.status).toBe(200)
    expect(replaced.headers.get('etag')).not.toBe(firstEtag)
    expect(await replaced.text()).toBe('replacement bytes')

    const wrongPath = await runtime.app.request(
      grant.downloadPath.replace('docs/report.txt', 'docs/other.txt'),
    )
    const wrongMethod = await runtime.app.request(grant.downloadPath, {
      method: 'PUT',
      body: 'not allowed',
    })
    now = grant.expiresAt
    const expired = await runtime.app.request(grant.downloadPath)
    expect([wrongPath.status, wrongMethod.status, expired.status]).toEqual([401, 401, 401])
  })

  test('an exact Drive read grant preserves Content-Length through the Bun server', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await Promise.all([
      mkdir(stateDir, { recursive: true }),
      mkdir(join(driveDir, 'docs'), { recursive: true }),
    ])
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    await writeFile(join(driveDir, 'docs/report.txt'), 'durable bytes')
    const runtime = createGatewayRuntime({ stateDir, driveDir })
    const grantResponse = await runtime.app.request('/v1/drive-grants', {
      method: 'POST',
      headers: {
        ...jsonAuthHeaders(),
        [DUET_ACTOR_CONTEXT_HEADER]: 'web:user1',
      },
      body: JSON.stringify({ kind: 'download', path: 'docs/report.txt' }),
    })
    expect(grantResponse.status).toBe(200)
    const grant = (await grantResponse.json()) as { downloadPath: string }
    const server = Bun.serve({ port: 0, fetch: request => runtime.app.fetch(request) })

    try {
      const response = await fetch(new URL(grant.downloadPath, server.url))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-length')).toBe('13')
      expect(await response.text()).toBe('durable bytes')

      const ranged = await fetch(new URL(grant.downloadPath, server.url), {
        headers: { range: 'bytes=0-6' },
      })
      expect(ranged.status).toBe(206)
      expect(ranged.headers.get('content-length')).toBe('7')
      expect(ranged.headers.get('content-range')).toBe('bytes 0-6/13')
      expect(await ranged.text()).toBe('durable')
    } finally {
      server.stop(true)
    }
  })

  test('drive PUTs disable Bun request timeout before streaming the body', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir, driveDir })
    const calls: Array<{ request: Request; seconds: number }> = []
    runtime.setRequestTimeoutExtender((request, seconds) => calls.push({ request, seconds }))

    const response = await runtime.app.request('/v1/files/large.bin', {
      method: 'PUT',
      headers: authHeaders(),
      body: 'bytes',
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request.method).toBe('PUT')
    expect(calls[0]!.seconds).toBe(0)
  })

  test('a drive grant is write-only and confined to its path prefix', async () => {
    let now = 1_000
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(driveDir, { recursive: true })])
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir,
      now: () => now,
      uploadTokenTtlMs: 500,
    })
    const grantResponse = await runtime.app.request('/v1/drive-grants', {
      method: 'POST',
      headers: {
        ...jsonAuthHeaders(),
        [DUET_ACTOR_CONTEXT_HEADER]: 'system',
      },
      body: JSON.stringify({ kind: 'upload', pathPrefix: 'uploads' }),
    })
    const grant = (await grantResponse.json()) as { uploadToken: string }
    const headers = { authorization: `Bearer ${grant.uploadToken}` }

    const inside = await runtime.app.request('/v1/files/uploads/file.txt', {
      method: 'PUT',
      headers,
      body: 'bytes',
    })
    const [outside, read, action] = await Promise.all([
      runtime.app.request('/v1/files/other/file.txt', { method: 'PUT', headers, body: 'bytes' }),
      runtime.app.request('/v1/files/uploads/file.txt', { headers }),
      runtime.app.request('/v1/files/actions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ operation: 'delete', path: 'uploads/file.txt' }),
      }),
    ])
    const removed = await runtime.app.request('/v1/files/uploads/file.txt', {
      method: 'DELETE',
      headers,
    })
    now = 1_500
    const expired = await runtime.app.request('/v1/files/uploads/late.txt', {
      method: 'PUT',
      headers,
      body: 'late',
    })

    expect(inside.status).toBe(200)
    expect([outside.status, read.status, action.status, expired.status]).toEqual([
      401, 401, 401, 401,
    ])
    expect(removed.status).toBe(200)
  })

  test('a VM-authenticated caller mints a token that authorizes a raw upload', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({
      stateDir,
      webAppOrigin: 'https://app-staging.duet.so',
      now: () => 1_000,
    })

    const grantResponse = await runtime.app.request('/v1/train/upload-token', {
      method: 'POST',
      headers: { authorization: 'Bearer vm-token' },
    })
    expect(grantResponse.status).toBe(200)
    const grant = (await grantResponse.json()) as {
      uploadPath: string
      uploadToken: string
      expiresAt: number
    }
    expect(grant.uploadPath).toBe('/v1/train/uploads')

    const bytes = new Uint8Array([0, 1, 2, 255])
    const response = await runtime.app.request('/v1/train/uploads/probe.bin', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${grant.uploadToken}`,
        origin: 'https://app-staging.duet.so',
      },
      body: bytes,
    })

    expect(response.status).toBe(201)
    expect(
      createHash('sha256')
        .update(await readFile(join(stateDir, 'train', 'uploads', 'root', 'probe.bin')))
        .digest('hex'),
    ).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app-staging.duet.so')
  })

  test('agent upload leases coexist and authorize only their own scoped path', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await Promise.all([
      mkdir(stateDir, { recursive: true }),
      mkdir(join(driveDir, 'agents', 'a'), { recursive: true }),
      mkdir(join(driveDir, 'agents', 'b'), { recursive: true }),
    ])
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir, driveDir, now: () => 1_000 })
    const reconcile = await runtime.app.request('/v1/anchors/reconcile', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        anchors: [
          gatewayAnchorFixture('anchor-a', 'agents/a', 'agent-a'),
          gatewayAnchorFixture('anchor-b', 'agents/b', 'agent-b'),
        ],
      }),
    })
    expect(reconcile.status).toBe(200)

    const grantAResponse = await runtime.app.request('/v1/train/agents/anchor-a/upload-token', {
      method: 'POST',
      headers: { authorization: 'Bearer vm-token' },
    })
    const grantBResponse = await runtime.app.request('/v1/train/agents/anchor-b/upload-token', {
      method: 'POST',
      headers: { authorization: 'Bearer vm-token' },
    })
    expect([grantAResponse.status, grantBResponse.status]).toEqual([200, 200])
    const grantA = (await grantAResponse.json()) as { uploadPath: string; uploadToken: string }
    const grantB = (await grantBResponse.json()) as { uploadPath: string; uploadToken: string }

    expect([grantA.uploadPath, grantB.uploadPath]).toEqual([
      '/v1/train/agents/anchor-a/uploads',
      '/v1/train/agents/anchor-b/uploads',
    ])
    const wrongScope = await runtime.app.request(`${grantB.uploadPath}/wrong.bin`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${grantA.uploadToken}` },
      body: 'wrong',
    })
    const [uploadedA, uploadedB] = await Promise.all([
      runtime.app.request(`${grantA.uploadPath}/a.bin`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${grantA.uploadToken}` },
        body: 'scope-a',
      }),
      runtime.app.request(`${grantB.uploadPath}/b.bin`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${grantB.uploadToken}` },
        body: 'scope-b',
      }),
    ])

    expect(wrongScope.status).toBe(401)
    expect([uploadedA.status, uploadedB.status]).toEqual([201, 201])
    expect(await readFile(join(stateDir, 'train', 'uploads', 'anchor-a', 'a.bin'), 'utf8')).toBe(
      'scope-a',
    )
    expect(await readFile(join(stateDir, 'train', 'uploads', 'anchor-b', 'b.bin'), 'utf8')).toBe(
      'scope-b',
    )
  })

  test('rejects unsafe agent anchors before minting a lease or resolving an inbox', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir })

    const mintResponse = await runtime.app.request(
      '/v1/train/agents/%2e%2e%2fescape/upload-token',
      {
        method: 'POST',
        headers: { authorization: 'Bearer vm-token' },
      },
    )
    const inboxResponse = await runtime.app.request('/v1/train/agents/root/uploads', {
      headers: { authorization: 'Bearer vm-token' },
    })

    expect([mintResponse.status, inboxResponse.status]).toEqual([400, 400])
    expect(await mintResponse.json()).toEqual({ error: 'invalid_anchor_id' })
    expect(await inboxResponse.json()).toEqual({ error: 'invalid_anchor_id' })
    expect(await readdir(join(stateDir, 'upload-tokens')).catch(() => [])).toEqual([])
  })

  test('rejects an expired upload token', async () => {
    let now = 1_000
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir, now: () => now, uploadTokenTtlMs: 500 })
    const grantResponse = await runtime.app.request('/v1/train/upload-token', {
      method: 'POST',
      headers: { authorization: 'Bearer vm-token' },
    })
    const grant = (await grantResponse.json()) as { uploadToken: string }

    now = 1_500
    const response = await runtime.app.request('/v1/train/uploads/probe.bin', {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant.uploadToken}` },
      body: 'bytes',
    })

    expect(response.status).toBe(401)
  })

  test('rejects a tampered upload token', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir, now: () => 1_000 })
    const grantResponse = await runtime.app.request('/v1/train/upload-token', {
      method: 'POST',
      headers: { authorization: 'Bearer vm-token' },
    })
    const grant = (await grantResponse.json()) as { uploadToken: string }

    const response = await runtime.app.request('/v1/train/uploads/probe.bin', {
      method: 'PUT',
      headers: { authorization: `Bearer ${grant.uploadToken}x` },
      body: 'bytes',
    })

    expect(response.status).toBe(401)
  })

  test('rejects an upload token outside the train uploads subtree', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir, now: () => 1_000 })
    const grantResponse = await runtime.app.request('/v1/train/upload-token', {
      method: 'POST',
      headers: { authorization: 'Bearer vm-token' },
    })
    const grant = (await grantResponse.json()) as { uploadToken: string }
    const headers = { authorization: `Bearer ${grant.uploadToken}` }

    const responses = await Promise.all([
      runtime.app.request('/v1/files/example.bin', { method: 'PUT', headers, body: 'bytes' }),
      runtime.app.request('/v1/memory', { method: 'POST', headers }),
      runtime.app.request('/v1/train', { method: 'POST', headers }),
      runtime.app.request('/v1/train/upload-token', { method: 'POST', headers }),
    ])

    expect(responses.map(response => response.status)).toEqual([401, 401, 401, 401])
  })
})

describe('gateway slice04 routes and phone-home loop seams', () => {
  test('health and admin status share the process-cached OS boot identity', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const reader = spyOn(bootIdentity, 'readProcessBootId').mockReturnValue('os-boot-test')
    try {
      const runtime = createGatewayRuntime({ stateDir, instanceId: 'process-test' })
      const headers = { authorization: 'Bearer vm-token' }
      for (const path of ['/health', '/v1/internal-admin/status']) {
        const response = await runtime.app.request(path, { headers })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          instanceId: 'process-test',
          bootId: 'os-boot-test',
        })
      }
    } finally {
      reader.mockRestore()
    }
  })
  test('health is VM-authenticated while the explicit bootstrap routes remain public', async () => {
    let now = 1_000
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      instanceId: 'gateway-instance-test',
      runtimeVersion: 'runtime-test',
      imageVersion: 'img-test',
      now: () => now,
    })

    const healthz = await runtime.app.request('/healthz')
    expect(healthz.status).toBe(200)
    expect(await healthz.text()).toBe('ok')
    expect((await runtime.app.request('/health')).status).toBe(401)
    expect(
      (await runtime.app.request('/health', { headers: { authorization: 'Bearer prov-token' } }))
        .status,
    ).toBe(401)
    now = 11_500
    const response = await runtime.app.request('/health', {
      headers: { authorization: 'Bearer vm-token' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      instanceId: 'gateway-instance-test',
      imageVersion: 'img-test',
      runtimeVersion: 'runtime-test',
      uptimeSeconds: 10,
      diagnostics: {
        attribution: {
          rawEventsObserved: 0,
          droppedReads: 0,
          overflow: 0,
          mirrorReadsSkipped: 0,
          cgroupMisses: 0,
          helperRestarts: 0,
        },
        scanNudge: {
          scans: 0,
          failures: 0,
          loopGuardSkips: 0,
          rawPathsObserved: 0,
          latestPaths: [],
        },
        anchorReconcile: null,
        restoreInFlight: false,
        bootHealthCertified: false,
        runtimeUpdateInFlight: false,
        backup: null,
      },
    })

    const restoreProbe = await runtime.app.request('/v1/diagnostics/restore-window', {
      method: 'POST',
      headers: {
        authorization: 'Bearer vm-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ anchors: [] }),
    })
    expect(restoreProbe.status).toBe(200)
    expect(await restoreProbe.json()).toEqual({
      reports: [],
      telemetry: expect.objectContaining({
        path: 'skipped',
        anchorCount: 0,
        anchorProbes: 0,
        walkEntries: 0,
        excludedSubtrees: 0,
        skipReason: 'restore_in_flight',
      }),
      restoreInFlight: false,
    })
    const probedHealth = await runtime.app.request('/health', {
      headers: { authorization: 'Bearer vm-token' },
    })
    expect(await probedHealth.json()).toMatchObject({
      diagnostics: {
        restoreInFlight: false,
        anchorReconcile: { path: 'skipped', skipReason: 'restore_in_flight' },
      },
    })
  })

  test('route table stays default-deny except the explicit auth allowlist', async () => {
    const runtime = createGatewayRuntime({ stateDir: join(tempDir, '.duet') })
    const allowlist = new Set(GATEWAY_AUTH_ALLOWLIST.map(route => `${route.method} ${route.path}`))
    const routes = runtime.routeSpecs()

    expect(routes.map(route => `${route.method} ${route.path}`)).toContain('GET /healthz')
    for (const route of routes) {
      const response = await runtime.app.request(samplePath(route.path), { method: route.method })
      if (allowlist.has(`${route.method} ${route.path}`)) {
        expect(response.status, `${route.method} ${route.path}`).not.toBe(401)
      } else {
        expect(response.status, `${route.method} ${route.path}`).toBe(401)
      }
    }
  })

  test('desktop path credentials enter through the shared runtime authenticator', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({
      stateDir,
      now: () => 100,
      readKasmCredential: async () => ({ username: 'duet', password: 'local-only' }),
      desktopFetch: async () => new Response('desktop asset'),
      systemCommand: async () => ({ exitCode: 0 }),
    })
    const token = 'browser_secret'
    const registered = await runtime.app.request('/v1/desktop/grants', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        grantId: 'desktop-1',
        tokenDigest: createHash('sha256').update(token).digest('hex'),
        expiresAt: 200,
        embedOrigin: 'https://customer.example',
      }),
    })
    expect(registered.status).toBe(200)

    const path = `/v1/desktop/desktop-1.${token}/static/app.js`
    const desktop = await runtime.app.request(path)
    expect(desktop.status).toBe(200)
    expect(desktop.headers.get('content-security-policy')).toBe(
      'frame-ancestors https://customer.example',
    )
    expect((await runtime.app.request('/v1/desktop/desktop-1.wrong/static/app.js')).status).toBe(
      401,
    )
    expect((await runtime.app.request('/v1/desktop/not-a-credential/static/app.js')).status).toBe(
      401,
    )
    const logs = await readFile(join(stateDir, 'logs', 'gateway.log'), 'utf8')
    expect(logs).not.toContain(token)
    expect(logs).toContain('/v1/desktop/:credential/static/app.js')
  })

  test('the browser batch handoff is VM-token authenticated and the legacy route is absent', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({
      stateDir,
      now: () => 1_500,
    })

    const unauthenticated = await runtime.app.request('/v1/desktop/browser/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-a' }),
    })
    expect(unauthenticated.status).toBe(401)

    const legacy = await runtime.app.request('/v1/desktop/browser/session', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ sessionId: 'session-a' }),
    })
    expect(legacy.status).toBe(404)

    const status = await runtime.app.request('/v1/desktop/status', {
      headers: jsonAuthHeaders(),
    })
    expect(await status.json()).toEqual({
      phase: 'stopped',
      viewers: 0,
      owners: [],
    })
    const logs = await readFile(join(stateDir, 'logs', 'gateway.log'), 'utf8')
    expect(logs).toContain('/v1/desktop/browser/batches')
    expect(logs).not.toContain('/v1/desktop/:credential/session')
  })

  test('connected-provider routes are registered and require VM bearer auth', async () => {
    const runtime = createGatewayRuntime({ stateDir: join(tempDir, '.duet') })
    const routes = [
      ['POST', '/v1/connected-providers/connect'],
      ['GET', '/v1/connected-providers/connect/:sessionId'],
      ['POST', '/v1/connected-providers/disconnect'],
      ['GET', '/v1/connected-providers'],
    ] as const
    const registered = new Set(runtime.routeSpecs().map(route => `${route.method} ${route.path}`))

    for (const [method, path] of routes) {
      expect(registered.has(`${method} ${path}`), `${method} ${path}`).toBe(true)
      const response = await runtime.app.request(path.replace(':sessionId', 'connect_fixture'), {
        method,
      })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
  })

  // Provider status is read when a person opens the page, not folded into the
  // poll: the credential store lives on the VM and can change out of band, so
  // the control plane asks the VM at read time instead of carrying a copy that
  // is wrong between polls. The poll must therefore never spawn the CLI.
  test('the sync rail never asks the CLI for connected-provider status', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    let posted: unknown
    const backend = new Hono()
    backend.post('/v1/vm/sync', async c => {
      posted = await c.req.json()
      return c.json(syncResponse())
    })
    const invocations: string[][] = []
    const runtime = createGatewayRuntime({
      stateDir,
      apiUrl: 'http://backend',
      connectedProviderRunCommand: argv => {
        invocations.push([...argv])
        return connectedProviderStatusCommand({ connections: [] })
      },
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    await runtime.syncOnce()

    expect(invocations).toEqual([])
    expect(posted).toBeDefined()
    expect(Object.keys(posted as Record<string, unknown>)).not.toContain('connectedProviders')
  })

  // Performance regression guard, denominated in the thing we pay for: CPU
  // burned by a workspace that is doing nothing. A VM polls this rail every
  // five seconds for its whole life, so any work a poll re-derives is paid
  // twelve times a minute forever — that is how idle VMs ended up at a third
  // of a core. The provider command here really spawns a process, because
  // spawning is the expensive shape this rail regressed into and a stubbed
  // stream would hide its cost.
  test('an idle sync poll stays inside its CPU budget', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const backend = new Hono()
    backend.post('/v1/vm/sync', c => c.json(syncResponse()))
    const runtime = createGatewayRuntime({
      stateDir,
      apiUrl: 'http://backend',
      connectedProviderRunCommand: () => spawnedConnectedProviderStatusCommand(),
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    await runtime.syncOnce() // first poll pays for cold caches and one probe
    const polls = 20
    spawnedProbeCpuMs = 0
    const before = process.cpuUsage()
    for (let poll = 0; poll < polls; poll += 1) await runtime.syncOnce()
    const used = process.cpuUsage(before)
    // Child CPU counts: it is billed to the VM exactly like our own.
    const cpuMsPerPoll = ((used.user + used.system) / 1000 + spawnedProbeCpuMs) / polls

    // Measured either side of the line this guards: a settled idle poll costs
    // ~3ms, while re-probing providers on every poll costs ~32ms — most of it
    // child CPU, which the VM is billed for exactly like ours. 10ms sits with
    // room on both sides so CI noise cannot decide the verdict.
    expect(cpuMsPerPoll).toBeLessThan(10)
  })

  test('register stores the durable vm token outside the drive with 0600 mode, then sync uses it', async () => {
    const calls: string[] = []
    const desired = runtimeFixture('registered-desire')
    const requestBodies: unknown[] = []
    const backend = new Hono()
    backend.post('/v1/vm/register', async c => {
      calls.push('register')
      expect(c.req.header('bypass-tunnel-reminder')).toBeUndefined()
      const body = await c.req.json()
      requestBodies.push(body)
      expect(body).toMatchObject({
        provisioningToken: 'prov-token',
        workspaceHint: 'ws1',
        runtimeVersion: '1.0.0',
        imageVersion: '3.0.0',
      })
      return c.json({
        vmToken: 'vm-token',
        syncIntervalSeconds: 60,
        sync: syncResponse(),
      })
    })
    backend.post('/v1/vm/sync', async c => {
      calls.push(c.req.header('authorization') ?? '')
      expect(c.req.header('bypass-tunnel-reminder')).toBeUndefined()
      const body = await c.req.json()
      requestBodies.push(body)
      expect(body).toMatchObject({
        workspaceHint: 'ws1',
        versions: {
          runtime: '1.0.0',
          image: '3.0.0',
        },
      })
      return c.json(syncResponse({ runtimeRelease: runtimeRelease(desired) }))
    })

    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      join(stateDir, BOOT_STATE_FILE),
      `${JSON.stringify({ attemptedVersion: '1.0.0', consecutiveFailures: 2 })}\n`,
    )
    const runtime = createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      driveDir,
      runtimeVersion: '1.0.0',
      imageVersion: '3.0.0',
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    await runtime.registerOnce()
    await runtime.syncOnce()

    expect(calls).toEqual(['register', 'Bearer vm-token'])
    expect(requestBodies).toHaveLength(2)
    expect(runtime.desiredState.current()).toMatchObject({
      paused: false,
      runtimeRelease: runtimeRelease(desired),
    })
    expect(createDesiredStateStore(stateDir).current()).toMatchObject({
      paused: false,
      runtimeRelease: runtimeRelease(desired),
    })
    expect((await readFile(join(stateDir, 'vm-token'), 'utf8')).trim()).toBe('vm-token')
    expect((await stat(join(stateDir, 'vm-token'))).mode & 0o777).toBe(0o600)
    expect(join(stateDir, 'vm-token')).not.toStartWith(driveDir)
    expect(await readBootState(stateDir)).toEqual({
      attemptedVersion: '1.0.0',
      consecutiveFailures: 2,
    })
  })

  test('sync app directives reconcile idempotently and distinguish absent from empty', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'sync-site')
    const startsPath = join(appDir, 'starts')
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, 'message.txt'), 'from sync')
    const port = await freePort()
    const appConfig = {
      slug: 'sync-site',
      command: `printf s >> starts; exec ${fileServerCommand(port)}`,
      port,
      anchorPath: 'apps/sync-site',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const responses = [
      syncResponse({ apps: [appConfig] }),
      syncResponse({ apps: [appConfig] }),
      syncResponse(),
      syncResponse({ apps: [] }),
    ]
    const backend = new Hono()
    backend.post('/v1/vm/sync', c => c.json(responses.shift()!))
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      driveDir,
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    // App reconcile is detached from the sync tick (installs must not block the
    // loop), so it converges shortly after syncOnce — poll the public endpoint
    // like a real client rather than assert synchronously.
    const appStatus = async (): Promise<number> =>
      (
        await runtime.app.request('/public/app/message.txt', {
          headers: { ...authHeaders(), [DUET_APP_SLUG_HEADER]: 'sync-site' },
        })
      ).status
    const waitForStatus = async (want: number): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await appStatus()) === want) return
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error(`app never reached status ${want}`)
    }

    await runtime.syncOnce()
    await waitForStatus(200)
    const proxied = await runtime.app.request('/public/app/message.txt', {
      headers: { ...authHeaders(), [DUET_APP_SLUG_HEADER]: 'sync-site' },
    })
    expect(await proxied.text()).toBe('from sync')
    expect(await readFile(startsPath, 'utf8')).toBe('s')

    await runtime.syncOnce()
    await waitForStatus(200)
    expect(await readFile(startsPath, 'utf8')).toBe('s')

    await runtime.syncOnce()
    await waitForStatus(200)

    await runtime.syncOnce()
    await waitForStatus(404)
  })

  test('gateway restart preserves cached app keys until an authoritative apps snapshot', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    createAppCredentialStore(stateDir).acceptResponse({
      appCredentials: [credentialEnvelope('saved-app', 'saved-app-key', ['files:read'])],
    })
    const saved = await readFile(appCredentialsPath(stateDir), 'utf8')
    const requests: Array<Record<string, unknown>> = []
    const backend = new Hono()
    backend.post('/v1/vm/sync', async c => {
      requests.push((await c.req.json()) as Record<string, unknown>)
      return c.json(syncResponse(requests.length === 1 ? {} : { apps: [] }))
    })
    const runtime = await registeredRuntime({
      stateDir,
      apiUrl: 'http://backend',
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    await runtime.syncOnce()
    expect(requests[0]!.needsAppCredentials).toEqual([])
    expect(await readFile(appCredentialsPath(stateDir), 'utf8')).toBe(saved)
    expect(createAppCredentialStore(stateDir).envForApp('saved-app')).toEqual({
      DUET_APP_API_KEY: 'saved-app-key',
    })

    await runtime.syncOnce()
    expect(createAppCredentialStore(stateDir).envForApp('saved-app')).toBeNull()
  })

  test('sync-delivered app credentials inject per app and rotation restarts only that app', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'credential-one'), { recursive: true })
    await mkdir(join(driveDir, 'apps', 'credential-two'), { recursive: true })
    await mkdir(join(driveDir, 'apps', 'credential-empty'), { recursive: true })
    const appOne: GatewayAppConfig = {
      slug: 'credential-one',
      command: envInspectorCommand(),
      port: await freePort(),
      anchorPath: 'apps/credential-one',
      appId: 'app-one',
      apiScopes: ['files:read'],
    }
    const appTwo: GatewayAppConfig = {
      slug: 'credential-two',
      command: envInspectorCommand(),
      port: await freePort(),
      anchorPath: 'apps/credential-two',
      appId: 'app-two',
      apiScopes: ['sessions'],
    }
    const appEmpty: GatewayAppConfig = {
      slug: 'credential-empty',
      command: envInspectorCommand(),
      port: await freePort(),
      anchorPath: 'apps/credential-empty',
      appId: 'app-empty',
      apiScopes: [],
    }
    const requests: Array<Record<string, unknown>> = []
    let poll = 0
    const backend = new Hono()
    backend.post('/v1/vm/sync', async c => {
      requests.push((await c.req.json()) as Record<string, unknown>)
      poll += 1
      if (poll === 1) return c.json(syncResponse({ apps: [appOne, appTwo, appEmpty] }))
      if (poll === 2) {
        return c.json(
          syncResponse({
            appCredentials: [
              credentialEnvelope('app-one', 'key-one-v1', ['files:read']),
              credentialEnvelope('app-two', 'key-two-v1', ['sessions']),
            ],
          }),
        )
      }
      return c.json(
        syncResponse({
          appCredentials: [credentialEnvelope('app-one', 'key-one-v2', ['files:read'])],
        }),
      )
    })
    const runtime = await registeredRuntime({
      apiUrl: 'https://api.duet.test///',
      driveDir,
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })
    const inspect = async (slug: string): Promise<{ env: Record<string, string>; pid: number }> => {
      const response = await runtime.app.request('/public/app/', {
        headers: { ...authHeaders(), [DUET_APP_SLUG_HEADER]: slug },
      })
      if (!response.ok) throw new Error(`inspector ${slug} returned ${response.status}`)
      return (await response.json()) as { env: Record<string, string>; pid: number }
    }

    await runtime.syncOnce()
    await runtime.syncOnce()
    await waitForAsync(
      async () =>
        (await inspect('credential-one').catch(() => null))?.env.DUET_APP_API_KEY === 'key-one-v1',
    )
    await waitForAsync(
      async () =>
        (await inspect('credential-two').catch(() => null))?.env.DUET_APP_API_KEY === 'key-two-v1',
    )
    await waitForAsync(async () => (await inspect('credential-empty').catch(() => null)) !== null)
    const firstOne = await inspect('credential-one')
    const firstTwo = await inspect('credential-two')
    const empty = await inspect('credential-empty')
    expect(requests[1]!.needsAppCredentials).toEqual(['app-one', 'app-two'])
    // Every app is told where the model gateway is; whether it may spend there
    // is the gateway's call, keyed on the app's own scopes.
    // No DUET_AGENT_DIR: these sit at the workspace root, so no agent owns them.
    expect(firstOne.env).toEqual({
      DUET_API_URL: 'https://api.duet.test',
      DUET_APP_API_KEY: 'key-one-v1',
      DUET_APP_DIR: 'apps/credential-one',
      DUET_GATEWAY_BASE_URL: 'https://gateway.test',
      HOME: process.env.HOME!,
      PATH: process.env.PATH!,
      PORT: String(appOne.port),
    })
    expect(firstTwo.env.DUET_APP_API_KEY).toBe('key-two-v1')
    expect(empty.env).toEqual({
      DUET_API_URL: 'https://api.duet.test',
      DUET_APP_DIR: 'apps/credential-empty',
      DUET_GATEWAY_BASE_URL: 'https://gateway.test',
      HOME: process.env.HOME!,
      PATH: process.env.PATH!,
      PORT: String(appEmpty.port),
    })

    await runtime.syncOnce()
    await waitForAsync(async () => {
      const current = await inspect('credential-one').catch(() => null)
      return current !== null && current.pid !== firstOne.pid
    })
    const rotatedOne = await inspect('credential-one')
    const unchangedTwo = await inspect('credential-two')
    expect(rotatedOne.env.DUET_APP_API_KEY).toBe('key-one-v2')
    expect(unchangedTwo.pid).toBe(firstTwo.pid)
    await runtime.app.request('/v1/apps/reconcile', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ apps: [] }),
    })
  })

  // An app that has to derive something — turn a scraped palette into colour
  // ROLES, write voice rules — calls the model gateway itself, so it needs the
  // address. It must NOT receive `DUET_API_KEY`: that is the runner's
  // workspace-wide model credential, and an app spends under its own key, which
  // is what lets the gateway attribute the generation to the app.
  // An app that writes into its agent's folder has to know which folder that is.
  // It cannot assume: an installed copy is named by whoever installed it, so the
  // canonical `agents/<slug>` of the manifest is right for the hub and wrong for
  // everyone else. The gateway resolves it through the same contract owner the
  // API's own app-onboarded route uses, so both sides answer alike.
  test('an app inside an agent folder is told which agent folder it is in', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'agents', 'branding', 'apps', 'setup'), { recursive: true })
    const app: GatewayAppConfig = {
      slug: 'setup',
      command: envInspectorCommand(),
      port: await freePort(),
      // The user called this agent "branding" on install; nothing in the app
      // could have guessed that.
      anchorPath: 'agents/branding/apps/setup',
      appId: 'app-setup',
      apiScopes: ['files:write'],
    }
    const backend = new Hono()
    backend.post('/v1/vm/register', c =>
      c.json({ vmToken: 'vm-token', syncIntervalSeconds: 5, sync: syncResponse({ apps: [app] }) }),
    )
    backend.post('/v1/vm/sync', async c => {
      await c.req.json()
      return c.json(
        syncResponse({
          apps: [app],
          agents: [
            {
              kind: 'agent',
              agentId: 'agent-1',
              anchorId: 'anchor-1',
              anchorPath: 'agents/branding',
              slug: 'branding',
              name: 'Branding',
            },
          ],
          appCredentials: [credentialEnvelope('app-setup', 'app-key-v1', ['files:write'])],
        }),
      )
    })
    const runtime = await registeredRuntime({
      apiUrl: 'https://api.duet.test',
      driveDir,
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })
    const inspect = async (): Promise<{ env: Record<string, string> }> => {
      const response = await runtime.app.request('/public/app/', {
        headers: { ...authHeaders(), [DUET_APP_SLUG_HEADER]: 'setup' },
      })
      if (!response.ok) throw new Error(`inspector returned ${response.status}`)
      return (await response.json()) as { env: Record<string, string> }
    }

    await runtime.syncOnce()
    await waitForAsync(
      async () => (await inspect().catch(() => null))?.env.DUET_APP_API_KEY === 'app-key-v1',
    )
    const { env } = await inspect()
    expect(env.DUET_AGENT_DIR).toBe('agents/branding')
    expect(env.DUET_APP_DIR).toBe('agents/branding/apps/setup')
  })

  test('app requests recover edge original hosts after VM ingress rewrites forwarded host', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'host-inspector')
    await mkdir(appDir, { recursive: true })
    await writeFile(
      join(appDir, 'server.ts'),
      `Bun.serve({
        hostname: '127.0.0.1',
        port: Number(process.env.PORT),
        fetch: request => Response.json({
          forwardedHost: request.headers.get('x-forwarded-host'),
          internalOriginalHost: request.headers.get('x-duet-original-host'),
        }),
      })`,
    )
    const app: GatewayAppConfig = {
      slug: 'host-inspector',
      command: 'bun server.ts',
      port: await freePort(),
      anchorPath: 'apps/host-inspector',
      appId: 'app-host-inspector',
      apiScopes: [],
    }
    const runtime = await registeredRuntime()
    try {
      const reconcile = await runtime.app.request('/v1/apps/reconcile', {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ apps: [app] }),
      })
      expect(reconcile.status).toBe(200)
      for (const originalHost of [
        'aomni.co',
        'host-inspector--acme.edge-staging.duet.so',
        undefined,
      ]) {
        const response = await runtime.app.request('/public/app/', {
          headers: {
            ...authHeaders(),
            [DUET_APP_SLUG_HEADER]: app.slug,
            [FORWARDED_HOST_HEADER]: 'duet-ws-fixture.exe.xyz',
            ...(originalHost === undefined ? {} : { [DUET_ORIGINAL_HOST_HEADER]: originalHost }),
          },
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          forwardedHost: originalHost ?? 'duet-ws-fixture.exe.xyz',
          internalOriginalHost: null,
        })
      }
    } finally {
      await runtime.app.request('/v1/apps/reconcile', {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ apps: [] }),
      })
    }
  })

  test('an app is given the model gateway address but never the workspace model key', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'gateway-url'), { recursive: true })
    const app: GatewayAppConfig = {
      slug: 'gateway-url',
      command: envInspectorCommand(),
      port: await freePort(),
      anchorPath: 'apps/gateway-url',
      appId: 'app-gateway-url',
      apiScopes: ['services'],
    }
    const backend = new Hono()
    backend.post('/v1/vm/register', c =>
      c.json({
        vmToken: 'vm-token',
        syncIntervalSeconds: 5,
        sync: syncResponse({
          apps: [app],
          modelCredentials: {
            apiKey: 'duet_sk_3333333333333333333333333333333333333333333333333333333333333333',
            gatewayBaseUrl: 'https://gateway.duet.test',
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          },
        }),
      }),
    )
    backend.post('/v1/vm/sync', async c => {
      await c.req.json()
      return c.json(
        syncResponse({
          apps: [app],
          appCredentials: [credentialEnvelope('app-gateway-url', 'app-key-v1', ['services'])],
          modelCredentials: {
            apiKey: 'duet_sk_3333333333333333333333333333333333333333333333333333333333333333',
            gatewayBaseUrl: 'https://gateway.duet.test',
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          },
        }),
      )
    })
    const runtime = await registeredRuntime({
      apiUrl: 'https://api.duet.test',
      driveDir,
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })
    const inspect = async (): Promise<{ env: Record<string, string> }> => {
      const response = await runtime.app.request('/public/app/', {
        headers: { ...authHeaders(), [DUET_APP_SLUG_HEADER]: 'gateway-url' },
      })
      if (!response.ok) throw new Error(`inspector returned ${response.status}`)
      return (await response.json()) as { env: Record<string, string> }
    }

    await runtime.syncOnce()
    await waitForAsync(
      async () => (await inspect().catch(() => null))?.env.DUET_APP_API_KEY === 'app-key-v1',
    )
    const { env } = await inspect()
    expect(env.DUET_GATEWAY_BASE_URL).toBe('https://gateway.duet.test')
    expect(env).not.toHaveProperty('DUET_API_KEY')
  })

  test('reports app reconciliation on the next sync poll and drains it after delivery', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'reported-site')
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, 'message.txt'), 'ready')
    const port = await freePort()
    const appConfig = {
      slug: 'reported-site',
      command: fileServerCommand(port),
      port,
      anchorPath: 'apps/reported-site',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const requests: unknown[] = []
    let poll = 0
    const backend = new Hono()
    backend.post('/v1/vm/sync', async c => {
      requests.push(await c.req.json())
      poll += 1
      return c.json(syncResponse(poll === 1 ? { apps: [appConfig] } : {}))
    })
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      driveDir,
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    await runtime.syncOnce()
    await waitForAsync(async () => {
      const response = await runtime.app.request('/public/app/', {
        headers: { ...authHeaders(), [DUET_APP_SLUG_HEADER]: 'reported-site' },
      })
      return response.status === 200
    })
    await runtime.syncOnce()
    await runtime.syncOnce()

    expect(requests).toEqual([
      expect.not.objectContaining({ appReconciliationReports: expect.anything() }),
      expect.objectContaining({
        appReconciliationReports: [{ ...appConfig, status: 'reconciled' }],
      }),
      expect.not.objectContaining({ appReconciliationReports: expect.anything() }),
    ])
  })

  test('an app reconcile failure does not reject the control-plane sync tick', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'broken-install'), { recursive: true })
    const backend = new Hono()
    backend.post('/v1/vm/sync', c =>
      c.json(
        syncResponse({
          apps: [
            {
              slug: 'broken-install',
              command: 'bun run start',
              installCommand: 'exit 1',
              port: 41_000,
              anchorPath: 'apps/broken-install',
              appId: 'fixture-app',
              apiScopes: [],
            },
          ],
        }),
      ),
    )
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      driveDir,
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    await expect(runtime.syncOnce()).resolves.toBeUndefined()
  })

  test('a sync skills descriptor starts a detached verified install', async () => {
    const built = skillsBundle([{ path: 'github/SKILL.md', content: '# GitHub\n' }])
    let releaseBundle!: () => void
    const bundleMayFinish = new Promise<void>(resolve => {
      releaseBundle = resolve
    })
    const backend = new Hono()
    backend.post('/v1/vm/sync', c =>
      c.json(syncResponse({ skills: { hash: built.hash, url: 'http://backend/skills' } })),
    )
    backend.get('/skills', async c => {
      await bundleMayFinish
      return c.body(built.bytes)
    })
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    try {
      expect(
        await Promise.race([
          runtime.syncOnce().then(() => 'sync-returned'),
          // Chaos margin for sync's filesystem work; the held download must not block it.
          Bun.sleep(1000).then(() => 'timed-out'),
        ]),
      ).toBe('sync-returned')
    } finally {
      releaseBundle()
    }
    // The active skill link becomes visible before its completion stamp.
    await waitForAsync(async () => existsSync(join(tempDir, '.duet', '.skills-hash')))

    expect(await readFile(join(tempDir, '.duet', 'skills', 'github', 'SKILL.md'), 'utf8')).toBe(
      '# GitHub\n',
    )
    expect(await readFile(join(tempDir, '.duet', '.skills-hash'), 'utf8')).toBe(`${built.hash}\n`)
  })

  test('a fresh runner waits until the current default skills are installed', async () => {
    const built = skillsBundle([
      { path: 'workspace-browser/SKILL.md', content: '# Workspace Browser\n' },
    ])
    let releaseBundle!: () => void
    const bundleMayFinish = new Promise<void>(resolve => {
      releaseBundle = resolve
    })
    const backend = new Hono()
    backend.post('/v1/vm/sync', c =>
      c.json(syncResponse({ skills: { hash: built.hash, url: 'http://backend/skills' } })),
    )
    backend.get('/skills', async c => {
      await bundleMayFinish
      return c.body(built.bytes)
    })
    const factoryArgs: AgentRunnerFactoryArgs[] = []
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(String(input), init)),
      agentRunnerFactory: args => {
        factoryArgs.push(args)
        return new MockAgentRunner()
      },
      agentRelayEvent: async () => undefined,
    })
    await runtime.syncOnce()

    const started = runtime.app.request('/v1/agent/sessions/sess_skills_ready/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_skills_ready',
          prompt: 'use the browser',
          behavior: 'steer',
          tier: 'balanced',
        }),
      ),
    })
    await Bun.sleep(20)
    expect(factoryArgs).toHaveLength(0)

    releaseBundle()
    expect((await started).status).toBe(200)
    expect(factoryArgs).toHaveLength(1)
    expect(
      await readFile(join(tempDir, '.agents', 'skills', 'workspace-browser', 'SKILL.md'), 'utf8'),
    ).toBe('# Workspace Browser\n')
  })

  test('a sync response without a skills descriptor does not start an install', async () => {
    const requests: string[] = []
    const backend = new Hono()
    backend.post('/v1/vm/sync', c => c.json(syncResponse()))
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        requests.push(new URL(request.url).pathname)
        return await backend.fetch(request)
      },
    })

    await runtime.syncOnce()
    await Bun.sleep(20)

    expect(requests).toEqual(['/v1/vm/sync'])
    await expect(stat(join(tempDir, '.duet', 'skills'))).rejects.toThrow()
  })

  test('desired state store persists one whole runtime release and paused updates', async () => {
    const stateDir = join(tempDir, '.duet')
    const store = createDesiredStateStore(stateDir)
    const release = runtimeFixture('desired')
    await store.accept(syncResponse({ runtimeRelease: runtimeRelease(release) }))
    expect(store.current()).toMatchObject({
      paused: false,
      runtimeRelease: runtimeRelease(release),
    })
    expect(createDesiredStateStore(stateDir).current()).toMatchObject({
      paused: false,
      runtimeRelease: runtimeRelease(release),
    })
    await store.accept(syncResponse())
    expect(store.current()).toMatchObject({ paused: true })
  })

  test('health reports the running cohort when the mutable current link changes', async () => {
    const releasesDir = join(tempDir, 'releases')
    const currentReleaseLink = join(tempDir, 'current')
    const old = runtimeFixture('health-old')
    const next = runtimeFixture('health-next')
    const oldDir = join(releasesDir, old.manifest.version)
    const nextDir = join(releasesDir, next.manifest.version)
    await old.write(oldDir)
    await next.write(nextDir)
    await symlink(oldDir, currentReleaseLink)
    const runtime = await registeredRuntime({
      currentReleaseLink,
      runtimeVersion: old.manifest.version,
      imageVersion: '3.0.0',
    })
    await rm(currentReleaseLink)
    await symlink(nextDir, currentReleaseLink)
    const health = await runtime.app.request('/health', { headers: authHeaders() })
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      runtimeVersion: old.manifest.version,
      imageVersion: '3.0.0',
    })
    expect(await readlink(currentReleaseLink)).toBe(nextDir)
  })

  test.each(['helper.js', 'photon_rs_bg.wasm'] as const)(
    'whole-runtime update rejects corrupt %s bytes and retries the complete inventory on next sync',
    async damaged => {
      const stateDir = join(tempDir, '.duet')
      const releasesDir = join(tempDir, 'releases')
      const currentReleaseLink = join(tempDir, 'current')
      const previousReleaseLink = join(tempDir, 'previous')
      const old = runtimeFixture('old-runtime')
      const older = runtimeFixture('older-runtime')
      const next = runtimeFixture('next-runtime')
      const oldDir = join(releasesDir, old.manifest.version)
      const nextDir = join(releasesDir, next.manifest.version)
      const olderDir = join(releasesDir, older.manifest.version)
      await old.write(oldDir)
      await older.write(olderDir)
      await symlink(oldDir, currentReleaseLink)
      let corrupt = true
      const exits: number[] = []
      const backend = new Hono()
      backend.post('/v1/vm/sync', c =>
        c.json(syncResponse({ runtimeRelease: runtimeRelease(next) })),
      )
      backend.get('/v1/vm/runtime-release/*', c => {
        expect(c.req.header('authorization')).toBe('Bearer vm-token')
        return corrupt && c.req.path.endsWith(`/${damaged}`)
          ? new Response(new Uint8Array(next.bytes.get(damaged)!.length))
          : next.fetch(c.req.url)
      })
      const runtime = await registeredRuntime({
        apiUrl: 'http://backend',
        stateDir,
        releasesDir,
        currentReleaseLink,
        runtimeVersion: old.manifest.version,
        exit: code => exits.push(code),
        fetch: async (input, init) =>
          backend.fetch(input instanceof Request ? input : new Request(input, init)),
      })
      await runtime.syncOnce()
      await waitForFileToContain(join(stateDir, 'logs/gateway.log'), damaged)
      expect(await readlink(currentReleaseLink)).toBe(oldDir)
      expect(exits).toEqual([])
      expect((await readdir(nextDir)).filter(name => name.endsWith('.partial'))).toEqual([])
      corrupt = false
      await runtime.syncOnce()
      await waitFor(() => exits.length === 1)
      expect(await readlink(currentReleaseLink)).toBe(nextDir)
      expect(await readlink(previousReleaseLink)).toBe(oldDir)
      for (const artifact of next.manifest.artifacts)
        expect(await readFile(join(nextDir, artifact.name))).toEqual(next.bytes.get(artifact.name)!)
      expect(JSON.parse(await readFile(join(nextDir, 'manifest.json'), 'utf8'))).toEqual(
        next.manifest,
      )
      expect((await stat(join(nextDir, 'duet'))).mode & 0o777).toBe(0o755)
      expect(await readdir(releasesDir)).not.toContain(older.manifest.version)
      expect(exits).toEqual([0])
    },
  )

  test('a held CLI asset keeps the whole runtime inactive while control-plane sync returns', async () => {
    const stateDir = join(tempDir, '.duet')
    const releasesDir = join(tempDir, 'releases')
    const currentReleaseLink = join(tempDir, 'current')
    const old = runtimeFixture('held-old')
    const next = runtimeFixture('held-next')
    const oldDir = join(releasesDir, old.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, currentReleaseLink)
    let finishDownload!: () => void
    const downloadMayFinish = new Promise<void>(resolve => {
      finishDownload = resolve
    })
    let started!: () => void
    const downloadStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const exits: number[] = []
    const backend = new Hono()
    backend.post('/v1/vm/sync', c => c.json(syncResponse({ runtimeRelease: runtimeRelease(next) })))
    backend.get('/v1/vm/runtime-release/*', async c => {
      if (c.req.path.endsWith('/duet')) {
        started()
        await downloadMayFinish
      }
      return next.fetch(c.req.url)
    })
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      stateDir,
      releasesDir,
      currentReleaseLink,
      runtimeVersion: old.manifest.version,
      exit: code => exits.push(code),
      fetch: async (input, init) =>
        backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })
    try {
      expect(
        await Promise.race([
          runtime.syncOnce().then(() => 'returned'),
          Bun.sleep(1000).then(() => 'blocked'),
        ]),
      ).toBe('returned')
      await downloadStarted
      const health = await runtime.app.request('/health', { headers: authHeaders() })
      expect((await health.json()).diagnostics.runtimeUpdateInFlight).toBe(true)
      expect(await readlink(currentReleaseLink)).toBe(oldDir)
      expect(exits).toEqual([])
    } finally {
      finishDownload()
    }
    await waitFor(() => exits.length === 1)
    const nextDir = join(releasesDir, next.manifest.version)
    expect(await readlink(currentReleaseLink)).toBe(nextDir)
    for (const artifact of next.manifest.artifacts)
      expect(await readFile(join(nextDir, artifact.name))).toEqual(next.bytes.get(artifact.name)!)
    expect(exits).toEqual([0])
  })

  test('runtime activation waits for train completion while sync remains available', async () => {
    const stateDir = join(tempDir, '.duet')
    const releasesDir = join(tempDir, 'releases')
    const currentReleaseLink = join(tempDir, 'current')
    const old = runtimeFixture('train-old')
    const next = runtimeFixture('train-next')
    const oldDir = join(releasesDir, old.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, currentReleaseLink)
    let releaseFetches = 0
    let trainStarted = false
    let finishTrain!: () => void
    const trainFinished = new Promise<void>(resolve => {
      finishTrain = resolve
    })
    const exits: number[] = []
    const backend = new Hono()
    backend.post('/v1/vm/sync', c => c.json(syncResponse({ runtimeRelease: runtimeRelease(next) })))
    backend.get('/v1/vm/runtime-release/*', c => {
      releaseFetches++
      return next.fetch(c.req.url)
    })
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      stateDir,
      releasesDir,
      currentReleaseLink,
      runtimeVersion: old.manifest.version,
      exit: code => exits.push(code),
      trainRunner: async input => {
        trainStarted = true
        await writeFakeTrainOutput(input)
        await trainFinished
        return { record: null, stdout: '', stderr: '' }
      },
      fetch: async (input, init) =>
        backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })
    const trainResponse = runtime.app.request('/v1/train', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ files: [{ filename: 'notes.md', content: 'hello' }] }),
    })
    try {
      await waitFor(() => trainStarted)
      await runtime.syncOnce()
      await waitForFileToContain(join(stateDir, 'logs/gateway.log'), '"status":"deferred"')
      expect(releaseFetches).toBe(0)
      expect(await readlink(currentReleaseLink)).toBe(oldDir)
      expect(exits).toEqual([])
    } finally {
      finishTrain()
    }
    expect((await trainResponse).status).toBe(202)
    await waitForAsync(async () => {
      const response = await runtime.app.request('/v1/train/uploads', { headers: authHeaders() })
      return ((await response.json()) as { meta: { running: boolean } }).meta.running === false
    })
    await runtime.syncOnce()
    await waitFor(() => exits.length === 1)
    expect(await readlink(currentReleaseLink)).toBe(join(releasesDir, next.manifest.version))
    expect(exits).toEqual([0])
  })

  test('runtime update never forces activation while an agent turn is live, then converges when idle', async () => {
    const stateDir = join(tempDir, '.duet')
    const releasesDir = join(tempDir, 'releases')
    const currentReleaseLink = join(tempDir, 'current')
    const old = runtimeFixture('agent-old')
    const next = runtimeFixture('agent-next')
    const oldDir = join(releasesDir, old.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, currentReleaseLink)
    let now = 1_000
    let offerRelease = false
    let releaseFetches = 0
    const exits: number[] = []
    const skills = skillsBundle([{ path: 'github/SKILL.md', content: '# GitHub\n' }])
    const backend = new Hono()
    backend.post('/v1/vm/sync', c =>
      c.json(
        syncResponse({
          skills: { hash: skills.hash, url: 'http://backend/skills' },
          ...(offerRelease ? { runtimeRelease: runtimeRelease(next) } : {}),
        }),
      ),
    )
    backend.get('/skills', c => c.body(skills.bytes))
    backend.get('/v1/vm/runtime-release/*', c => {
      releaseFetches++
      return next.fetch(c.req.url)
    })
    const runner = new MockAgentRunner()
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      stateDir,
      releasesDir,
      currentReleaseLink,
      runtimeVersion: old.manifest.version,
      runtimeUpdateMaxDeferMs: 100,
      now: () => now,
      exit: code => exits.push(code),
      agentRunnerFactory: () => runner,
      agentRelayEvent: async () => undefined,
      fetch: async (input, init) =>
        backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })
    await runtime.syncOnce()
    const start = await runtime.app.request('/v1/agent/sessions/sess_busy_update/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_busy_update',
          prompt: 'work',
          behavior: 'steer',
          tier: 'balanced',
        }),
      ),
    })
    expect(start.status).toBe(200)
    expect(runner.commands.map(command => command.type)).toEqual(['start', 'prompt'])
    expect(await readFile(join(tempDir, '.agents', 'skills', 'github', 'SKILL.md'), 'utf8')).toBe(
      '# GitHub\n',
    )
    offerRelease = true
    await runtime.syncOnce()
    await waitForFileToContain(join(stateDir, 'logs/gateway.log'), '"status":"deferred"')
    now = 1_101
    await runtime.syncOnce()
    await waitForAsync(async () => {
      const health = await runtime.app.request('/health', { headers: authHeaders() })
      return (await health.json()).diagnostics.runtimeUpdateInFlight === false
    })
    expect(await readlink(currentReleaseLink)).toBe(oldDir)
    expect(exits).toEqual([])
    expect(releaseFetches).toBe(0)
    runner.emitEvent({
      type: 'complete',
      state: COMPLETED_TURN_STATE,
      status: 'completed',
      result: 'done',
    })
    await waitFor(() => runner.killed)
    await runtime.syncOnce()
    await waitFor(() => exits.length === 1)
    expect(await readlink(currentReleaseLink)).toBe(join(releasesDir, next.manifest.version))
    expect(exits).toEqual([0])
  })

  test('a rollout pause during runtime download leaves the previous cohort active', async () => {
    const stateDir = join(tempDir, '.duet')
    const releasesDir = join(tempDir, 'releases')
    const currentReleaseLink = join(tempDir, 'current')
    const old = runtimeFixture('pause-old')
    const next = runtimeFixture('pause-next')
    const oldDir = join(releasesDir, old.manifest.version)
    await old.write(oldDir)
    await symlink(oldDir, currentReleaseLink)
    let paused = false
    let finishDownload!: () => void
    const downloadMayFinish = new Promise<void>(resolve => {
      finishDownload = resolve
    })
    let started!: () => void
    const downloadStarted = new Promise<void>(resolve => {
      started = resolve
    })
    const exits: number[] = []
    let trainStarts = 0
    const backend = new Hono()
    backend.post('/v1/vm/sync', c =>
      c.json(paused ? syncResponse() : syncResponse({ runtimeRelease: runtimeRelease(next) })),
    )
    backend.get('/v1/vm/runtime-release/*', async c => {
      if (c.req.path.endsWith('/duet')) {
        started()
        await downloadMayFinish
      }
      return next.fetch(c.req.url)
    })
    const runtime = await registeredRuntime({
      apiUrl: 'http://backend',
      stateDir,
      releasesDir,
      currentReleaseLink,
      trainRunner: async input => {
        trainStarts++
        await writeFakeTrainOutput(input)
        return { record: null, stdout: '', stderr: '' }
      },
      runtimeVersion: old.manifest.version,
      exit: code => exits.push(code),
      fetch: async (input, init) =>
        backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })
    try {
      await runtime.syncOnce()
      await downloadStarted
      paused = true
      await runtime.syncOnce()
      expect(runtime.desiredState.current().paused).toBe(true)
    } finally {
      finishDownload()
    }
    await waitForFileToContain(join(stateDir, 'logs/gateway.log'), '"status":"not_needed"')
    expect(await readlink(currentReleaseLink)).toBe(oldDir)
    expect(exits).toEqual([])
    const train = await runtime.app.request('/v1/train', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ files: [{ filename: 'after-pause.md', content: 'new work' }] }),
    })
    expect(train.status).toBe(202)
    await waitFor(() => trainStarts === 1)
    await waitForAsync(async () => {
      const uploads = await runtime.app.request('/v1/train/uploads', { headers: authHeaders() })
      return ((await uploads.json()) as { meta: { running: boolean } }).meta.running === false
    })
    for (const artifact of next.manifest.artifacts)
      expect(await readFile(join(releasesDir, next.manifest.version, artifact.name))).toEqual(
        next.bytes.get(artifact.name)!,
      )
  })

  test('model credentials persist with 0600 mode and suppress restart rotation requests', async () => {
    const syncBodies: unknown[] = []
    const backend = new Hono()
    backend.post('/v1/vm/register', c =>
      c.json({
        vmToken: 'vm-token',
        syncIntervalSeconds: 5,
        sync: syncResponse({
          modelCredentials: {
            apiKey: 'duet_sk_1111111111111111111111111111111111111111111111111111111111111111',
            gatewayBaseUrl: 'https://gateway.test',
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          },
        }),
      }),
    )
    backend.post('/v1/vm/sync', async c => {
      syncBodies.push(await c.req.json())
      return c.json(syncResponse())
    })

    const stateDir = join(tempDir, '.duet')
    const fetchBackend = async (input: string | URL | Request, init?: RequestInit) =>
      await backend.fetch(input instanceof Request ? input : new Request(input, init))
    await createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      fetch: fetchBackend,
    }).registerOnce()

    expect((await stat(modelCredentialsPath(stateDir))).mode & 0o777).toBe(0o600)

    const restarted = createGatewayRuntime({
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      fetch: fetchBackend,
    })
    await restarted.syncOnce()

    expect(syncBodies).toHaveLength(1)
    expect(syncBodies[0]).toMatchObject({ needsModelCredentials: false })
  })

  test('sync requests model credentials when cached credentials are near expiry', async () => {
    const syncBodies: unknown[] = []
    const now = 10_000
    const backend = new Hono()
    backend.post('/v1/vm/sync', async c => {
      syncBodies.push(await c.req.json())
      return c.json(
        syncResponse({
          modelCredentials: {
            apiKey: 'duet_sk_2222222222222222222222222222222222222222222222222222222222222222',
            gatewayBaseUrl: 'https://gateway.test',
            expiresAt: now + 24 * 60 * 60 * 1000,
          },
        }),
      )
    })

    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    await writeFile(
      modelCredentialsPath(stateDir),
      JSON.stringify({
        apiKey: 'duet_sk_3333333333333333333333333333333333333333333333333333333333333333',
        gatewayBaseUrl: 'https://gateway.test',
        expiresAt: now + 60 * 60 * 1000,
      }),
      { mode: 0o600 },
    )

    const runtime = createGatewayRuntime({
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      now: () => now,
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })
    await runtime.syncOnce()

    expect(syncBodies[0]).toMatchObject({ needsModelCredentials: true })
    expect(await readFile(modelCredentialsPath(stateDir), 'utf8')).toContain('duet_sk_2222')
  })

  test('agent runner and train runner receive the model credential env overlay', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    await writeFile(
      modelCredentialsPath(stateDir),
      JSON.stringify({
        apiKey: 'duet_sk_4444444444444444444444444444444444444444444444444444444444444444',
        gatewayBaseUrl: 'https://gateway.test',
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      }),
      { mode: 0o600 },
    )
    let agentEnv: Record<string, string> | undefined
    let trainEnv: Record<string, string> | undefined
    const agentRunner = new MockAgentRunner()
    const ctlMcpRequests: Array<{ authorization: string | null; method: string }> = []
    const runtime = createGatewayRuntime({
      stateDir,
      apiUrl: 'https://api.duet.test',
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const message = (await request.json()) as { id: number; method: string }
        ctlMcpRequests.push({
          authorization: request.headers.get('authorization'),
          method: message.method,
        })
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result:
            message.method === 'initialize'
              ? { protocolVersion: '2025-03-26', capabilities: {} }
              : { tools: [] },
        })
      },
      agentRunnerFactory: args => {
        agentEnv = args.env
        return agentRunner
      },
      agentRelayEvent: async () => undefined,
      trainRunner: async input => {
        trainEnv = input.env
        await writeFakeTrainOutput(input)
        return { record: null, stdout: '', stderr: '' }
      },
    })
    await runtime.desiredState.accept({ ...syncResponse(), workspaceSlug: 'acme' })

    const agent = await runtime.app.request('/v1/agent/sessions/sess_model_env/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_model_env',
          prompt: 'work',
          behavior: 'steer',
          tier: 'balanced',
          integrations: true,
          mcpServers: [{ name: 'notes' }, { name: 'tickets' }],
        }),
      ),
    })
    const train = await runtime.app.request('/v1/train', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ files: [{ filename: 'notes.md', content: 'hello' }] }),
    })

    expect(agent.status).toBe(200)
    expect(agentEnv).toEqual({
      DUET_API_KEY: 'duet_sk_4444444444444444444444444444444444444444444444444444444444444444',
      DUET_API_URL: 'https://api.duet.test',
      DUET_GATEWAY_BASE_URL: 'https://gateway.test',
      FIRECRAWL_API_KEY: 'duet_sk_4444444444444444444444444444444444444444444444444444444444444444',
      FIRECRAWL_API_URL: 'https://api.duet.test/v1/services/firecrawl',
    })
    expect(agentRunner.commands[0]).toEqual({
      type: 'start',
      options: { model: 'balanced' },
      mode: 'auto',
      mcpServers: {
        // Addressed at this gateway, which performed the opening exchange
        // against ctl while the runner booted and answers it from memory.
        integrations: {
          type: 'http',
          url: 'http://127.0.0.1:3000/v1/agent/sessions/sess_model_env/integrations/mcp',
          headers: {
            authorization:
              'Bearer duet_sk_4444444444444444444444444444444444444444444444444444444444444444',
          },
        },
        // Workspace-scoped, with no session segment: a custom server has no
        // conversation-scoped provider session to address.
        notes: {
          type: 'http',
          url: 'https://api.duet.test/v1/ws/acme/mcp/notes',
          headers: {
            authorization:
              'Bearer duet_sk_4444444444444444444444444444444444444444444444444444444444444444',
          },
        },
        tickets: {
          type: 'http',
          url: 'https://api.duet.test/v1/ws/acme/mcp/tickets',
          headers: {
            authorization:
              'Bearer duet_sk_4444444444444444444444444444444444444444444444444444444444444444',
          },
        },
      },
    })
    expect(train.status).toBe(202)
    await waitFor(() => trainEnv !== undefined)
    expect(trainEnv).toEqual(agentEnv!)

    // The runner speaks to that address with the key it was handed; the
    // gateway admits exactly that bearer on exactly that route, answers the
    // handshake it already performed, and had performed it as the runner.
    const mcp = (key: string, method: string) =>
      runtime.app.request('/v1/agent/sessions/sess_model_env/integrations/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: {} }),
      })
    const runnerKey = 'duet_sk_4444444444444444444444444444444444444444444444444444444444444444'
    const initialize = await mcp(runnerKey, 'initialize')
    expect(initialize.status).toBe(200)
    expect(await initialize.json()).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { protocolVersion: '2025-03-26', capabilities: {} },
    })
    expect((await mcp('duet_sk_not_this_workspace', 'initialize')).status).toBe(401)
    expect(ctlMcpRequests).toEqual([
      { authorization: `Bearer ${runnerKey}`, method: 'initialize' },
      { authorization: `Bearer ${runnerKey}`, method: 'tools/list' },
    ])
  })

  test('credential refresh changes only runners spawned after the refresh', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    await writeFile(
      modelCredentialsPath(stateDir),
      JSON.stringify({
        apiKey: 'duet_sk_7777777777777777777777777777777777777777777777777777777777777777',
        gatewayBaseUrl: 'https://gateway.test',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      { mode: 0o600 },
    )
    const backend = new Hono()
    backend.post('/v1/vm/sync', c =>
      c.json(
        syncResponse({
          modelCredentials: {
            apiKey: 'duet_sk_8888888888888888888888888888888888888888888888888888888888888888',
            gatewayBaseUrl: 'https://gateway.test',
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          },
        }),
      ),
    )
    const spawnedEnvs: Array<Record<string, string> | undefined> = []
    const runtime = createGatewayRuntime({
      stateDir,
      apiUrl: 'https://api.duet.test',
      workspaceHint: 'ws1',
      agentRunnerFactory: args => {
        spawnedEnvs.push(args.env)
        return new MockAgentRunner()
      },
      agentRelayEvent: async () => undefined,
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    const spawn = async (sessionId: string) =>
      await runtime.app.request(`/v1/agent/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify(
          runnerInputBody({
            sessionId,
            prompt: 'work',
            behavior: 'steer',
            tier: 'balanced',
          }),
        ),
      })

    expect((await spawn('sess_before_refresh')).status).toBe(200)
    await runtime.syncOnce()
    expect((await spawn('sess_after_refresh')).status).toBe(200)

    expect(spawnedEnvs).toHaveLength(2)
    expect(spawnedEnvs[0]).toMatchObject({
      DUET_API_KEY: 'duet_sk_7777777777777777777777777777777777777777777777777777777777777777',
      FIRECRAWL_API_KEY: 'duet_sk_7777777777777777777777777777777777777777777777777777777777777777',
    })
    expect(spawnedEnvs[1]).toMatchObject({
      DUET_API_KEY: 'duet_sk_8888888888888888888888888888888888888888888888888888888888888888',
      FIRECRAWL_API_KEY: 'duet_sk_8888888888888888888888888888888888888888888888888888888888888888',
    })
  })

  test('missing model credentials QUEUE the turn rather than spawning keyless', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const seenAgentEnv: Array<Record<string, string> | undefined> = []
    const seenTrainEnv: Array<Record<string, string> | undefined> = []
    const agentRunners: MockAgentRunner[] = []
    const runtime = createGatewayRuntime({
      stateDir,
      agentRunnerFactory: args => {
        seenAgentEnv.push(args.env)
        const runner = new MockAgentRunner()
        agentRunners.push(runner)
        return runner
      },
      agentRelayEvent: async () => undefined,
      trainRunner: async input => {
        seenTrainEnv.push(input.env)
        await writeFakeTrainOutput(input)
        return { record: null, stdout: '', stderr: '' }
      },
    })

    const firstAgent = await runtime.app.request(
      '/v1/agent/sessions/sess_missing_model_env_1/input',
      {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify(
          runnerInputBody({
            sessionId: 'sess_missing_model_env_1',
            prompt: 'work',
            behavior: 'steer',
            tier: 'balanced',
          }),
        ),
      },
    )
    const secondAgent = await runtime.app.request(
      '/v1/agent/sessions/sess_missing_model_env_2/input',
      {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify(
          runnerInputBody({
            sessionId: 'sess_missing_model_env_2',
            prompt: 'work',
            behavior: 'steer',
            tier: 'balanced',
          }),
        ),
      },
    )
    const train = await runtime.app.request('/v1/train', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ files: [{ filename: 'notes.md', content: 'hello' }] }),
    })

    // Credentials arrive on a VM-sync tick, not at provision, so a fresh VM has
    // a window with none. Spawning through it produced a turn that could not
    // authenticate and died on a raw upstream 401 — a broken-looking product
    // rather than a not-ready one. `503 runner_unavailable` is what the API's
    // drain redelivers on, so the turn is queued until credentials land.
    // A runner lives for one turn, so spawn time is the only moment env has to
    // be right.
    expect(firstAgent.status).toBe(503)
    expect(secondAgent.status).toBe(503)
    expect(await firstAgent.json()).toEqual({ error: 'runner_unavailable' })
    // Nothing was started: a keyless process is never preferable to a delay.
    expect(seenAgentEnv).toBeEmpty()
    expect(agentRunners).toBeEmpty()

    // TRAIN is unchanged — it degrades without model env rather than failing,
    // so it still runs and still reports the missing credentials once.
    expect(train.status).toBe(202)
    await waitFor(() => seenTrainEnv.length === 1)
    expect(seenTrainEnv).toEqual([undefined])
    const log = await readFile(join(stateDir, 'logs', 'gateway.log'), 'utf8')
    expect(log.split('spawn_model_credentials').length - 1).toBe(1)
  })

  test('expired persisted model credentials QUEUE the turn rather than spawning unauthorized', async () => {
    const stateDir = join(tempDir, '.duet')
    const now = 10_000
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    await writeFile(
      modelCredentialsPath(stateDir),
      JSON.stringify({
        apiKey: 'duet_sk_7777777777777777777777777777777777777777777777777777777777777777',
        gatewayBaseUrl: 'https://gateway.test',
        expiresAt: now - 1,
      }),
      { mode: 0o600 },
    )
    const spawnedEnvs: Array<Record<string, string> | undefined> = []
    const runtime = createGatewayRuntime({
      stateDir,
      now: () => now,
      agentRunnerFactory: args => {
        spawnedEnvs.push(args.env)
        return new MockAgentRunner()
      },
      agentRelayEvent: async () => undefined,
    })

    const response = await runtime.app.request('/v1/agent/sessions/sess_expired_model_env/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_expired_model_env',
          prompt: 'work',
          behavior: 'steer',
          tier: 'balanced',
        }),
      ),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'runner_unavailable' })
    expect(spawnedEnvs).toBeEmpty()
  })

  test('runDuetTrain forwards model credential env to the spawned duet process', async () => {
    const binDir = join(tempDir, 'bin')
    const stagingDir = join(tempDir, 'stage')
    const capturePath = join(tempDir, 'train-env.json')
    await mkdir(binDir, { recursive: true })
    await mkdir(stagingDir, { recursive: true })
    const duetPath = join(binDir, 'duet')
    await writeFile(
      duetPath,
      [
        '#!/usr/bin/env bun',
        "import { writeFile } from 'node:fs/promises'",
        'const args = process.argv.slice(2)',
        "if (args[0] === '-v') {",
        "  console.log('1.0.0')",
        '  process.exit(0)',
        '}',
        'await writeFile(process.env.DUET_ENV_CAPTURE, JSON.stringify({ DUET_API_KEY: process.env.DUET_API_KEY, DUET_GATEWAY_BASE_URL: process.env.DUET_GATEWAY_BASE_URL }))',
        'process.exit(0)',
      ].join('\n'),
      { mode: 0o700 },
    )
    await chmod(duetPath, 0o700)
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}:${originalPath ?? ''}`
    try {
      await runDuetTrain({
        stagingDir,
        slug: 'env-train',
        storeDir: join(tempDir, 'store'),
        env: {
          DUET_API_KEY: 'duet_sk_5555555555555555555555555555555555555555555555555555555555555555',
          DUET_GATEWAY_BASE_URL: 'https://gateway.test',
          DUET_ENV_CAPTURE: capturePath,
        },
      })
    } finally {
      process.env.PATH = originalPath
    }

    expect(JSON.parse(await readFile(capturePath, 'utf8'))).toEqual({
      DUET_API_KEY: 'duet_sk_5555555555555555555555555555555555555555555555555555555555555555',
      DUET_GATEWAY_BASE_URL: 'https://gateway.test',
    })
  })

  test('delivered model credentials are registered with gateway redaction', async () => {
    const apiKey = 'duet_sk_6666666666666666666666666666666666666666666666666666666666666666'
    const backend = new Hono()
    backend.post('/v1/vm/register', c =>
      c.json({
        vmToken: 'vm-token',
        syncIntervalSeconds: 5,
        sync: syncResponse({
          modelCredentials: {
            apiKey,
            gatewayBaseUrl: 'https://gateway.test',
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          },
        }),
      }),
    )

    await createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir: join(tempDir, '.duet'),
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    }).registerOnce()

    expect(redactText(`stderr leaked ${apiKey}`)).toBe(`stderr leaked ${REDACTION_MASK}`)
  })

  test('extra outbound headers are opt-in through the runtime seam', async () => {
    const seen: Array<string | undefined> = []
    const backend = new Hono()
    backend.post('/v1/vm/register', c => {
      seen.push(c.req.header('bypass-tunnel-reminder'))
      return c.json({ vmToken: 'vm-token', syncIntervalSeconds: 5, sync: syncResponse() })
    })
    backend.post('/v1/vm/sync', c => {
      seen.push(c.req.header('bypass-tunnel-reminder'))
      return c.json(syncResponse())
    })

    const stateDir = join(tempDir, '.duet')
    const runtime = createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      extraHeaders: { 'bypass-tunnel-reminder': 'duet' },
      fetch: async (input, init) =>
        await backend.fetch(input instanceof Request ? input : new Request(input, init)),
    })

    await runtime.registerOnce()
    await runtime.syncOnce()

    expect(seen).toEqual(['duet', 'duet'])
  })

  test('sync conflicts are surfaced by API without special-casing the file content', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'project', 'nested'), { recursive: true })
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    await writeFile(
      join(driveDir, 'project', 'nested', 'notes.sync-conflict-20260706.txt'),
      'conflict',
    )
    await writeFile(join(driveDir, 'project', 'normal.txt'), 'normal')
    const runtime = createGatewayRuntime({ stateDir, driveDir })

    const response = await runtime.app.request('/v1/sync/conflicts?path=project', {
      headers: { authorization: 'Bearer vm-token' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      conflicts: ['project/nested/notes.sync-conflict-20260706.txt'],
    })
  })

  test('backend-owned share projection is not mutable through gateway routes', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir })
    for (const path of [
      '/v1/sync/mounts',
      '/v1/sync/syncthing/folders',
      '/v1/sync/syncthing/devices',
      '/v1/tunnel/accept',
    ]) {
      const response = await runtime.app.request(path, {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({}),
      })
      expect(response.status, path).toBe(404)
    }
  })

  test('mirror device registration provisions the whole-drive folder, .stignore, knobs, and device-store', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await mkdir(stateDir, { recursive: true })
    await mkdir(driveDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    let config: {
      devices?: Array<{ deviceID: string }>
      folders?: Array<Record<string, unknown>>
      options?: Record<string, unknown>
      gui?: Record<string, unknown>
    } = { devices: [], folders: [], options: {} }
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir,
      syncthingApiUrl: 'http://syncthing.local',
      syncthingApiKey: 'api-key',
      fetch: async (input, init) => {
        const url = String(input)
        if (url === 'http://syncthing.local/rest/system/status') {
          return Response.json({ myID: 'VMDEVICE-IDABCDE' })
        }
        if (url === 'http://syncthing.local/rest/config' && init?.method !== 'PUT') {
          return Response.json(config)
        }
        if (url === 'http://syncthing.local/rest/config' && init?.method === 'PUT') {
          config = JSON.parse(String(init.body))
          return Response.json({ ok: true })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const fullDeviceId = 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'

    const response = await runtime.app.request('/v1/sync/syncthing/mirror/devices', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        machineId: 'cred_9',
        syncthingDeviceId: fullDeviceId,
        deviceName: 'MacBook Pro',
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      folderId: 'workspace-drive',
      vmSyncthingDeviceId: 'VMDEVICE-IDABCDE',
    })

    // .stignore at the drive root carries the mirror exclusions (G1) but NOT
    // .env* (a personal mirror keeps its secrets).
    const stignore = await readFile(join(driveDir, '.stignore'), 'utf8')
    expect(stignore).toContain('**/.git')
    expect(stignore).toContain('(?d)**/node_modules')
    expect(stignore).toContain('.duet')
    expect(stignore).not.toContain('.env')

    // The whole-drive folder is sendreceive, rooted at the drive, with the
    // mirror knobs — fsWatcherDelayS strictly > 0 (L22).
    const folder = config.folders?.find(f => f.id === 'workspace-drive')
    expect(folder).toBeDefined()
    expect(folder).toMatchObject({
      type: 'sendreceive',
      path: await realpath(driveDir),
      fsWatcherEnabled: true,
      ignorePerms: false,
      maxConflicts: 10,
    })
    expect(folder!.fsWatcherDelayS as number).toBeGreaterThan(0)
    expect((folder!.devices as Array<{ deviceID: string }>).map(d => d.deviceID)).toContain(
      fullDeviceId,
    )
    // The instance is hardened as a side effect of provisioning (semantic owner).
    expect(config.options).toMatchObject({ natEnabled: false, urAccepted: -1 })

    // List reflects the device-store binding (machine ↔ Syncthing device ID).
    const list = await runtime.app.request('/v1/sync/syncthing/mirror/devices', {
      headers: jsonAuthHeaders(),
    })
    expect(await list.json()).toEqual({
      devices: [
        {
          machineId: 'cred_9',
          deviceName: 'MacBook Pro',
          syncthingDeviceId: fullDeviceId,
          registeredAt: expect.any(Number),
        },
      ],
    })
  })

  test('mirror registration is idempotent and removal detaches the device + tears down the folder membership', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await mkdir(stateDir, { recursive: true })
    await mkdir(driveDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    let config: {
      devices?: Array<{ deviceID: string }>
      folders?: Array<{ id: string; devices?: Array<{ deviceID: string }> }>
      options?: Record<string, unknown>
    } = { devices: [], folders: [], options: {} }
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir,
      syncthingApiUrl: 'http://syncthing.local',
      syncthingApiKey: 'api-key',
      fetch: async (input, init) => {
        const url = String(input)
        if (url === 'http://syncthing.local/rest/system/status') {
          return Response.json({ myID: 'VMDEVICE-IDABCDE' })
        }
        if (url === 'http://syncthing.local/rest/config' && init?.method !== 'PUT') {
          return Response.json(config)
        }
        config = JSON.parse(String(init!.body))
        return Response.json({ ok: true })
      },
    })
    const fullDeviceId = 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'
    const register = () =>
      runtime.app.request('/v1/sync/syncthing/mirror/devices', {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ machineId: 'cred_9', syncthingDeviceId: fullDeviceId }),
      })
    await register()
    await register()

    // One device record, one folder membership — never a duplicate.
    const afterTwice = await (
      await runtime.app.request('/v1/sync/syncthing/mirror/devices', { headers: jsonAuthHeaders() })
    ).json()
    expect((afterTwice as { devices: unknown[] }).devices).toHaveLength(1)
    expect(config.devices).toHaveLength(1)

    const removed = await runtime.app.request('/v1/sync/syncthing/mirror/devices/cred_9', {
      method: 'DELETE',
      headers: jsonAuthHeaders(),
    })
    expect(await removed.json()).toEqual({ ok: true, machineId: 'cred_9' })
    const afterRemove = await (
      await runtime.app.request('/v1/sync/syncthing/mirror/devices', { headers: jsonAuthHeaders() })
    ).json()
    expect((afterRemove as { devices: unknown[] }).devices).toEqual([])
    expect(config.devices).toEqual([])
    const folder = config.folders?.find(f => f.id === 'workspace-drive')
    expect(folder?.devices ?? []).toEqual([])

    // Removing an unregistered device is idempotent success.
    const again = await runtime.app.request('/v1/sync/syncthing/mirror/devices/cred_absent', {
      method: 'DELETE',
      headers: jsonAuthHeaders(),
    })
    expect(again.status).toBe(200)
  })

  test('concurrent mirror registration retains both machines', async () => {
    let config: Record<string, unknown> = { devices: [], folders: [] }
    const runtime = await registeredRuntime({
      syncthingApiUrl: 'http://syncthing',
      syncthingApiKey: 'key',
      fetch: async (input, init) => {
        if (String(input).endsWith('/rest/system/status'))
          return Response.json({ myID: 'AAAAAAA-BBBBBBB' })
        if (init?.method === 'PUT') config = JSON.parse(String(init.body))
        return Response.json(config)
      },
    })
    const response = await Promise.all(
      ['machine-a', 'machine-b'].map(machineId =>
        runtime.app.request('/v1/sync/syncthing/mirror/devices', {
          method: 'POST',
          headers: jsonAuthHeaders(),
          body: JSON.stringify({
            machineId,
            syncthingDeviceId: machineId === 'machine-a' ? 'AAAAAAA' : 'BBBBBBB',
          }),
        }),
      ),
    )
    expect(response.map(result => result.status)).toEqual([200, 200])
    const listed = (await (
      await runtime.app.request('/v1/sync/syncthing/mirror/devices', { headers: jsonAuthHeaders() })
    ).json()) as { devices: Array<{ machineId: string }> }
    expect(listed.devices.map(device => device.machineId).sort()).toEqual([
      'machine-a',
      'machine-b',
    ])
  })

  test('next successful sync prunes a removed machine after a missed detach, preserving another mirror', async () => {
    const stateDir = join(tempDir, '.duet')
    let apiAvailable = false
    let configWriteAvailable = false
    let config = {
      devices: [{ deviceID: 'PEER-A' }, { deviceID: 'PEER-B' }, { deviceID: 'SHARE-PEER' }],
      folders: [
        {
          id: 'workspace-drive',
          path: join(tempDir, 'drive'),
          devices: [{ deviceID: 'PEER-A' }, { deviceID: 'PEER-B' }],
        },
        { id: 'share-one', path: '/drive/shared', devices: [{ deviceID: 'SHARE-PEER' }] },
      ],
    }
    const runtime = await registeredRuntime({
      stateDir,
      apiUrl: 'http://backend',
      syncthingApiUrl: 'http://syncthing',
      syncthingApiKey: 'key',
      fetch: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/v1/vm/sync'))
          return apiAvailable
            ? Response.json({ ...syncResponse(), mirrorMachineIds: ['machine-b'] })
            : new Response('unavailable', { status: 503 })
        if (url.endsWith('/rest/system/status')) return Response.json({ myID: 'AAAAAAA-BBBBBBB' })
        if (url.endsWith('/rest/config')) {
          if (init?.method === 'PUT') {
            if (!configWriteAvailable) return new Response('not ready', { status: 503 })
            config = JSON.parse(String(init.body))
          }
          return Response.json(config)
        }
        return new Response('not found', { status: 404 })
      },
    })
    await writeFile(
      join(stateDir, 'sync-mirror-devices.json'),
      JSON.stringify([
        { machineId: 'machine-a', syncthingDeviceId: 'PEER-A', registeredAt: 1 },
        { machineId: 'machine-b', syncthingDeviceId: 'PEER-B', registeredAt: 1 },
      ]),
    )
    const digest = await tunnelTokenDigest('token')
    runtime.tunnelAccepts.registerMirror({
      machineId: 'machine-a',
      acceptId: 'mirror-a',
      tokenDigest: digest,
      expiresAt: Date.now() + 60_000,
    })
    runtime.tunnelAccepts.registerMirror({
      machineId: 'machine-b',
      acceptId: 'mirror-b',
      tokenDigest: digest,
      expiresAt: Date.now() + 60_000,
    })
    await expect(runtime.syncOnce()).rejects.toThrow('503')
    apiAvailable = true
    await expect(runtime.syncOnce()).rejects.toThrow('503')
    const retainedAfterFailure = JSON.parse(
      await readFile(join(stateDir, 'sync-mirror-devices.json'), 'utf8'),
    ) as Array<{ machineId: string }>
    expect(retainedAfterFailure.map(device => device.machineId)).toEqual(['machine-a', 'machine-b'])
    configWriteAvailable = true
    await runtime.syncOnce()
    const listed = (await (
      await runtime.app.request('/v1/sync/syncthing/mirror/devices', { headers: jsonAuthHeaders() })
    ).json()) as { devices: unknown[] }
    expect(listed.devices).toEqual([
      { machineId: 'machine-b', syncthingDeviceId: 'PEER-B', registeredAt: 1 },
    ])
    expect(await runtime.tunnelAccepts.authorize('mirror-a', 'token')).toBe(false)
    expect(await runtime.tunnelAccepts.authorize('mirror-b', 'token')).toBe(true)
    expect(config.devices).toEqual([{ deviceID: 'PEER-B' }, { deviceID: 'SHARE-PEER' }])
    expect(config.folders.find(folder => folder.id === 'share-one')).toMatchObject({
      devices: [{ deviceID: 'SHARE-PEER' }],
    })
  })

  test('mirror admission is bounded before side effects while an existing device can re-register at the limit', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await mkdir(stateDir, { recursive: true })
    await mkdir(driveDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const devices = Array.from({ length: MAX_MIRROR_DEVICES_PER_WORKSPACE }, (_, index) => ({
      machineId: `cred_${index}`,
      syncthingDeviceId: 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY',
      registeredAt: index,
    }))
    await writeFile(join(stateDir, 'sync-mirror-devices.json'), `${JSON.stringify(devices)}\n`)
    let fetched = false
    let config: Record<string, unknown> = { devices: [], folders: [], options: {} }
    const runtime = createGatewayRuntime({
      stateDir,
      driveDir,
      syncthingApiUrl: 'http://syncthing.local',
      syncthingApiKey: 'api-key',
      fetch: async (input, init) => {
        fetched = true
        const url = String(input)
        if (url.endsWith('/rest/system/status')) return Response.json({ myID: 'VMDEVICE-IDABCDE' })
        if (url.endsWith('/rest/config') && init?.method === 'PUT') {
          config = JSON.parse(String(init.body))
          return Response.json({ ok: true })
        }
        if (url.endsWith('/rest/config')) return Response.json(config)
        return new Response('not found', { status: 404 })
      },
    })
    const request = (machineId: string) =>
      runtime.app.request('/v1/sync/syncthing/mirror/devices', {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          machineId,
          syncthingDeviceId: 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY',
        }),
      })
    const overflow = await request('cred_overflow')
    expect(overflow.status).toBe(409)
    expect(await overflow.json()).toEqual({ error: 'mirror_device_limit' })
    expect(fetched).toBeFalse()
    expect((await request('cred_0')).status).toBe(200)
    const listed = await runtime.app.request('/v1/sync/syncthing/mirror/devices', {
      headers: jsonAuthHeaders(),
    })
    const listedBody = (await listed.json()) as { devices: Array<{ machineId: string }> }
    expect(listedBody.devices).toHaveLength(MAX_MIRROR_DEVICES_PER_WORKSPACE)
    expect(listedBody.devices.filter(device => device.machineId === 'cred_0')).toHaveLength(1)
  })

  test('projecting a tunnel accept is activity-neutral (sleep-transparency L17/Q3)', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    await mkdir(stateDir, { recursive: true })
    await mkdir(driveDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir, driveDir })

    runtime.tunnelAccepts.replace([
      {
        acceptId: 'mirror-cred_9-abc',
        targetPort: 22000,
        tokenDigest: 'a'.repeat(64),
        expiresAt: Date.now() + 60_000,
      },
    ])
  })

  test('the files move route preserves anchor identity and earns an automatic reanchor', async () => {
    const runtime = await registeredRuntime()
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'site'), { recursive: true })
    const anchors: GatewayAnchor[] = [
      {
        id: 'anchor-1',
        workspaceId: 'workspace-1',
        path: 'apps/site',
        kind: 'app',
        settings: {},
        state: 'active',
        markerNonce: 'nonce-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir: join(tempDir, '.duet-anchor-state'),
      reportMoveCandidates: async () => {},
    })

    expect(await reconciler.reconcile(anchors)).toEqual([])
    const moved = await runtime.app.request('/v1/files/actions', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        operation: 'move',
        source: 'apps/site',
        destination: 'apps/site-renamed',
      }),
    })
    expect(moved.status).toBe(200)
    const emitted = await reconciler.reconcile(anchors)

    expect(emitted).toEqual([
      {
        anchorId: 'anchor-1',
        candidates: [
          {
            fromPath: 'apps/site',
            toPath: 'apps/site-renamed',
            confidence: 0.75,
            inodeMatch: true,
            markerMatch: true,
          },
        ],
        anchorPathExists: false,
        consecutiveMissingPolls: 1,
        markerMatches: ['apps/site-renamed'],
        missingIsConclusive: true,
      },
    ])
    expect(
      resolveAnchorRenameDecisions(
        [{ anchorId: 'anchor-1', path: 'apps/site', kind: 'app' }],
        emitted,
      ),
    ).toEqual([
      {
        action: 'reanchor',
        anchorId: 'anchor-1',
        fromPath: 'apps/site',
        toPath: 'apps/site-renamed',
        confidence: 0.95,
        inodeMatch: true,
        markerMatch: true,
      },
    ])
  })

  test('anchor reconciler skips drive snapshots and clears stale state when there are no active anchors', async () => {
    const driveDir = join(tempDir, 'missing-drive')
    const stateDir = join(tempDir, '.duet-anchor-state')
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      join(stateDir, 'anchor-snapshots.json'),
      `${JSON.stringify([{ anchorId: 'stale-anchor', path: 'apps/stale', inodeKey: '1:2', marker: 'old', kind: 'directory' }])}\n`,
    )
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => undefined,
    })

    expect(await reconciler.reconcile([])).toEqual([])
    expect(await readFile(join(stateDir, 'anchor-snapshots.json'), 'utf8')).toBe('[]\n')
  })

  // The blast-radius guard on the reap. A missing-folder report is what deletes
  // an app's row, and an unreadable drive would hand one to EVERY anchor at once
  // — one unmount reading as "the user deleted everything they own". A walk that
  // could not look is not evidence: the cycle is skipped whole, and the missing
  // counters do not advance, so nothing inches toward a reap on its strength.
  test('anchor reconciler reports nothing when the drive cannot be read at all', async () => {
    const stateDir = join(tempDir, '.duet-anchor-state-unreadable')
    const anchors: GatewayAnchor[] = [
      {
        id: 'anchor-unreadable',
        workspaceId: 'workspace-1',
        path: 'apps/site',
        kind: 'app',
        settings: {},
        state: 'active',
        markerNonce: 'nonce-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const reported: AnchorMoveCandidatesReport[][] = []
    const skipped: string[] = []
    const reconciler = createAnchorReconciler({
      driveDir: join(tempDir, 'drive-that-is-not-mounted'),
      stateDir,
      reportMoveCandidates: async reports => {
        reported.push(reports)
      },
      onReconcileSkipped: reason => {
        skipped.push(reason)
      },
    })

    expect(await reconciler.reconcile(anchors)).toEqual([])
    expect(await reconciler.reconcile(anchors)).toEqual([])
    expect(reported).toEqual([])
    expect(skipped).toEqual(['drive_unreadable', 'drive_unreadable'])
    // No snapshot state was written either: nothing observed, nothing counted, so
    // a drive that comes back does not find a head start toward deletion.
    expect(await readFile(join(stateDir, 'anchor-snapshots.json'), 'utf8').catch(() => null)).toBe(
      null,
    )
  })

  // An empty drive we could actually read IS evidence — the user really did
  // delete it all — so the missing counter has to advance toward the reap.
  test('anchor reconciler counts missing polls on a readable but empty drive', async () => {
    const driveDir = join(tempDir, 'drive-empty')
    await mkdir(driveDir, { recursive: true })
    const anchors: GatewayAnchor[] = [
      {
        id: 'anchor-empty',
        workspaceId: 'workspace-1',
        path: 'apps/site',
        kind: 'app',
        settings: {},
        state: 'active',
        markerNonce: 'nonce-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir: join(tempDir, '.duet-anchor-state-empty'),
      reportMoveCandidates: async () => undefined,
    })

    expect(await reconciler.reconcile(anchors)).toMatchObject([
      { anchorId: 'anchor-empty', anchorPathExists: false, consecutiveMissingPolls: 1 },
    ])
    expect(await reconciler.reconcile(anchors)).toMatchObject([
      { anchorId: 'anchor-empty', anchorPathExists: false, consecutiveMissingPolls: 2 },
    ])
  })

  test('anchor reconciler materializes a first-seen share mount before share convergence', async () => {
    const driveDir = join(tempDir, 'drive')
    const stateDir = join(tempDir, '.duet-anchor-state')
    await mkdir(driveDir, { recursive: true })
    const reports: AnchorMoveCandidatesReport[][] = []
    const anchors: GatewayAnchor[] = [
      {
        id: 'share-mount-anchor',
        workspaceId: 'workspace-1',
        path: 'shared/project',
        kind: 'share-mount',
        settings: {},
        state: 'active',
        markerNonce: 'share-mount-nonce',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async emitted => {
        reports.push(emitted)
      },
    })

    expect(await reconciler.reconcile(anchors)).toEqual([])
    expect(
      await readFile(join(driveDir, 'shared', 'project', DUET_ANCHOR_MARKER_FILE), 'utf8'),
    ).toBe('duet-anchor:v1:share-mount-anchor:share-mount-nonce\n')
    expect(reports).toEqual([])
  })

  test('anchor reconciler persists consecutive misses and marker matches across restart', async () => {
    const driveDir = join(tempDir, 'drive')
    const stateDir = join(tempDir, '.duet-anchor-state')
    const originalPath = join(driveDir, 'shared', 'project')
    const relocatedPath = join(driveDir, 'archive', 'project')
    await mkdir(originalPath, { recursive: true })
    const anchors: GatewayAnchor[] = [
      {
        id: 'share-mount-anchor',
        workspaceId: 'workspace-1',
        path: 'shared/project',
        kind: 'share-mount',
        settings: {},
        state: 'active',
        markerNonce: 'share-mount-nonce',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const first = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => undefined,
    })
    await first.reconcile(anchors)
    await mkdir(dirname(relocatedPath), { recursive: true })
    await rename(originalPath, relocatedPath)

    expect(await first.reconcile(anchors)).toEqual([
      {
        anchorId: 'share-mount-anchor',
        candidates: [
          {
            fromPath: 'shared/project',
            toPath: 'archive/project',
            confidence: 0.75,
            inodeMatch: true,
            markerMatch: true,
          },
        ],
        anchorPathExists: false,
        consecutiveMissingPolls: 1,
        markerMatches: ['archive/project'],
        missingIsConclusive: true,
      },
    ])

    const restarted = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => undefined,
    })
    expect(await restarted.reconcile(anchors)).toEqual([
      {
        anchorId: 'share-mount-anchor',
        candidates: [
          {
            fromPath: 'shared/project',
            toPath: 'archive/project',
            confidence: 0.75,
            inodeMatch: true,
            markerMatch: true,
          },
        ],
        anchorPathExists: false,
        consecutiveMissingPolls: 2,
        markerMatches: ['archive/project'],
        missingIsConclusive: true,
      },
    ])
  })

  test('anchor reconciler still reports a first-seen missing app anchor', async () => {
    const reports: AnchorMoveCandidatesReport[][] = []
    // A readable drive that simply does not hold the anchor's folder. An absent
    // drive ROOT is a different verdict entirely — see the unreadable-drive test.
    await mkdir(join(tempDir, 'drive'), { recursive: true })
    const reconciler = createAnchorReconciler({
      driveDir: join(tempDir, 'drive'),
      stateDir: join(tempDir, '.duet-anchor-state'),
      reportMoveCandidates: async emitted => {
        reports.push(emitted)
      },
    })
    const anchors: GatewayAnchor[] = [
      {
        id: 'missing-app-anchor',
        workspaceId: 'workspace-1',
        path: 'apps/missing',
        kind: 'app',
        settings: {},
        state: 'active',
        markerNonce: 'missing-app-nonce',
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    expect(await reconciler.reconcile(anchors)).toEqual([
      {
        anchorId: 'missing-app-anchor',
        candidates: [],
        anchorPathExists: false,
        consecutiveMissingPolls: 1,
        markerMatches: [],
        missingIsConclusive: true,
      },
    ])
    expect(reports).toEqual([
      [
        {
          anchorId: 'missing-app-anchor',
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: [],
          missingIsConclusive: true,
        },
      ],
    ])
  })

  test('anchor reconciler follows a marker-backed rename after restart', async () => {
    const driveDir = join(tempDir, 'drive')
    const stateDir = join(tempDir, '.duet-anchor-state')
    await mkdir(join(driveDir, 'apps', 'site'), { recursive: true })
    const anchors: GatewayAnchor[] = [
      {
        id: 'anchor-1',
        workspaceId: 'workspace-1',
        path: 'apps/site',
        kind: 'app',
        settings: {},
        state: 'active',
        markerNonce: 'nonce-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const firstReconciler = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => undefined,
    })
    await firstReconciler.reconcile(anchors)

    const restartedReconciler = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => undefined,
    })
    await rename(join(driveDir, 'apps', 'site'), join(driveDir, 'apps', 'site-renamed'))
    const emitted = await restartedReconciler.reconcile(anchors)

    expect(emitted).toEqual([
      {
        anchorId: 'anchor-1',
        candidates: [
          {
            fromPath: 'apps/site',
            toPath: 'apps/site-renamed',
            confidence: 0.75,
            inodeMatch: true,
            markerMatch: true,
          },
        ],
        anchorPathExists: false,
        consecutiveMissingPolls: 1,
        markerMatches: ['apps/site-renamed'],
        missingIsConclusive: true,
      },
    ])
  })

  test('anchor reconciler still reports a rename when the old path is replaced before scanning', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'site'), { recursive: true })
    const anchors: GatewayAnchor[] = [
      {
        id: 'anchor-1',
        workspaceId: 'workspace-1',
        path: 'apps/site',
        kind: 'app',
        settings: {},
        state: 'active',
        markerNonce: 'nonce-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir: join(tempDir, '.duet-anchor-state'),
      reportMoveCandidates: async () => undefined,
    })

    await reconciler.reconcile(anchors)
    await rename(join(driveDir, 'apps', 'site'), join(driveDir, 'apps', 'site-renamed'))
    await mkdir(join(driveDir, 'apps', 'site'))
    const emitted = await reconciler.reconcile(anchors)

    expect(emitted).toEqual([
      {
        anchorId: 'anchor-1',
        candidates: [
          {
            fromPath: 'apps/site',
            toPath: 'apps/site-renamed',
            confidence: 0.75,
            inodeMatch: true,
            markerMatch: true,
          },
        ],
        anchorPathExists: true,
        consecutiveMissingPolls: 1,
        markerMatches: ['apps/site-renamed'],
      },
    ])
  })

  test('anchor reconciler rejects a replacement file at a directory anchor path', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'site'), { recursive: true })
    const anchors: GatewayAnchor[] = [
      {
        id: 'anchor-1',
        workspaceId: 'workspace-1',
        path: 'apps/site',
        kind: 'app',
        settings: {},
        state: 'active',
        markerNonce: 'nonce-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir: join(tempDir, '.duet-anchor-state'),
      reportMoveCandidates: async () => undefined,
    })

    await reconciler.reconcile(anchors)
    await rename(join(driveDir, 'apps', 'site'), join(driveDir, 'apps', 'site-renamed'))
    await writeFile(join(driveDir, 'apps', 'site'), 'replacement file')
    const emitted = await reconciler.reconcile(anchors)

    expect(emitted).toEqual([
      {
        anchorId: 'anchor-1',
        candidates: [
          {
            fromPath: 'apps/site',
            toPath: 'apps/site-renamed',
            confidence: 0.75,
            inodeMatch: true,
            markerMatch: true,
          },
        ],
        anchorPathExists: true,
        consecutiveMissingPolls: 1,
        markerMatches: ['apps/site-renamed'],
      },
    ])
  })

  test('anchor reconciler keeps inode evidence when reporting a move fails transiently', async () => {
    const driveDir = join(tempDir, 'drive')
    const stateDir = join(tempDir, '.duet-anchor-state')
    await mkdir(join(driveDir, 'apps', 'site'), { recursive: true })
    let failReport = true
    const telemetry: AnchorReconcileTelemetry[] = []
    const anchors: GatewayAnchor[] = [
      {
        id: 'anchor-1',
        workspaceId: 'workspace-1',
        path: 'apps/site',
        kind: 'app',
        settings: {},
        state: 'active',
        markerNonce: 'nonce-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => {
        if (failReport) {
          failReport = false
          throw new Error('anchor move report failed')
        }
      },
      onReconcileTelemetry: event => telemetry.push(event),
    })

    await reconciler.reconcile(anchors)
    await rename(join(driveDir, 'apps', 'site'), join(driveDir, 'apps', 'site-renamed'))
    await expect(reconciler.reconcile(anchors)).rejects.toThrow('anchor move report failed')
    const restarted = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => undefined,
      onReconcileTelemetry: event => telemetry.push(event),
    })
    const retried = await restarted.reconcile(anchors)

    expect(retried).toEqual([
      {
        anchorId: 'anchor-1',
        candidates: [
          {
            fromPath: 'apps/site',
            toPath: 'apps/site-renamed',
            confidence: 0.75,
            inodeMatch: true,
            markerMatch: true,
          },
        ],
        anchorPathExists: false,
        consecutiveMissingPolls: 1,
        markerMatches: ['apps/site-renamed'],
        missingIsConclusive: true,
      },
    ])
    expect(telemetry.filter(event => event.path === 'slow')).toHaveLength(1)
    expect(telemetry.at(-1)).toMatchObject({ path: 'fast', anchorProbes: 1 })
  })

  test('a re-minted marker identity discards a stale durable move report before replay', async () => {
    const driveDir = join(tempDir, 'drive')
    const stateDir = join(tempDir, '.duet-anchor-state')
    await mkdir(driveDir, { recursive: true })
    const original: GatewayAnchor = {
      id: 'anchor-reminted',
      workspaceId: 'workspace-1',
      path: 'apps/missing',
      kind: 'app',
      settings: {},
      state: 'active',
      markerNonce: 'old-nonce',
      createdAt: 1,
      updatedAt: 1,
    }
    const first = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => {
        throw new Error('anchor move report failed')
      },
    })
    await expect(first.reconcile([original])).rejects.toThrow('anchor move report failed')

    const telemetry: AnchorReconcileTelemetry[] = []
    const restarted = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => undefined,
      onReconcileTelemetry: event => telemetry.push(event),
    })
    await restarted.reconcile([
      { ...original, markerNonce: 'new-nonce', updatedAt: original.updatedAt + 1 },
    ])

    expect(telemetry.at(-1)).toMatchObject({ path: 'slow', anchorProbes: 1 })
  })

  test('a first-seen missing file anchor can recover after its report fails', async () => {
    const driveDir = join(tempDir, 'drive')
    const stateDir = join(tempDir, '.duet-anchor-state')
    // The drive is readable and simply does not hold the file yet; an absent
    // drive root would suppress the cycle instead of reporting a missing anchor.
    await mkdir(driveDir, { recursive: true })
    let reportAttempts = 0
    const anchors: GatewayAnchor[] = [
      {
        id: 'file-anchor',
        workspaceId: 'workspace-1',
        path: 'published/report.md',
        kind: 'publish',
        settings: { kind: 'file' },
        state: 'active',
        markerNonce: 'file-nonce',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async () => {
        reportAttempts += 1
        throw new Error('anchor move report failed')
      },
    })

    await expect(reconciler.reconcile(anchors)).rejects.toThrow('anchor move report failed')
    await mkdir(join(driveDir, 'published'), { recursive: true })
    await writeFile(join(driveDir, 'published', 'report.md'), 'recovered')

    expect(await reconciler.reconcile(anchors)).toEqual([])
    expect(reportAttempts).toBe(1)
  })

  test('anchor reconciler refreshes marker for a manually repaired directory anchor', async () => {
    const driveDir = join(tempDir, 'drive')
    const stateDir = join(tempDir, '.duet-anchor-state')
    await mkdir(join(driveDir, 'apps', 'old'), { recursive: true })
    const baseAnchor: GatewayAnchor = {
      id: 'anchor-1',
      workspaceId: 'workspace-1',
      path: 'apps/old',
      kind: 'app',
      settings: {},
      state: 'active',
      markerNonce: 'nonce-1',
      createdAt: 1,
      updatedAt: 1,
    }
    let anchors = [baseAnchor]
    const reports: unknown[] = []
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async emitted => {
        reports.push({ reports: emitted })
      },
    })

    await reconciler.reconcile(anchors)
    await rm(join(driveDir, 'apps', 'old'), { recursive: true, force: true })
    await mkdir(join(driveDir, 'apps', 'fixed'), { recursive: true })
    anchors = [
      {
        ...baseAnchor,
        path: 'apps/fixed',
        markerNonce: 'nonce-2',
        updatedAt: 2,
      },
    ]

    expect(await reconciler.reconcile(anchors)).toEqual([])
    expect(await readFile(join(driveDir, 'apps', 'fixed', DUET_ANCHOR_MARKER_FILE), 'utf8')).toBe(
      'duet-anchor:v1:anchor-1:nonce-2\n',
    )
    expect(reports).toEqual([])
  })

  // The anti-hijack refusal and its release, at ONE path. A folder recreated
  // without its marker is refused while the backend's claim is unchanged —
  // the reconciler cannot tell the recreated folder from a stranger's. But a
  // re-minted marker nonce IS the release: the backend rotates it only
  // through an editor-authenticated reanchor/heal, so a changed nonce at the
  // same path is proof of an authorized reclaim, and waiting for the refused
  // snapshot to age out first (the old retry-and-settle dance) serves nothing.
  test('anchor reconciler re-adopts a same-path folder only when the marker nonce was re-minted', async () => {
    const driveDir = join(tempDir, 'drive')
    const stateDir = join(tempDir, '.duet-anchor-state')
    await mkdir(join(driveDir, 'agents', 'seo'), { recursive: true })
    const baseAnchor: GatewayAnchor = {
      id: 'anchor-seo',
      workspaceId: 'workspace-1',
      path: 'agents/seo',
      kind: 'agent',
      settings: {},
      state: 'active',
      markerNonce: 'nonce-1',
      createdAt: 1,
      updatedAt: 1,
    }
    const reports: AnchorMoveCandidatesReport[][] = []
    const reconciler = createAnchorReconciler({
      driveDir,
      stateDir,
      reportMoveCandidates: async emitted => {
        reports.push(emitted)
      },
    })
    await reconciler.reconcile([baseAnchor])

    // Delete-then-recreate: same path, marker gone, unchanged backend claim.
    await rm(join(driveDir, 'agents', 'seo'), { recursive: true, force: true })
    await mkdir(join(driveDir, 'agents', 'seo'), { recursive: true })
    const refused = await reconciler.reconcile([baseAnchor])
    expect(refused).toMatchObject([
      { anchorId: 'anchor-seo', candidates: [], anchorPathExists: true },
    ])
    // Refusal must not silently re-bless the folder: no marker written.
    expect(await readdir(join(driveDir, 'agents', 'seo'))).toEqual([])

    // The heal re-mints the nonce; the very next reconcile adopts — no report,
    // no waiting for the refused snapshot to be forgotten first.
    reports.length = 0
    const healed = await reconciler.reconcile([
      { ...baseAnchor, markerNonce: 'nonce-2', updatedAt: 2 },
    ])
    expect(healed).toEqual([])
    expect(reports).toEqual([])
    expect(await readFile(join(driveDir, 'agents', 'seo', DUET_ANCHOR_MARKER_FILE), 'utf8')).toBe(
      'duet-anchor:v1:anchor-seo:nonce-2\n',
    )
  })

  test('registration cannot persist VM identity before its restore descriptor is durable', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const archive = await buildSeedArchive()
    const blockedWrite = join(stateDir, 'pending-restore.json.tmp')
    await mkdir(blockedWrite, { recursive: true })
    const runtime = createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      driveDir,
      systemCommand: async () => ({ exitCode: 0 }),
      fetch: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === '/v1/vm/register')
          return Response.json({
            vmToken: 'vm-token',
            syncIntervalSeconds: 5,
            restore: { kind: 'birth-seed', url: 'http://backend/seed', sha256: archive.sha256 },
            sync: syncResponse(),
          })
        if (url.pathname === '/seed') return new Response(archive.bytes.slice())
        return new Response('not found', { status: 404 })
      },
    })
    await expect(runtime.registerOnce()).rejects.toThrow()
    await expect(readFile(join(stateDir, 'vm-token'))).rejects.toThrow()
    expect(await runtime.getVmToken()).toBeNull()
    await rm(blockedWrite, { recursive: true })
    await runtime.registerOnce()
    expect(await runtime.getVmToken()).toBe('vm-token')
    expect(await readFile(join(driveDir, 'welcome', 'README.md'), 'utf8')).not.toBe('')
  })

  test('pending archive restore retries before any sync is sent', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const archiveRoot = join(tempDir, 'archive-root')
    await mkdir(join(archiveRoot, 'drive'), { recursive: true })
    await writeFile(join(archiveRoot, 'drive', 'marker.txt'), 'restored-marker')
    const archive = await tarFixture(archiveRoot, 'drive')
    let archiveAttempts = 0
    const calls: string[] = []
    const runtime = createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      driveDir,
      systemCommand: async () => ({ exitCode: 0 }),
      fetch: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === '/v1/vm/register') {
          return Response.json({
            vmToken: 'vm-token',
            syncIntervalSeconds: 5,
            restore: {
              kind: 'birth-seed',
              url: 'http://backend/archive',
              sha256: createHash('sha256').update(new Uint8Array(archive)).digest('hex'),
            },
            sync: syncResponse(),
          })
        }
        if (url.pathname === '/archive') {
          archiveAttempts += 1
          if (archiveAttempts === 1) return new Response('try again', { status: 503 })
          return new Response(archive, { headers: { 'content-type': 'application/x-tar' } })
        }
        if (url.pathname === '/v1/vm/sync') {
          calls.push('sync')
          return Response.json(syncResponse())
        }
        return new Response('not found', { status: 404 })
      },
    })

    await expect(runtime.registerOnce()).rejects.toThrow('Restore download failed')
    expect(await runtime.getVmToken()).toBe('vm-token')
    await expect(readFile(join(driveDir, 'marker.txt'), 'utf8')).rejects.toThrow()

    await runtime.syncOnce()

    expect(archiveAttempts).toBe(2)
    expect(await readFile(join(driveDir, 'marker.txt'), 'utf8')).toBe('restored-marker')
    expect(calls).toEqual(['sync'])
  })

  test('pending seed restore installs Drive without replacing fresh VM identity', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const archiveRoot = join(tempDir, 'archive-root')
    await mkdir(join(archiveRoot, 'drive'), { recursive: true })
    await mkdir(join(archiveRoot, '.duet'), { recursive: true })
    await writeFile(join(archiveRoot, 'drive', 'marker.txt'), 'restored-drive')
    await writeFile(join(archiveRoot, '.duet', 'memory.db'), 'restored-memory')
    await writeFile(join(archiveRoot, '.duet', 'vm-token'), 'old-vm-token\n')
    await writeFile(
      modelCredentialsPath(join(archiveRoot, '.duet')),
      JSON.stringify({
        apiKey: 'old-model-key',
        gatewayBaseUrl: 'https://old-gateway.example',
        expiresAt: 1,
      }),
    )
    const archive = await tarFixture(archiveRoot, 'drive', '.duet')
    const systemCommandCalls: string[] = []
    const runtime = createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      driveDir,
      systemCommand: async argv => {
        systemCommandCalls.push(argv.join(' '))
        return { exitCode: 0 }
      },
      fetch: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === '/v1/vm/register') {
          return Response.json({
            vmToken: 'new-vm-token',
            syncIntervalSeconds: 5,
            restore: {
              kind: 'birth-seed',
              url: 'http://backend/archive',
              sha256: createHash('sha256').update(new Uint8Array(archive)).digest('hex'),
            },
            sync: syncResponse({
              modelCredentials: {
                apiKey: 'new-model-key',
                gatewayBaseUrl: 'https://gateway.example',
                expiresAt: Date.now() + 60_000,
              },
            }),
          })
        }
        if (url.pathname === '/archive') {
          return new Response(archive, { headers: { 'content-type': 'application/x-tar' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    await runtime.registerOnce()

    expect(await readFile(join(driveDir, 'marker.txt'), 'utf8')).toBe('restored-drive')
    await expect(readFile(join(stateDir, 'memory.db'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(stateDir, 'vm-token'), 'utf8')).toBe('new-vm-token\n')
    expect(await readFile(modelCredentialsPath(stateDir), 'utf8')).toContain('new-model-key')
    // Restore-stop (MAP-SYNC V3/L18): env.systemCommand is threaded through to
    // the swap, which stops syncthing before and starts it after.
    expect(systemCommandCalls).toEqual([
      'sudo -n systemctl stop duet-syncthing.service',
      'sudo -n systemctl start duet-syncthing.service',
    ])
  })

  test('registration restores seed content before writing anchors and starting the seeded app', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const archive = await buildSeedArchive()
    const hello: AppDeclaration = seedAppRegistrations[0]
    const port = await freePort()
    const events: string[] = []
    let syncRequest: Record<string, unknown> | undefined
    const recordWhen = async (name: string, observe: () => Promise<boolean>): Promise<void> => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (await observe()) {
          events.push(name)
          return
        }
        await Bun.sleep(10)
      }
      throw new Error(`registration stage never completed: ${name}`)
    }
    const runtime = createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      driveDir,
      systemCommand: async () => ({ exitCode: 0 }),
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        if (url.pathname === '/v1/vm/register') {
          return Response.json({
            vmToken: 'vm-token',
            syncIntervalSeconds: 5,
            restore: { kind: 'birth-seed', url: 'http://backend/archive', sha256: archive.sha256 },
            sync: syncResponse({
              anchors: [
                {
                  id: 'hello-anchor',
                  workspaceId: 'workspace-1',
                  path: hello.path,
                  kind: 'app',
                  settings: {},
                  state: 'active',
                  markerNonce: 'hello-marker',
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
              apps: [
                {
                  slug: hello.slug,
                  command: hello.command,
                  ...(hello.installCommand === undefined
                    ? {}
                    : { installCommand: hello.installCommand }),
                  port,
                  anchorPath: hello.path,
                  appId: 'fixture-app',
                  apiScopes: [],
                },
              ],
            }),
          })
        }
        if (url.pathname === '/archive') {
          return new Response(archive.bytes.buffer as ArrayBuffer, {
            headers: { 'content-type': 'application/x-tar' },
          })
        }
        if (url.pathname === '/v1/vm/sync') {
          syncRequest = (await request.json()) as Record<string, unknown>
          return Response.json(syncResponse())
        }
        return new Response('not found', { status: 404 })
      },
    })
    const appResponse = async (): Promise<Response> =>
      await runtime.app.request('/public/app/api/tasks', {
        headers: { ...authHeaders(), [DUET_APP_SLUG_HEADER]: hello.slug },
      })
    const stages = (async () => {
      await recordWhen('extract', async () => {
        return (
          (await readFile(join(driveDir, 'welcome', 'README.md'), 'utf8').catch(() => '')).length >
          0
        )
      })
      await recordWhen('marker', async () => {
        return (
          await readFile(join(driveDir, hello.path, DUET_ANCHOR_MARKER_FILE), 'utf8').catch(
            () => '',
          )
        ).includes('hello-anchor')
      })
      await recordWhen('supervisor hello', async () => {
        const response = await appResponse()
        if (response.status !== 200) return false
        const body = (await response.json().catch(() => null)) as { tasks?: unknown } | null
        return Array.isArray(body?.tasks)
      })
    })()

    await runtime.registerOnce()
    await stages
    await runtime.syncOnce()

    expect(events).toEqual(['extract', 'marker', 'supervisor hello'])
    expect(syncRequest).toMatchObject({
      appReconciliationReports: [
        {
          slug: hello.slug,
          command: hello.command,
          port,
          anchorPath: hello.path,
          appId: 'fixture-app',
          apiScopes: [],
          status: 'reconciled',
        },
      ],
    })
    expect(await readFile(join(driveDir, hello.path, DUET_ANCHOR_MARKER_FILE), 'utf8')).toBe(
      'duet-anchor:v1:hello-anchor:hello-marker\n',
    )
    const stop = await runtime.app.request('/v1/apps/reconcile', {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ apps: [] }),
    })
    expect(stop.status).toBe(200)
  }, 60_000)

  test('pending seed restore rejects a symlinked Drive root', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const archiveRoot = join(tempDir, 'archive-root')
    await mkdir(stateDir, { recursive: true })
    await mkdir(driveDir, { recursive: true })
    await mkdir(archiveRoot, { recursive: true })
    await symlink('/tmp/outside-duet-drive', join(archiveRoot, 'drive'))
    const archive = await tarFixture(archiveRoot, 'drive')
    const runtime = createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      driveDir,
      fetch: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === '/v1/vm/register') {
          return Response.json({
            vmToken: 'new-vm-token',
            syncIntervalSeconds: 5,
            restore: {
              kind: 'birth-seed',
              url: 'http://backend/archive',
              sha256: createHash('sha256').update(new Uint8Array(archive)).digest('hex'),
            },
            sync: syncResponse(),
          })
        }
        if (url.pathname === '/archive') {
          return new Response(archive, { headers: { 'content-type': 'application/x-tar' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    await expect(runtime.registerOnce()).rejects.toThrow('archive restore rejected unsafe entry')
  })

  test('pending archive restore rejects unparseable tar sizes before extraction', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const archiveRoot = join(tempDir, 'archive-root')
    await mkdir(join(archiveRoot, 'drive'), { recursive: true })
    await writeFile(join(archiveRoot, 'drive', 'marker.txt'), 'should-not-restore')
    const archive = corruptFirstTarSize(await tarFixture(archiveRoot, 'drive'))
    const runtime = createGatewayRuntime({
      provisioningToken: 'prov-token',
      apiUrl: 'http://backend',
      workspaceHint: 'ws1',
      stateDir,
      driveDir,
      fetch: async input => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname === '/v1/vm/register') {
          return Response.json({
            vmToken: 'new-vm-token',
            syncIntervalSeconds: 5,
            restore: {
              kind: 'birth-seed',
              url: 'http://backend/archive',
              sha256: createHash('sha256').update(new Uint8Array(archive)).digest('hex'),
            },
            sync: syncResponse(),
          })
        }
        if (url.pathname === '/archive') {
          return new Response(archive, { headers: { 'content-type': 'application/x-tar' } })
        }
        return new Response('not found', { status: 404 })
      },
    })

    await expect(runtime.registerOnce()).rejects.toThrow(
      'archive restore rejected unsupported tar size encoding',
    )
    await expect(readFile(join(driveDir, 'marker.txt'), 'utf8')).rejects.toThrow()
  })

  // slice 05 — files API
  test('files routes keep serving while the attribution helper is permanently down', async () => {
    const completedChild = (output: string): HelperChild => ({
      stdout: {
        async *[Symbol.asyncIterator]() {
          if (output !== '') yield new TextEncoder().encode(output)
        },
      },
      sendCommand: async () => ({ status: 'sent' }),
      kill: () => undefined,
      exited: Promise.resolve(),
    })
    let helperAttempts = 0
    const spawn: SpawnHelper = argv => {
      if (argv[0] === 'systemctl') return completedChild('0\n')
      helperAttempts += 1
      if (helperAttempts === 1) return completedChild('')
      return {
        stdout: {
          [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
            return {
              next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
            }
          },
        },
        sendCommand: async () => ({ status: 'helper_down', error: 'helper unavailable' }),
        kill: () => undefined,
        exited: new Promise<void>(() => undefined),
      } satisfies HelperChild
    }
    const runtime = await registeredRuntime({ helperSpawn: spawn })
    runtime.startHelperLoop()
    await waitFor(() => helperAttempts === 2)

    const put = await runtime.app.request('/v1/files/helper-down.txt', {
      method: 'PUT',
      headers: authHeaders(),
      body: 'still serving',
    })
    expect(put.status).toBe(200)
    const get = await runtime.app.request('/v1/files/helper-down.txt', authInit())
    expect(get.status).toBe(200)
    expect(await get.text()).toBe('still serving')
  })

  test('files API rejects traversal variants and reserved .duet paths as not found', async () => {
    const runtime = await registeredRuntime()
    for (const directory of ['safe%2F..%2F.duet', 'safe%5C..%5C.duet']) {
      await mkdir(join(tempDir, 'drive', directory), { recursive: true })
      await writeFile(join(tempDir, 'drive', directory, 'vm-token'), 'must not serve')
    }
    for (const path of [
      '/v1/files/../.duet/vm-token',
      '/v1/files/%2e%2e/.duet/vm-token',
      '/v1/files/%252e%252e/.duet/vm-token',
      '/v1/files/safe%2F..%2F.duet/vm-token',
      '/v1/files/safe%5C..%5C.duet/vm-token',
      '/v1/files/safe/%00/token',
      '/v1/files/.duet/vm-token',
      '/v1/files/safe/.duet/vm-token',
    ]) {
      const response = await runtime.app.request(path, authInit())
      expect(response.status, path).toBe(404)
    }
  })

  test('files API preserves literal percent filenames as identities distinct from nested paths', async () => {
    const runtime = await registeredRuntime()
    const writes = [
      ['/v1/files/100%25.pdf', 'literal percent'],
      ['/v1/files/a%252Fb', 'encoded-looking name'],
      ['/v1/files/a/b', 'nested path'],
    ] as const

    for (const [url, body] of writes) {
      const response = await runtime.app.request(url, {
        method: 'PUT',
        headers: authHeaders(),
        body,
      })
      expect(response.status, url).toBe(200)
    }

    for (const [url, body] of writes) {
      const response = await runtime.app.request(url, authInit())
      expect(response.status, url).toBe(200)
      expect(await response.text(), url).toBe(body)
    }

    const literalStat = await runtime.app.request('/v1/files/a%252Fb?stat=1', authInit())
    expect(literalStat.status).toBe(200)
    expect(await literalStat.json()).toEqual({
      entry: {
        name: 'a%2Fb',
        path: 'a%2Fb',
        type: 'file',
        size: 20,
        mtime: expect.any(String),
      },
      etag: expect.stringMatching(/^".+"$/),
    })

    const listing = await runtime.app.request('/v1/files?list=1', authInit())
    expect(listing.status).toBe(200)
    const listed = (await listing.json()) as {
      items: Array<{ name: string; path: string; type: string }>
    }
    expect(listed.items.map(({ name, path, type }) => ({ name, path, type }))).toEqual(
      expect.arrayContaining([
        { name: '100%.pdf', path: '100%.pdf', type: 'file' },
        { name: 'a%2Fb', path: 'a%2Fb', type: 'file' },
        { name: 'a', path: 'a', type: 'directory' },
      ]),
    )

    const deleted = await runtime.app.request('/v1/files/a%252Fb', {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(deleted.status).toBe(200)
    expect((await runtime.app.request('/v1/files/a%252Fb', authInit())).status).toBe(404)
    const nestedAfterDelete = await runtime.app.request('/v1/files/a/b', authInit())
    expect(nestedAfterDelete.status).toBe(200)
    expect(await nestedAfterDelete.text()).toBe('nested path')
  })

  test('files API never reads or writes through a link that escapes the drive root', async () => {
    const runtime = await registeredRuntime()
    const outsideTarget = join(tempDir, 'outside-secret.txt')
    await writeFile(outsideTarget, 'secret')
    await symlink(outsideTarget, join(tempDir, 'drive', 'link-out'))

    // An escaping link fails typed (slice 16), never serves outside bytes.
    const read = await runtime.app.request('/v1/files/link-out', authInit())
    expect(read.status).toBe(409)
    expect(await read.json()).toEqual({ error: 'symlink_unresolvable', target: outsideTarget })

    const overwrite = await runtime.app.request('/v1/files/link-out', {
      method: 'PUT',
      headers: authHeaders(),
      body: 'new',
    })
    expect(overwrite.status).toBe(409)
    expect(await overwrite.json()).toEqual({ error: 'path_is_symlink' })
    expect(await readFile(outsideTarget, 'utf8')).toBe('secret')

    // An escaping link in an intermediate segment stays an opaque 404.
    await mkdir(join(tempDir, 'outside-dir'), { recursive: true })
    await writeFile(join(tempDir, 'outside-dir', 'inner.txt'), 'outside')
    await symlink(join(tempDir, 'outside-dir'), join(tempDir, 'drive', 'dir-out'))
    const nested = await runtime.app.request('/v1/files/dir-out/inner.txt', authInit())
    expect(nested.status).toBe(404)
  })

  test('files API returns exact single byte ranges and rejects unsatisfied or multi-range requests', async () => {
    const runtime = await registeredRuntime()
    const bytes = crypto.getRandomValues(new Uint8Array(1024))
    await mkdir(join(tempDir, 'drive', 'bin'), { recursive: true })
    await writeFile(join(tempDir, 'drive', 'bin', 'random.dat'), bytes)

    const first = await runtime.app.request('/v1/files/bin/random.dat', {
      ...authInit(),
      headers: { ...authHeaders(), range: 'bytes=100-199' },
    })
    expect(first.status).toBe(206)
    expect(first.headers.get('accept-ranges')).toBe('bytes')
    expect(first.headers.get('content-range')).toBe('bytes 100-199/1024')
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(bytes.slice(100, 200))

    const suffix = await runtime.app.request('/v1/files/bin/random.dat', {
      ...authInit(),
      headers: { ...authHeaders(), range: 'bytes=-12' },
    })
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 1012-1023/1024')
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.slice(1012))

    const pastEof = await runtime.app.request('/v1/files/bin/random.dat', {
      ...authInit(),
      headers: { ...authHeaders(), range: 'bytes=1024-2048' },
    })
    expect(pastEof.status).toBe(416)
    expect(pastEof.headers.get('content-range')).toBe('bytes */1024')

    const multiRange = await runtime.app.request('/v1/files/bin/random.dat', {
      ...authInit(),
      headers: { ...authHeaders(), range: 'bytes=0-1,3-4' },
    })
    expect(multiRange.status).toBe(416)
  })

  test('files API uploads survive a fresh gateway instance and still serve exact ranges', async () => {
    const stateDir = join(tempDir, '.duet')
    const driveDir = join(tempDir, 'drive')
    const bytes = new Uint8Array(3 * 1024 * 1024)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251

    const firstRuntime = await registeredRuntime({ stateDir, driveDir })
    // File publication belongs to the durable drive. Unrelated state-dir contents
    // must not become a hidden prerequisite for accepting an upload.
    await writeFile(join(stateDir, 'uploads'), 'ephemeral state sentinel')
    const put = await firstRuntime.app.request('/v1/files/live/big.bin', {
      method: 'PUT',
      headers: authHeaders(),
      body: bytes,
    })
    expect(put.status).toBe(200)

    const beforeRestart = await firstRuntime.app.request('/v1/files/live/big.bin', {
      headers: { ...authHeaders(), range: 'bytes=12345-12444' },
    })
    expect(beforeRestart.status).toBe(206)
    expect(beforeRestart.headers.get('content-range')).toBe('bytes 12345-12444/3145728')
    expect(new Uint8Array(await beforeRestart.arrayBuffer())).toEqual(bytes.slice(12345, 12445))

    const restartedRuntime = createGatewayRuntime({ stateDir, driveDir })
    const afterRestart = await restartedRuntime.app.request('/v1/files/live/big.bin', {
      headers: { ...authHeaders(), range: 'bytes=2097152-2097251' },
    })
    expect(afterRestart.status).toBe(206)
    expect(afterRestart.headers.get('content-range')).toBe('bytes 2097152-2097251/3145728')
    expect(new Uint8Array(await afterRestart.arrayBuffer())).toEqual(bytes.slice(2097152, 2097252))
  })

  test('public publish route reuses file GET but refuses .env-like paths', async () => {
    const runtime = await registeredRuntime()
    await mkdir(join(tempDir, 'drive', 'public'), { recursive: true })
    await writeFile(join(tempDir, 'drive', 'public', 'notes.md'), 'hello')
    await writeFile(join(tempDir, 'drive', 'public', '.env.local'), 'SECRET=1')

    const nested = await runtime.app.request('/public/publish/notes.md?raw', {
      headers: {
        ...authHeaders(),
        [DUET_PUBLISH_KIND_HEADER]: 'folder',
        [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'public',
        range: 'bytes=1-3',
      },
    })
    expect(nested.status).toBe(206)
    expect(nested.headers.get('content-range')).toBe('bytes 1-3/5')
    expect(await nested.text()).toBe('ell')

    const env = await runtime.app.request('/public/publish/.env.local?raw', {
      headers: {
        ...authHeaders(),
        [DUET_PUBLISH_KIND_HEADER]: 'folder',
        [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'public',
      },
    })
    expect(env.status).toBe(404)

    const envAnchor = await runtime.app.request('/public/publish?raw', {
      headers: {
        ...authHeaders(),
        [DUET_PUBLISH_KIND_HEADER]: 'file',
        [DUET_PUBLISH_ANCHOR_PATH_HEADER]: 'public/.env.local',
      },
    })
    expect(envAnchor.status).toBe(404)
  })

  test('files API writes atomically, checks If-Match, lists directories, and deletes only files or empty dirs', async () => {
    const runtime = await registeredRuntime()
    const put = await runtime.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: authHeaders(),
      body: 'first',
    })
    expect(put.status).toBe(200)
    const putBody = (await put.json()) as { etag: string }
    const firstEtag = put.headers.get('etag')
    expect(firstEtag).toBe(putBody.etag)
    expect(firstEtag).not.toBeNull()
    expect(await readFile(join(tempDir, 'drive', 'docs', 'a.txt'), 'utf8')).toBe('first')

    const conflict = await runtime.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: { ...authHeaders(), 'if-match': '"stale-etag"' },
      body: 'stale',
    })
    expect(conflict.status).toBe(412)
    expect(await readFile(join(tempDir, 'drive', 'docs', 'a.txt'), 'utf8')).toBe('first')

    const sameSizeOverwrite = await runtime.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: { ...authHeaders(), 'if-match': firstEtag! },
      body: 'other',
    })
    expect(sameSizeOverwrite.status).toBe(200)
    const secondEtag = sameSizeOverwrite.headers.get('etag')
    expect(secondEtag).not.toBe(firstEtag)

    const staleSameSize = await runtime.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: { ...authHeaders(), 'if-match': firstEtag! },
      body: 'third',
    })
    expect(staleSameSize.status).toBe(412)
    expect(await readFile(join(tempDir, 'drive', 'docs', 'a.txt'), 'utf8')).toBe('other')

    const [parallelA, parallelB] = await Promise.all([
      runtime.app.request('/v1/files/concurrent/a.txt', {
        method: 'PUT',
        headers: authHeaders(),
        body: 'a',
      }),
      runtime.app.request('/v1/files/concurrent/b.txt', {
        method: 'PUT',
        headers: authHeaders(),
        body: 'b',
      }),
    ])
    expect(parallelA.status).toBe(200)
    expect(parallelB.status).toBe(200)

    const overwrite = await runtime.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: { ...authHeaders(), 'if-match': secondEtag! },
      body: 'second',
    })
    expect(overwrite.status).toBe(200)
    expect(await readFile(join(tempDir, 'drive', 'docs', 'a.txt'), 'utf8')).toBe('second')
    const wildcardOverwrite = await runtime.app.request('/v1/files/docs/a.txt', {
      method: 'PUT',
      headers: { ...authHeaders(), 'if-match': '*' },
      body: 'second',
    })
    expect(wildcardOverwrite.status).toBe(200)
    const textRead = await runtime.app.request('/v1/files/docs/a.txt', authInit())
    expect(textRead.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(textRead.headers.get('content-security-policy')).toBe('sandbox')
    expect(textRead.headers.get('x-content-type-options')).toBe('nosniff')

    await mkdir(join(tempDir, 'drive', 'docs', 'empty'), { recursive: true })
    await mkdir(join(tempDir, 'drive', 'docs', '.duet'), { recursive: true })
    await writeFile(join(tempDir, 'drive', 'docs', '.duet', 'hidden.txt'), 'hidden')
    const rootListing = await runtime.app.request('/v1/files?list=1', authInit())
    expect(rootListing.status).toBe(200)
    expect(await rootListing.json()).toMatchObject({
      items: [
        { name: 'concurrent', type: 'directory' },
        { name: 'docs', type: 'directory' },
      ],
    })
    const listing = await runtime.app.request('/v1/files/docs?list=1', authInit())
    expect(listing.status).toBe(200)
    expect(await listing.json()).toMatchObject({
      items: [
        { name: 'a.txt', type: 'file', size: 6 },
        { name: 'empty', type: 'directory' },
      ],
      nextCursor: null,
    })
    const fileStat = await runtime.app.request('/v1/files/docs/a.txt?stat=1', authInit())
    expect(fileStat.status).toBe(200)
    expect(fileStat.headers.get('content-type')).toContain('application/json')
    expect(await fileStat.json()).toEqual({
      entry: {
        name: 'a.txt',
        path: 'docs/a.txt',
        type: 'file',
        size: 6,
        mtime: expect.any(String),
      },
      etag: textRead.headers.get('etag'),
    })
    const directoryStat = await runtime.app.request('/v1/files/docs?stat=1', authInit())
    expect(directoryStat.status).toBe(200)
    expect(await directoryStat.json()).toMatchObject({
      entry: { name: 'docs', path: 'docs', type: 'directory', size: 0 },
      etag: null,
    })
    await rm(join(tempDir, 'drive', 'docs', '.duet'), { recursive: true, force: true })

    const nonEmptyDelete = await runtime.app.request('/v1/files/docs', {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(nonEmptyDelete.status).toBe(409)

    const fileDelete = await runtime.app.request('/v1/files/docs/a.txt', {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(fileDelete.status).toBe(200)
    expect(await readdir(join(tempDir, 'drive', 'docs'))).toEqual(['empty'])

    const dirDelete = await runtime.app.request('/v1/files/docs/empty', {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(dirDelete.status).toBe(200)
  })

  test('files API can delete an otherwise empty anchored directory with only its marker', async () => {
    const runtime = await registeredRuntime()
    await mkdir(join(tempDir, 'drive', 'anchored'), { recursive: true })
    await writeFile(
      join(tempDir, 'drive', 'anchored', DUET_ANCHOR_MARKER_FILE),
      'duet-anchor:v1:a:n\n',
    )

    const listing = await runtime.app.request('/v1/files/anchored?list=1', authInit())
    expect(listing.status).toBe(200)
    expect(await listing.json()).toEqual({ items: [], nextCursor: null })

    const deleted = await runtime.app.request('/v1/files/anchored', {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(deleted.status).toBe(200)
    await expect(stat(join(tempDir, 'drive', 'anchored'))).rejects.toThrow()
  })

  // The marker is the folder's anchor identity, and a non-recursive delete
  // used to unlink it BEFORE attempting the rmdir — so a delete that then
  // failed (an app writing into its folder mid-delete) had destroyed the
  // proof and kept the folder, and the anchor rail then refused the still-
  // living folder as a hijack. This actually broke content-board in a real
  // run. A failed delete must leave the marker in place; only a delete that
  // removed the directory may discard it.
  test('a failed non-recursive delete leaves the anchor marker intact', async () => {
    // Permission bits are the deterministic stand-in for the mid-delete race:
    // a read-only PARENT makes the rmdir fail while the marker inside the
    // still-writable directory remains deletable. Root ignores permission
    // bits, so the probe cannot fail there.
    if (process.getuid?.() === 0) return
    const runtime = await registeredRuntime()
    const parent = join(tempDir, 'drive', 'keep')
    const markerPath = join(parent, 'anchored', DUET_ANCHOR_MARKER_FILE)
    await mkdir(join(parent, 'anchored'), { recursive: true })
    await writeFile(markerPath, 'duet-anchor:v1:board-anchor:board-nonce\n')
    await chmod(parent, 0o555)
    try {
      const failed = await runtime.app.request('/v1/files/keep/anchored', {
        method: 'DELETE',
        headers: authHeaders(),
      })
      expect(failed.status).toBeGreaterThanOrEqual(400)
      // The folder survived the failed delete, so its proof must have too.
      expect(await readFile(markerPath, 'utf8')).toBe('duet-anchor:v1:board-anchor:board-nonce\n')
    } finally {
      await chmod(parent, 0o755)
    }
  })

  test('files API does not ignore arbitrary files named like the anchor marker', async () => {
    const runtime = await registeredRuntime()
    await mkdir(join(tempDir, 'drive', 'user-dir'), { recursive: true })
    await writeFile(
      join(tempDir, 'drive', 'user-dir', DUET_ANCHOR_MARKER_FILE),
      'not an internal marker',
    )

    const deleted = await runtime.app.request('/v1/files/user-dir', {
      method: 'DELETE',
      headers: authHeaders(),
    })

    expect(deleted.status).toBe(409)
    expect(
      await readFile(join(tempDir, 'drive', 'user-dir', DUET_ANCHOR_MARKER_FILE), 'utf8'),
    ).toBe('not an internal marker')
  })

  test('file reads and writes advance the synchronized activity generation', async () => {
    const runtime = await registeredRuntime()
    await writeFile(join(tempDir, 'drive', 'activity.txt'), 'hello')

    await rm(join(tempDir, '.duet', 'activity'), { force: true })
    const read = await runtime.app.request('/v1/files/activity.txt', authInit())
    expect(read.status).toBe(200)

    await rm(join(tempDir, '.duet', 'activity'), { force: true })
    const write = await runtime.app.request('/v1/files/activity.txt', {
      method: 'PUT',
      headers: authHeaders(),
      body: 'changed',
    })
    expect(write.status).toBe(200)
  })

  test('streaming writes keep temporary upload files outside visible listings', async () => {
    const runtime = await registeredRuntime()
    let finish!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
        finish = () => controller.close()
      },
    })
    const pending = runtime.app.request('/v1/files/docs/slow.txt', {
      method: 'PUT',
      headers: authHeaders(),
      body,
    })

    await waitForUploads()
    const listing = await runtime.app.request('/v1/files/docs?list=1', authInit())
    expect(listing.status).toBe(200)
    expect(await listing.json()).toEqual({ items: [], nextCursor: null })

    finish()
    const written = await pending
    expect(written.status).toBe(200)
    expect(await readFile(join(tempDir, 'drive', 'docs', 'slow.txt'), 'utf8')).toBe('partial')
  })

  test('file actions create directories and move or copy without implicit collision overwrites', async () => {
    const runtime = await registeredRuntime()
    const action = (body: Record<string, unknown>) =>
      runtime.app.request('/v1/files/actions', {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify(body),
      })

    await rm(join(tempDir, 'drive'), { recursive: true, force: true })
    const firstFolder = await action({ operation: 'mkdir', path: 'projects' })
    expect(firstFolder.status).toBe(200)
    expect((await stat(join(tempDir, 'drive', 'projects'))).isDirectory()).toBe(true)

    const missingParent = await action({ operation: 'mkdir', path: 'missing/briefs' })
    expect(missingParent.status).toBe(409)
    expect(await missingParent.json()).toEqual({ error: 'parent_not_found' })

    const made = await action({
      operation: 'mkdir',
      path: 'projects/briefs',
      recursive: true,
    })
    expect(made.status).toBe(200)
    expect(await made.json()).toEqual({ ok: true, affectedEntries: 1 })
    expect((await stat(join(tempDir, 'drive', 'projects', 'briefs'))).isDirectory()).toBe(true)

    await writeFile(join(tempDir, 'drive', 'projects', 'briefs', 'launch.md'), 'launch plan')
    const copied = await action({
      operation: 'copy',
      source: 'projects/briefs/launch.md',
      destination: 'projects/briefs/launch-copy.md',
    })
    expect(copied.status).toBe(200)
    expect(
      await readFile(join(tempDir, 'drive', 'projects', 'briefs', 'launch-copy.md'), 'utf8'),
    ).toBe('launch plan')

    const collision = await action({
      operation: 'move',
      source: 'projects/briefs/launch-copy.md',
      destination: 'projects/briefs/launch.md',
    })
    expect(collision.status).toBe(409)
    expect(await collision.json()).toEqual({ error: 'path_exists' })

    const moved = await action({
      operation: 'move',
      source: 'projects/briefs/launch-copy.md',
      destination: 'projects/launch-copy.md',
    })
    expect(moved.status).toBe(200)
    expect(await readFile(join(tempDir, 'drive', 'projects', 'launch-copy.md'), 'utf8')).toBe(
      'launch plan',
    )
    await expect(
      stat(join(tempDir, 'drive', 'projects', 'briefs', 'launch-copy.md')),
    ).rejects.toThrow()
  })

  test('file actions preserve percent-looking logical paths without aliasing nested paths', async () => {
    const runtime = await registeredRuntime()
    const action = (body: Record<string, unknown>) =>
      runtime.app.request('/v1/files/actions', {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify(body),
      })
    await mkdir(join(tempDir, 'drive', 'source'), { recursive: true })
    await writeFile(join(tempDir, 'drive', 'source%2Fnote.txt'), 'literal source')
    await writeFile(join(tempDir, 'drive', 'source', 'note.txt'), 'nested source')

    const copied = await action({
      operation: 'copy',
      source: 'source%2Fnote.txt',
      destination: 'copy%2Fnote.txt',
    })
    expect(copied.status).toBe(200)
    expect(await readFile(join(tempDir, 'drive', 'copy%2Fnote.txt'), 'utf8')).toBe('literal source')
    expect(await readFile(join(tempDir, 'drive', 'source', 'note.txt'), 'utf8')).toBe(
      'nested source',
    )

    const moved = await action({
      operation: 'move',
      source: 'copy%2Fnote.txt',
      destination: 'moved%2Fnote.txt',
    })
    expect(moved.status).toBe(200)
    expect(await readFile(join(tempDir, 'drive', 'moved%2Fnote.txt'), 'utf8')).toBe(
      'literal source',
    )
    await expect(stat(join(tempDir, 'drive', 'copy%2Fnote.txt'))).rejects.toThrow()

    const deleted = await action({ operation: 'delete', path: 'moved%2Fnote.txt' })
    expect(deleted.status).toBe(200)
    await expect(stat(join(tempDir, 'drive', 'moved%2Fnote.txt'))).rejects.toThrow()
    expect(await readFile(join(tempDir, 'drive', 'source', 'note.txt'), 'utf8')).toBe(
      'nested source',
    )
  })

  test('recursive copy omits anchor identity and recursive delete stays explicit', async () => {
    const runtime = await registeredRuntime()
    const action = (body: Record<string, unknown>) =>
      runtime.app.request('/v1/files/actions', {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify(body),
      })
    await mkdir(join(tempDir, 'drive', 'source', 'nested'), { recursive: true })
    await writeFile(join(tempDir, 'drive', 'source', 'nested', 'note.txt'), 'hello')
    await writeFile(
      join(tempDir, 'drive', 'source', DUET_ANCHOR_MARKER_FILE),
      'duet-anchor:v1:anchor:name\n',
    )

    const needsRecursive = await action({
      operation: 'copy',
      source: 'source',
      destination: 'copy',
    })
    expect(needsRecursive.status).toBe(409)
    expect(await needsRecursive.json()).toEqual({ error: 'recursive_required' })

    const copied = await action({
      operation: 'copy',
      source: 'source',
      destination: 'copy',
      recursive: true,
    })
    expect(copied.status).toBe(200)
    expect(await readFile(join(tempDir, 'drive', 'copy', 'nested', 'note.txt'), 'utf8')).toBe(
      'hello',
    )
    await expect(stat(join(tempDir, 'drive', 'copy', DUET_ANCHOR_MARKER_FILE))).rejects.toThrow()

    const refused = await action({ operation: 'delete', path: 'copy' })
    expect(refused.status).toBe(409)
    expect(await readFile(join(tempDir, 'drive', 'copy', 'nested', 'note.txt'), 'utf8')).toBe(
      'hello',
    )
    const deleted = await action({ operation: 'delete', path: 'copy', recursive: true })
    expect(deleted.status).toBe(200)
    // No count: a recursive delete no longer walks the tree to produce one, which
    // is what let the bound on it go away entirely.
    expect(await deleted.json()).toEqual({ ok: true })
    await expect(stat(join(tempDir, 'drive', 'copy'))).rejects.toThrow()
  })

  test('file actions copy embedded links as links, refuse an over-limit copy, and still delete that tree', async () => {
    const runtime = await registeredRuntime()
    const action = (body: Record<string, unknown>) =>
      runtime.app.request('/v1/files/actions', {
        method: 'POST',
        headers: jsonAuthHeaders(),
        body: JSON.stringify(body),
      })
    await mkdir(join(tempDir, 'drive', 'linked'), { recursive: true })
    await writeFile(join(tempDir, 'drive', 'target.txt'), 'target')
    await symlink('../target.txt', join(tempDir, 'drive', 'linked', 'alias.txt'))
    const symlinked = await action({
      operation: 'copy',
      source: 'linked',
      destination: 'linked-copy',
      recursive: true,
    })
    // Slice 16: a copy reproduces a link verbatim, never follows it.
    expect(symlinked.status).toBe(200)
    expect(await symlinked.json()).toEqual({ ok: true, affectedEntries: 2 })
    expect(await readlink(join(tempDir, 'drive', 'linked-copy', 'alias.txt'))).toBe('../target.txt')
    expect(
      (await readdir(join(tempDir, 'drive', '.duet', 'uploads')).catch(() => [])).some(name =>
        name.startsWith('copy-'),
      ),
    ).toBe(false)

    await mkdir(join(tempDir, 'drive', 'large'))
    await Promise.all(
      Array.from({ length: 1_000 }, (_, index) =>
        writeFile(join(tempDir, 'drive', 'large', `${index}.txt`), ''),
      ),
    )
    const copyOverLimit = await action({
      operation: 'copy',
      source: 'large',
      destination: 'large-copy',
      recursive: true,
    })
    expect(copyOverLimit.status).toBe(409)
    expect(await copyOverLimit.json()).toEqual({ error: 'recursive_limit_exceeded' })
    await expect(stat(join(tempDir, 'drive', 'large-copy'))).rejects.toThrow()
    // The same tree DELETES fine. A copy is bounded because it reproduces every
    // entry; a delete reproduces nothing, and bounding it the same way would mean
    // a folder with dependencies installed can never be thrown away — the folder
    // being the only handle on an app whose row refuses direct deletion.
    const deleted = await action({
      operation: 'delete',
      path: 'large',
      recursive: true,
    })
    expect(deleted.status).toBe(200)
    await expect(stat(join(tempDir, 'drive', 'large'))).rejects.toThrow()
  })

  test('a failed recursive copy removes its hidden staging tree and leaves no destination', async () => {
    const runtime = await registeredRuntime()
    await mkdir(join(tempDir, 'drive', 'source'))
    await writeFile(join(tempDir, 'drive', 'source', 'a-good.txt'), 'copied first')
    const unreadable = join(tempDir, 'drive', 'source', 'z-unreadable.txt')
    await writeFile(unreadable, 'blocked')
    await chmod(unreadable, 0o000)

    const copied = await runtime.app.request('/v1/files/actions', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        operation: 'copy',
        source: 'source',
        destination: 'destination',
        recursive: true,
      }),
    })

    expect(copied.status).toBe(500)
    await expect(stat(join(tempDir, 'drive', 'destination'))).rejects.toThrow()
    expect(
      (await readdir(join(tempDir, 'drive', '.duet', 'uploads'))).filter(name =>
        name.startsWith('copy-'),
      ),
    ).toEqual([])
    await chmod(unreadable, 0o600)
  })

  test('skills API lists what the agent CLI reports for the requested agent folder', async () => {
    const argvs: string[][] = []
    const runtime = await registeredRuntime({
      duetRunner: async argv => {
        argvs.push(argv)
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            skills: [{ name: 'review', path: '/skills/review', scope: 'project' }],
          }),
        }
      },
    })
    await mkdir(join(tempDir, 'drive', 'agents', 'scout'), { recursive: true })

    const response = await runtime.app.request('/v1/skills?cwd=agents%2Fscout', authInit())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      skills: [{ name: 'review', path: '/skills/review', scope: 'project' }],
    })
    expect(argvs).toEqual([['skills', '--workdir', join(tempDir, 'drive', 'agents', 'scout')]])
    expect((await runtime.app.request('/v1/skills')).status).toBe(401)
  })

  test('memory API adds through the agent CLI contract and searches ranked JSON results', async () => {
    const mock = new MockMemoryCli()
    const runtime = await registeredRuntime({ duetRunner: mock.runner })

    const weak = await runtime.app.request('/v1/memory', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ content: 'Discount approval requires finance review', source: 'api' }),
    })
    expect(weak.status).toBe(200)

    const strong = await runtime.app.request('/v1/memory', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        content: 'Enterprise discount discount cap is 20 percent',
        source: 'system',
      }),
    })
    expect(strong.status).toBe(200)
    expect(await strong.json()).toMatchObject({
      content: 'Enterprise discount discount cap is 20 percent',
      kind: 'note',
      source: 'system',
      priority: 'medium',
      observedDate: '2023-11-14',
      tags: [],
    })

    const search = await runtime.app.request('/v1/memory/search?q=discount&limit=5', authInit())
    expect(search.status).toBe(200)
    expect(await search.json()).toEqual({
      query: 'discount',
      limit: 5,
      results: [
        {
          id: 'mem_2',
          content: 'Enterprise discount discount cap is 20 percent',
          kind: 'note',
          source: 'system',
          priority: 'medium',
          relevanceScore: 2,
          lastUsedAt: '2023-11-14T22:15:00.000Z',
          createdAt: '2023-11-14T22:13:20.001Z',
          observedDate: '2023-11-14',
          tags: [],
          packScore: 1,
        },
        {
          id: 'mem_1',
          content: 'Discount approval requires finance review',
          kind: 'note',
          source: 'api',
          priority: 'medium',
          relevanceScore: 1,
          lastUsedAt: '2023-11-14T22:15:00.000Z',
          createdAt: '2023-11-14T22:13:20.000Z',
          observedDate: '2023-11-14',
          tags: [],
          packScore: 1,
        },
      ],
    })
    expect(mock.calls).toContainEqual([
      'memory',
      'add',
      '--db',
      join(tempDir, '.duet', 'memory.db'),
      '--json',
      '--source',
      'system',
      '--wait',
      '5',
      'Enterprise discount discount cap is 20 percent',
    ])
    expect(mock.calls).toContainEqual([
      'memory',
      'recall',
      '--db',
      join(tempDir, '.duet', 'memory.db'),
      '--query',
      'discount',
      '--json',
      '--limit',
      '5',
      '--wait',
      '5',
    ])
  })

  test('memory API reports a missing agent binary as a CLI failure', async () => {
    const runtime = await registeredRuntime({
      duetRunner: async () => {
        throw new Error('Executable not found in $PATH: "duet"')
      },
    })

    const response = await runtime.app.request('/v1/memory/search?q=discount', authInit())

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'memory_cli_failed',
      exitCode: 69,
      message: 'Executable not found in $PATH: "duet"',
    })
  })

  test('memory DB path is rejected inside the drive root', async () => {
    await expect(
      registeredRuntime({
        memoryDbPath: join(tempDir, 'drive', 'memory.sqlite'),
        duetRunner: new MockMemoryCli().runner,
      }),
    ).rejects.toThrow('path must be outside the drive root')
  })

  test('memory API passes the lock wait budget and reports lock timeouts clearly', async () => {
    const successfulMock = new MockMemoryCli()
    successfulMock.simulateLockContention(20)
    const successfulRuntime = await registeredRuntime({
      memoryLockWaitMs: 50,
      duetRunner: successfulMock.runner,
    })

    const added = await successfulRuntime.app.request('/v1/memory', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ content: 'lock eventually clears', source: 'api' }),
    })
    expect(added.status).toBe(200)
    expect(successfulMock.calls.at(-1)).toContain('0.05')

    const failingMock = new MockMemoryCli()
    failingMock.simulateLockContention(50)
    const failingRuntime = await registeredRuntime({
      memoryLockWaitMs: 10,
      duetRunner: failingMock.runner,
    })

    const failed = await failingRuntime.app.request('/v1/memory', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ content: 'lock does not clear', source: 'api' }),
    })
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({
      error: 'memory_lock_timeout',
      message: 'memory database locked after 10ms',
    })

    const failedRecall = await failingRuntime.app.request(
      '/v1/memory/search?q=still%20locked',
      authInit(),
    )
    expect(failedRecall.status).toBe(503)
    expect(await failedRecall.json()).toEqual({
      error: 'memory_lock_timeout',
      message: 'memory database locked after 10ms',
    })
  })

  test('memory add and recall advance the synchronized activity generation', async () => {
    const runtime = await registeredRuntime({ duetRunner: new MockMemoryCli().runner })

    await rm(join(tempDir, '.duet', 'activity'), { force: true })
    const add = await runtime.app.request('/v1/memory', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ content: 'memory activity marker', source: 'api' }),
    })
    expect(add.status).toBe(200)

    await rm(join(tempDir, '.duet', 'activity'), { force: true })
    const search = await runtime.app.request('/v1/memory/search?q=activity', authInit())
    expect(search.status).toBe(200)
  })

  test('default memory DB path follows the configured state directory', async () => {
    const mock = new MockMemoryCli()
    const stateDir = join(tempDir, 'custom-state')
    const runtime = await registeredRuntime({ stateDir, duetRunner: mock.runner })

    const add = await runtime.app.request('/v1/memory', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ content: 'custom state memory', source: 'api' }),
    })

    expect(add.status).toBe(200)
    expect(mock.calls.at(-1)).toContain(join(stateDir, 'memory.db'))
  })

  test('memory and RPC share the configured DB while train receives only its job store', async () => {
    const memoryDbPath = join(tempDir, '.duet', 'shared-memory.db')
    const memory = new MockMemoryCli()
    let trainInputKeys: string[] | undefined
    let trainStoreDir: string | undefined
    let runnerDbPath: string | undefined
    const runtime = await registeredRuntime({
      memoryDbPath,
      duetRunner: memory.runner,
      trainRunner: async input => {
        trainInputKeys = Object.keys(input)
        trainStoreDir = input.storeDir
        await writeFakeTrainOutput(input)
        return { record: null, stdout: '', stderr: '' }
      },
      agentRunnerFactory: args => {
        runnerDbPath = args.memoryDbPath
        return new MockAgentRunner()
      },
      agentRelayEvent: async () => undefined,
    })

    const added = await runtime.app.request('/v1/memory', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ content: 'shared path', source: 'api' }),
    })
    const trained = await runtime.app.request('/v1/train', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({ files: [{ filename: 'notes.md', content: 'hello' }] }),
    })
    const started = await runtime.app.request('/v1/agent/sessions/sess_shared_db/input', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify(
        runnerInputBody({
          sessionId: 'sess_shared_db',
          prompt: 'work',
          behavior: 'steer',
          tier: 'balanced',
        }),
      ),
    })

    expect(added.status).toBe(200)
    expect(trained.status).toBe(202)
    await waitFor(() => trainStoreDir !== undefined)
    expect(started.status).toBe(200)
    expect(memory.calls.at(-1)).toContain(memoryDbPath)
    expect(trainInputKeys).not.toContain('dbPath')
    expect(trainInputKeys).not.toContain('waitMs')
    expect(trainStoreDir).toMatch(/\/train\/jobs\/[^/]+\/store$/)
    expect(runnerDbPath).toBe(memoryDbPath)
  })

  test('rail-owned tunnel accepts require the projected token digest', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir })
    const echoServer = await startTcpEchoServer()
    let gatewayServer: ReturnType<typeof Bun.serve> | undefined
    try {
      gatewayServer = serveGateway(runtime)
      const token = 'duet_tt_projected'
      runtime.tunnelAccepts.replace([
        {
          acceptId: 'accept-1',
          targetPort: addressPort(echoServer),
          tokenDigest: await tunnelTokenDigest(token),
          expiresAt: Date.now() + 60_000,
        },
      ])

      const bad = await fetch(new URL('/v1/tunnel/accept/accept-1', gatewayServer.url), {
        headers: { upgrade: 'websocket', 'x-duet-tunnel-token': 'wrong-token' },
      })
      expect(bad.status).toBe(401)

      const echoed = await websocketRoundTrip(
        new URL('/v1/tunnel/accept/accept-1', gatewayServer.url).toString().replace('http:', 'ws:'),
        token,
      )
      expect(echoed).toBe('from-b')
    } finally {
      gatewayServer?.stop(true)
      await closeServer(echoServer)
    }
  })

  test('mirror tunnel minting registers a digest-only accept outside rail snapshot GC', async () => {
    const stateDir = join(tempDir, '.duet')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
    const runtime = createGatewayRuntime({ stateDir, now: () => 100 })

    const response = await runtime.app.request('/v1/tunnel/mirror-accept', {
      method: 'POST',
      headers: jsonAuthHeaders(),
      body: JSON.stringify({
        machineId: 'machine-a',
        acceptId: 'mirror-credential-a',
        tokenDigest: 'a'.repeat(64),
        expiresAt: 200,
      }),
    })

    expect(response.status).toBe(200)
    expect(runtime.tunnelAccepts.get('mirror-credential-a')).toMatchObject({
      targetHost: '127.0.0.1',
      targetPort: 22_000,
      tokenDigest: 'a'.repeat(64),
    })
    runtime.tunnelAccepts.replace([])
    expect(runtime.tunnelAccepts.get('mirror-credential-a')).toBeDefined()
  })
})

describe('gateway app supervisor', () => {
  test('reconciliation reports strip every app credential field', () => {
    const report = {
      appId: 'fixture-app',
      slug: 'credential-safe',
      command: 'bun app.ts',
      port: 4_000,
      anchorPath: 'apps/credential-safe',
      apiScopes: ['files:read' as const],
      status: 'reconciled' as const,
    }

    for (const credentialField of [
      { apiKey: 'must-not-echo' },
      { appCredentials: [{ appId: 'fixture-app', apiKey: 'must-not-echo' }] },
      { DUET_APP_API_KEY: 'must-not-echo' },
    ]) {
      expect(AppReconciliationReportSchema.parse({ ...report, ...credentialField })).toEqual(report)
    }
  })

  test('spawned app environment is the exact allowlist plus app credentials and API URL', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'env-inspector'), { recursive: true })
    const port = await freePort()
    const supervisor = new AppSupervisor({
      driveDir,
      startupGraceMs: 50,
      spawnEnvExtras: app => ({
        DUET_APP_API_KEY: `secret-for-${app.appId}`,
        DUET_API_URL: 'https://api.duet.test',
      }),
    })
    const originalProvisioningToken = process.env.DUET_PROVISIONING_TOKEN
    const originalSentinel = process.env.SENTINEL_GATEWAY_SECRET
    process.env.DUET_PROVISIONING_TOKEN = 'provisioning-secret'
    process.env.SENTINEL_GATEWAY_SECRET = 'sentinel-secret'
    try {
      await supervisor.reconcile([
        {
          slug: 'env-inspector',
          command: [
            'bun',
            '-e',
            JSON.stringify(
              "const shellOwned=new Set(['PWD','SHLVL','_']); const names=Object.keys(process.env).filter(name=>!shellOwned.has(name)).sort(); Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>Response.json(names)}); await new Promise(()=>{})",
            ),
          ].join(' '),
          port,
          anchorPath: 'apps/env-inspector',
          appId: 'fixture-app',
          apiScopes: [],
        },
      ])

      const response = await supervisor.handleProxy(
        new Request('http://gateway/public/app/', {
          headers: { [DUET_APP_SLUG_HEADER]: 'env-inspector' },
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([
        'DUET_API_URL',
        'DUET_APP_API_KEY',
        'HOME',
        'PATH',
        'PORT',
      ])
    } finally {
      supervisor.stop()
      restoreEnv('DUET_PROVISIONING_TOKEN', originalProvisioningToken)
      restoreEnv('SENTINEL_GATEWAY_SECRET', originalSentinel)
    }
  })

  test('spawn extras reach services but never install commands', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'spawn-extras')
    await mkdir(appDir, { recursive: true })
    const port = 0
    const originalProvisioningToken = process.env.DUET_PROVISIONING_TOKEN
    process.env.DUET_PROVISIONING_TOKEN = 'provisioning-secret'
    const supervisor = new AppSupervisor({
      driveDir,
      spawnEnvExtras: app => ({ DUET_APP_API_KEY: `secret-for-${app.slug}` }),
      startupBindTimeoutMs: 20,
      startupGraceMs: 20,
      respawnBaseDelayMs: 1_000,
      respawnMaxDelayMs: 1_000,
    })
    try {
      await expect(
        supervisor.reconcile([
          {
            slug: 'spawn-extras',
            installCommand: [
              'bun',
              '-e',
              JSON.stringify(
                "require('node:fs').writeFileSync('install-env.json',JSON.stringify({hasPort:process.env.PORT!==undefined,hasAppKey:process.env.DUET_APP_API_KEY!==undefined,hasProvisioningToken:process.env.DUET_PROVISIONING_TOKEN!==undefined}))",
              ),
            ].join(' '),
            command: [
              'bun',
              '-e',
              JSON.stringify(
                "require('node:fs').writeFileSync('service-env.json',JSON.stringify({hasPort:process.env.PORT!==undefined,hasAppKey:process.env.DUET_APP_API_KEY!==undefined,hasProvisioningToken:process.env.DUET_PROVISIONING_TOKEN!==undefined})); await Bun.sleep(1_000)",
              ),
            ].join(' '),
            port,
            anchorPath: 'apps/spawn-extras',
            appId: 'fixture-app',
            apiScopes: [],
          },
        ]),
      ).rejects.toThrow('did not become ready')

      expect(JSON.parse(await readFile(join(appDir, 'install-env.json'), 'utf8'))).toEqual({
        hasPort: true,
        hasAppKey: false,
        hasProvisioningToken: false,
      })
      expect(JSON.parse(await readFile(join(appDir, 'service-env.json'), 'utf8'))).toEqual({
        hasPort: true,
        hasAppKey: true,
        hasProvisioningToken: false,
      })
    } finally {
      supervisor.stop()
      restoreEnv('DUET_PROVISIONING_TOKEN', originalProvisioningToken)
    }
  })

  test('app service output and startup stderr buffers redact delivered keys', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'redacting-service'), { recursive: true })
    const apiKey = 'app-key-that-must-never-reach-output'
    registerRedactionSecret(apiKey)
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    const originalError = console.error
    console.warn = (...args: unknown[]) => void warnings.push(args)
    console.error = (...args: unknown[]) => void warnings.push(args)
    const supervisor = new AppSupervisor({
      driveDir,
      spawnEnvExtras: () => ({ DUET_APP_API_KEY: apiKey }),
      startupGraceMs: 100,
      respawnBaseDelayMs: 1_000,
      respawnMaxDelayMs: 1_000,
    })
    try {
      const result = supervisor.reconcile([
        {
          appId: 'redacting-service-id',
          slug: 'redacting-service',
          command: `bun -e ${JSON.stringify('console.error(process.env.DUET_APP_API_KEY); process.exit(1)')}`,
          port: 4_000,
          anchorPath: 'apps/redacting-service',
          apiScopes: ['files:read'],
        },
      ])
      await expect(result).rejects.toThrow('did not become ready')
      expect(warnings.flat().join(' ')).toContain(REDACTION_MASK)
      expect(warnings.flat().join(' ')).not.toContain(apiKey)
    } finally {
      supervisor.stop()
      console.warn = originalWarn
      console.error = originalError
    }
  })

  test('a name-only desired change reports the new name without restarting the process', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'renamable'), { recursive: true })
    const port = await freePort()
    const app = {
      slug: 'renamable',
      name: 'Before Rename',
      command: [
        'bun',
        '-e',
        JSON.stringify(
          "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response(String(process.pid))}); await new Promise(()=>{})",
        ),
      ].join(' '),
      port,
      anchorPath: 'apps/renamable',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 25 })
    const processId = async () => {
      const response = await supervisor.handleProxy(
        new Request('http://gateway/public/app/', {
          headers: { [DUET_APP_SLUG_HEADER]: app.slug },
        }),
      )
      expect(response.status).toBe(200)
      return await response.text()
    }
    try {
      await supervisor.reconcile([app])
      const beforeProcessId = await processId()
      supervisor.acknowledge(supervisor.reports())

      const renamed = { ...app, name: 'After Rename' }
      await supervisor.reconcile([renamed])

      expect(await processId()).toBe(beforeProcessId)
      expect(supervisor.reports()).toEqual([{ ...renamed, status: 'reconciled' }])
      supervisor.acknowledge([{ ...app, status: 'reconciled' }])
      expect(supervisor.reports()).toEqual([{ ...renamed, status: 'reconciled' }])
    } finally {
      supervisor.stop()
    }
  })

  test('visibility-only reconcile updates desired configs immediately without restarting', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'visibility'), { recursive: true })
    const port = await freePort()
    const app: GatewayAppConfig = {
      slug: 'visibility',
      command: [
        'bun',
        '-e',
        JSON.stringify(
          "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response(String(process.pid))}); await new Promise(()=>{})",
        ),
      ].join(' '),
      port,
      anchorPath: 'apps/visibility',
      appId: 'fixture-app',
      apiScopes: [],
      visibility: 'folder',
    }
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 25 })
    const processId = async () => {
      const response = await supervisor.handleProxy(
        new Request('http://gateway/public/app/', {
          headers: { [DUET_APP_SLUG_HEADER]: app.slug },
        }),
      )
      expect(response.status).toBe(200)
      return await response.text()
    }
    try {
      await supervisor.reconcile([app])
      const beforeProcessId = await processId()
      const publiclyVisible = {
        ...app,
        visibility: 'public' as const,
        canonicalUrl: 'https://visibility--acme.edge.duet.so/',
      }

      const reconcile = supervisor.reconcile([publiclyVisible])
      expect(supervisor.desiredConfigs()).toEqual([publiclyVisible])
      const callerSnapshot = supervisor.desiredConfigs() as GatewayAppConfig[]
      callerSnapshot[0]!.canonicalUrl = 'https://mutated.invalid/'
      expect(supervisor.desiredConfigs()).toEqual([publiclyVisible])
      await reconcile

      expect(await processId()).toBe(beforeProcessId)
      expect(supervisor.reports()).toEqual([{ ...publiclyVisible, status: 'reconciled' }])
    } finally {
      supervisor.stop()
    }
  })

  test('an acknowledged reconciliation outcome stays drained across unchanged snapshots', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'stable'), { recursive: true })
    const port = await freePort()
    const app = {
      slug: 'stable',
      command: stickyFileServerCommand(port),
      port,
      anchorPath: 'apps/stable',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 50 })
    try {
      await supervisor.reconcile([app])
      const reports = supervisor.reports()
      expect(reports).toEqual([{ ...app, status: 'reconciled' }])

      supervisor.acknowledge(reports)
      expect(supervisor.reports()).toEqual([])

      await supervisor.reconcile([app])
      expect(supervisor.reports()).toEqual([])

      const changed = { ...app, command: `exec ${app.command}` }
      await supervisor.reconcile([changed])
      expect(supervisor.reports()).toEqual([{ ...changed, status: 'reconciled' }])
    } finally {
      supervisor.stop()
    }
  })

  test('an unchanged unhealthy app does not fail reconciliation for a newly healthy app', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'broken'), { recursive: true })
    await mkdir(join(driveDir, 'apps', 'healthy'), { recursive: true })
    const broken = {
      slug: 'broken',
      command: `bun -e ${JSON.stringify('process.exit(1)')}`,
      port: await freePort(),
      anchorPath: 'apps/broken',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 25 })
    try {
      await expect(supervisor.reconcile([broken])).rejects.toThrow('did not become ready')
      supervisor.acknowledge(supervisor.reports())
      await expect(
        supervisor.reconcile([broken], { requiredReadySlugs: ['broken'] }),
      ).rejects.toThrow('did not become ready')

      const healthyPort = await freePort()
      const healthy = {
        slug: 'healthy',
        command: stickyFileServerCommand(healthyPort),
        port: healthyPort,
        anchorPath: 'apps/healthy',
        appId: 'fixture-app',
        apiScopes: [],
      }
      await expect(supervisor.reconcile([broken, healthy])).resolves.toBeUndefined()
      expect(
        Object.fromEntries(supervisor.reports().map(report => [report.slug, report.status])),
      ).toEqual({
        healthy: 'reconciled',
      })
    } finally {
      supervisor.stop()
    }
  })

  test('a required app reconciles while an unrelated install is still in flight', async () => {
    const driveDir = join(tempDir, 'drive')
    const slowDir = join(driveDir, 'apps', 'slow-install')
    const healthyDir = join(driveDir, 'apps', 'healthy-now')
    await mkdir(slowDir, { recursive: true })
    await mkdir(healthyDir, { recursive: true })
    await writeFile(join(healthyDir, 'message.txt'), 'healthy-now')
    const slowPort = await freePort()
    const slow = {
      slug: 'slow-install',
      installCommand: [
        'bun',
        '-e',
        JSON.stringify(
          "const fs = require('node:fs'); fs.writeFileSync('install-started','yes'); while (!fs.existsSync('install-release')) await Bun.sleep(10); fs.writeFileSync('install-finished','yes')",
        ),
      ].join(' '),
      command: stickyFileServerCommand(slowPort),
      port: slowPort,
      anchorPath: 'apps/slow-install',
      appId: 'fixture-app',
      apiScopes: [],
    }
    // The release barrier owns this install lifetime; a short fixture timeout
    // would race unrelated app startup under load. Keep the production backstop.
    const supervisor = new AppSupervisor({
      driveDir,
      startupGraceMs: 25,
    })
    const background = supervisor.reconcile([slow]).then(
      () => ({ ok: true as const }),
      error => ({ error }),
    )
    try {
      await waitForStarts(join(slowDir, 'install-started'), 1)
      const healthyPort = await freePort()
      const healthy = {
        slug: 'healthy-now',
        command: stickyFileServerCommand(healthyPort),
        port: healthyPort,
        anchorPath: 'apps/healthy-now',
        appId: 'fixture-app',
        apiScopes: [],
      }

      await supervisor.reconcile([slow, healthy], { requiredReadySlugs: ['healthy-now'] })

      const response = await supervisor.handleProxy(
        new Request('http://gateway/public/app/message.txt', {
          headers: { [DUET_APP_SLUG_HEADER]: 'healthy-now' },
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('healthy-now')
      await expect(readFile(join(slowDir, 'install-finished'), 'utf8')).rejects.toThrow()
    } finally {
      try {
        await writeFile(join(slowDir, 'install-release'), 'release')
        expect(await background).toEqual({ ok: true })
        expect(await readFile(join(slowDir, 'install-finished'), 'utf8')).toBe('yes')
      } finally {
        supervisor.stop()
      }
    }
  })

  test('a required caller shares an in-flight reconcile and receives its failure', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'shared-failure')
    await mkdir(appDir, { recursive: true })
    const port = await freePort()
    const app = {
      slug: 'shared-failure',
      installCommand: [
        'bun',
        '-e',
        JSON.stringify(
          "require('node:fs').writeFileSync('install-started','yes'); await Bun.sleep(80); process.exit(7)",
        ),
      ].join(' '),
      command: stickyFileServerCommand(port),
      port,
      anchorPath: 'apps/shared-failure',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const supervisor = new AppSupervisor({
      driveDir,
      installTimeoutMs: 1_000,
      startupGraceMs: 25,
    })
    const background = supervisor.reconcile([app]).catch(() => undefined)
    try {
      await waitForStarts(join(appDir, 'install-started'), 1)
      await expect(
        supervisor.reconcile([app], { requiredReadySlugs: ['shared-failure'] }),
      ).rejects.toThrow('failed (code=7')
    } finally {
      supervisor.stop()
      await background
    }
  })

  test('an unrelated desired-state change does not supersede a required app', async () => {
    const driveDir = join(tempDir, 'drive')
    const requiredDir = join(driveDir, 'apps', 'required')
    await mkdir(requiredDir, { recursive: true })
    await mkdir(join(driveDir, 'apps', 'unrelated'), { recursive: true })
    await writeFile(join(requiredDir, 'message.txt'), 'required-ready')
    const requiredPort = await freePort()
    const required = {
      slug: 'required',
      installCommand: [
        'bun',
        '-e',
        JSON.stringify(
          "require('node:fs').writeFileSync('install-started','yes'); await Bun.sleep(80)",
        ),
      ].join(' '),
      command: stickyFileServerCommand(requiredPort),
      port: requiredPort,
      anchorPath: 'apps/required',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const unrelatedPort = await freePort()
    const unrelated = {
      slug: 'unrelated',
      command: stickyFileServerCommand(unrelatedPort),
      port: unrelatedPort,
      anchorPath: 'apps/unrelated',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 25 })
    const direct = supervisor.reconcile([required], { requiredReadySlugs: ['required'] })
    try {
      await waitForStarts(join(requiredDir, 'install-started'), 1)
      const background = supervisor.reconcile([required, unrelated]).catch(() => undefined)

      await expect(direct).resolves.toBeUndefined()
      const response = await supervisor.handleProxy(
        new Request('http://gateway/public/app/message.txt', {
          headers: { [DUET_APP_SLUG_HEADER]: 'required' },
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('required-ready')
      await background
    } finally {
      supervisor.stop()
    }
  })

  test('install command completes in the app cwd with PORT before the serve command spawns', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'install-first')
    await mkdir(appDir, { recursive: true })
    const port = await freePort()
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 50 })
    try {
      await supervisor.reconcile([
        {
          slug: 'install-first',
          installCommand: [
            'bun',
            '-e',
            JSON.stringify(
              "require('node:fs').appendFileSync('events.txt','install-start:'+process.cwd()+':'+process.env.PORT+'\\n'); await Bun.sleep(50); require('node:fs').appendFileSync('events.txt','install-finish\\n')",
            ),
          ].join(' '),
          command: [
            'bun',
            '-e',
            JSON.stringify(
              "require('node:fs').appendFileSync('events.txt','serve\\n'); Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('ok')}); await new Promise(()=>{})",
            ),
          ].join(' '),
          port,
          anchorPath: 'apps/install-first',
          appId: 'fixture-app',
          apiScopes: [],
        },
      ])

      expect((await readFile(join(appDir, 'events.txt'), 'utf8')).split('\n')).toEqual([
        `install-start:${await realpath(appDir)}:${port}`,
        'install-finish',
        'serve',
        '',
      ])
    } finally {
      supervisor.stop()
    }
  })

  // A crash-looping app (port already taken, bad command) is respawned on a
  // doubling delay. The vm-sync poll reconciles far more often than that delay,
  // and a reconcile pass must not be able to short-circuit it: if every pass
  // forgets the accumulated backoff and respawns immediately, the retry rate
  // collapses to the poll rate and the loop never yields. That is what took a
  // production workspace down — 90k respawns in one hour.
  test('repeated reconciles do not reset the respawn backoff of a crash-looping app', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'crash-loop')
    await mkdir(appDir, { recursive: true })
    const supervisor = new AppSupervisor({
      driveDir,
      startupGraceMs: 5,
      respawnBaseDelayMs: 200,
      respawnMaxDelayMs: 2_000,
    })
    const app = {
      slug: 'crash-loop',
      command: [
        'bun',
        '-e',
        JSON.stringify("require('node:fs').appendFileSync('starts.txt','x'); process.exit(1)"),
      ].join(' '),
      port: await freePort(),
      anchorPath: 'apps/crash-loop',
      appId: 'fixture-app',
      apiScopes: [],
    }
    try {
      // Ten reconciles inside a single 200ms backoff window: the second and
      // later passes must find the pending respawn and leave it alone.
      for (let pass = 0; pass < 10; pass += 1) {
        await supervisor.reconcile([app]).catch(() => undefined)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      const starts = await readFile(join(appDir, 'starts.txt'), 'utf8')
      // Backoff schedule over this window admits the initial spawn plus the
      // 200ms retry; one reconcile-driven start per pass would be ten.
      expect(starts.length).toBeLessThanOrEqual(4)
    } finally {
      supervisor.stop()
    }
  })

  test('install failure rejects reconciliation, skips serve, and retries with backoff', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'install-fails')
    await mkdir(appDir, { recursive: true })
    const routes = createAppsRoutes({
      driveDir,
      startupGraceMs: 5,
      respawnBaseDelayMs: 15,
      respawnMaxDelayMs: 30,
    })
    try {
      const response = await routes.reconcile.request('/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apps: [
            {
              slug: 'install-fails',
              installCommand:
                "bun -e \"require('node:fs').appendFileSync('installs.txt','x'); console.error('dependency install failed'); process.exit(7)\"",
              command:
                "bun -e \"require('node:fs').writeFileSync('served.txt','yes'); Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('ok')}); await new Promise(()=>{})\"",
              port: await freePort(),
              anchorPath: 'apps/install-fails',
              appId: 'fixture-app',
              apiScopes: [],
            },
          ],
        }),
      })

      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('dependency install failed'),
      })
      expect((await waitForStarts(join(appDir, 'installs.txt'), 2)).length).toBeGreaterThanOrEqual(
        2,
      )
      await expect(readFile(join(appDir, 'served.txt'), 'utf8')).rejects.toThrow()
    } finally {
      routes.supervisor.stop()
    }
  })

  test('changing app config re-runs the install command before the replacement serve process', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'install-change')
    await mkdir(appDir, { recursive: true })
    const port = await freePort()
    const supervisor = new AppSupervisor({
      driveDir,
      startupGraceMs: 10,
      respawnBaseDelayMs: 15,
      respawnMaxDelayMs: 30,
    })
    const app = {
      slug: 'install-change',
      command: stickyFileServerCommand(port),
      port,
      anchorPath: 'apps/install-change',
      appId: 'fixture-app',
      apiScopes: [],
    }
    try {
      await supervisor.reconcile([
        {
          ...app,
          installCommand: "bun -e \"require('node:fs').appendFileSync('installs.txt','a')\"",
        },
      ])
      await supervisor.reconcile([
        {
          ...app,
          installCommand: "bun -e \"require('node:fs').appendFileSync('installs.txt','b')\"",
        },
      ])

      await waitForStarts(join(appDir, 'installs.txt'), 2)
      expect(await readFile(join(appDir, 'installs.txt'), 'utf8')).toBe('ab')
    } finally {
      supervisor.stop()
    }
  })

  test('changing only content generation reinstalls that app without touching unrelated apps', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'generated'), { recursive: true })
    await mkdir(join(driveDir, 'apps', 'unrelated'), { recursive: true })
    const generatedPort = await freePort()
    const unrelatedPort = await freePort()
    const generated = {
      slug: 'generated',
      command: stickyFileServerCommand(generatedPort),
      installCommand: "bun -e \"require('node:fs').appendFileSync('installs.txt','g')\"",
      port: generatedPort,
      anchorPath: 'apps/generated',
      appId: 'fixture-app',
      apiScopes: [],
      contentGeneration: 'etag-1',
    }
    const unrelated = {
      slug: 'unrelated',
      command: stickyFileServerCommand(unrelatedPort),
      installCommand: "bun -e \"require('node:fs').appendFileSync('installs.txt','u')\"",
      port: unrelatedPort,
      anchorPath: 'apps/unrelated',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 10 })
    try {
      await supervisor.reconcile([generated, unrelated])
      await supervisor.reconcile([{ ...generated, contentGeneration: 'etag-2' }, unrelated])

      expect(await readFile(join(driveDir, 'apps', 'generated', 'installs.txt'), 'utf8')).toBe('gg')
      expect(await readFile(join(driveDir, 'apps', 'unrelated', 'installs.txt'), 'utf8')).toBe('u')
    } finally {
      supervisor.stop()
    }
  })

  test('an install failure on config change rejects reconciliation before replacement serve', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'install-change-fails'), { recursive: true })
    const port = await freePort()
    const routes = createAppsRoutes({ driveDir, startupGraceMs: 20 })
    const app = {
      slug: 'install-change-fails',
      command: stickyFileServerCommand(port),
      port,
      anchorPath: 'apps/install-change-fails',
      appId: 'fixture-app',
      apiScopes: [],
    }
    try {
      await routes.supervisor.reconcile([
        {
          ...app,
          installCommand: "bun -e \"require('node:fs').writeFileSync('installed.txt','v1')\"",
        },
      ])
      const response = await routes.reconcile.request('/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apps: [
            {
              ...app,
              installCommand: 'bun -e "console.error(\'update install failed\'); process.exit(9)"',
            },
          ],
        }),
      })

      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('update install failed'),
      })
      const stillServing = await routes.supervisor.handleProxy(
        new Request('http://gateway/public/app/installed.txt', {
          headers: { [DUET_APP_SLUG_HEADER]: 'install-change-fails' },
        }),
      )
      expect(stillServing.status).toBe(200)
      expect(await stillServing.text()).toBe('v1')
    } finally {
      routes.supervisor.stop()
    }
  })

  test('a replacement startup failure restores the previous live config before returning', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'startup-rollback'), { recursive: true })
    const port = await freePort()
    const routes = createAppsRoutes({ driveDir, startupGraceMs: 20 })
    const app = {
      slug: 'startup-rollback',
      command: stickyFileServerCommand(port),
      port,
      anchorPath: 'apps/startup-rollback',
      appId: 'fixture-app',
      apiScopes: [],
    }
    try {
      await routes.supervisor.reconcile([
        {
          ...app,
          installCommand: "bun -e \"require('node:fs').writeFileSync('installed.txt','v1')\"",
        },
      ])
      const response = await routes.reconcile.request('/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apps: [
            {
              ...app,
              installCommand: "bun -e \"require('node:fs').writeFileSync('installed.txt','v2')\"",
              command: `bun -e ${JSON.stringify('process.exit(1)')}`,
            },
          ],
        }),
      })

      expect(response.status).toBe(502)
      const stillServing = await routes.supervisor.handleProxy(
        new Request('http://gateway/public/app/installed.txt', {
          headers: { [DUET_APP_SLUG_HEADER]: 'startup-rollback' },
        }),
      )
      expect(stillServing.status).toBe(200)
      expect(await stillServing.text()).toBe('v1')
    } finally {
      routes.supervisor.stop()
    }
  })

  test('a hanging install times out without spawning the app', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'install-timeout')
    await mkdir(appDir, { recursive: true })
    const routes = createAppsRoutes({
      driveDir,
      installTimeoutMs: 30,
      respawnBaseDelayMs: 1_000,
      respawnMaxDelayMs: 1_000,
    })
    try {
      const response = await routes.reconcile.request('/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          apps: [
            {
              slug: 'install-timeout',
              installCommand: 'sleep 60',
              command: 'touch served.txt; sleep 60',
              port: await freePort(),
              anchorPath: 'apps/install-timeout',
              appId: 'fixture-app',
              apiScopes: [],
            },
          ],
        }),
      })

      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('timed out') })
      await expect(readFile(join(appDir, 'served.txt'), 'utf8')).rejects.toThrow()
    } finally {
      routes.supervisor.stop()
    }
  })

  test('stopping the supervisor cancels an in-flight install promptly', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'install-stopped')
    await mkdir(appDir, { recursive: true })
    const supervisor = new AppSupervisor({ driveDir, installTimeoutMs: 200 })
    const reconcile = supervisor.reconcile([
      {
        slug: 'install-stopped',
        installCommand:
          "bun -e \"require('node:fs').writeFileSync('started.txt','x'); await Bun.sleep(60_000)\"",
        command: 'sleep 60',
        port: await freePort(),
        anchorPath: 'apps/install-stopped',
        appId: 'fixture-app',
        apiScopes: [],
      },
    ])
    await waitForStarts(join(appDir, 'started.txt'), 1)

    supervisor.stop()

    expect(
      await Promise.race([
        reconcile.then(
          () => true,
          () => true,
        ),
        Bun.sleep(100).then(() => false),
      ]),
    ).toBe(true)
  })

  test('an app without installCommand spawns once with the configured PORT as before', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'port-env')
    await mkdir(appDir, { recursive: true })
    const port = await freePort()
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 50 })
    try {
      await supervisor.reconcile([
        {
          slug: 'port-env',
          command: [
            'bun',
            '-e',
            JSON.stringify(
              "require('node:fs').writeFileSync('port.txt', process.env.PORT ?? 'missing'); Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('ok')}); await new Promise(()=>{})",
            ),
          ].join(' '),
          port,
          anchorPath: 'apps/port-env',
          appId: 'fixture-app',
          apiScopes: [],
        },
      ])

      expect(await readFile(join(appDir, 'port.txt'), 'utf8')).toBe(String(port))
    } finally {
      supervisor.stop()
    }
  })

  test('legacy same-port apps never cross-serve another app process', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'first'), { recursive: true })
    await mkdir(join(driveDir, 'apps', 'second'), { recursive: true })
    await writeFile(join(driveDir, 'apps', 'first', 'message.txt'), 'first')
    await writeFile(join(driveDir, 'apps', 'second', 'message.txt'), 'second')
    const port = await freePort()
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 50 })
    try {
      await expect(
        supervisor.reconcile([
          {
            slug: 'first',
            command: stickyFileServerCommand(port),
            port,
            anchorPath: 'apps/first',
            appId: 'fixture-app',
            apiScopes: [],
          },
          {
            slug: 'second',
            command: stickyFileServerCommand(port),
            port,
            anchorPath: 'apps/second',
            appId: 'fixture-app',
            apiScopes: [],
          },
        ]),
      ).rejects.toThrow('did not become ready')

      const responses = await Promise.all(
        ['first', 'second'].map(slug =>
          supervisor.handleProxy(
            new Request('http://gateway/public/app/message.txt', {
              headers: { [DUET_APP_SLUG_HEADER]: slug },
            }),
          ),
        ),
      )
      const served = responses.filter(response => response.status === 200)
      const unavailable = responses.filter(response => response.status === 502)
      expect(served).toHaveLength(1)
      expect(unavailable).toHaveLength(1)
      expect(await served[0]!.text()).toBe(served[0] === responses[0] ? 'first' : 'second')
      expect(await unavailable[0]!.json()).toEqual({ error: 'app_unavailable' })
      expect(
        supervisor
          .reports()
          .map(report => report.status)
          .sort(),
      ).toEqual(['reconcile_failed', 'reconciled'])
    } finally {
      supervisor.stop()
    }
  })

  test('a slow-starting app becomes proxyable after it binds its claimed port', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'slow'), { recursive: true })
    const port = await freePort()
    const supervisor = new AppSupervisor({
      driveDir,
      startupBindTimeoutMs: 1_000,
      startupGraceMs: 5,
    })
    try {
      await supervisor.reconcile([
        {
          slug: 'slow',
          command: [
            'bun',
            '-e',
            JSON.stringify(
              "await Bun.sleep(80); Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('slow-ready')}); await new Promise(()=>{})",
            ),
          ].join(' '),
          port,
          anchorPath: 'apps/slow',
          appId: 'fixture-app',
          apiScopes: [],
        },
      ])

      const response = await supervisor.handleProxy(
        new Request('http://gateway/public/app/', {
          headers: { [DUET_APP_SLUG_HEADER]: 'slow' },
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('slow-ready')
    } finally {
      supervisor.stop()
    }
  })

  test('an app is not ready when another managed process binds its claimed port', async () => {
    const driveDir = join(tempDir, 'drive')
    await mkdir(join(driveDir, 'apps', 'claimed'), { recursive: true })
    await mkdir(join(driveDir, 'apps', 'other'), { recursive: true })
    const claimedPort = await freePort()
    const otherPort = await freePort()
    const supervisor = new AppSupervisor({
      driveDir,
      startupBindTimeoutMs: 1_000,
      startupGraceMs: 5,
    })
    try {
      await expect(
        supervisor.reconcile([
          {
            slug: 'claimed',
            command: [
              'bun',
              '-e',
              JSON.stringify(
                "await Bun.sleep(80); try { Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('from-claimed')}) } catch {} await new Promise(()=>{})",
              ),
            ].join(' '),
            port: claimedPort,
            anchorPath: 'apps/claimed',
            appId: 'fixture-app',
            apiScopes: [],
          },
          {
            slug: 'other',
            command: [
              'bun',
              '-e',
              JSON.stringify(
                `await Bun.sleep(30); Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response('other')}); Bun.serve({hostname:'127.0.0.1',port:${claimedPort},fetch:()=>new Response('from-other')}); await new Promise(()=>{})`,
              ),
            ].join(' '),
            port: otherPort,
            anchorPath: 'apps/other',
            appId: 'fixture-app',
            apiScopes: [],
          },
        ]),
      ).rejects.toThrow('did not become ready')

      const response = await supervisor.handleProxy(
        new Request('http://gateway/public/app/', {
          headers: { [DUET_APP_SLUG_HEADER]: 'claimed' },
        }),
      )
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'app_unavailable' })
    } finally {
      supervisor.stop()
    }
  })

  test('reconcile starts, proxies, live-serves edited files, and stops removed apps', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'site')
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, 'message.txt'), 'first')
    const port = await freePort()
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 50 })
    try {
      await supervisor.reconcile([
        {
          slug: 'site',
          command: fileServerCommand(port),
          port,
          anchorPath: 'apps/site',
          appId: 'fixture-app',
          apiScopes: [],
        },
      ])

      const first = await supervisor.handleProxy(
        new Request('http://gateway/public/app/message.txt', {
          headers: { [DUET_APP_SLUG_HEADER]: 'site' },
        }),
      )
      expect(first.status).toBe(200)
      expect(await first.text()).toBe('first')

      await writeFile(join(appDir, 'message.txt'), 'second')
      const second = await supervisor.handleProxy(
        new Request('http://gateway/public/app/message.txt', {
          headers: { [DUET_APP_SLUG_HEADER]: 'site' },
        }),
      )
      expect(second.status).toBe(200)
      expect(await second.text()).toBe('second')

      await supervisor.reconcile([])
      const stopped = await supervisor.handleProxy(
        new Request('http://gateway/public/app/message.txt', {
          headers: { [DUET_APP_SLUG_HEADER]: 'site' },
        }),
      )
      expect(stopped.status).toBe(404)
    } finally {
      supervisor.stop()
    }
  })

  test('unknown slugs and .env paths are never proxied', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'site')
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, '.env'), 'SECRET=1')
    const port = await freePort()
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 50 })
    try {
      await supervisor.reconcile([
        {
          appId: 'fixture-app',
          slug: 'site',
          command: fileServerCommand(port),
          port,
          anchorPath: 'apps/site',
          apiScopes: [],
        },
      ])

      const unknown = await supervisor.handleProxy(
        new Request('http://gateway/public/app/.env', {
          headers: { [DUET_APP_SLUG_HEADER]: 'missing' },
        }),
      )
      expect(unknown.status).toBe(404)

      const env = await supervisor.handleProxy(
        new Request('http://gateway/public/app/.env', {
          headers: { [DUET_APP_SLUG_HEADER]: 'site' },
        }),
      )
      expect(env.status).toBe(404)
      expect(await env.json()).toEqual({ error: 'not_found' })

      const encodedEnv = await supervisor.handleProxy(
        new Request('http://gateway/public/app/%2eenv', {
          headers: { [DUET_APP_SLUG_HEADER]: 'site' },
        }),
      )
      expect(encodedEnv.status).toBe(404)
      expect(await encodedEnv.json()).toEqual({ error: 'not_found' })
    } finally {
      supervisor.stop()
    }
  })

  test('reconcile refuses symlink app anchors before spawning commands', async () => {
    const driveDir = join(tempDir, 'drive')
    const outsideDir = join(tempDir, 'outside-app')
    await mkdir(join(driveDir, 'apps'), { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await symlink(outsideDir, join(driveDir, 'apps', 'site'))
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 50 })
    try {
      await expect(
        supervisor.reconcile([
          {
            slug: 'site',
            command: 'touch spawned; sleep 1',
            port: await freePort(),
            anchorPath: 'apps/site',
            appId: 'fixture-app',
            apiScopes: [],
          },
        ]),
      ).rejects.toThrow('did not become ready')
      await new Promise(resolve => setTimeout(resolve, 100))
      await expect(readFile(join(outsideDir, 'spawned'), 'utf8')).rejects.toThrow()
    } finally {
      supervisor.stop()
    }
  })

  test('replacing a shell-wrapped app releases its child server and reports the new runtime ready', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'wrapped')
    await mkdir(appDir, { recursive: true })
    await writeFile(
      join(appDir, 'server.ts'),
      `
      await Bun.write(process.argv[2] + '.pid', String(process.pid));
      Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT),
        fetch: () => new Response(process.argv[2]) });
      await new Promise(() => {});
    `,
    )
    const app = {
      slug: 'wrapped',
      command: 'bun server.ts old & wait',
      port: await freePort(),
      anchorPath: 'apps/wrapped',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const supervisor = new AppSupervisor({ driveDir, startupGraceMs: 50 })
    try {
      await supervisor.reconcile([app])
      supervisor.acknowledge(supervisor.reports())
      const replacement = { ...app, command: 'bun server.ts new & wait' }
      await supervisor.reconcile([replacement])
      const response = await supervisor.handleProxy(
        new Request('http://gateway/public/app/', {
          headers: { [DUET_APP_SLUG_HEADER]: app.slug },
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('new')
      expect(supervisor.reports()).toEqual([{ ...replacement, status: 'reconciled' }])
    } finally {
      supervisor.stop()
      // The unfixed supervisor leaves the shell's child alive. Always reap the fixture.
      for (const name of ['old', 'new']) {
        const pid = Number(await readFile(join(appDir, name + '.pid'), 'utf8').catch(() => ''))
        if (pid > 0) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
      }
    }
  })

  test('a crashed wrapper heals without a config edit even when its child ignores SIGTERM', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'wrapper-crash')
    await mkdir(appDir, { recursive: true })
    await writeFile(
      join(appDir, 'server.ts'),
      String.raw`
      require('node:fs').appendFileSync('pids', process.pid + '\n');
      process.on('SIGTERM', () => {});
      Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT),
        fetch: () => Response.json({ pid: process.pid, parent: process.ppid }) });
      await new Promise(() => {});
    `,
    )
    const app = {
      slug: 'wrapper-crash',
      command: 'bun server.ts & wait',
      port: await freePort(),
      anchorPath: 'apps/wrapper-crash',
      appId: 'fixture-app',
      apiScopes: [],
    }
    const supervisor = new AppSupervisor({
      driveDir,
      startupGraceMs: 25,
      respawnBaseDelayMs: 50,
      respawnMaxDelayMs: 100,
    })
    const readServer = async () => {
      const response = await fetch(`http://127.0.0.1:${app.port}/`, {
        signal: AbortSignal.timeout(500),
      })
      return (await response.json()) as { pid: number; parent: number }
    }
    try {
      await supervisor.reconcile([app])
      const before = await readServer()
      supervisor.acknowledge(supervisor.reports())
      process.kill(before.parent, 'SIGKILL')
      let healed = false
      for (const deadline = Date.now() + 3_000; Date.now() < deadline; ) {
        await Bun.sleep(50)
        // The production sync repeats the same desired config; no manual restart.
        await supervisor.reconcile([app])
        const current = await readServer().catch(() => undefined)
        if (
          current &&
          current.pid !== before.pid &&
          supervisor.reports().some(report => report.status === 'reconciled')
        ) {
          healed = true
          break
        }
      }
      expect(healed).toBe(true)
      expect(supervisor.reports()).toEqual([{ ...app, status: 'reconciled' }])
      const response = await supervisor.handleProxy(
        new Request('http://gateway/public/app/', {
          headers: { [DUET_APP_SLUG_HEADER]: app.slug },
        }),
      )
      expect(response.status).toBe(200)
      expect((await response.json()).pid).not.toBe(before.pid)
    } finally {
      supervisor.stop()
      const pids = await readFile(join(appDir, 'pids'), 'utf8').catch(() => '')
      for (const pid of pids.trim().split('\n').map(Number)) {
        if (pid > 0) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
        }
      }
    }
  }, 10_000)

  test('crashed app processes respawn with backoff while still desired', async () => {
    const driveDir = join(tempDir, 'drive')
    const appDir = join(driveDir, 'apps', 'crashy')
    await mkdir(appDir, { recursive: true })
    const port = await freePort()
    const supervisor = new AppSupervisor({
      driveDir,
      startupGraceMs: 5,
      respawnBaseDelayMs: 15,
      respawnMaxDelayMs: 30,
    })
    try {
      await expect(
        supervisor.reconcile([
          {
            slug: 'crashy',
            command: `bun -e "require('node:fs').appendFileSync('starts.txt','x')"`,
            port,
            anchorPath: 'apps/crashy',
            appId: 'fixture-app',
            apiScopes: [],
          },
        ]),
      ).rejects.toThrow('did not become ready')
      const starts = await waitForStarts(join(appDir, 'starts.txt'), 2)
      expect(starts.length).toBeGreaterThanOrEqual(2)
    } finally {
      supervisor.stop()
    }
  })
})

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('port allocation failed')))
        return
      }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function fileServerCommand(port: number): string {
  return [
    'bun',
    '-e',
    JSON.stringify(
      "Bun.serve({hostname:'127.0.0.1',port:" +
        port +
        ",fetch:async req=>{const path=new URL(req.url).pathname.slice(1)||'message.txt'; return new Response(await Bun.file(path).text())}}); await new Promise(()=>{})",
    ),
  ].join(' ')
}

function stickyFileServerCommand(port: number): string {
  return [
    'bun',
    '-e',
    JSON.stringify(
      "try { Bun.serve({hostname:'127.0.0.1',port:" +
        port +
        ",fetch:async req=>{const path=new URL(req.url).pathname.slice(1)||'message.txt'; return new Response(await Bun.file(path).text())}}) } catch {} await new Promise(()=>{})",
    ),
  ].join(' ')
}

async function waitForStarts(path: string, minimum: number): Promise<string> {
  const deadline = Date.now() + 1_000
  let starts = ''
  for (;;) {
    try {
      starts = await readFile(path, 'utf8')
      if (starts.length >= minimum) return starts
    } catch {
      // The crash loop may not have written the first marker yet.
    }
    if (Date.now() >= deadline) return starts
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * A VM that has registered and synced HAS model credentials. Spawning requires
 * them now — a keyless spawn is queued rather than started — so any fixture that
 * expects a runner to start has to be in that state. The not-yet-synced window
 * has its own test and deliberately skips this.
 */
async function seedModelCredentials(stateDir: string): Promise<void> {
  await writeFile(
    modelCredentialsPath(stateDir),
    JSON.stringify({
      apiKey: 'duet_sk_1111111111111111111111111111111111111111111111111111111111111111',
      gatewayBaseUrl: 'https://gateway.test',
      expiresAt: Date.now() + 60 * 60 * 1000,
    }),
    { mode: 0o600 },
  )
}

async function registeredRuntime(
  env: Parameters<typeof createGatewayRuntime>[0] = {},
): Promise<ReturnType<typeof createGatewayRuntime>> {
  const stateDir = join(tempDir, '.duet')
  const driveDir = join(tempDir, 'drive')
  const effectiveStateDir = env.stateDir ?? stateDir
  await mkdir(effectiveStateDir, { recursive: true })
  await mkdir(driveDir, { recursive: true })
  await writeFile(join(effectiveStateDir, 'vm-token'), 'vm-token\n', { mode: 0o600 })
  // A registered VM that has synced HAS model credentials, and spawning now
  // requires them — a keyless spawn is queued instead. Seeding here keeps these
  // fixtures on the normal path; the not-yet-synced window has its own test,
  // which builds a runtime that never syncs at all.
  await writeFile(
    modelCredentialsPath(effectiveStateDir),
    JSON.stringify({
      apiKey: 'duet_sk_1111111111111111111111111111111111111111111111111111111111111111',
      gatewayBaseUrl: 'https://gateway.test',
      expiresAt: Date.now() + 60 * 60 * 1000,
    }),
    { mode: 0o600 },
  )
  return createGatewayRuntime({
    ...env,
    stateDir: effectiveStateDir,
    driveDir: env.driveDir ?? driveDir,
  })
}

/**
 * A provider status command that really costs a process, so a regression that
 * reintroduces per-poll probing shows up as CPU rather than hiding behind a
 * stubbed stream.
 */
let spawnedProbeCpuMs = 0

function spawnedConnectedProviderStatusCommand(): ConnectCommandChild {
  // A JS runtime start, because that is what the real probe costs and what the
  // rail regressed into — a shell builtin would be a thousand times cheaper
  // than the thing being guarded and would let the regression through.
  const child = Bun.spawn(
    [process.execPath, '-e', `process.stdout.write(${JSON.stringify('{"connections":[]}\n')})`],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const exited = child.exited.then(code => {
    try {
      const usage = child.resourceUsage()
      if (usage !== undefined) {
        spawnedProbeCpuMs += Number(usage.cpuTime.user + usage.cpuTime.system) / 1000
      }
    } catch {
      // Accounting is best-effort; it must never fail the probe it measures.
    }
    return code
  })
  return {
    stdout: child.stdout as ReadableStream<Uint8Array>,
    stderr: child.stderr as ReadableStream<Uint8Array>,
    exited,
    kill: () => child.kill(),
  }
}

const emptyConnectedProviderStatusCommand: ConnectCommandRunner = () =>
  connectedProviderStatusCommand({ connections: [] })

function connectedProviderStatusCommand(value: unknown) {
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`))
        controller.close()
      },
    }),
    stderr: new ReadableStream({ start: controller => controller.close() }),
    exited: Promise.resolve(0),
    kill: () => undefined,
  }
}

function gatewayAnchorFixture(id: string, path: string, agentId: string): GatewayAnchor {
  return {
    id,
    agentId,
    workspaceId: 'workspace-1',
    path,
    kind: 'agent',
    settings: {},
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    markerNonce: `nonce-${id}`,
  }
}

function syncResponse(
  options: {
    runtimeRelease?: VmSyncResponse['runtimeRelease']
    anchors?: GatewayAnchor[]
    apps?: VmSyncResponse['apps']
    skills?: VmSyncResponse['skills']
    modelCredentials?: VmSyncResponse['modelCredentials']
    appCredentials?: VmSyncResponse['appCredentials']
    agents?: VmSyncResponse['agents']
    quiesce?: boolean
  } = {},
): VmSyncResponse {
  return {
    pollAfterMs: 5_000,
    ...(options.quiesce === undefined ? {} : { quiesce: options.quiesce }),
    anchors: options.anchors ?? [],
    mirrorMachineIds: [],
    ...(options.apps === undefined ? {} : { apps: options.apps }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.runtimeRelease === undefined ? {} : { runtimeRelease: options.runtimeRelease }),
    updates: { paused: options.runtimeRelease === undefined },
    // A registered VM that has synced HAS credentials — that is the normal
    // state, and spawning now requires them. Tests that need the not-yet-synced
    // window (the queuing contract) build a runtime with no sync at all rather
    // than a sync that withholds them.
    modelCredentials: options.modelCredentials ?? {
      apiKey: 'duet_sk_1111111111111111111111111111111111111111111111111111111111111111',
      gatewayBaseUrl: 'https://gateway.test',
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
    ...(options.appCredentials === undefined ? {} : { appCredentials: options.appCredentials }),
    ...(options.agents === undefined ? {} : { agents: options.agents }),
  }
}

function credentialEnvelope(appId: string, apiKey: string, scopes: AppApiCapability[]) {
  return { appId, apiKey, scopes, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 }
}

function envInspectorCommand(): string {
  return [
    'bun',
    '-e',
    JSON.stringify(
      "const names=['DUET_API_URL','DUET_APP_API_KEY','DUET_GATEWAY_BASE_URL','DUET_API_KEY','DUET_APP_DIR','DUET_AGENT_DIR','HOME','PATH','PORT']; const env=Object.fromEntries(names.flatMap(name=>process.env[name]===undefined?[]:[[name,process.env[name]]])); Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>Response.json({env,pid:process.pid})}); await new Promise(()=>{})",
    ),
  ].join(' ')
}

function runtimeRelease(
  fixture: ReturnType<typeof runtimeFixture>,
): NonNullable<VmSyncResponse['runtimeRelease']> {
  return {
    ...fixture.manifest,
    artifacts: fixture.manifest.artifacts.map(artifact => ({
      ...artifact,
      href: `http://backend/v1/vm/runtime-release/artifacts/${artifact.name}`,
    })),
  }
}

function skillsBundle(files: Array<{ path: string; content: string }>): {
  bytes: string
  hash: string
} {
  const bytes = JSON.stringify({ version: 1, files })
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') }
}

function authHeaders(): Record<string, string> {
  return {
    authorization: 'Bearer vm-token',
    [DUET_COLLECTION_SUBJECT_HEADER]: 'workspace:test',
  }
}

function jsonAuthHeaders(): Record<string, string> {
  return { ...authHeaders(), 'content-type': 'application/json' }
}

function authInit(): RequestInit {
  return { headers: authHeaders() }
}

function samplePath(path: string): string {
  return path.replace('*', 'probe.txt')
}

interface ParsedSseFrame {
  id?: string
  event?: string
  data: { seq?: number; event: AgentTurnEvent }
}

function parseSseFrames(body: string): ParsedSseFrame[] {
  return (
    body
      .trim()
      .split('\n\n')
      // A comment-only block (the stream's opening byte, a keepalive) is the
      // transport's own, not an event.
      .filter(block => block.length > 0 && !block.split('\n').every(line => line.startsWith(':')))
      .map(block => {
        const frame: {
          id?: string
          event?: string
          data?: { seq?: number; event: AgentTurnEvent }
        } = {}
        for (const line of block.split('\n')) {
          const separator = line.indexOf(':')
          if (separator === -1) continue
          const field = line.slice(0, separator)
          const value = line.slice(separator + 1).replace(/^ /, '')
          if (field === 'id') frame.id = value
          if (field === 'event') frame.event = value
          if (field === 'data') frame.data = JSON.parse(value)
        }
        if (frame.data === undefined) throw new Error(`SSE frame missing data: ${block}`)
        return frame as ParsedSseFrame
      })
  )
}

async function waitForUploads(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const uploads = await readdir(join(tempDir, 'drive', '.duet', 'uploads')).catch(() => [])
    if (uploads.length > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for upload temp file')
}

async function tarFixture(parentDir: string, ...entryNames: string[]): Promise<ArrayBuffer> {
  const proc = Bun.spawn(['tar', '-C', parentDir, '-cf', '-', ...entryNames], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [archive, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`tar fixture failed: ${stderr}`)
  return archive
}

function corruptFirstTarSize(archive: ArrayBuffer): ArrayBuffer {
  const corrupted = new Uint8Array(archive.slice(0))
  corrupted[124] = 0x80
  for (let index = 125; index < 136; index += 1) corrupted[index] = 0
  return corrupted.buffer.slice(
    corrupted.byteOffset,
    corrupted.byteOffset + corrupted.byteLength,
  ) as ArrayBuffer
}

function serveGateway(
  runtime: ReturnType<typeof createGatewayRuntime>,
): ReturnType<typeof Bun.serve> {
  let server: ReturnType<typeof Bun.serve>
  server = Bun.serve({
    port: 0,
    fetch: async request => {
      const tunnelResponse = await handleTunnelUpgrade(request, server, runtime.tunnelAccepts)
      if (tunnelResponse !== null) return tunnelResponse
      return runtime.app.fetch(request)
    },
    websocket: tunnelWebSocketHandlers(),
  })
  return server
}

async function startTcpEchoServer(): Promise<Server> {
  const server = createServer(socket => {
    socket.on('data', chunk => socket.write(chunk))
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return server
}

function addressPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('TCP echo server did not expose a port')
  return address.port
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolveClose => server.close(() => resolveClose()))
}

async function waitFor(assertion: () => boolean): Promise<void> {
  // A quick condition still returns on the first pass; the ceiling only pays
  // out under machine load. The old 1s budget (100 x 10ms) was chaos-tight for
  // seam-level async once the whole repo's suites run concurrently — quiesce
  // and runner-seam waits tripped it in full gates while passing alone.
  for (let index = 0; index < 400; index += 1) {
    if (assertion()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition was not met')
}

/**
 * 5s, matching `waitForStatus` above. The old 1s budget could not cover an app
 * RESTART — delivering a credential kills and respawns the process, and a fresh
 * `bun -e` boot with several app processes contending exceeds a second — so
 * every credential-rotation assertion raced the respawn it was waiting for.
 */
async function waitForAsync(assertion: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (await assertion()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition was not met')
}

async function waitForFileToContain(path: string, expected: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    const contents = await readFile(path, 'utf8').catch(() => '')
    if (contents.includes(expected)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`file did not contain ${expected}`)
}

async function writeProc(
  procDir: string,
  pid: string,
  entry: { environ: string[]; cmdline: string[] },
): Promise<void> {
  const dir = join(procDir, pid)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'environ'), entry.environ.join('\0'))
  await writeFile(join(dir, 'cmdline'), entry.cmdline.join('\0'))
}

class MockAgentRunner implements AgentRunner {
  readonly commands: AgentRunnerCommand[] = []
  killed = false
  private readonly listeners: Array<(event: AgentRunnerEvent) => void> = []
  private readonly exitListeners: Array<(code: number | null) => void> = []
  private alive = false
  private started: AgentRunnerStartedEvent | null = null

  constructor(private readonly askOnPrompt = false) {}

  async start(): Promise<void> {
    this.alive = true
  }

  async send(command: AgentRunnerCommand): Promise<void> {
    this.commands.push(command)
    if (command.type === 'start') {
      const started: AgentRunnerStartedEvent = {
        type: 'turn_started',
        state: RUNNING_TURN_STATE,
      }
      this.started = started
      this.emit(started)
    }
    if (command.type === 'interrupt') {
      this.emit({ type: 'interrupted', state: INTERRUPTED_TURN_STATE })
      this.alive = false
    }
    if (command.type === 'prompt' && this.askOnPrompt) {
      this.emit({
        type: 'ask',
        state: WAITING_TURN_STATE,
        questions: [{ question: 'Approve?', options: [] }],
      })
    }
  }

  async waitForTurnStarted(): Promise<AgentRunnerStartedEvent> {
    if (this.started !== null) return this.started
    return await new Promise(resolve => {
      const unsubscribe = this.onEvent(event => {
        if (event.type === 'turn_started') {
          unsubscribe()
          resolve(event as AgentRunnerStartedEvent)
        }
      })
    })
  }

  onEvent(listener: (event: AgentRunnerEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index !== -1) this.listeners.splice(index, 1)
    }
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.push(listener)
    return () => {
      const index = this.exitListeners.indexOf(listener)
      if (index !== -1) this.exitListeners.splice(index, 1)
    }
  }

  isAlive(): boolean {
    return this.alive
  }

  getPid(): number | null {
    return null
  }

  getStderr(): string {
    return ''
  }

  kill(): void {
    if (this.killed) return
    this.killed = true
    this.alive = false
    for (const listener of this.exitListeners.slice()) listener(null)
  }

  emitEvent(event: AgentRunnerEvent): void {
    if (event.type === 'complete' || event.type === 'interrupted' || event.type === 'sleep') {
      this.alive = false
    }
    this.emit(event)
  }

  private emit(event: AgentRunnerEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

async function collectFrames(
  frames: AsyncIterable<LiveFrame>,
  count: number,
): Promise<LiveFrame[]> {
  const iterator = frames[Symbol.asyncIterator]()
  const collected: LiveFrame[] = []
  for (let index = 0; index < count; index += 1) {
    const result = await withTimeout(iterator.next(), 1_000)
    if (result.done === true) break
    collected.push(result.value)
  }
  return collected
}

function frameSummary(frame: LiveFrame): [string, number | null] {
  if (frame.event.type === 'step') return [frame.event.step.type, frame.seq]
  return [frame.event.type, frame.seq]
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}

function websocketRoundTrip(url: string, tunnelToken: string): Promise<string> {
  return new Promise((resolveRoundTrip, rejectRoundTrip) => {
    const BunWebSocket = WebSocket as BunWebSocketConstructor
    const ws = new BunWebSocket(url, {
      headers: tunnelHeaders({ tunnelToken }),
    })
    const timeout = setTimeout(() => {
      ws.close()
      rejectRoundTrip(new Error('WebSocket tunnel round trip timed out'))
      // Below the 60s test budget so this specific error surfaces instead of
      // a bare test timeout, with load headroom a tight watchdog lacks.
    }, 30_000)
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('open', () => {
      ws.send(
        toArrayBuffer(
          encodeTunnelFrame({ type: 'data', payload: new TextEncoder().encode('from-b') }),
        ),
      )
    })
    ws.addEventListener('message', event => {
      clearTimeout(timeout)
      const decoded = decodeTunnelFrame(
        event.data instanceof ArrayBuffer
          ? event.data
          : new TextEncoder().encode(String(event.data)),
      )
      ws.close()
      resolveRoundTrip(new TextDecoder().decode(decoded.payload))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      rejectRoundTrip(new Error('WebSocket tunnel errored'))
    })
  })
}

interface BunWebSocketConstructor {
  new (url: string | URL, options?: { headers?: HeadersInit }): WebSocket
}

async function writeFakeTrainOutput(input: TrainRunnerInput): Promise<void> {
  await mkdir(input.storeDir, { recursive: true })
  await writeFile(
    join(input.storeDir, `${input.slug}.md`),
    serializeMemoryFile({
      version: 1,
      id: `mem_${input.slug.replaceAll('-', '_')}`,
      kind: 'train',
      createdAt: Date.parse('2026-07-23T00:00:00.000Z'),
      content: 'Fake gateway training output.\n',
    }),
  )
}

function runnerInputBody(spec: {
  sessionId: string
  prompt: string
  behavior: 'steer' | 'follow_up'
  tier: ModelSelectionId
  cwd?: string
  onboarding?: boolean
  integrations?: GatewayRunnerInputRequest['launch']['integrations']
  mcpServers?: GatewayRunnerInputRequest['launch']['mcpServers']
  throughSeq?: number
  images?: Extract<GatewayRunnerInputRequest['input'], { kind: 'prompt' }>['images']
}): GatewayRunnerInputRequest {
  const throughSeq = spec.throughSeq ?? 1
  return {
    attemptId: `${spec.sessionId}:${throughSeq}`,
    throughSeq,
    input: {
      kind: 'prompt',
      message: spec.prompt,
      behavior: spec.behavior,
      ...(spec.images === undefined ? {} : { images: spec.images }),
    },
    launch: {
      tier: spec.tier,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      ...(spec.onboarding === undefined ? {} : { onboarding: spec.onboarding }),
      ...(spec.integrations === undefined ? {} : { integrations: spec.integrations }),
      ...(spec.mcpServers === undefined ? {} : { mcpServers: spec.mcpServers }),
    },
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

test('direct runtime registration fallback preserves existing mirrors and the committed token', async () => {
  const stateDir = join(tempDir, '.duet')
  await mkdir(stateDir, { recursive: true })
  const devices = [
    {
      machineId: 'existing-machine',
      syncthingDeviceId: 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY',
      registeredAt: 1,
    },
  ]
  await writeFile(join(stateDir, 'sync-mirror-devices.json'), JSON.stringify(devices))
  const runtime = createGatewayRuntime({
    stateDir,
    driveDir: join(tempDir, 'drive'),
    apiUrl: 'http://control.test',
    provisioningToken: 'fixture-provisioning',
    workspaceHint: 'fixture-workspace',
    syncthingApiUrl: 'http://syncthing.test',
    syncthingApiKey: 'fixture-syncthing',
    fetch: async input => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/vm/register')
        return Response.json({
          vmToken: 'committed-token',
          syncIntervalSeconds: 5,
          sync: { pollAfterMs: 5000, anchors: [], updates: { paused: true } },
        })
      return Response.json({ devices: [], folders: [], options: {} })
    },
  })
  await runtime.registerOnce()
  expect(await readFile(join(stateDir, 'vm-token'), 'utf8')).toBe('committed-token\n')
  expect(JSON.parse(await readFile(join(stateDir, 'sync-mirror-devices.json'), 'utf8'))).toEqual(
    devices,
  )
})
