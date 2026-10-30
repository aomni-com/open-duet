'use node'

import { createHash } from 'node:crypto'

import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { WORKSPACE_VM_POOL, type WorkspaceVmCaps } from '@repo/contract'
import { type ExeClient, type CreateVmOptions, type ExeVm } from '@repo/exe'

import type { Id } from '../../_generated/dataModel'
import { internalAction } from '../../_generated/server'
import { duetAppUrl, gatewayExtraHeadersJson, modelGatewayUrl } from '../../config'
import { PROVISIONING_TOKEN_EXPIRES_MS } from './provisioningCore'
import { workspaceVmExe } from './vmExe'
import { resolveVmImageRef } from './vmImage'
import { workspaceVmTags } from './vmTags'
import { generateProvisioningToken, hashProvisioningToken, randomHex } from './vmToken'

type MutationRef = FunctionReference<'mutation'>
type QueryRef = FunctionReference<'query'>

interface WorkspaceVmAttachPlan {
  imageRef?: string
  diskGb: number
  vmName?: string
  vmTokenNonce?: string
  attachAllowed: boolean
  ephemeral?: boolean
  vmCaps: WorkspaceVmCaps
}

export type WorkspaceVmAttachExe = Pick<ExeClient, 'create' | 'list' | 'remove' | 'setSharePublic'>

interface AttachCtx {
  runQuery(ref: QueryRef, args: Record<string, unknown>): Promise<unknown>
  runMutation(ref: MutationRef, args: Record<string, unknown>): Promise<unknown>
}

export const ensureWorkspaceVm = internalAction({
  args: { workspaceId: v.id('workspaces'), imageRef: v.optional(v.string()) },
  handler: async (ctx, args) => await ensureWorkspaceVmImpl(ctx, args),
})

export async function ensureWorkspaceVmImpl(
  ctx: AttachCtx,
  args: {
    workspaceId: Id<'workspaces'>
    imageRef?: string
    exe?: WorkspaceVmAttachExe
    env?: NodeJS.ProcessEnv
    now?: number
  },
): Promise<{
  workspaceId: Id<'workspaces'>
  status: 'provisioning' | 'paused'
  vmName?: string
  restoredFromArchive: false
}> {
  const env = args.env ?? process.env
  const now = args.now ?? Date.now()
  const workspace = (await ctx.runQuery(
    fnQuery('domains/workspaces/vmAttachModel:workspaceVmAttachPlan'),
    { workspaceId: args.workspaceId, now },
  )) as WorkspaceVmAttachPlan
  if (workspace.attachAllowed === false) {
    return { workspaceId: args.workspaceId, status: 'paused' as const, restoredFromArchive: false }
  }
  const imageRef = resolveVmImageRef(args.imageRef, env)
  const apiUrl = env.DUET_API_URL
  if (apiUrl === undefined || apiUrl.trim().length === 0) {
    throw new Error('DUET_API_URL is required')
  }

  const exe = args.exe ?? workspaceVmExe(env)
  const vmName = workspaceVmName(args.workspaceId)
  const existingVm = (await exe.list()).find(vm => vm.vm_name === vmName)
  if (existingVm !== undefined) {
    if (workspace.vmName !== vmName || workspace.vmTokenNonce === undefined) {
      // Idempotent: a crashed attach may have created the VM without reaching
      // set-public, so the re-record path asserts it too (slice 01 verdict).
      await exe.setSharePublic(existingVm.vm_name)
      const recorded = await recordWorkspaceVmAttach(ctx, {
        workspaceId: args.workspaceId,
        // The row records realized capacity: an existing VM keeps whatever
        // disk it has (D4 — desired only applies to VMs we create).
        diskGb: realizedDiskGb(existingVm) ?? workspace.diskGb,
        vm: existingVm,
        imageRef: args.imageRef ?? workspace.imageRef ?? imageRef,
        vmTokenNonce: workspace.vmTokenNonce ?? randomHex(16),
        now,
      })
      if (!recorded) {
        await exe.remove(existingVm.vm_name)
        return {
          workspaceId: args.workspaceId,
          status: 'paused' as const,
          restoredFromArchive: false,
        }
      }
    }
    return attachResult(args.workspaceId, vmName)
  }

  const provisioningToken = generateProvisioningToken()
  const vmTokenNonce = workspace.vmTokenNonce ?? randomHex(16)
  const prepared = (await ctx.runMutation(
    fnMutation('domains/workspaces/vmAttachModel:prepareWorkspaceVmAttach'),
    {
      workspaceId: args.workspaceId,
      imageRef,
      provisioningTokenHash: await hashProvisioningToken(provisioningToken),
      provisioningTokenExpiresAt: now + PROVISIONING_TOKEN_EXPIRES_MS,
      vmTokenNonce,
      now,
    },
  )) as { ok: boolean }
  if (!prepared.ok) {
    return { workspaceId: args.workspaceId, status: 'paused' as const, restoredFromArchive: false }
  }
  const vm = await exe.create(
    workspaceVmCreateOptions({
      name: vmName,
      imageRef,
      vmDiskGb: workspace.diskGb,
      vmCaps: workspace.vmCaps,
      tags: workspaceVmTags(workspace, env, apiUrl),
      env: provisioningEnv({
        provisioningToken,
        apiUrl,
        workspaceId: args.workspaceId,
        imageRef,
        env,
      }),
    }),
  )
  try {
    await exe.setSharePublic(vm.vm_name)
    const recorded = await recordWorkspaceVmAttach(ctx, {
      workspaceId: args.workspaceId,
      diskGb: workspace.diskGb,
      vm,
      imageRef,
      vmTokenNonce,
      now: Date.now(),
    })
    if (!recorded) {
      await exe.remove(vm.vm_name)
      return {
        workspaceId: args.workspaceId,
        status: 'paused' as const,
        restoredFromArchive: false,
      }
    }
  } catch (error) {
    await exe.remove(vm.vm_name)
    throw error
  }
  return attachResult(args.workspaceId, vm.vm_name)
}

/** exe.dev provisions "NGB" as N GiB; the lobby reports capacity in bytes. */
function realizedDiskGb(vm: ExeVm): number | undefined {
  return vm.disk_capacity_bytes === undefined
    ? undefined
    : Math.round(vm.disk_capacity_bytes / 1024 ** 3)
}

export function workspaceVmName(workspaceId: Id<'workspaces'>): string {
  return `duet-ws-${createHash('sha256').update(workspaceId).digest('hex').slice(0, 24)}`
}

export function workspaceVmCreateOptions(args: {
  name?: string
  imageRef: string
  vmDiskGb: number
  registryAuth?: string
  tags: string[]
  env: string[]
  vmCaps: WorkspaceVmCaps
}): CreateVmOptions {
  return {
    name: args.name,
    image: args.imageRef,
    pool: WORKSPACE_VM_POOL,
    cpu: args.vmCaps.cpu,
    memory: args.vmCaps.memory,
    disk: `${args.vmDiskGb}GB`,
    command: 'auto',
    tags: args.tags,
    registryAuth: args.registryAuth,
    env: args.env,
  }
}

function provisioningEnv(args: {
  provisioningToken: string
  apiUrl: string
  workspaceId: Id<'workspaces'>
  imageRef: string
  env?: NodeJS.ProcessEnv
}): string[] {
  const env = args.env ?? process.env
  return [
    `DUET_PROVISIONING_TOKEN=${args.provisioningToken}`,
    `DUET_API_URL=${args.apiUrl}`,
    `DUET_WORKSPACE_HINT=${args.workspaceId}`,
    `DUET_IMAGE_VERSION=${args.imageRef}`,
    `DUET_WEB_APP_ORIGIN=${duetAppUrl(env)}`,
    ...optionalEnv('DUET_GATEWAY_EXTRA_HEADERS_JSON', gatewayExtraHeadersJson(env)),
    ...optionalEnv('DUET_MODEL_GATEWAY_URL', modelGatewayUrl(env)),
    ...optionalEnv('DUET_CONNECT_FAKE_ISSUER_URL', env.DUET_CONNECT_FAKE_ISSUER_URL),
  ]
}

async function recordWorkspaceVmAttach(
  ctx: AttachCtx,
  args: {
    workspaceId: Id<'workspaces'>
    diskGb: number
    vm: ExeVm
    imageRef: string
    vmTokenNonce: string
    now: number
  },
): Promise<boolean> {
  const result = (await ctx.runMutation(
    fnMutation('domains/workspaces/vmAttachModel:recordWorkspaceVmAttach'),
    {
      workspaceId: args.workspaceId,
      diskGb: args.diskGb,
      vmName: args.vm.vm_name,
      sshDest: args.vm.ssh_dest,
      httpsUrl: args.vm.https_url,
      imageRef: args.imageRef,
      vmTokenNonce: args.vmTokenNonce,
      now: args.now,
    },
  )) as { ok: boolean }
  return result.ok
}

function attachResult(workspaceId: Id<'workspaces'>, vmName: string) {
  return {
    workspaceId,
    status: 'provisioning' as const,
    vmName,
    restoredFromArchive: false as const,
  }
}

function optionalEnv(name: string, value: string | undefined): string[] {
  return value === undefined || value.length === 0 ? [] : [`${name}=${value}`]
}

function fnMutation(name: string): MutationRef {
  return makeFunctionReference(name) as MutationRef
}

function fnQuery(name: string): QueryRef {
  return makeFunctionReference(name) as QueryRef
}
