#!/usr/bin/env bun
// Staging SSE transport soak probe (specs/done/file-attribution slice 14; report in
// specs/done/file-attribution/research/vercel-transport-probe.md).
//
// Measures, against the DEPLOYED staging runtime, the three transport facts that
// gate slice 17's SSE-vs-long-poll choice:
//   1. segment lifetime — how long one authenticated agent-events SSE response
//      survives before the platform cuts it,
//   2. proxy buffering — whether frames/keepalives reach the client promptly or
//      arrive batched,
//   3. keepalive delivery — whether the gateway's 15s `: keepalive` comments
//      arrive at their cadence.
//
// Run from the repo root with the decrypted staging env:
//   bunx dotenvx run -f .env.staging -- bun packages/test-harness/scripts/sse-soak-probe.ts
//
// The probe provisions a synthetic staging-e2e user + workspace via programmatic
// login (same path as src/staging-live.ts), starts an agent session whose turn is
// deliberately long (sequential sleeps), records the SSE chunk timeline until the
// segment dies, proves Last-Event-ID resume on a second segment, then tears
// everything down (session, workspace + VM, synthetic user).

import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'

import { convexUrlsFromDeployment } from '@repo/contract'

import {
  readSseSegment,
  sseKeepaliveGaps,
  type SseSegmentRecord,
} from '../src/sse-segment-reader.ts'

const KEEPALIVE_NOMINAL_MS = 15_000 // gateway agentSessions SSE keepalive cadence
const SOAK_CAP_MS = 1_000_000 // hard stop: past every plausible maxDuration (800s)
const RESUME_READ_MS = 45_000

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env: ${name}`)
  return value
}

const apiUrl = requireEnv('DUET_API_URL').replace(/\/+$/, '')
if (!new URL(apiUrl).hostname.includes('staging')) {
  throw new Error('DUET_API_URL must target a staging hostname')
}
const internalKey = requireEnv('DUET_API_INTERNAL_KEY')
const loginSecret = requireEnv('DUET_PROGRAMMATIC_LOGIN_SECRET')
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
const convex = new ConvexHttpClient(
  convexUrlsFromDeployment(requireEnv('CONVEX_DEPLOYMENT')).cloudUrl,
)

const runId = `staging-e2e-${crypto.randomUUID()}`
const email = `${runId}@agentmail.to`
const startedAt = Date.now()

function log(message: string): void {
  console.log(`[+${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`)
}

function headers(token?: string, extra: Record<string, string> = {}): Headers {
  const result = new Headers(extra)
  if (token !== undefined) result.set('authorization', `Bearer ${token}`)
  if (bypassSecret !== undefined) result.set('x-vercel-protection-bypass', bypassSecret)
  return result
}

async function apiJson<T>(
  url: string,
  init: RequestInit,
  expected: number,
  label: string,
): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.text()
  if (response.status !== expected) {
    throw new Error(
      `${label} returned ${response.status} (expected ${expected}): ${body.slice(0, 300)}`,
    )
  }
  return JSON.parse(body) as T
}

const fnMutation = (name: string) => makeFunctionReference<'mutation'>(name)
const fnQuery = (name: string) => makeFunctionReference<'query'>(name)

async function waitForWorkspace(
  workspaceId: string,
  predicate: (row: {
    status: string
    vmName?: string
    lastHeartbeatAt?: number
    vmTeardownRunId?: string
  }) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = (await convex.query(fnQuery('testing/workspaces:rawWorkspaceByIdForTest'), {
      internalKey,
      workspaceId,
    })) as {
      status: string
      vmName?: string
      lastHeartbeatAt?: number
      vmTeardownRunId?: string
    } | null
    if (row !== null && predicate(row)) return
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for workspace ${workspaceId}; last=${JSON.stringify(row)}`)
    }
    await Bun.sleep(2_000)
  }
}

const TERMINAL_TYPES = new Set(['complete', 'ask', 'interrupted', 'sleep'])

async function readSegment(
  url: string,
  token: string,
  lastEventId: number | undefined,
  capMs: number,
  label: string,
): Promise<SseSegmentRecord> {
  return await readSseSegment({
    url,
    headers: headers(token),
    lastEventId,
    capMs,
    terminalEventTypes: TERMINAL_TYPES,
    onChunk: (chunk, index) => {
      if (index >= 8 && chunk.keepalives === 0 && chunk.ids.length === 0) return
      log(
        `${label}: chunk at +${(chunk.atMs / 1000).toFixed(1)}s bytes=${chunk.bytes} keepalives=${chunk.keepalives} ids=${chunk.ids.length > 0 ? `${chunk.ids[0]}..${chunk.ids.at(-1)}` : '-'} events=${chunk.eventTypes.slice(0, 4).join(',') || '-'}`,
      )
    },
  })
}

const SOAK_PROMPT = [
  'You are a transport soak fixture. Do not explain anything.',
  'Using your shell tool, run the single command `sleep 900`.',
  'If the tool rejects or times out on a command that long, instead run `sleep 100`',
  'ten times sequentially (one tool call per sleep, never in parallel).',
  'When the sleeps are done, reply with exactly: SOAK_OK',
].join(' ')

let workspaceId: string | undefined
let workspaceSlug: string | undefined
let sessionId: string | undefined
let token: string | undefined
const report: Record<string, unknown> = {
  runId,
  apiUrl,
  startedAtIso: new Date(startedAt).toISOString(),
}

async function cleanupProbeResources(): Promise<void> {
  log('cleanup: session, workspace, synthetic user')
  try {
    if (sessionId !== undefined && token !== undefined && workspaceSlug !== undefined) {
      await fetch(`${apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}/interrupt`, {
        method: 'POST',
        headers: headers(token, { 'content-type': 'application/json' }),
        body: '{}',
      }).catch(() => undefined)
      const deleted = await fetch(`${apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: headers(token),
      })
      log(`session delete -> ${deleted.status}`)
    }
    if (workspaceId !== undefined) {
      await convex.mutation(fnMutation('testing/workspaces:deleteWorkspaceByIdForTest'), {
        internalKey,
        workspaceId,
      })
      await waitForWorkspace(
        workspaceId,
        row =>
          row.status === 'deleted' && row.vmName === undefined && row.vmTeardownRunId === undefined,
        240_000,
      )
      log('workspace deleted and VM torn down')
    }
    await convex.mutation(fnMutation('testing/stagingE2e:retireUserByEmailForTest'), {
      internalKey,
      email,
    })
    const remaining = await convex.query(fnQuery('testing/stagingE2e:userByEmailForTest'), {
      internalKey,
      email,
    })
    if (remaining !== null) throw new Error('synthetic user survived cleanup')
    log('synthetic user retired')
    report.cleanup = 'complete'
  } catch (error) {
    report.cleanup = `INCOMPLETE: ${error instanceof Error ? error.message : String(error)}`
    log(`CLEANUP FAILURE (manual sweep needed for ${email}): ${report.cleanup}`)
    process.exitCode = 1
  }
}

try {
  log(`programmatic login as ${email}`)
  const login = await apiJson<{ token: string; userId: string; workspaceSlug: string }>(
    `${apiUrl}/v1/admin/login-as`,
    {
      method: 'POST',
      headers: headers(loginSecret, { 'content-type': 'application/json' }),
      body: JSON.stringify({ email, create: true, name: `SSE Soak ${runId}` }),
    },
    200,
    'programmatic login',
  )
  token = login.token
  workspaceSlug = login.workspaceSlug
  const whoami = await apiJson<{ workspaces: Array<{ id: string; slug: string }> }>(
    `${apiUrl}/v1/whoami`,
    { headers: headers(token) },
    200,
    'whoami',
  )
  workspaceId = whoami.workspaces.find(row => row.slug === workspaceSlug)?.id
  if (workspaceId === undefined) throw new Error('login workspace absent from whoami')

  await convex.mutation(
    fnMutation('testing/workspaces:activateSyntheticSubscriptionByEmailForTest'),
    {
      internalKey,
      email,
    },
  )
  await convex.mutation(fnMutation('domains/credits/internal:applyLedgerEntry'), {
    internalKey,
    workspaceId,
    amountMicroUsd: 5_000_000,
    type: 'grant',
    reference: `grant:sse-soak:${crypto.randomUUID()}`,
  })
  log(`waiting for workspace ${workspaceSlug} to become active`)
  await waitForWorkspace(
    workspaceId,
    row => row.status === 'active' && row.vmName !== undefined && row.lastHeartbeatAt !== undefined,
    300_000,
  )
  log('workspace active; creating soak agent session')

  const created = await apiJson<{ session: { sessionId: string }; dispatched: boolean }>(
    `${apiUrl}/v1/ws/${workspaceSlug}/agent/sessions`,
    {
      method: 'POST',
      headers: headers(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ prompt: SOAK_PROMPT }),
    },
    201,
    'agent session create',
  )
  if (created.dispatched) throw new Error('agent session create bypassed the durable queue handoff')
  sessionId = created.session.sessionId
  const eventsUrl = `${apiUrl}/v1/ws/${workspaceSlug}/agent/sessions/${sessionId}/events`
  log(`session ${sessionId} durably queued; opening SSE segment (cap ${SOAK_CAP_MS / 1000}s)`)

  const soak = await readSegment(eventsUrl, token, undefined, SOAK_CAP_MS, 'soak')
  report.soak = soak
  const gaps = sseKeepaliveGaps(soak)
  report.keepaliveGapsMs = gaps
  report.keepaliveMaxGapMs = gaps.length > 0 ? Math.max(...gaps) : null
  report.keepaliveNominalMs = KEEPALIVE_NOMINAL_MS
  log(
    `soak segment over: lifetime=${(soak.lifetimeMs / 1000).toFixed(1)}s endedBy=${soak.endedBy} chunks=${soak.chunks.length} keepaliveGaps=${gaps.length} terminal=${soak.terminalSeen}`,
  )

  log('opening resume segment with last-event-id to prove reconnect semantics')
  const resume = await readSegment(eventsUrl, token, soak.lastId ?? 0, RESUME_READ_MS, 'resume')
  report.resume = resume
  log(
    `resume segment: status=${resume.status} lifetime=${(resume.lifetimeMs / 1000).toFixed(1)}s endedBy=${resume.endedBy} firstChunkAt=${resume.ttfbMs}ms`,
  )
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  log(`PROBE ERROR: ${report.error}`)
  process.exitCode = 1
} finally {
  await cleanupProbeResources()
  console.log(`SSE_SOAK_REPORT ${JSON.stringify(report)}`)
}
