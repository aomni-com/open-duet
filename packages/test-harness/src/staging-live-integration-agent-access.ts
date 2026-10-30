import assert from 'node:assert/strict'

import { Composio } from '@composio/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import {
  AGENT_TERMINAL_STATES,
  INTEGRATIONS_MCP_SERVER_NAME,
  IntegrationConnectionListSchema,
  isKnownTimelineEvent,
  SessionCreateResponseSchema,
  SessionInputResponseSchema,
} from '@repo/contract'

import { provisionStagingAgent } from './staging-live-agent-fixture.ts'
import {
  deleteStagingSession,
  loadSessionSnapshot,
  waitForSessionHistory,
  waitForSessionSnapshot,
} from './staging-live-agent-sessions.ts'
import { assertNoCredentialArtifacts } from './staging-live-artifacts.ts'
import { fnQuery, isUsableStagingCredential } from './staging-live-env.ts'
import { runFirecrawlIntegrationAcceptance } from './staging-live-firecrawl.ts'
import { apiJson, bearer, bearerJson, vercelBypassHeaders } from './staging-live-http.ts'
import type { ChronologicalSessionHistory } from './staging-live-pagination.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
  type WorkspaceBrowserJourneyResult,
} from './staging-live-workspace-browser.ts'

const FIRECRAWL = 'firecrawl'
const CONFIG_WAIT_MS = 120_000
const WORKBENCH_AGENT_TOOL_NAME = `${INTEGRATIONS_MCP_SERVER_NAME}__COMPOSIO_REMOTE_WORKBENCH`
export const INTEGRATION_AGENT_ACCESS_ALL_LABEL = 'All agents'

interface ToolRouterConfig {
  configId: string
  permissionFingerprint: string
  disabledToolkitSlugs: string[]
  providerSessionId?: string
}

export interface IntegrationAgentAccessEvidence {
  rootConfigId: string
  childConfigId: string
  otherConversationConfigId: string
  changedPolicyConfigId: string
  rootDenied: true
  childAllowed: true
  workbenchReused: true
  providerSessionRecovered: true
  crossConversationIsolated: true
  permissionsUpdatedInPlace: true
  reconnectRetainedPolicy: true
  clearedToAll: true
}

export async function runIntegrationAgentAccessJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<WorkspaceBrowserJourneyResult<IntegrationAgentAccessEvidence>> {
  const providerCredentials = {
    composioApiKey: requireProviderCredential('COMPOSIO_API_KEY'),
    firecrawlApiKey: requireProviderCredential('FIRECRAWL_API_KEY'),
  }
  const result = await runWorkspaceBrowserJourney({
    journey: 'integration-agent-access',
    label: 'Integration agent access',
    onProgress: options.onProgress,
    run: async context => await runIntegrationAgentAccessAcceptance(context, providerCredentials),
  })
  await assertNoCredentialArtifacts(result.artifactDirectory)
  return result
}

async function runIntegrationAgentAccessAcceptance(
  context: WorkspaceBrowserJourneyContext,
  providerCredentials: { composioApiKey: string; firecrawlApiKey: string },
): Promise<IntegrationAgentAccessEvidence> {
  const { env, page, workspace, apiToken, runId, ledger, convex, artifacts, progress } = context
  const browser = page.context().browser()
  assert(browser !== null, 'integration access journey page had no browser owner')
  const providerEnv = {
    ...env,
    landerUrl: env.appUrl,
    docsUrl: env.appUrl,
    ...providerCredentials,
  }
  const agentName = `Integration Access ${runId.slice(-6)}`
  const trackedProviderSessionIds = new Set<string>()
  const agent = await provisionStagingAgent({
    env,
    workspace,
    apiToken,
    runId,
    slug: `integration-access-${runId.slice(-6)}`,
    name: agentName,
    description: 'Staging fixture for per-agent integration access.',
    ledger,
    convex,
    artifacts,
  })

  let firstPass:
    | Omit<IntegrationAgentAccessEvidence, 'reconnectRetainedPolicy' | 'clearedToAll'>
    | undefined
  progress('integration-agent-access:connect')
  await runFirecrawlIntegrationAcceptance({
    env: providerEnv,
    browser,
    ownerPage: page,
    workspace,
    apiToken,
    runId,
    ledger,
    artifacts,
    captureConnectedScreenshot: false,
    onConnected: async connection => {
      assert.equal(connection.allowedAgentIds, undefined, 'new connection did not default to All')
      await assertUiPolicy(page, FIRECRAWL, { all: true })

      progress('integration-agent-access:child-only-policy')
      await setUiCheckbox(
        page,
        workspace.slug,
        FIRECRAWL,
        INTEGRATION_AGENT_ACCESS_ALL_LABEL,
        false,
      )
      await setUiCheckbox(page, workspace.slug, FIRECRAWL, agentName, true)
      const childOnly = await listConnection(context)
      assert.deepEqual(childOnly.allowedAgentIds, [agent.id], 'UI did not save child-only policy')

      progress('integration-agent-access:root-and-child-turns')
      const rootSessionId = await createSession(context, 'root', undefined)
      const childSessionId = await createSession(context, 'child', agent.anchorPath)
      const rootConfig = await waitForConfig(context, rootSessionId, [FIRECRAWL])
      const childConfig = await waitForConfig(context, childSessionId, [])
      assert.notEqual(rootConfig.permissionFingerprint, childConfig.permissionFingerprint)

      const composio = new Composio({ apiKey: providerCredentials.composioApiKey })
      const rootProbe = await openTrackedMcpProbe(
        context,
        composio,
        trackedProviderSessionIds,
        rootSessionId,
        rootConfig.configId,
      )
      try {
        const childProbe = await openTrackedMcpProbe(
          context,
          composio,
          trackedProviderSessionIds,
          childSessionId,
          childConfig.configId,
        )
        let childProbeOpen = true
        try {
          assertMetaTools(rootProbe.toolNames)
          assertMetaTools(childProbe.toolNames)
          assert.deepEqual(
            await providerSessionFirecrawlState(composio, rootProbe.ready.providerSessionId),
            { present: false, active: false },
            'denied root provider session still exposed Firecrawl',
          )
          assert.deepEqual(
            await providerSessionFirecrawlState(composio, childProbe.ready.providerSessionId),
            { present: true, active: true },
            'allowed child provider session omitted Firecrawl',
          )

          progress('integration-agent-access:workbench-reuse')
          const sentinel = `duet-access-${runId}`
          await writeWorkbenchSentinel(childProbe.client, sentinel)
          await sendTurn(context, childSessionId, 'same-conversation', sentinel)
          const sameConfig = await waitForConfig(context, childSessionId, [])
          assert.equal(sameConfig.configId, childConfig.configId)

          progress('integration-agent-access:conversation-isolation')
          const otherSessionId = await createSession(
            context,
            'other-conversation',
            agent.anchorPath,
          )
          const otherConfig = await waitForConfig(context, otherSessionId, [])
          assert.notEqual(otherConfig.configId, childConfig.configId)
          const otherProbe = await openTrackedMcpProbe(
            context,
            composio,
            trackedProviderSessionIds,
            otherSessionId,
            otherConfig.configId,
          )
          try {
            await assertWorkbenchMissing(otherProbe.client, sentinel)
          } finally {
            await otherProbe.close()
          }
          assert.notEqual(
            otherProbe.ready.providerSessionId,
            childProbe.ready.providerSessionId,
            'different Duet conversations shared a provider session',
          )

          progress('integration-agent-access:next-turn-cutover')
          await putPolicy(context, ['root'])
          assert.deepEqual(
            await providerSessionFirecrawlState(composio, childProbe.ready.providerSessionId),
            { present: true, active: true },
            'policy edit mutated the old provider snapshot',
          )
          await assertWorkbenchSentinel(childProbe.client, sentinel)
          await sendTurn(context, childSessionId, 'changed-policy')
          const changedConfig = await waitForConfig(context, childSessionId, [FIRECRAWL])
          assert.equal(changedConfig.configId, childConfig.configId)
          const changedProbe = await openTrackedMcpProbe(
            context,
            composio,
            trackedProviderSessionIds,
            childSessionId,
            changedConfig.configId,
          )
          try {
            assert.deepEqual(
              await providerSessionFirecrawlState(composio, changedProbe.ready.providerSessionId),
              { present: false, active: false },
              'next child turn did not receive the changed policy',
            )
            assert.equal(
              changedProbe.ready.providerSessionId,
              childProbe.ready.providerSessionId,
              'permission update replaced the conversation provider session',
            )
            await assertWorkbenchSentinel(changedProbe.client, sentinel)
          } finally {
            await changedProbe.close()
          }

          progress('integration-agent-access:return-to-prior')
          await putPolicy(context, [agent.id])
          await sendTurn(context, childSessionId, 'return-to-prior', sentinel)
          const returned = await waitForConfig(context, childSessionId, [])
          assert.equal(returned.configId, childConfig.configId)
          const readyReturned = await waitForReadyConfig(context, childSessionId, returned.configId)
          assert.equal(readyReturned.providerSessionId, childProbe.ready.providerSessionId)

          progress('integration-agent-access:provider-session-recovery')
          await childProbe.close()
          childProbeOpen = false
          await composio.sessions.delete(childProbe.ready.providerSessionId)
          const recoveredProbe = await openTrackedMcpProbe(
            context,
            composio,
            trackedProviderSessionIds,
            childSessionId,
            returned.configId,
          )
          try {
            assert.notEqual(
              recoveredProbe.ready.providerSessionId,
              childProbe.ready.providerSessionId,
              'Duet retained the provider identity that Composio had lost',
            )
            assertMetaTools(recoveredProbe.toolNames)
            assert.deepEqual(
              await providerSessionFirecrawlState(composio, recoveredProbe.ready.providerSessionId),
              { present: true, active: true },
              'replacement provider session did not retain current permissions',
            )
          } finally {
            await recoveredProbe.close()
          }

          firstPass = {
            rootConfigId: rootConfig.configId,
            childConfigId: childConfig.configId,
            otherConversationConfigId: otherConfig.configId,
            changedPolicyConfigId: changedConfig.configId,
            rootDenied: true,
            childAllowed: true,
            workbenchReused: true,
            providerSessionRecovered: true,
            crossConversationIsolated: true,
            permissionsUpdatedInPlace: true,
          }
        } finally {
          if (childProbeOpen) await childProbe.close()
        }
      } finally {
        await rootProbe.close()
      }
    },
  })

  assert(firstPass !== undefined, 'first connected interval produced no evidence')
  progress('integration-agent-access:reconnect')
  let reconnectRetainedPolicy = false
  let clearedToAll = false
  await runFirecrawlIntegrationAcceptance({
    env: providerEnv,
    browser,
    ownerPage: page,
    workspace,
    apiToken,
    runId,
    ledger,
    artifacts,
    recordProviderSweep: false,
    captureConnectedScreenshot: false,
    onConnected: async connection => {
      assert.deepEqual(
        connection.allowedAgentIds,
        [agent.id],
        'disconnect/reconnect discarded the toolkit policy',
      )
      await assertUiPolicy(page, FIRECRAWL, { all: false, checkedLabel: agentName })
      reconnectRetainedPolicy = true
      await setUiCheckbox(page, workspace.slug, FIRECRAWL, INTEGRATION_AGENT_ACCESS_ALL_LABEL, true)
      assert.equal((await listConnection(context)).allowedAgentIds, undefined)
      clearedToAll = true
    },
  })
  assert(reconnectRetainedPolicy, 'reconnect policy check did not run')
  assert(clearedToAll, 'final All policy clear did not run')
  return { ...firstPass, reconnectRetainedPolicy: true, clearedToAll: true }
}

function requireProviderCredential(name: 'COMPOSIO_API_KEY' | 'FIRECRAWL_API_KEY'): string {
  const value = process.env[name]
  const normalized = value?.trim()
  if (!isUsableStagingCredential(value) || normalized === undefined) {
    throw new Error(`integration-agent-access journey requires ${name}`)
  }
  return normalized
}

function recordToolRouterCleanup(
  context: WorkspaceBrowserJourneyContext,
  composio: Composio,
  trackedProviderSessionIds: Set<string>,
  providerSessionId: string,
): void {
  if (trackedProviderSessionIds.has(providerSessionId)) return
  context.ledger.record({
    kind: 'integration',
    id: `tool-router:${providerSessionId}`,
    label: `${context.runId}:integration-access-tool-router:${providerSessionId}`,
    cleanup: async () => {
      await composio.sessions.delete(providerSessionId).catch(error => {
        if (!providerMissing(error)) throw error
      })
    },
    verify: async () => {
      try {
        await composio.sessions.use(providerSessionId)
        return false
      } catch (error) {
        return providerMissing(error)
      }
    },
  })
  trackedProviderSessionIds.add(providerSessionId)
}

function providerMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const value = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  }
  return [value.status, value.statusCode, value.response?.status].some(status => status === 404)
}

async function createSession(
  context: WorkspaceBrowserJourneyContext,
  label: string,
  cwd: string | undefined,
): Promise<string> {
  const response = SessionCreateResponseSchema.parse(
    await apiJson(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/agent/sessions`,
      {
        method: 'POST',
        headers: bearerJson(context.apiToken),
        body: JSON.stringify({
          prompt: `Reply exactly "${label}" and do not call tools.`,
          ...(cwd === undefined ? {} : { cwd }),
        }),
        signal: AbortSignal.timeout(360_000),
      },
      201,
      `integration access ${label} session create`,
      context.artifacts,
    ),
  )
  assert.equal(response.delivery, 'accepted', `integration access ${label} session was queued`)
  const sessionId = response.session.sessionId
  context.ledger.record({
    kind: 'session',
    id: sessionId,
    label: `${context.runId}:integration-access-session:${label}:${sessionId}`,
    cleanup: async () =>
      await deleteStagingSession(context.env, context.workspace.slug, sessionId, context.apiToken),
    verify: async () =>
      await workspaceIsDeleted(context.convex, context.env.internalKey, context.workspace._id),
  })
  await waitForSessionSnapshot(
    context.env,
    context.workspace.slug,
    sessionId,
    context.apiToken,
    snapshot =>
      snapshot.lastEventSeq > response.session.lastEventSeq &&
      isTerminalStatus(snapshot.turnStatus),
    360_000,
  )
  return sessionId
}

async function sendTurn(
  context: WorkspaceBrowserJourneyContext,
  sessionId: string,
  label: string,
  workbenchSentinel?: string,
): Promise<void> {
  const before = await loadSessionSnapshot(
    context.env,
    context.workspace.slug,
    sessionId,
    context.apiToken,
  )
  const response = SessionInputResponseSchema.parse(
    await apiJson(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/agent/sessions/${sessionId}/messages`,
      {
        method: 'POST',
        headers: bearerJson(context.apiToken),
        body: JSON.stringify({
          behavior: 'steer',
          prompt:
            workbenchSentinel === undefined
              ? `Reply exactly "${label}" and do not call tools.`
              : `Use ${WORKBENCH_AGENT_TOOL_NAME} to print the existing duet_access_sentinel variable, then reply exactly "${label}".`,
        }),
        signal: AbortSignal.timeout(300_000),
      },
      202,
      `integration access ${label} turn`,
      context.artifacts,
    ),
  )
  assert.equal(response.delivery, 'accepted', `integration access ${label} turn was queued`)
  await waitForSessionSnapshot(
    context.env,
    context.workspace.slug,
    sessionId,
    context.apiToken,
    snapshot =>
      snapshot.lastEventSeq > before.lastEventSeq &&
      snapshot.lastDeliveredInputSeq > before.lastDeliveredInputSeq &&
      isTerminalStatus(snapshot.turnStatus),
    300_000,
  )
  if (workbenchSentinel !== undefined) {
    await waitForSessionHistory(
      context.env,
      context.workspace.slug,
      sessionId,
      context.apiToken,
      history => hasWorkbenchTurnEvidence(history, before.lastEventSeq, workbenchSentinel),
      300_000,
    )
  }
}

export function hasWorkbenchTurnEvidence(
  history: ChronologicalSessionHistory,
  afterSeq: number,
  sentinel: string,
): boolean {
  return history.events.some(row => {
    if (row.seq <= afterSeq) return false
    if (!isKnownTimelineEvent(row.event) || row.event.type !== 'step') return false
    const step = row.event.step
    return (
      step.type === 'tool_call' &&
      step.toolName === WORKBENCH_AGENT_TOOL_NAME &&
      !step.isError &&
      step.output?.some(item => item.type === 'text' && item.text.includes(sentinel)) === true
    )
  })
}

async function waitForConfig(
  context: WorkspaceBrowserJourneyContext,
  sessionId: string,
  disabledToolkitSlugs: string[],
): Promise<ToolRouterConfig> {
  const deadline = Date.now() + CONFIG_WAIT_MS
  for (;;) {
    const rows = await toolRouterConfigs(context, sessionId)
    const row = rows.find(candidate =>
      equalStrings(candidate.disabledToolkitSlugs, disabledToolkitSlugs),
    )
    if (row !== undefined) return row
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for integration config ${JSON.stringify(disabledToolkitSlugs)}; ` +
          `observed=${JSON.stringify(rows.map(candidate => candidate.disabledToolkitSlugs))}`,
      )
    }
    await Bun.sleep(500)
  }
}

async function waitForReadyConfig(
  context: WorkspaceBrowserJourneyContext,
  sessionId: string,
  configId: string,
): Promise<ToolRouterConfig & { providerSessionId: string }> {
  const deadline = Date.now() + CONFIG_WAIT_MS
  for (;;) {
    const row = (await toolRouterConfigs(context, sessionId)).find(
      candidate => candidate.configId === configId,
    )
    if (row?.providerSessionId !== undefined) {
      return { ...row, providerSessionId: row.providerSessionId }
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ready config ${configId}`)
    await Bun.sleep(500)
  }
}

async function toolRouterConfigs(
  context: WorkspaceBrowserJourneyContext,
  sessionId: string,
): Promise<ToolRouterConfig[]> {
  return (await context.convex.query(
    fnQuery('testing/agentSessions:toolRouterConfigsForSessionForTest'),
    {
      internalKey: context.env.internalKey,
      workspaceId: context.workspace._id,
      sessionId,
    },
  )) as ToolRouterConfig[]
}

async function openMcpProbe(context: WorkspaceBrowserJourneyContext, sessionId: string) {
  const headers = bearer(context.apiToken, vercelBypassHeaders(context.env.vercelBypassSecret))
  const transport = new StreamableHTTPClientTransport(
    new URL(
      `${context.env.apiUrl}/v1/ws/${encodeURIComponent(context.workspace.slug)}/agent/sessions/${encodeURIComponent(sessionId)}/integrations/mcp`,
    ),
    { requestInit: { headers } },
  )
  const client = new Client({ name: 'duet-integration-agent-access-staging', version: '1.0.0' })
  await client.connect(transport)
  const tools = await client.listTools()
  return {
    client,
    toolNames: new Set(tools.tools.map(tool => tool.name)),
    close: async () => await client.close(),
  }
}

async function openTrackedMcpProbe(
  context: WorkspaceBrowserJourneyContext,
  composio: Composio,
  trackedProviderSessionIds: Set<string>,
  sessionId: string,
  configId: string,
) {
  let probe: Awaited<ReturnType<typeof openMcpProbe>>
  try {
    probe = await openMcpProbe(context, sessionId)
  } catch (error) {
    const ready = (await toolRouterConfigs(context, sessionId)).find(
      candidate => candidate.configId === configId && candidate.providerSessionId !== undefined,
    )
    if (ready?.providerSessionId !== undefined) {
      recordToolRouterCleanup(context, composio, trackedProviderSessionIds, ready.providerSessionId)
    }
    throw error
  }
  try {
    const ready = await waitForReadyConfig(context, sessionId, configId)
    recordToolRouterCleanup(context, composio, trackedProviderSessionIds, ready.providerSessionId)
    return { ...probe, ready }
  } catch (error) {
    await probe.close()
    throw error
  }
}

function assertMetaTools(toolNames: Set<string>): void {
  for (const name of [
    'COMPOSIO_MANAGE_CONNECTIONS',
    'COMPOSIO_REMOTE_WORKBENCH',
    'COMPOSIO_REMOTE_BASH_TOOL',
  ]) {
    assert(toolNames.has(name), `Tool Router session omitted ${name}`)
  }
}

async function providerSessionFirecrawlState(
  composio: Composio,
  providerSessionId: string,
): Promise<{ present: boolean; active: boolean }> {
  const session = await composio.sessions.use(providerSessionId)
  const page = await session.toolkits({ toolkits: [FIRECRAWL], limit: 20 })
  const item = page.items.find(candidate => candidate.slug === FIRECRAWL)
  return { present: item !== undefined, active: item?.connection?.isActive === true }
}

async function writeWorkbenchSentinel(client: Client, sentinel: string): Promise<void> {
  const result = await client.callTool({
    name: 'COMPOSIO_REMOTE_WORKBENCH',
    arguments: workbenchArguments(
      `duet_access_sentinel = ${JSON.stringify(sentinel)}\nprint(duet_access_sentinel)`,
    ),
  })
  assert(serializedToolResult(result).includes(sentinel), 'workbench did not echo written sentinel')
}

async function assertWorkbenchSentinel(client: Client, sentinel: string): Promise<void> {
  const result = await client.callTool({
    name: 'COMPOSIO_REMOTE_WORKBENCH',
    arguments: workbenchArguments(`print(globals().get("duet_access_sentinel", "MISSING"))`),
  })
  assert(serializedToolResult(result).includes(sentinel), 'reused workbench lost its sentinel')
}

async function assertWorkbenchMissing(client: Client, sentinel: string): Promise<void> {
  const result = await client.callTool({
    name: 'COMPOSIO_REMOTE_WORKBENCH',
    arguments: workbenchArguments(`print(globals().get("duet_access_sentinel", "MISSING"))`),
  })
  const serialized = serializedToolResult(result)
  assert(serialized.includes('MISSING'), 'different conversation inherited the workbench sentinel')
  assert(!serialized.includes(sentinel), 'different conversation exposed the workbench sentinel')
}

function workbenchArguments(code: string): Record<string, unknown> {
  return {
    code_to_execute: code,
    thought: 'Verify Duet conversation-scoped workbench continuity.',
    current_step: 'VERIFYING_WORKBENCH',
    current_step_metric: '1/1 checks',
  }
}

function serializedToolResult(result: unknown): string {
  return JSON.stringify(result)
}

async function putPolicy(
  context: WorkspaceBrowserJourneyContext,
  allowedAgentIds: string[] | undefined,
): Promise<void> {
  await apiJson(
    `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/integrations/${FIRECRAWL}/agent-policy`,
    {
      method: 'PUT',
      headers: bearerJson(context.apiToken),
      body: JSON.stringify(allowedAgentIds === undefined ? {} : { allowedAgentIds }),
    },
    200,
    'integration access policy update',
    context.artifacts,
  )
}

async function listConnection(context: WorkspaceBrowserJourneyContext) {
  const list = IntegrationConnectionListSchema.parse(
    await apiJson(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/integrations/connections`,
      { headers: bearer(context.apiToken) },
      200,
      'integration access connection list',
      context.artifacts,
    ),
  )
  const connection = list.items.find(item => item.integration === FIRECRAWL)
  assert(connection !== undefined, 'active Firecrawl connection was absent')
  return connection
}

async function setUiCheckbox(
  page: WorkspaceBrowserJourneyContext['page'],
  workspaceSlug: string,
  toolkitSlug: string,
  label: string,
  checked: boolean,
): Promise<void> {
  const editor = page.locator(`[data-integration-agent-access="${toolkitSlug}"]`)
  const panel = page.locator(`[data-integration-agent-access-panel="${toolkitSlug}"]`)
  await openAgentAccessEditor(editor)
  const checkbox = panel.getByRole('checkbox', { name: label, exact: true })
  await waitForCheckboxEnabled(checkbox)
  assert.equal(
    await checkbox.isChecked(),
    !checked,
    `${label} checkbox was not ready for the expected toggle`,
  )
  /* Three facts decide where a missing policy save died — the click, the
     mutation, or the request — and the page's global observers record none
     of them: a request that is never issued leaves no trace, and one that
     succeeds is not an error. Watch for them here, and put all three in the
     failure. */
  const policyPath = `/api/duet/ws/${workspaceSlug}/integrations/${toolkitSlug}/agent-policy`
  const issued: string[] = []
  const observe = (request: { method(): string; url(): string }) => {
    if (new URL(request.url()).pathname === policyPath) issued.push(request.method())
  }
  page.on('request', observe)
  try {
    const [response] = await Promise.all([
      page
        .waitForResponse(
          candidate =>
            candidate.request().method() === 'PUT' &&
            new URL(candidate.url()).pathname === policyPath,
        )
        .catch(async (error: unknown) => {
          const flipped = (await checkbox.isChecked()) === checked
          const busy = await editor.getAttribute('aria-busy')
          throw new Error(
            `policy save for ${toolkitSlug} never answered: checkbox ${flipped ? 'flipped' : 'did not flip'}, ` +
              `editor aria-busy=${busy ?? 'null'}, requests to ${policyPath}: ` +
              `${issued.length === 0 ? 'none issued' : issued.join(',')} — ${String(error)}`,
          )
        }),
      checkbox.click(),
    ])
    assert.equal(response.status(), 200, `integration policy UI save returned ${response.status()}`)
    // The live query response can replace the popover's content. Reopen that
    // same connected row's dropdown before reading its settled checkbox state.
    await openAgentAccessEditor(editor)
    await waitForCheckboxEnabled(checkbox)
    await assertUiPolicy(page, toolkitSlug, {
      all: label === INTEGRATION_AGENT_ACCESS_ALL_LABEL && checked,
      checkedLabel: checked ? label : undefined,
    })
  } finally {
    page.off('request', observe)
  }
}

async function openAgentAccessEditor(
  editor: ReturnType<WorkspaceBrowserJourneyContext['page']['locator']>,
): Promise<void> {
  const trigger = editor.getByRole('button')
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
    await trigger.click()
  }
}

async function waitForCheckboxEnabled(
  checkbox: ReturnType<WorkspaceBrowserJourneyContext['page']['getByRole']>,
): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    if (await checkbox.isEnabled()) return
    if (Date.now() >= deadline) throw new Error('Timed out waiting for integration policy editor')
    await Bun.sleep(100)
  }
}

async function assertUiPolicy(
  page: WorkspaceBrowserJourneyContext['page'],
  toolkitSlug: string,
  expected: { all: boolean; checkedLabel?: string },
): Promise<void> {
  const editor = page.locator(`[data-integration-agent-access="${toolkitSlug}"]`)
  const panel = page.locator(`[data-integration-agent-access-panel="${toolkitSlug}"]`)
  await editor.waitFor()
  await openAgentAccessEditor(editor)
  assert.equal(
    await panel
      .getByRole('checkbox', { name: INTEGRATION_AGENT_ACCESS_ALL_LABEL, exact: true })
      .isChecked(),
    expected.all,
  )
  if (expected.checkedLabel !== undefined) {
    assert(
      await panel.getByRole('checkbox', { name: expected.checkedLabel, exact: true }).isChecked(),
      `${expected.checkedLabel} was not checked`,
    )
  }
}

function equalStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isTerminalStatus(status: string): boolean {
  return AGENT_TERMINAL_STATES.some(terminal => terminal === status)
}
