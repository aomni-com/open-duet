import assert from 'node:assert/strict'

import { SessionSnapshotSchema, WorkspaceAuditPageSchema } from '@repo/contract'
import { ExeClient, type ExeVm } from '@repo/exe'

import type { LiveEnv } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import { loadChronologicalSessionHistory } from './staging-live-pagination.ts'

const POLL_TIMEOUT_MS = 120_000
const RAW_STARTER_DISK_BYTES = 28 * 1024 ** 3
const RAW_PRO_DISK_BYTES = 58 * 1024 ** 3
const RESIZE_BLIP_TOLERANCE_MS = 30_000
const NO_RESIZE_OBSERVATION_MS = 30_000

export async function proveStorageTierResize(args: {
  env: LiveEnv
  token: string
  workspaceSlug: string
  vmName: string
  prompt: string
}): Promise<{ sessionId: string }> {
  const exe = storageTierExe()
  await pollVmCapacity(exe, args.vmName, RAW_PRO_DISK_BYTES)
  await pollGatewayReadyAfterResize(args.env, args.token, args.workspaceSlug)
  return {
    sessionId: await provePostResizePromptSettles({
      env: args.env,
      token: args.token,
      workspaceSlug: args.workspaceSlug,
      prompt: args.prompt,
    }),
  }
}

export async function proveStarterStorageCapacity(vmName: string): Promise<void> {
  await pollVmCapacity(storageTierExe(), vmName, RAW_STARTER_DISK_BYTES)
}

export async function captureResizeAuditEventIds(
  env: LiveEnv,
  token: string,
  workspaceSlug: string,
): Promise<Set<string>> {
  return new Set((await workspaceAuditEvents(env, token, workspaceSlug)).map(event => event.id))
}

export async function proveScheduledDowngradeRetainsProCapacity(args: {
  env: LiveEnv
  token: string
  workspaceSlug: string
  vmName: string
  auditIdsBeforeDowngrade: ReadonlySet<string>
}): Promise<void> {
  const deadline = Date.now() + NO_RESIZE_OBSERVATION_MS
  for (;;) {
    const newResizeEvents = newResizeScheduleEvents(
      await workspaceAuditEvents(args.env, args.token, args.workspaceSlug),
      args.auditIdsBeforeDowngrade,
    )
    assert.equal(
      newResizeEvents.length,
      0,
      `scheduled downgrade emitted resize audit event(s): ${newResizeEvents.map(event => event.id).join(', ')}`,
    )
    if (Date.now() >= deadline) break
    await Bun.sleep(1_000)
  }

  const retainedVm = await pollVmCapacity(storageTierExe(), args.vmName, RAW_PRO_DISK_BYTES)
  assert.equal(
    retainedVm.disk_capacity_bytes,
    RAW_PRO_DISK_BYTES,
    'scheduled downgrade changed the retained Pro disk capacity',
  )
}

export function findVmAtCapacity(
  vms: readonly Pick<ExeVm, 'vm_name' | 'disk_capacity_bytes'>[],
  vmName: string,
  capacityBytes: number,
): Pick<ExeVm, 'vm_name' | 'disk_capacity_bytes'> | undefined {
  return vms.find(vm => vm.vm_name === vmName && vm.disk_capacity_bytes === capacityBytes)
}

export function newResizeScheduleEvents<T extends { id: string; event: string }>(
  events: readonly T[],
  existingIds: ReadonlySet<string>,
): T[] {
  return events.filter(
    event => event.event === 'workspace.vm_disk_resize_scheduled' && !existingIds.has(event.id),
  )
}

function storageTierExe(): ExeClient {
  const token = process.env.EXE_TOKEN?.trim()
  assert(token !== undefined && token.length > 0, 'storage resize proof requires EXE_TOKEN')
  return new ExeClient({ token, connectTimeoutSec: 10 })
}

async function pollVmCapacity(
  exe: Pick<ExeClient, 'list'>,
  vmName: string,
  capacityBytes: number,
): Promise<Pick<ExeVm, 'vm_name' | 'disk_capacity_bytes'>> {
  return await poll(
    async () => findVmAtCapacity(await exe.list(), vmName, capacityBytes),
    POLL_TIMEOUT_MS,
    `${vmName} disk capacity ${capacityBytes}`,
  )
}

async function pollGatewayReadyAfterResize(
  env: LiveEnv,
  token: string,
  workspaceSlug: string,
): Promise<void> {
  await poll(
    async () => {
      try {
        const response = await stagingFetch(`${env.apiUrl}/v1/ws/${workspaceSlug}/files?list=1`, {
          headers: bearer(token),
        })
        return response.ok ? true : undefined
      } catch {
        return undefined
      }
    },
    RESIZE_BLIP_TOLERANCE_MS,
    'workspace data plane after storage resize restart',
  )
}

async function provePostResizePromptSettles(args: {
  env: LiveEnv
  token: string
  workspaceSlug: string
  prompt: string
}): Promise<string> {
  const response = await stagingFetch(
    `${args.env.apiUrl}/v1/ws/${args.workspaceSlug}/agent/sessions`,
    {
      method: 'POST',
      headers: bearerJson(args.token),
      body: JSON.stringify({ prompt: args.prompt }),
    },
  )
  const responseText = await response.text()
  let responseBody: unknown
  try {
    responseBody = JSON.parse(responseText)
  } catch {
    responseBody = responseText
  }
  assert(
    !JSON.stringify(responseBody).includes('turn_already_running'),
    'post-resize prompt was rejected as turn_already_running',
  )
  assert.equal(
    response.status,
    201,
    `post-resize prompt returned ${response.status}: ${responseText}`,
  )
  const sessionId = (responseBody as { session?: { sessionId?: unknown } }).session?.sessionId
  assert(typeof sessionId === 'string', 'post-resize prompt omitted its session id')

  const snapshot = await poll(
    async () => {
      const value = SessionSnapshotSchema.parse(
        await apiJson(
          `${args.env.apiUrl}/v1/ws/${args.workspaceSlug}/agent/sessions/${sessionId}`,
          { headers: bearer(args.token) },
          200,
          'post-resize prompt snapshot',
        ),
      )
      return value.turnStatus === 'running' ? undefined : value
    },
    240_000,
    'post-resize prompt terminal state',
  )
  assert.equal(
    snapshot.turnStatus,
    'complete',
    `post-resize prompt settled as ${snapshot.turnStatus}`,
  )
  const history = await loadChronologicalSessionHistory(
    `${args.env.apiUrl}/v1/ws/${args.workspaceSlug}/agent/sessions/${sessionId}/history`,
    args.token,
    'post-resize prompt history',
  )
  assert(
    !JSON.stringify(history).includes('turn_already_running'),
    'post-resize prompt history contains turn_already_running',
  )
  return sessionId
}

async function workspaceAuditEvents(env: LiveEnv, token: string, workspaceSlug: string) {
  return WorkspaceAuditPageSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspaceSlug}/audit?limit=100`,
      { headers: bearer(token) },
      200,
      'subscription workspace audit events',
    ),
  ).items
}

async function poll<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() >= deadline) throw new Error(`Timed out polling ${label}`)
    await Bun.sleep(500)
  }
}
