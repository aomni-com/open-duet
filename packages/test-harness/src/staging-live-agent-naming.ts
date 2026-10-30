import assert from 'node:assert/strict'

import { AgentListResponseSchema, ROOT_AGENT_SCOPE, type Agent } from '@repo/contract'

import type { LiveEnv, Workspace } from './staging-live-env.ts'
import { apiJson, bearerJson } from './staging-live-http.ts'

/**
 * Agent naming, end to end on deployed staging.
 *
 * One leg here cannot be proved anywhere else: a rename surviving workspace
 * onboarding needs the real first-write-wins path, and that ordering is what
 * would quietly make the rename endpoint a no-op for every workspace that had
 * already onboarded. The others are here because a display name is threaded
 * through four layers — request schema, Convex validator, agent row, whoami —
 * and each has its own way of dropping a field.
 *
 * NOT covered here: the marketplace install name surviving a publisher pull.
 * That needs a real listing refresh against a publisher this journey does not
 * own, so it is pinned in `packages/backend/src/marketplace.test.ts` instead.
 * Worth adding if this journey ever gains a listing of its own.
 */
export interface AgentNamingEvidence {
  /** The agent's slug, which the display name never touches. */
  slug: string
  /** The name after a re-register that mentioned no metadata. */
  nameAfterReregister: string
  /** The default agent's name after rename, read from whoami. */
  duetName: string
  /** The default agent's name after onboarding ran on top of the rename. */
  duetNameAfterOnboarding: string
}

export async function runAgentNamingJourney(args: {
  env: LiveEnv
  login: { token: string }
  workspace: Workspace
  runId: string
  progress: (stage: string) => void
}): Promise<AgentNamingEvidence> {
  const { env, login, workspace, runId, progress } = args
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const headers = bearerJson(login.token)

  // Leg 1 — an agent registered with a name, then re-registered without one.
  // This is the `manage-agents` shape: create, then a later call that mentions
  // only what it is changing. Convex deletes a field patched to `undefined`, so
  // the second call used to clear the name and drop the agent back to its slug.
  progress('agent-naming:register')
  const slug = `e2e-naming-${runId.slice(-8)}`
  const chosen = `E2E Named ${runId.slice(-4)}`
  await apiJson(
    `${base}/files/${encodeURIComponent(`agents/${slug}`)}`,
    { headers, method: 'POST', body: JSON.stringify({ kind: 'directory' }) },
    201,
    'agent-naming:mkdir',
  )
  await apiJson(
    `${base}/agents`,
    {
      headers,
      method: 'POST',
      body: JSON.stringify({ path: `agents/${slug}`, slug, name: chosen }),
    },
    201,
    'agent-naming:register',
  )

  progress('agent-naming:re-register')
  await apiJson(
    `${base}/agents`,
    { headers, method: 'POST', body: JSON.stringify({ path: `agents/${slug}`, slug }) },
    201,
    'agent-naming:re-register',
  )
  const afterReregister = await listAgents(base, headers)
  const reregistered = afterReregister.find(agent => agent.slug === slug)
  assert.ok(reregistered, `re-registered agent ${slug} is missing from the roster`)
  assert.equal(
    reregistered.name,
    chosen,
    'a re-register that mentioned no name must preserve the one already chosen',
  )

  // Leg 2 — rename the default agent, which has no row at all.
  progress('agent-naming:rename-default')
  const duetName = `Milo ${runId.slice(-4)}`
  const renamed = await apiJson<{ name: string }>(
    `${base}/agents/${ROOT_AGENT_SCOPE}`,
    { headers, method: 'PATCH', body: JSON.stringify({ name: duetName }) },
    200,
    'agent-naming:rename-default',
  )
  assert.equal(renamed.name, duetName, 'the default-agent rename must echo the stored name')
  assert.equal(
    await duetNameOf(env, login, workspace.slug),
    duetName,
    'the renamed default agent must be visible on whoami',
  )

  // Renaming the default agent must not have minted an agent row for it.
  const afterRename = await listAgents(base, headers)
  assert.ok(
    !afterRename.some(agent => agent.slug === ROOT_AGENT_SCOPE),
    'renaming the default agent must not create an agent row',
  )

  // Leg 3 — onboarding on top of the rename. Onboarding is first-write-wins by
  // design, so a workspace that renamed first must keep its name. This is the
  // ordering that would make the whole rename endpoint a silent no-op.
  //
  // The onboarding call must SUCCEED for this to mean anything: a failed request
  // leaves `duetName` untouched too, so swallowing the error would let the
  // assertion below pass against an endpoint that is simply broken.
  progress('agent-naming:onboarding-after-rename')
  await apiJson(
    `${base}/onboarding`,
    {
      headers,
      method: 'POST',
      body: JSON.stringify({ duetName: 'Onboarded Over The Top', selectedNames: [] }),
    },
    200,
    'agent-naming:onboarding',
  )
  const duetNameAfterOnboarding = await duetNameOf(env, login, workspace.slug)
  assert.equal(
    duetNameAfterOnboarding,
    duetName,
    'workspace onboarding must not overwrite an explicit default-agent rename',
  )

  return {
    slug,
    nameAfterReregister: reregistered.name ?? '',
    duetName,
    duetNameAfterOnboarding,
  }
}

async function listAgents(base: string, headers: Headers): Promise<readonly Agent[]> {
  const body = await apiJson(`${base}/agents`, { headers, method: 'GET' }, 200, 'agent-naming:list')
  return AgentListResponseSchema.parse(body).items
}

async function duetNameOf(
  env: LiveEnv,
  login: { token: string },
  workspaceSlug: string,
): Promise<string | undefined> {
  const whoami = await apiJson<{ workspaces: Array<{ slug: string; duetName?: string }> }>(
    `${env.apiUrl}/v1/whoami`,
    { headers: bearerJson(login.token), method: 'GET' },
    200,
    'agent-naming:whoami',
  )
  return whoami.workspaces.find(workspace => workspace.slug === workspaceSlug)?.duetName
}
