import assert from 'node:assert/strict'

import type { ConvexHttpClient } from 'convex/browser'

import { AgentResponseSchema, MAX_AGENT_NAME_LENGTH, type Agent } from '@repo/contract'

import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import type { LiveEnv, Workspace } from './staging-live-env.ts'

// Only the two fields this helper reads, so browser journeys — whose env is a
// narrower slice than LiveEnv — can reuse it without widening their contract.
export type StagingAgentFixtureEnv = Pick<LiveEnv, 'apiUrl' | 'internalKey'>
import { apiJson, apiText, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import { workspaceIsDeleted, type StagingResourceLedger } from './staging-live-resource-ledger.ts'

export async function provisionStagingAgent(args: {
  env: StagingAgentFixtureEnv
  workspace: Workspace
  apiToken: string
  runId: string
  slug: string
  name: string
  description: string
  anchorPath?: string
  ledger: StagingResourceLedger
  convex: ConvexHttpClient
  artifacts: StagingArtifactCollector
}): Promise<Agent> {
  const { env, workspace, apiToken, runId, slug, description, ledger, convex, artifacts } = args
  // Clamped here, not asked of every caller. Agent names cap at
  // MAX_AGENT_NAME_LENGTH and a runId is longer than the room a label leaves, so
  // any caller composing `${label} ${runId}` 400s the register before its leg
  // runs — which is exactly what happened, twice, in two different legs. A test
  // agent's display name has no reader; fitting is the only thing it owes.
  const name = args.name.slice(0, MAX_AGENT_NAME_LENGTH)
  const anchorPath = args.anchorPath ?? `agents/${slug}`
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`

  await apiJson(
    `${base}/files/actions`,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({ operation: 'mkdir', path: anchorPath, recursive: true }),
    },
    200,
    'agent fixture anchor mkdir',
    artifacts,
  )
  await apiText(
    `${base}/files/${anchorPath}/AGENTS.md`,
    {
      method: 'PUT',
      headers: bearer(apiToken, { 'content-type': 'text/markdown' }),
      body: `# ${name}\n\n${description}\n`,
    },
    200,
    'agent fixture AGENTS.md write',
    artifacts,
  )
  const agent = AgentResponseSchema.parse(
    await apiJson(
      `${base}/agents`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ path: anchorPath, slug, name }),
      },
      201,
      'agent fixture register',
      artifacts,
    ),
  ).agent
  ledger.record({
    kind: 'agent',
    id: agent.id,
    label: `${runId}:agent:${slug}`,
    cleanup: async () => {
      const response = await stagingFetch(`${base}/agents/${slug}`, {
        method: 'DELETE',
        headers: bearer(apiToken),
      })
      assert(
        [200, 404, 502].includes(response.status),
        `agent fixture cleanup returned HTTP ${response.status}`,
      )
    },
    verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
  })
  return agent
}

/**
 * Complete (or reset) an agent's onboarding through the public onboarded
 * route. Only an agent whose config declares onboarding is ever locked, so this
 * is for journeys exercising that lock; an ordinary agent is usable as a
 * session owner the moment it is registered and must not be stamped here.
 */
export async function markStagingAgentOnboarded(args: {
  env: Pick<StagingAgentFixtureEnv, 'apiUrl'>
  workspace: Workspace
  apiToken: string
  slug: string
  onboarded?: boolean
  artifacts: StagingArtifactCollector
}): Promise<Agent> {
  const { env, workspace, apiToken, slug, artifacts, onboarded = true } = args
  const { agent } = AgentResponseSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/agents/${slug}/onboarded`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ onboarded }),
      },
      200,
      'agent fixture onboarded',
      artifacts,
    ),
  )
  assert.equal(
    agent.onboardedAt !== undefined,
    onboarded,
    `${slug} did not become ${onboarded ? 'onboarded' : 'locked'}`,
  )
  return agent
}
