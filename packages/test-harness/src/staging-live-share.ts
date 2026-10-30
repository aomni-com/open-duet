import assert from 'node:assert/strict'

import type { ConvexHttpClient } from 'convex/browser'

import {
  IncomingShareResponseSchema,
  PendingShareListResponseSchema,
  ShareResponseSchema,
} from '@repo/contract'

import type { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { fnMutation, fnQuery, type LiveEnv, type Workspace } from './staging-live-env.ts'
import {
  apiJson,
  apiText,
  assertResponse,
  bearer,
  bearerJson,
  stagingFetch,
  timedFetch,
} from './staging-live-http.ts'
import { workspaceIsDeleted, type StagingResourceLedger } from './staging-live-resource-ledger.ts'
import { assertWorkspaceCanBecomeActive, waitForWorkspace } from './staging-live-streaming.ts'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface ShareByteArrivalContext {
  env: LiveEnv
  convex: ConvexHttpClient
  ledger: StagingResourceLedger
  artifacts: StagingArtifactCollector
  runId: string
  ownerEmail: string
  originToken: string
  browserToken: string
  originWorkspace: Workspace
  recipientWorkspace: { id: string; slug: string }
}

export async function runShareByteArrivalAcceptance(args: ShareByteArrivalContext): Promise<{
  latencyMs: number
  relocationMs: number
  reverseLatencyMs: number
  recipientVmName: string
}> {
  const expectedGatewayVersion = args.originWorkspace.runtimeVersion
  assert(expectedGatewayVersion !== undefined, 'origin workspace omitted its gateway version')
  const recipient = await waitForWorkspace(
    args.convex,
    args.env.internalKey,
    args.recipientWorkspace.id,
    workspace => {
      assertWorkspaceCanBecomeActive(workspace)
      return (
        workspace.status === 'active' &&
        workspace.vmName !== undefined &&
        workspace.lastHeartbeatAt !== undefined &&
        workspace.runtimeVersion === expectedGatewayVersion
      )
    },
  )
  assert(recipient.vmName !== undefined, 'active recipient workspace omitted its VM name')

  const sourceRoot = `share-live/${args.runId}`
  const mountRoot = `shared/${args.runId}`
  const relocatedMountRoot = `${mountRoot}-relocated`
  const seedPath = `${sourceRoot}/seed.txt`
  const proofName = 'rail-byte-arrival.txt'
  const sourceProofPath = `${sourceRoot}/${proofName}`
  const recipientProofPath = `${mountRoot}/${proofName}`
  const expectedBytes = `rail-only share delivery ${args.runId}\n`

  await apiText(
    fileUrl(args.env.apiUrl, args.originWorkspace.slug, seedPath),
    {
      method: 'PUT',
      headers: bearer(args.originToken, { 'content-type': 'text/plain' }),
      body: `share root ${args.runId}\n`,
    },
    200,
    'share source root write',
    args.artifacts,
  )
  recordFileCleanup({
    ...args,
    workspace: { id: args.originWorkspace._id, slug: args.originWorkspace.slug },
    token: args.originToken,
    path: seedPath,
  })

  const created = ShareResponseSchema.parse(
    await apiJson(
      `${args.env.apiUrl}/v1/ws/${encodeURIComponent(args.originWorkspace.slug)}/shares`,
      {
        method: 'POST',
        headers: bearerJson(args.originToken),
        body: JSON.stringify({
          path: sourceRoot,
          toEmail: args.ownerEmail,
          mode: 'write',
        }),
      },
      201,
      'share create',
      args.artifacts,
    ),
  )
  assert.equal(created.share.state, 'pending', 'new share did not enter pending state')
  assert.equal(created.share.toEmail, args.ownerEmail, 'share recipient email changed')
  recordShareCleanup({ ...args, shareId: created.share.id })

  const pending = PendingShareListResponseSchema.parse(
    await apiJson(
      `${args.env.apiUrl}/v1/share-requests`,
      { headers: bearer(args.browserToken) },
      200,
      'pending share list',
      args.artifacts,
    ),
  )
  assert(
    pending.items.some(share => share.id === created.share.id && share.state === 'pending'),
    'new share was absent from the recipient pending list',
  )

  const accepted = IncomingShareResponseSchema.parse(
    await apiJson(
      `${args.env.apiUrl}/v1/share-requests/${encodeURIComponent(created.share.id)}/accept`,
      {
        method: 'POST',
        headers: bearerJson(args.browserToken),
        body: JSON.stringify({
          toWorkspaceId: args.recipientWorkspace.id,
          mountPath: mountRoot,
        }),
      },
      200,
      'share accept',
      args.artifacts,
    ),
  )
  assert.equal(accepted.share.id, created.share.id, 'accepted the wrong share')
  assert.equal(accepted.share.state, 'active', 'accepted share did not become active')
  assert.equal(accepted.share.mountPath, mountRoot, 'accepted share mount path changed')

  await apiText(
    fileUrl(args.env.apiUrl, args.originWorkspace.slug, sourceProofPath),
    {
      method: 'PUT',
      headers: bearer(args.originToken, { 'content-type': 'text/plain' }),
      body: expectedBytes,
    },
    200,
    'shared proof file write',
    args.artifacts,
  )
  recordFileCleanup({
    ...args,
    workspace: { id: args.originWorkspace._id, slug: args.originWorkspace.slug },
    token: args.originToken,
    path: sourceProofPath,
  })
  args.ledger.record({
    kind: 'file',
    id: `${args.recipientWorkspace.id}:${recipientProofPath}`,
    label: `${args.runId}:shared-file:${args.recipientWorkspace.slug}:${recipientProofPath}`,
    cleanup: async () => undefined,
    verify: async () =>
      await workspaceIsDeleted(args.convex, args.env.internalKey, args.recipientWorkspace.id),
  })

  const arrival = await waitForSharedFileBytes({
    url: fileUrl(args.env.apiUrl, args.recipientWorkspace.slug, recipientProofPath),
    token: args.browserToken,
    expectedBytes,
    fetchImpl: async (input, init) =>
      await timedFetch(
        input instanceof Request ? input.url : String(input),
        init ?? {},
        args.artifacts,
      ),
  })

  await apiJson(
    `${args.env.apiUrl}/v1/ws/${encodeURIComponent(args.recipientWorkspace.slug)}/files/actions`,
    {
      method: 'POST',
      headers: bearerJson(args.browserToken),
      body: JSON.stringify({
        operation: 'move',
        source: mountRoot,
        destination: relocatedMountRoot,
        overwrite: false,
      }),
    },
    200,
    'move accepted share mount',
    args.artifacts,
  )
  const relocationStarted = Date.now()
  await args.convex.mutation(fnMutation('testing/shares:patchShareMountPathForTest'), {
    internalKey: args.env.internalKey,
    shareId: created.share.id,
    mountPath: relocatedMountRoot,
  })

  const afterRelocationName = 'after-relocation.txt'
  const afterRelocationBytes = `origin after relocation ${args.runId}\n`
  const sourceAfterRelocationPath = `${sourceRoot}/${afterRelocationName}`
  const recipientAfterRelocationPath = `${relocatedMountRoot}/${afterRelocationName}`
  await apiText(
    fileUrl(args.env.apiUrl, args.originWorkspace.slug, sourceAfterRelocationPath),
    {
      method: 'PUT',
      headers: bearer(args.originToken, { 'content-type': 'text/plain' }),
      body: afterRelocationBytes,
    },
    200,
    'post-relocation origin write',
    args.artifacts,
  )
  recordFileCleanup({
    ...args,
    workspace: { id: args.originWorkspace._id, slug: args.originWorkspace.slug },
    token: args.originToken,
    path: sourceAfterRelocationPath,
  })
  await waitForSharedFileBytes({
    url: fileUrl(args.env.apiUrl, args.recipientWorkspace.slug, recipientAfterRelocationPath),
    token: args.browserToken,
    expectedBytes: afterRelocationBytes,
    fetchImpl: async (input, init) =>
      await timedFetch(
        input instanceof Request ? input.url : String(input),
        init ?? {},
        args.artifacts,
      ),
  })
  const relocationMs = Date.now() - relocationStarted

  assert.equal(
    await apiText(
      fileUrl(args.env.apiUrl, args.originWorkspace.slug, sourceProofPath),
      { headers: bearer(args.originToken) },
      200,
      'origin bytes after relocation',
      args.artifacts,
    ),
    expectedBytes,
    'recipient relocation deleted the origin proof bytes',
  )
  assert.equal(
    await apiText(
      fileUrl(args.env.apiUrl, args.recipientWorkspace.slug, `${relocatedMountRoot}/${proofName}`),
      { headers: bearer(args.browserToken) },
      200,
      'recipient bytes after relocation',
      args.artifacts,
    ),
    expectedBytes,
    'recipient relocation lost the original received bytes',
  )

  const reverseName = 'recipient-after-relocation.txt'
  const reverseBytes = `recipient after relocation ${args.runId}\n`
  const reverseStarted = Date.now()
  await apiText(
    fileUrl(args.env.apiUrl, args.recipientWorkspace.slug, `${relocatedMountRoot}/${reverseName}`),
    {
      method: 'PUT',
      headers: bearer(args.browserToken, { 'content-type': 'text/plain' }),
      body: reverseBytes,
    },
    200,
    'post-relocation recipient write',
    args.artifacts,
  )
  await waitForSharedFileBytes({
    url: fileUrl(args.env.apiUrl, args.originWorkspace.slug, `${sourceRoot}/${reverseName}`),
    token: args.originToken,
    expectedBytes: reverseBytes,
    fetchImpl: async (input, init) =>
      await timedFetch(
        input instanceof Request ? input.url : String(input),
        init ?? {},
        args.artifacts,
      ),
  })
  const reverseLatencyMs = Date.now() - reverseStarted
  recordFileCleanup({
    ...args,
    workspace: { id: args.originWorkspace._id, slug: args.originWorkspace.slug },
    token: args.originToken,
    path: `${sourceRoot}/${reverseName}`,
  })

  return {
    ...arrival,
    relocationMs,
    reverseLatencyMs,
    recipientVmName: recipient.vmName,
  }
}

export async function waitForSharedFileBytes(args: {
  url: string
  token: string
  expectedBytes: string
  timeoutMs?: number
  pollMs?: number
  fetchImpl?: FetchLike
  sleep?: (milliseconds: number) => Promise<unknown>
  now?: () => number
}): Promise<{ latencyMs: number }> {
  const timeoutMs = args.timeoutMs ?? 180_000
  const pollMs = args.pollMs ?? 2_000
  const fetchImpl = args.fetchImpl ?? stagingFetch
  const sleep = args.sleep ?? Bun.sleep
  const now = args.now ?? Date.now
  const startedAt = now()
  const deadline = startedAt + timeoutMs

  let lastBytes: string | undefined
  for (;;) {
    const response = await fetchImpl(args.url, { headers: bearer(args.token) })
    if (response.status === 200) {
      // Stale or mid-repair content is a retry condition, not a verdict —
      // sync and read-mode repair converge on their own cadence.
      lastBytes = await response.text()
      if (lastBytes === args.expectedBytes) return { latencyMs: now() - startedAt }
    } else if (![404, 502, 503].includes(response.status)) {
      throw new Error(`shared file read returned HTTP ${response.status}`)
    } else {
      await response.arrayBuffer()
    }
    if (now() >= deadline) {
      if (lastBytes !== undefined) {
        assert.equal(
          lastBytes,
          args.expectedBytes,
          'shared file bytes differed from the origin write',
        )
      }
      throw new Error(`Timed out waiting ${timeoutMs}ms for shared file bytes`)
    }
    await sleep(pollMs)
  }
}

function recordShareCleanup(args: ShareByteArrivalContext & { shareId: string }): void {
  args.ledger.record({
    kind: 'share',
    id: args.shareId,
    label: `${args.runId}:share:${args.shareId}`,
    cleanupPriority: 100,
    cleanup: async () => {
      const response = await stagingFetch(
        `${args.env.apiUrl}/v1/ws/${encodeURIComponent(args.originWorkspace.slug)}/shares/${encodeURIComponent(args.shareId)}`,
        { method: 'DELETE', headers: bearer(args.originToken) },
      )
      assertResponse(response, 200, 'share cleanup')
    },
    verify: async () => {
      const shares = (await args.convex.query(fnQuery('testing/shares:rawSharesForTest'), {
        internalKey: args.env.internalKey,
      })) as Array<{ id: string; state: string }>
      const share = shares.find(candidate => candidate.id === args.shareId)
      return share === undefined || share.state === 'revoked'
    },
  })
}

function recordFileCleanup(
  args: ShareByteArrivalContext & {
    workspace: { id: string; slug: string }
    token: string
    path: string
  },
): void {
  args.ledger.record({
    kind: 'file',
    id: `${args.workspace.id}:${args.path}`,
    label: `${args.runId}:file:${args.workspace.slug}:${args.path}`,
    cleanup: async () => {
      const response = await stagingFetch(
        fileUrl(args.env.apiUrl, args.workspace.slug, args.path),
        { method: 'DELETE', headers: bearer(args.token) },
      )
      assert(
        response.status === 200 || response.status === 404,
        `share file cleanup returned HTTP ${response.status}`,
      )
    },
    verify: async () =>
      await workspaceIsDeleted(args.convex, args.env.internalKey, args.workspace.id),
  })
}

function fileUrl(apiUrl: string, workspaceSlug: string, filePath: string): string {
  const encodedPath = filePath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  return `${apiUrl}/v1/ws/${encodeURIComponent(workspaceSlug)}/files/${encodedPath}`
}
