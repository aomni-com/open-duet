import { expect } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import {
  type GatewayRunnerInputRequest,
  type AgentTurnState,
  type ApprovedModel,
  createApprovedModelCatalog,
  defaultTierFor,
  hashApiKey,
  MAX_AGENT_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  type ModelTierId,
  type ModelSelectionId,
  type IntegrationConnection,
} from '@repo/contract'

export const DEFAULT_CHAT_TIER: ModelTierId = defaultTierFor({ subscriber: true, plan: 'starter' })

export function runnerInputReceipt(
  body: Pick<GatewayRunnerInputRequest, 'throughSeq'>,
  disposition: 'live' | 'hydrated' | 'duplicate' = 'live',
): Response {
  return Response.json({ acceptedThroughSeq: body.throughSeq, disposition })
}

export const ISO_TIMESTAMP_PATTERN = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function escapeXmlLikeRenderer(value: string): string {
  const escapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return value.replace(/[&<>"']/g, character => escapes[character]!)
}

export type EnvelopeSender =
  | { kind: 'user'; email?: string }
  | { kind: 'app'; appId: string; slug?: string }
  | { kind: 'session'; sessionId: string; agentSlug?: string; agentName?: string }
  | { kind: 'system' }

export function envelopeIdentity(sender: EnvelopeSender): string {
  switch (sender.kind) {
    case 'user':
      return ` user_email="${sender.email ?? owner.user.email}"`
    case 'app':
      return ` app_id="${sender.appId}"${sender.slug === undefined ? '' : ` app_slug="${sender.slug}"`}`
    case 'session':
      // A session inside an agent is enriched with that agent's current slug
      // and name at composition time (agent-delegation slice 02); a root or
      // agentless session stays id-only.
      return (
        ` session_id="${sender.sessionId}"` +
        (sender.agentSlug === undefined ? '' : ` agent_slug="${sender.agentSlug}"`) +
        (sender.agentName === undefined ? '' : ` agent_name="${sender.agentName}"`)
      )
    case 'system':
      return ''
  }
}

// Backend delivery renders one sender-attributed envelope per durable input and
// the API only forwards it, so these tests pin the WIRING — which rows reached
// the gateway, under which author — while the exact grammar stays owned by the
// renderer's byte fixtures in @repo/backend. Only the row clock is a wildcard.
export function envelopePattern(spec: {
  seq: number
  body: string
  role?: 'message' | 'note'
  answer?: true
  sender?: EnvelopeSender
}): string {
  const sender: EnvelopeSender = spec.sender ?? { kind: 'user' }
  const element = `${sender.kind}_${spec.role ?? 'message'}`
  return (
    escapeRegExp(`<${element} seq="${spec.seq}" timestamp="`) +
    ISO_TIMESTAMP_PATTERN +
    escapeRegExp(
      `"${spec.answer === true ? ' kind="answer"' : ''}${envelopeIdentity(sender)}>` +
        `${escapeXmlLikeRenderer(spec.body)}</${element}>`,
    )
  )
}

export function composedRunnerMessage(spec: {
  seq: number
  body: string
  notes?: Array<{ seq: number; body: string; sender?: EnvelopeSender }>
  answer?: true
  sender?: EnvelopeSender
}): string {
  const primary = envelopePattern(spec)
  const notes = spec.notes ?? []
  const source =
    notes.length === 0
      ? primary
      : [
          escapeRegExp('<queued_notes>'),
          ...notes.map(
            note =>
              `  ${envelopePattern({
                seq: note.seq,
                body: note.body,
                role: 'note',
                ...(note.sender === undefined ? {} : { sender: note.sender }),
              })}`,
          ),
          escapeRegExp('</queued_notes>'),
          primary,
        ].join('\n')
  return expect.stringMatching(new RegExp(`^${source}$`)) as unknown as string
}

// A runner reads its instruction out of the envelope it was sent; the fakes
// below echo that body back so their assertions stay about the wiring.
export function primaryEnvelopeBody(message: string): string {
  const body = message.match(
    /^(?:[\s\S]*<\/queued_notes>\n)?<\w+_message [^>]*>([\s\S]*)<\/\w+_message>$/,
  )?.[1]
  if (body === undefined) throw new Error(`Not a runner input envelope: ${message}`)
  return body
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

/**
 * What every runner request says about the workspace it launches in. Shared by
 * both expectation builders because a field added to the launch wire has to
 * appear in both, and a second copy only agrees until someone edits one.
 */
type ExpectedLaunchSpec = {
  tier?: ModelSelectionId
  cwd?: string
}

function expectedLaunch(
  spec: ExpectedLaunchSpec & { createdBySessionId?: string; defaultSession?: true },
) {
  return {
    tier: spec.tier ?? DEFAULT_CHAT_TIER,
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    ...(spec.createdBySessionId === undefined
      ? {}
      : { createdBySessionId: spec.createdBySessionId }),
    ...(spec.defaultSession === undefined ? {} : { defaultSession: spec.defaultSession }),
  }
}

export function expectedRunnerInput(
  spec: {
    throughSeq: number
    message: string
    seq?: number
    notes?: Array<{ seq: number; body: string; sender?: EnvelopeSender }>
    sender?: EnvelopeSender
    behavior: 'steer' | 'follow_up'
    images?: Array<{
      data: string
      mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'
    }>
    createdBySessionId?: string
    defaultSession?: true
  } & ExpectedLaunchSpec,
): GatewayRunnerInputRequest {
  return {
    attemptId: expect.any(String) as unknown as string,
    throughSeq: spec.throughSeq,
    input: {
      kind: 'prompt',
      message: composedRunnerMessage({
        seq: spec.seq ?? spec.throughSeq,
        body: spec.message,
        ...(spec.notes === undefined ? {} : { notes: spec.notes }),
        ...(spec.sender === undefined ? {} : { sender: spec.sender }),
      }),
      behavior: spec.behavior,
      ...(spec.images === undefined ? {} : { images: spec.images }),
    },
    launch: expectedLaunch(spec),
  }
}

export function expectedRunnerAnswer(
  spec: {
    throughSeq: number
    answer: string
    seq?: number
    notes?: Array<{ seq: number; body: string; sender?: EnvelopeSender }>
    sender?: EnvelopeSender
  } & ExpectedLaunchSpec,
): GatewayRunnerInputRequest {
  return {
    attemptId: expect.any(String) as unknown as string,
    throughSeq: spec.throughSeq,
    input: {
      kind: 'answer',
      answer: composedRunnerMessage({
        seq: spec.seq ?? spec.throughSeq,
        body: spec.answer,
        answer: true,
        ...(spec.notes === undefined ? {} : { notes: spec.notes }),
        ...(spec.sender === undefined ? {} : { sender: spec.sender }),
      }),
    },
    launch: expectedLaunch(spec),
  }
}
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  settleWorkspaceProvisioning,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { createApiApp, type IntegrationProvider } from './index'

export const BACKEND_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'packages/backend',
)
export const INTERNAL_KEY = 'test-api-internal-key'
export const IMAGE_REF = 'ttl.sh/duet-test-slice05:1h'
export const SYNCTHING_DEVICE_ID_ONE =
  'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'
export const SYNCTHING_DEVICE_ID_TWO =
  'A5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'

export const SKILLS_FIXTURE_MODEL: ApprovedModel = {
  id: 'fixture:skills-chat',
  gatewayModelId: 'fixture/skills-chat',
  kind: 'chat',
  name: 'Skills fixture chat',
  simpleName: 'skills fixture',
  description: 'Synthetic model for API skills delivery tests',
  internal: true,
}

export function skillsFixtureCatalog(model: ApprovedModel = SKILLS_FIXTURE_MODEL) {
  return createApprovedModelCatalog([model])
}

export let convex: ConvexDevFixture
export let app: ReturnType<typeof createApiApp>
export let owner: SignedInUser
export let workspace: WorkspaceRow['workspace']
export let sequence = 0

// Imported bindings are read-only, so tests advance the shared counter through
// this instead of `sequence++`.
export function nextSequence(): number {
  sequence += 1
  return sequence
}

/**
 * One API suite deployment per test FILE: the api v1 suite is split across
 * topic slice files (auth/vm/apps/sessions/train/billing.test.ts), each of
 * which boots its own
 * deployment through these hooks — shared-nothing between slices, so the
 * kit's module state is naturally per-slice. The topics and the placement
 * rule for new tests live in the README's "Test suite shape" section.
 */
export async function bootApiSuite(): Promise<void> {
  convex = await convexDev(BACKEND_DIR, {
    env: {
      ...generateAuthKeys(),
      DUET_API_INTERNAL_KEY: INTERNAL_KEY,
      DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
      DUET_TEST_AUTH_EMAIL: '1',
      DUET_TEST_AUTH_GOOGLE: '1',
      DUET_TEST_FAKE_EXE: '1',
      DUET_TEST_FAKE_STRIPE: '1',
      DUET_API_URL: 'https://api.example',
      DUET_VM_IMAGE_REF: IMAGE_REF,
      DUET_APP_URL: 'http://localhost:3000',
      // Marketplace subscription projection derives per-listing source URLs
      // from the edge host and fails closed without one.
      DUET_EDGE_HOST: 'edge-staging.duet.so',
      STRIPE_STARTER_RECURRING_PRICE_ID: 'price_test_starter',
      STRIPE_PRO_RECURRING_PRICE_ID: 'price_test_pro',
      STRIPE_MAX_RECURRING_PRICE_ID: 'price_test_max',
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_test_duet',
    },
    reset: true,
  })
  app = createApiApp({
    convexUrl: convex.url,
    internalKey: INTERNAL_KEY,
    appUrl: 'http://localhost:3000',
  })
  owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('api-owner'), 'API Owner')
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
    plan: 'starter',
  })
  workspace = (await listMine(owner.client))[0]!.workspace
  await completeWorkspaceForTest(owner.client, workspace._id)
}

export async function stopApiSuite(): Promise<void> {
  await convex?.stop()
}

const humanFixtureMemberships: string[] = []

export async function resetApiSuiteBetweenTests(): Promise<void> {
  for (const membershipId of humanFixtureMemberships.splice(0)) {
    await mutate(owner.client, 'testing/workspaces:deleteMembershipGenerationForTest', {
      internalKey: INTERNAL_KEY,
      membershipId,
      now: Date.now(),
    })
  }
  await mutate(owner.client, 'testing/workspaces:resetCurrentUserWorkspaceMembershipsForTest', {
    internalKey: INTERNAL_KEY,
    keepWorkspaceId: workspace._id,
  })
}

/** A fresh human with a current role, or no membership when role is null. */
export async function humanWorkspaceFixture(
  workspaceId: string,
  role: WorkspaceRow['role'] | null,
): Promise<SignedInUser> {
  const person = await signInWithMagicLink<UserRow>(convex, uniqueEmail('api-member'), 'API Member')
  if (role !== null) {
    const membershipId = (await mutate(
      owner.client,
      'testing/workspaces:addWorkspaceMemberForTest',
      { internalKey: INTERNAL_KEY, workspaceId, userId: person.user._id, role },
    )) as string
    humanFixtureMemberships.push(membershipId)
  }
  return person
}

export async function mintHumanDeviceKey(clientName: string): Promise<string> {
  const codeResponse = await postJson('/v1/device/code', {
    client_name: clientName,
  })
  expect(codeResponse.status).toBe(200)
  const code = (await codeResponse.json()) as DeviceCodeResponse
  await mutateDeviceApproval(owner.client, 'approve', code.user_code)
  const tokenResponse = await postJson('/v1/device/token', { device_code: code.device_code })
  expect(tokenResponse.status).toBe(200)
  const token = (await tokenResponse.json()) as DeviceTokenResponse
  expect(token.status).toBe('approved')
  expect(token).not.toHaveProperty('scopes')
  expect(token).not.toHaveProperty('workspace')
  return token.access_token!
}

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await postJson('/v1/device/code', {})
  expect(response.status).toBe(200)
  return (await response.json()) as DeviceCodeResponse
}

// A dedicated workspace for identity fixtures: adding members to the
// suite-shared workspace breaks later tests that pin its member list.
export async function createIdentityWorkspace(
  client: ConvexHttpClient,
  label: string,
): Promise<{ id: string; slug: string; name: string }> {
  const slug = uniqueSlug(label)
  const name = `Identity ${label}`
  const id = (await mutate(client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug,
    name,
  })) as string
  return { id, slug, name }
}

export async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function oauthToken(body: Record<string, string>): Promise<
  | {
      response: Response
      tokens: {
        access_token: string
        refresh_token: string
        expires_in: number
        token_type: 'Bearer'
        scope: string
      }
      error?: never
    }
  | { response: Response; error: unknown; tokens?: never }
> {
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const payload = await response.json()
  return response.ok
    ? {
        response,
        tokens: payload as {
          access_token: string
          refresh_token: string
          expires_in: number
          token_type: 'Bearer'
          scope: string
        },
      }
    : { response, error: payload }
}

export async function deviceApprovalRequest(
  action: 'inspect' | 'approve' | 'deny',
  key: string,
  userCode: string,
): Promise<Response> {
  return await authedWith(app, `/v1/device/${action}`, key, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userCode }),
  })
}

export async function authed(path: string, key: string): Promise<Response> {
  return await app.request(path, { headers: { authorization: `Bearer ${key}` } })
}

export async function mintBrowserSession(client: ConvexHttpClient): Promise<string> {
  const session = (await mutate(client, 'domains/apiKeys/mutations:mintBrowserSession', {})) as {
    token: string
  }
  return session.token
}

export async function authedWith(
  targetApp: ReturnType<typeof createApiApp>,
  path: string,
  key: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${key}`)
  return await targetApp.request(path, { ...init, headers })
}

export function waitUntilCollector() {
  const pending: Promise<unknown>[] = []
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise)
    },
    async drain() {
      await Promise.all(pending.splice(0))
    },
  }
}

export async function revokeKey(client: ConvexHttpClient, prefix: string): Promise<void> {
  const keys = await listUserKeys(client)
  const key = keys.find(candidate => candidate.prefix === prefix)
  expect(key).toBeDefined()
  await mutate(client, 'domains/apiKeys/userApi:revoke', {
    internalKey: INTERNAL_KEY,
    actorId: await currentUserId(client),
    keyId: key!.id,
    now: Date.now(),
  })
}

export async function listUserKeys(client: ConvexHttpClient): Promise<ListedKey[]> {
  const result = (await query(client, 'domains/apiKeys/userApi:list', {
    internalKey: INTERNAL_KEY,
    actorId: await currentUserId(client),
    paginationOpts: { cursor: null, numItems: 100 },
  })) as { page: ListedKey[] }
  return result.page
}

export async function mutateDeviceApproval(
  client: ConvexHttpClient,
  action: 'approve' | 'deny',
  userCode: string,
): Promise<unknown> {
  return await mutate(client, `domains/apiKeys/deviceApi:${action}`, {
    internalKey: INTERNAL_KEY,
    actorId: await currentUserId(client),
    userCode,
    now: Date.now(),
  })
}

export async function currentUserId(client: ConvexHttpClient): Promise<string> {
  return ((await query(client, 'domains/users/queries:current', {})) as { _id: string })._id
}

/**
 * Most API route tests exercise an already usable workspace. Keep that fixture
 * state explicit now that real workspaces remain incomplete until card setup
 * and onboarding completion; tests that cover the lifecycle pass their own
 * incomplete workspace instead.
 */
export async function completeWorkspaceForTest(
  client: ConvexHttpClient,
  workspaceId: string,
): Promise<void> {
  const now = Date.now()
  await mutate(client, 'testing/workspaces:markWorkspaceOnboardedForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now,
    duetName: 'Test User',
  })
}

export async function provisionRegisteredWorkspace(
  slug: string,
  workspaceOwner: SignedInUser = owner,
  existingWorkspaceId?: string,
): Promise<{ workspaceId: string; slug: string; vmToken: string }> {
  // Fresh rows are born here with no provisioning actors; a workspace that
  // already exists (signup-birthed, product-created) carries a live attach
  // run whose re-prepare would race the pair — settle it first, so the pair
  // below is deterministically single-shot.
  if (existingWorkspaceId !== undefined) {
    await settleWorkspaceProvisioning(workspaceOwner.client, {
      internalKey: INTERNAL_KEY,
      workspaceId: existingWorkspaceId,
    })
  }
  const provisioningToken = `provision-${slug}`
  const now = Date.now()
  const workspace = (await mutate(
    workspaceOwner.client,
    'testing/workspaces:prepareWorkspaceForRegistration',
    {
      internalKey: INTERNAL_KEY,
      actorId: workspaceOwner.user._id,
      ...(existingWorkspaceId === undefined ? {} : { workspaceId: existingWorkspaceId }),
      slug,
      name: 'Files Proxy Workspace',
      imageRef: IMAGE_REF,
      provisioningTokenHash: await hashApiKey(provisioningToken),
      provisioningTokenExpiresAt: now + 60_000,
      now,
    },
  )) as { workspaceId: string }
  const registered = (await mutate(
    workspaceOwner.client,
    'domains/workspaces/provisioning:registerVm',
    {
      internalKey: INTERNAL_KEY,
      provisioningTokenHash: await hashApiKey(provisioningToken),
      workspaceHint: workspace.workspaceId,
      vmName: 'duet-test-files-proxy',
      sshDest: 'exedev@duet-test-files-proxy.exe.xyz',
      httpsUrl: 'https://gateway-proxy.exe.xyz',
      now: now + 1,
    },
  )) as { vmToken: string }
  return { workspaceId: workspace.workspaceId, slug, vmToken: registered.vmToken }
}

export async function waitForRegisteredGateway(vmToken: string): Promise<void> {
  // Registration lands via async work the suite does not drive; under suite
  // load it legitimately takes more than eventually()'s default 5s window —
  // the contract is that it lands, not that the machine was idle.
  await eventually(async () => {
    expect(
      await convex.query('domains/workspaces/provisioning:gatewayConnectionByVmToken', {
        internalKey: INTERNAL_KEY,
        vmTokenHash: await hashApiKey(vmToken),
      }),
    ).not.toBeNull()
  }, 20_000)
}

export async function vmSyncRequest(
  targetApp: ReturnType<typeof createApiApp>,
  vmToken: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return await targetApp.request('/v1/vm/sync', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${vmToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      needsModelCredentials: false,
      versions: { runtime: '1.0.0', image: '1.0.0' },
      ...body,
    }),
  })
}

export async function prepareWorkspaceForHttpRegistration(
  slug: string,
  name: string,
  lifecycleBackupId?: string,
): Promise<{ workspaceId: string; provisioningToken: string }> {
  const provisioningToken = `provision-${slug}`
  const now = Date.now()
  const prepared = (await mutate(
    owner.client,
    'testing/workspaces:prepareWorkspaceForRegistration',
    {
      internalKey: INTERNAL_KEY,
      actorId: owner.user._id,
      slug,
      name,
      imageRef: IMAGE_REF,
      lifecycleBackupId,
      provisioningTokenHash: await hashApiKey(provisioningToken),
      provisioningTokenExpiresAt: now + 60_000,
      now,
    },
  )) as { workspaceId: string }
  return { workspaceId: prepared.workspaceId, provisioningToken }
}

export async function rawWorkspace(workspaceId: string): Promise<Record<string, unknown>> {
  const rows = (await convex.query('testing/workspaces:rawWorkspacesForTest', {
    internalKey: INTERNAL_KEY,
  })) as Array<Record<string, unknown>>
  const row = rows.find(candidate => candidate._id === workspaceId)
  expect(row).toBeDefined()
  return row!
}

export async function eventually(
  assertion: () => Promise<void>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('eventually timed out')
}

export async function grantCredits(workspaceId: string, reference: string): Promise<void> {
  await setCredits(workspaceId, 10_000_000, reference)
}

export async function setCredits(
  workspaceId: string,
  targetMicroUsd: number,
  reference: string,
): Promise<void> {
  const current = (await convex.mutation('domains/credits/internal:runPreflight', {
    internalKey: INTERNAL_KEY,
    workspaceId,
  })) as { balanceMicroUsd: number }
  await convex.mutation('domains/credits/internal:applyLedgerEntry', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    amountMicroUsd: targetMicroUsd - current.balanceMicroUsd,
    type: 'adjustment',
    reference,
  })
}

export async function createAgentSession(
  workspaceId: string,
  prompt: string,
  now: number,
  cwd?: string,
  actorId = owner.user._id,
): Promise<{ sessionId: string; status: string; lastEventSeq: number }> {
  const created = (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    actorId,
    identity: { principal: { kind: 'human', userId: actorId }, actorId },
    workspaceId,
    attemptId: `test:${crypto.randomUUID()}`,
    input: {
      kind: 'initial_prompt',
      prompt,
      behavior: 'steer',
      sender: { kind: 'user', userId: actorId },
      ...(cwd === undefined ? {} : { cwd }),
    },
    now,
  })) as { sessionId: string; status: string; dispatch: { throughSeq: number } }
  return { ...created, lastEventSeq: created.dispatch.throughSeq }
}

export async function appendAgentNote(
  workspaceId: string,
  sessionId: string,
  note: string,
  now: number,
): Promise<void> {
  await convex.mutation('domains/agentSessions/model:appendSessionNote', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    sessionId,
    note,
    sender: { kind: 'user', userId: owner.user._id },
    now,
  })
}

export async function relayAgentEvent(
  targetApp: ReturnType<typeof createApiApp>,
  vmToken: string,
  sessionId: string,
  event: Record<string, unknown>,
  acceptedThroughSeq?: number,
): Promise<unknown> {
  const response = await targetApp.request(`/v1/vm/agent/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${vmToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      relayId: crypto.randomUUID(),
      event,
      ...(acceptedThroughSeq === undefined ? {} : { acceptedThroughSeq }),
    }),
  })
  expect(response.status).toBe(200)
  return await response.json()
}

export async function createBackendAgentSession(
  workspaceId: string,
  prompt: string,
): Promise<{ sessionId: string; status: string; lastEventSeq: number }> {
  const created = (await convex.mutation('domains/agentSessions/model:prepareRunnerInputDelivery', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    identity: {
      principal: { kind: 'human', userId: owner.user._id },
      actorId: owner.user._id,
    },
    workspaceId,
    attemptId: `test:${crypto.randomUUID()}`,
    input: {
      kind: 'initial_prompt',
      prompt,
      behavior: 'steer',
      sender: { kind: 'user', userId: owner.user._id },
    },
    now: Date.now(),
  })) as { sessionId: string; status: string; dispatch: { throughSeq: number } }
  return { ...created, lastEventSeq: created.dispatch.throughSeq }
}

export async function readSseEvents(
  response: Response,
  count: number,
): Promise<
  Array<{
    seq?: number
    id?: string
    eventName?: string
    event: { type: string } & Record<string, unknown>
  }>
> {
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<{
    seq?: number
    id?: string
    eventName?: string
    event: { type: string } & Record<string, unknown>
  }> = []
  try {
    while (events.length < count) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const lines = frame.split('\n')
        const data = lines.find(line => line.startsWith('data: '))?.slice('data: '.length)
        if (data !== undefined) {
          const id = lines.find(line => line.startsWith('id: '))?.slice('id: '.length)
          const eventName = lines.find(line => line.startsWith('event: '))?.slice('event: '.length)
          const row = JSON.parse(data) as {
            seq?: number
            event: { type: string } & Record<string, unknown>
          }
          events.push({
            ...(row.seq === undefined ? {} : { seq: row.seq }),
            ...(id === undefined ? {} : { id }),
            ...(eventName === undefined ? {} : { eventName }),
            event: row.event,
          })
        }
        if (events.length >= count) break
      }
    }
  } finally {
    await reader.cancel()
  }
  return events
}

export function sessionIdFromGatewayEventsUrl(url: string): string {
  const pathname = new URL(url).pathname
  const match = pathname.match(/^\/v1\/agent\/sessions\/([^/]+)\/events$/)
  if (match === null) throw new Error(`unexpected gateway events URL: ${url}`)
  return decodeURIComponent(match[1]!)
}

export function sessionIdFromGatewayInputUrl(url: string): string {
  const pathname = new URL(url).pathname
  const match = pathname.match(/^\/v1\/agent\/sessions\/([^/]+)\/input$/)
  if (match === null) throw new Error(`unexpected gateway input URL: ${url}`)
  return decodeURIComponent(match[1]!)
}

export function liveGatewaySse(
  targetApp: ReturnType<typeof createApiApp>,
  vmToken: string,
  sessionId: string,
  since: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let closed = false
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      await sleep(5)
      if (closed) return
      controller.enqueue(
        encoder.encode(
          `event: step\ndata: ${JSON.stringify({
            event: { type: 'step', step: { type: 'text_delta', delta: `live ${since + 1}` } },
          })}\n\n`,
        ),
      )
      await sleep(5)
      if (closed) return
      const event = { type: 'step', step: { type: 'text', text: `live canonical ${since + 1}` } }
      const result = (await relayAgentEvent(targetApp, vmToken, sessionId, event)) as {
        seq: number
      }
      controller.enqueue(
        encoder.encode(
          `id: ${result.seq}\nevent: step\ndata: ${JSON.stringify({
            seq: result.seq,
            event,
          })}\n\n`,
        ),
      )
      controller.close()
    },
    cancel() {
      closed = true
    },
  })
}

export async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export async function expectOneAudit(
  eventName: string,
  mutateOnce: () => Promise<unknown>,
): Promise<void> {
  const before = await auditEvents()
  await mutateOnce()
  const after = await auditEvents()
  expect(after).toHaveLength(before.length + 1)
  const event = after.at(-1)!
  expect(event.event).toBe(eventName)
  expect(event.actorId).toBe(owner.user._id)
}

export async function listMine(client: ConvexHttpClient): Promise<WorkspaceRow[]> {
  return (await query(client, 'domains/workspaces/queries:listMine', {})) as WorkspaceRow[]
}

export async function auditEvents(
  client: ConvexHttpClient = owner.client,
  workspaceId: string = workspace._id,
): Promise<AuditRow[]> {
  return (await query(client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as AuditRow[]
}

export function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

export function uniqueSlug(prefix: string): string {
  sequence += 1
  // The suffix alone guarantees uniqueness, so trim the prefix to keep the whole slug
  // inside every cap the slug has to satisfy. Without this, a long prefix plus the
  // growing sequence counter silently overflows the schema (`too_long`) only deep into
  // a suite run — an order-dependent failure that passes in isolation.
  //
  // The tighter of the two caps is the agent name's, not the slug's: an agent
  // registered by slug wears that slug as its name, and a name is 32 where a slug is
  // 40. Trimming to the slug cap alone left an eight-character window in which a slug
  // was legal and the name it became was not — and the window opened exactly when the
  // counter reached three digits, so the suite passed until somebody added a test
  // ahead of `onboarded toggles per-workspace completion` and pushed it past 99.
  const suffix = `-${Date.now()}-${sequence}`
  const prefixRoom = Math.max(1, Math.min(MAX_SLUG_LENGTH, MAX_AGENT_NAME_LENGTH) - suffix.length)
  const trimmedPrefix = prefix.slice(0, prefixRoom).replace(/-+$/, '')
  return `${trimmedPrefix}${suffix}`
}

export function runningTurnState(): AgentTurnState {
  return {
    status: 'running',
    mode: 'agent',
    agent: { status: 'running', messages: [] },
  }
}

export function waitingTurnState(): AgentTurnState {
  return {
    status: 'waiting_for_human',
    mode: 'agent',
    agent: { status: 'waiting', messages: [] },
  }
}

export function completedTurnState(): AgentTurnState {
  return {
    status: 'completed',
    mode: 'agent',
    agent: { status: 'completed', messages: [] },
  }
}

export function integrationProviderFixture(
  overrides: Partial<IntegrationProvider>,
): IntegrationProvider {
  return {
    listCatalog: async () => ({ items: [], nextCursor: null }),
    listConnections: async () => ({ items: [], nextCursor: null }),
    getConnection: async () => undefined,
    beginConnection: async () => ({
      authorizeUrl: 'https://provider.example/authorize',
    }),
    disconnect: async () => {},
    ...overrides,
  }
}

export function connection(id: string, integration: string): IntegrationConnection {
  return {
    id,
    integration,
    status: 'active',
    connectedAt: 1,
    updatedAt: 1,
  }
}

export function renderAccessMatrix(items: IntegrationConnection[], agentId: string): string {
  const labels: Record<string, string> = {
    gmail: 'absent',
    github: '[]',
    slack: '[root]',
    notion: '[agent-a]',
  }
  const rows = items.map(item => {
    const allowed = item.allowedAgentIds
    const root = allowed === undefined || allowed.includes('root') ? 'yes' : 'no'
    const agent = allowed === undefined || allowed.includes(agentId) ? 'yes' : 'no'
    const future = allowed === undefined ? 'yes' : 'no'
    return [item.integration, labels[item.integration], root, agent, future].join('\t')
  })
  return ['toolkit\tpolicy\troot\tagent-a\tfuture', ...rows].join('\n')
}

export interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

export interface UserRow {
  _id: string
  email: string
  name?: string
}

export interface FeedbackRow {
  content: string
  source?: string
  createdAt: number
}

export interface WorkspaceRow {
  role: 'owner' | 'editor' | 'viewer'
  workspace: {
    _id: string
    slug: string
    name: string
    status: string
    billingUserId: string
  }
}

export interface ListedKey {
  id: string
  prefix: string
  revokedAt?: number
}

export interface RawApiKeyRow {
  _id: string
  prefix: string
  hashedKey: string
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface DeviceTokenResponse {
  status: string
  access_token?: string
}

export interface AuditRow {
  event: string
  actorId: string
}

export function apiStateMachineFixture() {
  return {
    definition: {
      name: 'Deployment relay',
      prompt: 'Wait then inspect deployment.',
      states: [
        { name: 'wait', kind: 'timer', wakeAfterMs: '1h' },
        { name: 'inspect', kind: 'agent', prompt: 'Inspect deployment.' },
        { name: 'done', kind: 'terminal', status: 'completed' },
      ],
    },
    prompt: 'Deployment reminder',
    currentState: 'wait',
    progress: { states: { wait: { runs: 1, sleeps: 0 } } },
    history: [],
    createdAt: 1,
    updatedAt: 2,
  }
}

export interface AnchorRow {
  id: string
  workspaceId: string
  path: string
  kind: 'app' | 'agent' | 'publish' | 'share-root'
  settings: unknown
  state: 'active' | 'broken'
  createdAt: number
  updatedAt: number
}

// Re-exports so the slice files can import every suite dependency from one place.
export { createHash } from 'node:crypto'
export { mkdtemp, rm, writeFile } from 'node:fs/promises'
export { tmpdir } from 'node:os'
export { dirname, join } from 'node:path'
export { fileURLToPath } from 'node:url'
export type { ConvexHttpClient } from 'convex/browser'
export { createApprovedModelCatalog, hashApiKey, MAX_SLUG_LENGTH } from '@repo/contract'
export type {
  App,
  AppResponse,
  GatewayRunnerInputRequest,
  AgentTurnState,
  ApprovedModel,
  GatewayAnchor,
  RuntimeReleaseDescriptor,
  ModelTierId,
  IntegrationConnection,
  SessionListPage,
  SessionHistoryPage,
  SessionTimelineEntry,
  RunnerDeliveryAttempt,
} from '@repo/contract'
export { SESSION_WAIT_TIMEOUT_MS } from './session-wait'
export {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  uniqueEmail,
} from '@repo/test-harness'
export type { ConvexDevFixture } from '@repo/test-harness'
export { createApiApp } from './index'
export type { IntegrationProvider } from './index'

// Restored re-exports (pruned by mistake alongside unused imports).
export {
  BillingHistoryPageSchema,
  BillingHostedSessionResponseSchema,
  DUET_ACTOR_CONTEXT_HEADER,
  DUET_APP_ACCESS_QUERY,
  FileErrorSchema,
  IntegrationAgentPolicyResponseSchema,
  IntegrationConnectResponseSchema,
  ROOT_AGENT_SCOPE,
  SessionActivityResponseSchema,
  SessionCreateResponseSchema,
  SessionReadResponseSchema,
  SessionSummarySchema,
  SubscriptionPlanChangeResponseSchema,
  UserBillingOverviewSchema,
  VmRegisterResponseSchema,
  VmSyncResponseSchema,
  WorkspaceCreateResultSchema,
  X_DUET_GATEWAY_CODE_HEADER,
  X_DUET_GATEWAY_HEADER,
  urlToUploadFilename,
  verifyAppAccessGrant,
} from '@repo/contract'
export { issueKey } from '@repo/test-harness'
export { TEST_AUTH_CODE }
export { IntegrationConnectionListSchema } from '@repo/contract'
export { APPROVED_MODELS } from '@repo/contract'
