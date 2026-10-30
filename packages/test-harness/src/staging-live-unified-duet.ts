import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MirrorRegisteredSchema,
  SyncMachinePageSchema,
  UserApiKeyIssuedSchema,
  WhoamiResponseSchema,
  type ApiDeployment,
  type WebDeployment,
  type DocsDeployment,
} from '@repo/contract'
import { shellQuote } from '@repo/exe'

import { createCommandContext, type CliRuntime, type CliResult } from '../../duet/src/cli-support'
import { configPathForHome, loadConfig, saveConfig } from '../../duet/src/config'
import { ApiClient } from '../../duet/src/http'
import { resolveSyncthingBinary } from '../../duet/src/sync/binary'
import { workspaceSyncKey } from '../../duet/src/sync/daemon-status'
import { registerSyncMachine } from '../../duet/src/sync/machine'
import { createRealMirrorStarter, type WorkspaceMirrorHandle } from '../../duet/src/sync/mirror'
import { deleteStagingSession } from './staging-live-agent-sessions'
import { assertReleaseDeployment } from './staging-live-deployment'
import { runHumanDeviceLogin } from './staging-live-device'
import { fnMutation, fnQuery, type Workspace } from './staging-live-env'
import { apiJson, apiText, bearer, bearerJson, stagingFetch, timedFetch } from './staging-live-http'
import { acquireInvitedMemberBrowser } from './staging-live-invited-member'
import { resolveAgentMailInbox, taggedInboxAddress } from './staging-live-mailbox'
import { recordWorkspaceCleanup, workspaceIsDeleted } from './staging-live-resource-ledger'
import { readAnnouncedRuntime } from './staging-live-runtime'
import { waitForWorkspace } from './staging-live-streaming'
import {
  inspectUnifiedDuetEvidence,
  type UnifiedDuetEvidenceInput,
} from './staging-live-unified-duet-evidence'
import {
  exerciseSync,
  waitBytes,
  waitMirrorDetached,
  stopMirrors,
} from './staging-live-unified-duet-sync'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
} from './staging-live-workspace-browser'

export async function runUnifiedDuetJourney(
  options: { onProgress?: (stage: string) => void } = {},
) {
  const path = process.env.DUET_E2E_UNIFIED_EVIDENCE
  if (!path) throw new Error('DUET_E2E_UNIFIED_EVIDENCE must name the bound live cutover receipts')
  const evidence = inspectUnifiedDuetEvidence(await Bun.file(path).json())
  const binary = process.env.DUET_SYNCTHING_BIN
  assert(
    binary && (await Bun.file(binary).exists()),
    'DUET_SYNCTHING_BIN must name the verified scratch-peer binary',
  )
  await resolveSyncthingBinary({ env: { DUET_SYNCTHING_BIN: binary } })
  const modelUrl = process.env.DUET_MODEL_GATEWAY_URL?.replace(/\/+$/, '')
  assert(
    modelUrl && new URL(modelUrl).hostname.includes('staging'),
    'DUET_MODEL_GATEWAY_URL must target staging',
  )
  return await runWorkspaceBrowserJourney({
    journey: 'unified-duet',
    label: 'Unified Duet',
    plan: 'pro',
    onProgress: options.onProgress,
    run: async context => await runUnifiedDuetAcceptance(context, evidence, binary, modelUrl),
  })
}

async function runUnifiedDuetAcceptance(
  context: WorkspaceBrowserJourneyContext,
  input: UnifiedDuetEvidenceInput,
  binary: string,
  modelUrl: string,
) {
  const { env, workspace, apiToken, convex, ledger, artifacts, runId, progress, vmNames } = context
  progress('unified-duet:bound-runtime-observations')
  const migrated = await observeRuntime(context, input.migrated.workspaceId, input)
  const fresh = await observeRuntime(context, workspace._id, input)
  const [api, web, docs] = await Promise.all([
    apiJson<ApiDeployment>(
      `${env.apiUrl}/deployment`,
      {},
      200,
      'unified API deployment',
      artifacts,
    ),
    apiJson<WebDeployment>(
      `${env.appUrl}/api/version`,
      {},
      200,
      'unified web deployment',
      artifacts,
    ),
    apiJson<DocsDeployment>(
      `${env.docsUrl}/deployment.json`,
      {},
      200,
      'unified docs deployment',
      artifacts,
    ),
  ])
  const release = assertReleaseDeployment({
    api,
    web,
    docs,
    runtimeManifest: fresh.manifest,
    runtimeHealth: { runtimeVersion: fresh.runtimeVersion },
    workspace: { runtimeVersion: fresh.runtimeVersion },
  })
  assert.notEqual(fresh.vmName, migrated.vmName, 'Fresh fixture reused the migrated VM')
  const second = await apiJson<{ workspaceId: string; slug: string }>(
    `${env.apiUrl}/v1/workspaces`,
    {
      method: 'POST',
      headers: bearerJson(apiToken),
      body: JSON.stringify({
        slug: `unified-${runId.slice(-6)}`,
        name: `${runId} second workspace`,
      }),
    },
    202,
    'create second unified workspace',
    artifacts,
  )
  recordWorkspaceCleanup({
    ledger,
    convex,
    env,
    output: { vmNames },
    workspaceId: second.workspaceId,
    slug: second.slug,
  })
  const secondWorkspace = await waitForWorkspace(
    convex,
    env.internalKey,
    second.workspaceId,
    row => row.status === 'active' && row.servicingStatus === 'active' && row.vmName !== undefined,
  )
  await convex.mutation(fnMutation('domains/credits/internal:applyLedgerEntry'), {
    internalKey: env.internalKey,
    workspaceId: second.workspaceId,
    amountMicroUsd: 10_000_000,
    type: 'grant',
    reference: `grant:unified-duet:${runId}`,
  })

  progress('unified-duet:human-device-memberships')
  const inbox = await resolveAgentMailInbox({
    apiKey: env.agentMailApiKey,
    address: env.agentMailInboxAddress,
  })
  const browser = context.page.context().browser()
  assert(browser, 'Workspace browser fixture has no browser')
  const member = await acquireInvitedMemberBrowser({
    ...context,
    browser,
    ownerToken: apiToken,
    email: taggedInboxAddress(inbox.address, `${runId}-member`),
    role: 'editor',
    inboxId: inbox.id,
  })
  const scratch = await mkdtemp(join(tmpdir(), 'duet-unified-live-'))
  const handles: WorkspaceMirrorHandle[] = []
  let failure: unknown
  try {
    const device = await runHumanDeviceLogin({ ...context, page: member.page, email: member.email })
    // Membership setup uses the existing test fixture; all authorization below is real HTTP.
    await convex.mutation(fnMutation('testing/workspaces:addWorkspaceMemberForTest'), {
      internalKey: env.internalKey,
      workspaceId: second.workspaceId,
      userId: member.userId,
      role: 'editor',
    })
    const identity = await whoami(context, device.accessToken)
    for (const row of [workspace, secondWorkspace])
      assert(
        identity.workspaces.some(
          candidate => candidate.id === row._id && candidate.role === 'editor',
        ),
        'One user key did not see both live memberships',
      )
    for (const row of [workspace, secondWorkspace])
      await apiJson(
        `${env.apiUrl}/v1/ws/${row.slug}/files?list=1`,
        { headers: bearer(device.accessToken) },
        200,
        'same-key workspace files',
        artifacts,
      )

    progress('unified-duet:explicit-model-workspace')
    const models = await verifyModelSelection(
      context,
      device.accessToken,
      [workspace, secondWorkspace],
      modelUrl,
    )
    progress('unified-duet:two-machine-sync')
    const sync = await exerciseSync(
      context,
      device.accessToken,
      member.apiToken,
      member.userId,
      binary,
      scratch,
      workspace,
      handles,
    )
    const replacement = UserApiKeyIssuedSchema.parse(
      await apiJson(
        `${env.apiUrl}/v1/user/api-keys`,
        {
          method: 'POST',
          headers: bearerJson(device.accessToken),
          body: JSON.stringify({ name: `${runId} replacement` }),
        },
        201,
        'replace human key',
        artifacts,
      ),
    )
    ledger.record({
      kind: 'api-key',
      id: replacement.record.id,
      label: `${runId}:replacement-key`,
      cleanup: async () => {
        await apiJson(
          `${env.apiUrl}/v1/user/api-keys/${replacement.record.id}`,
          { method: 'DELETE', headers: bearer(member.apiToken) },
          200,
          'replacement key cleanup',
          artifacts,
        )
      },
      verify: async () =>
        (await stagingFetch(`${env.apiUrl}/v1/whoami`, { headers: bearer(replacement.key) }))
          .status === 401,
    })
    for (const machine of sync.machines) {
      await saveConfig(
        { ...(await loadConfig(configPathForHome(machine.home))), apiKey: replacement.key },
        configPathForHome(machine.home),
      )
      const { ctx } = await createCommandContext(['whoami'], {
        home: machine.home,
        env: {},
        fetch: stagingFetch,
      })
      assert.equal(
        await registerSyncMachine(ctx, binary),
        machine.machineId,
        'Replacing the user key changed the machine identity',
      )
      assert.equal((await loadConfig(configPathForHome(machine.home))).machineId, machine.machineId)
    }

    progress('unified-duet:live-role-and-member-removal')
    await apiJson(
      `${env.apiUrl}/v1/ws/${second.slug}/members/${member.userId}`,
      { method: 'PATCH', headers: bearerJson(apiToken), body: JSON.stringify({ role: 'viewer' }) },
      200,
      'member becomes viewer',
      artifacts,
    )
    const viewerWrite = await timedFetch(
      `${env.apiUrl}/v1/ws/${second.slug}/files/viewer-denied.txt`,
      {
        method: 'PUT',
        headers: bearer(replacement.key, { 'content-type': 'text/plain' }),
        body: 'must not write',
      },
      artifacts,
    )
    assert.equal(viewerWrite.status, 403, 'Viewer retained write access after role change')
    await apiJson(
      `${env.apiUrl}/v1/ws/${second.slug}/members/${member.userId}`,
      { method: 'PATCH', headers: bearerJson(apiToken), body: JSON.stringify({ role: 'editor' }) },
      200,
      'restore member editor',
      artifacts,
    )
    await apiJson(
      `${env.apiUrl}/v1/ws/${workspace.slug}/members/${member.userId}`,
      { method: 'DELETE', headers: bearer(apiToken) },
      200,
      'remove one workspace membership',
      artifacts,
    )
    const afterRemoval = await whoami(context, replacement.key)
    assert(
      !afterRemoval.workspaces.some(row => row.id === workspace._id),
      'Removed membership remained accessible',
    )
    assert(
      afterRemoval.workspaces.some(row => row.id === second.workspaceId),
      'Membership removal detached the other workspace',
    )
    const deniedFiles = await timedFetch(
      `${env.apiUrl}/v1/ws/${workspace.slug}/files?list=1`,
      { headers: bearer(replacement.key) },
      artifacts,
    )
    assert([403, 404].includes(deniedFiles.status), 'Removed member still read workspace files')
    await assertModelRefusal(
      context,
      replacement.key,
      workspace.slug,
      modelUrl,
      [workspace, secondWorkspace],
      403,
    )
    for (const machine of sync.machines) {
      const request = { machineId: machine.machineId, syncthingDeviceId: machine.syncthingDeviceId }
      const denied = await timedFetch(
        `${env.apiUrl}/v1/ws/${workspace.slug}/mirror-devices`,
        { method: 'POST', headers: bearerJson(replacement.key), body: JSON.stringify(request) },
        artifacts,
      )
      assert([403, 404].includes(denied.status), 'Removed member reminted a mirror tunnel')
      MirrorRegisteredSchema.parse(
        await apiJson(
          `${env.apiUrl}/v1/ws/${second.slug}/mirror-devices`,
          { method: 'POST', headers: bearerJson(replacement.key), body: JSON.stringify(request) },
          200,
          'other membership mirror remains usable',
          artifacts,
        ),
      )
    }
    for (const [index, machine] of sync.machines.entries())
      await waitMirrorDetached(context, workspace, machine.machineId, handles[index]!)
    // Stop the detached first-workspace peers before testing removal on the still-accessible one.
    await stopMirrors(handles)
    for (const machine of sync.machines) {
      const handle = await createRealMirrorStarter({
        api: new ApiClient({ baseUrl: env.apiUrl, apiKey: replacement.key, fetch: stagingFetch }),
        machineId: machine.machineId,
        home: machine.home,
        binaryPath: binary,
        fetch: stagingFetch,
      })({
        slug: second.slug,
        syncKey: workspaceSyncKey(env.apiUrl, second.workspaceId),
        localDir: join(machine.home, 'second-drive'),
        log: () => {},
      })
      handles.push(handle)
    }
    const attachedBytes = Buffer.from(`ATTACHED-${runId}`)
    await apiText(
      `${env.apiUrl}/v1/ws/${second.slug}/files/removal-observer.txt`,
      {
        method: 'PUT',
        headers: bearer(apiToken, { 'content-type': 'text/plain' }),
        body: attachedBytes,
      },
      200,
      'observe both live second-workspace peers',
      artifacts,
    )
    for (const handle of handles)
      await waitBytes(join(handle.localDir, 'removal-observer.txt'), attachedBytes)
    const survivor = sync.machines[1]!
    const survivingHandle = handles[1]!
    const removed = sync.machines[0]!
    for (let attempt = 0; attempt < 2; attempt++)
      await apiJson(
        `${env.apiUrl}/v1/user/sync-machines/${removed.machineId}`,
        { method: 'DELETE', headers: bearer(replacement.key) },
        200,
        'repeatable machine removal',
        artifacts,
      )
    const removedMint = await timedFetch(
      `${env.apiUrl}/v1/ws/${second.slug}/mirror-devices`,
      {
        method: 'POST',
        headers: bearerJson(replacement.key),
        body: JSON.stringify({
          machineId: removed.machineId,
          syncthingDeviceId: removed.syncthingDeviceId,
        }),
      },
      artifacts,
    )
    assert.equal(removedMint.status, 404, 'Removed machine reminted a tunnel')
    await waitMirrorDetached(context, secondWorkspace, removed.machineId, handles[0]!)
    const survivorBytes = Buffer.from(`SURVIVOR-${runId}\u0000\xff`)
    await apiText(
      `${env.apiUrl}/v1/ws/${second.slug}/files/survivor.txt`,
      {
        method: 'PUT',
        headers: bearer(apiToken, { 'content-type': 'application/octet-stream' }),
        body: survivorBytes,
      },
      200,
      'survivor sync seed',
      artifacts,
    )
    await waitBytes(join(survivingHandle.localDir, 'survivor.txt'), survivorBytes)
    const activeMachines = SyncMachinePageSchema.parse(
      await apiJson(
        `${env.apiUrl}/v1/user/sync-machines?limit=100`,
        { headers: bearer(replacement.key) },
        200,
        'remaining machine identities',
        artifacts,
      ),
    )
    assert(
      activeMachines.items.some(
        row => row.machineId === survivor.machineId && row.removedAt === undefined,
      ),
      'Other machine did not remain active',
    )

    progress('unified-duet:key-revocation')
    const keys = await apiJson<{ items: Array<{ id: string; prefix: string }> }>(
      `${env.apiUrl}/v1/user/api-keys?limit=100`,
      { headers: bearer(replacement.key) },
      200,
      'human key inventory',
      artifacts,
    )
    const priorKey = keys.items.find(row => row.prefix === device.prefix)
    assert(priorKey, 'Device-issued key is missing from normal key management')
    await apiJson(
      `${env.apiUrl}/v1/user/api-keys/${priorKey.id}`,
      { method: 'DELETE', headers: bearer(replacement.key) },
      200,
      'revoke prior human key',
      artifacts,
    )
    assert.equal(
      (
        await timedFetch(
          `${env.apiUrl}/v1/whoami`,
          { headers: bearer(device.accessToken) },
          artifacts,
        )
      ).status,
      401,
    )
    const revokedMint = await timedFetch(
      `${env.apiUrl}/v1/ws/${second.slug}/mirror-devices`,
      {
        method: 'POST',
        headers: bearerJson(device.accessToken),
        body: JSON.stringify({
          machineId: survivor.machineId,
          syncthingDeviceId: survivor.syncthingDeviceId,
        }),
      },
      artifacts,
    )
    assert.equal(revokedMint.status, 401, 'Revoked human key reminted a tunnel')
    await assertModelRefusal(
      context,
      device.accessToken,
      second.slug,
      modelUrl,
      [workspace, secondWorkspace],
      401,
    )
    await whoami(context, replacement.key)

    progress('unified-duet:managed-command-rpc-memory')
    const native = await exerciseManagedCli(context, fresh)
    await stopMirrors(handles)
    await apiJson(
      `${env.apiUrl}/v1/ws/${second.slug}/members/${member.userId}`,
      { method: 'DELETE', headers: bearer(apiToken) },
      200,
      'remove final workspace membership',
      artifacts,
    )
    assert.deepEqual(
      (await whoami(context, replacement.key)).workspaces,
      [],
      'User key retained workspace access without memberships',
    )
    await assertModelRefusal(
      context,
      replacement.key,
      second.slug,
      modelUrl,
      [workspace, secondWorkspace],
      403,
    )
    const result = {
      targetVersion: input.targetVersion,
      transitionVersion: input.transitionVersion,
      imageRef: input.imageRef,
      release,
      migrated,
      fresh,
      device: {
        userId: member.userId,
        currentMembershipChecked: true,
        roleChangeChecked: true,
        membershipRemoved: workspace._id,
        revokedPrefix: device.prefix,
        noMembershipAccessChecked: true,
      },
      models,
      sync: {
        machines: sync.machines.map(({ machineId, syncthingDeviceId }) => ({
          machineId,
          syncthingDeviceId,
        })),
        bytesSha256: sync.bytesSha256,
        removedMachineId: removed.machineId,
        survivingMachineId: survivor.machineId,
      },
      native,
      externalDrills: input.drills,
    }
    await artifacts.writeJson('unified-duet.json', result)
    return result
  } catch (error) {
    failure = error
    throw error
  } finally {
    await cleanupUnifiedScratch(handles, member.close, scratch, failure)
  }
}

async function cleanupUnifiedScratch(
  handles: WorkspaceMirrorHandle[],
  closeBrowser: () => Promise<void>,
  scratch: string,
  failure: unknown,
) {
  const cleanup = await Promise.allSettled([stopMirrors(handles), closeBrowser()])
  const removal = await Promise.allSettled([rm(scratch, { recursive: true, force: true })])
  const failed = [...cleanup, ...removal].filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failed.length > 0)
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure]), ...failed.map(result => result.reason)],
      'Scratch mirror/browser cleanup failed',
    )
}

async function whoami(context: WorkspaceBrowserJourneyContext, key: string) {
  return WhoamiResponseSchema.parse(
    await apiJson(
      `${context.env.apiUrl}/v1/whoami`,
      { headers: bearer(key) },
      200,
      'current human memberships',
      context.artifacts,
    ),
  )
}

async function observeRuntime(
  context: WorkspaceBrowserJourneyContext,
  workspaceId: string,
  input: UnifiedDuetEvidenceInput,
) {
  const row = (await context.convex.query(fnQuery('testing/workspaces:rawWorkspaceByIdForTest'), {
    internalKey: context.env.internalKey,
    workspaceId,
  })) as Workspace & { imageRef?: string; sshDest?: string }
  assert(
    row?.vmName && row.sshDest && row.imageRef,
    'Runtime observation requires an attached VM with real image provenance',
  )
  const connection = (await context.convex.query(
    fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
    { internalKey: context.env.internalKey, slug: row.slug },
  )) as { vmToken: string; httpsUrl: string } | null
  assert(
    connection?.vmToken && connection.httpsUrl,
    'Runtime observation has no gateway connection',
  )
  const manifest = await readAnnouncedRuntime({
    apiUrl: context.env.apiUrl,
    vmToken: connection.vmToken,
    artifacts: context.artifacts,
  })
  assert.equal(
    manifest.version,
    input.targetVersion,
    'API release changed from frozen closeout target',
  )
  const health = await apiJson<{ runtimeVersion: string; bootId?: string }>(
    `${connection.httpsUrl.replace(/\/+$/, '')}/health`,
    { headers: bearer(connection.vmToken) },
    200,
    'running unified gateway',
    context.artifacts,
  )
  assert.equal(
    health.runtimeVersion,
    input.targetVersion,
    'Gateway process is not running the strict release',
  )
  assert.equal(
    row.runtimeVersion,
    input.targetVersion,
    'Workspace heartbeat differs from the strict release',
  )
  const bootId = health.bootId
  assert(
    typeof bootId === 'string' && bootId.length > 0,
    'Linux gateway omitted its OS boot identity',
  )
  if (workspaceId === input.migrated.workspaceId) {
    assert.equal(row.vmName, input.migrated.vmName, 'Migrated VM identity changed')
    assert.equal(row.sshDest, input.migrated.sshDest, 'Migrated SSH identity changed')
    assert.equal(
      row.imageRef,
      input.migrated.imageRef,
      'Migrated VM image provenance was rewritten',
    )
    assert.equal(bootId, input.migrated.bootIdAfter, 'Migrated VM rebooted after adoption receipt')
  } else
    assert.equal(row.imageRef, input.imageRef, 'Fresh VM did not use the verified strict image')
  return {
    workspaceId,
    vmName: row.vmName,
    sshDest: row.sshDest,
    imageRef: row.imageRef,
    bootId,
    runtimeVersion: health.runtimeVersion,
    duetArtifact: manifest.artifacts.find(artifact => artifact.name === 'duet')!,
    manifest,
  }
}

async function generations(context: WorkspaceBrowserJourneyContext, workspace: Workspace) {
  return (await context.convex.query(fnQuery('testing/modelGateway:listGenerationsForTest'), {
    internalKey: context.env.internalKey,
    workspaceId: workspace._id,
  })) as Array<Record<string, unknown> & { _id: string }>
}

async function assertModelRefusal(
  context: WorkspaceBrowserJourneyContext,
  key: string,
  slug: string | undefined,
  modelUrl: string,
  workspaces: Workspace[],
  status: number,
) {
  const before = await Promise.all(workspaces.map(row => generations(context, row)))
  const response = await timedFetch(
    `${modelUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: bearerJson(key, slug === undefined ? {} : { 'x-duet-workspace': slug }),
      body: JSON.stringify({
        model: 'openai/gpt-6-luna',
        messages: [{ role: 'user', content: 'Reply OK.' }],
        max_tokens: 32,
      }),
      signal: AbortSignal.timeout(120_000),
    },
    context.artifacts,
  )
  assert.equal(response.status, status, 'Unauthorized or ambiguous model request was forwarded')
  const after = await Promise.all(workspaces.map(row => generations(context, row)))
  assert.deepEqual(
    after.map(rows => rows.map(row => row._id).sort()),
    before.map(rows => rows.map(row => row._id).sort()),
    'Refused model request created a billable generation',
  )
}

async function verifyModelSelection(
  context: WorkspaceBrowserJourneyContext,
  key: string,
  workspaces: Workspace[],
  modelUrl: string,
) {
  await assertModelRefusal(context, key, undefined, modelUrl, workspaces, 403)
  await assertModelRefusal(
    context,
    key,
    `absent-${context.runId.slice(-6)}`,
    modelUrl,
    workspaces,
    403,
  )
  const evidence = []
  for (const workspace of workspaces) {
    const before = await Promise.all(workspaces.map(row => generations(context, row)))
    const response = await timedFetch(
      `${modelUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: bearerJson(key, { 'x-duet-workspace': workspace.slug }),
        body: JSON.stringify({
          model: 'openai/gpt-6-luna',
          messages: [{ role: 'user', content: 'Reply with the integer 42 only.' }],
          max_tokens: 64,
        }),
        signal: AbortSignal.timeout(120_000),
      },
      context.artifacts,
    )
    assert.equal(response.status, 200, 'Explicit model workspace was refused')
    const body = (await response.json()) as { id?: string }
    assert(typeof body.id === 'string', 'Model response omitted upstream generation identity')
    const deadline = Date.now() + 300_000
    for (;;) {
      const rows = await generations(context, workspace)
      const generation = rows.find(
        row => row.upstreamGenerationId === body.id && row.status === 'settled',
      )
      const transactions = (await context.convex.query(
        fnQuery('testing/credits:listWorkspaceTransactionsForTest'),
        { internalKey: context.env.internalKey, workspaceId: workspace._id },
      )) as Array<Record<string, unknown>>
      const debit = transactions.find(
        row => row.type === 'usage' && row.reference === `ai_generation:${body.id}`,
      )
      if (generation && debit) {
        assert.equal(
          generation.workspaceId,
          workspace._id,
          'Generation captured the wrong billing workspace',
        )
        assert(
          typeof debit.amountMicroUsd === 'number' && debit.amountMicroUsd < 0,
          'Model settlement did not debit the selected workspace',
        )
        assert.equal(
          -debit.amountMicroUsd,
          generation.billedCostMicroUsd,
          'Ledger and generation amount differ',
        )
        evidence.push({
          workspaceId: workspace._id,
          slug: workspace.slug,
          generationId: generation._id,
          upstreamGenerationId: body.id,
          billedCostMicroUsd: generation.billedCostMicroUsd,
          debitMicroUsd: debit.amountMicroUsd,
        })
        break
      }
      assert(Date.now() < deadline, 'Selected model generation did not settle')
      await Bun.sleep(2_000)
    }
    for (const [index, other] of workspaces.entries())
      if (other._id !== workspace._id)
        assert.deepEqual(
          (await generations(context, other)).map(row => row._id).sort(),
          before[index]!.map(row => row._id).sort(),
          'Model request charged the other membership',
        )
  }
  return evidence
}

async function exerciseManagedCli(
  context: WorkspaceBrowserJourneyContext,
  fresh: Awaited<ReturnType<typeof observeRuntime>>,
) {
  const { env, workspace, apiToken, runId, artifacts, ledger, convex } = context
  const probePath = `unified-${runId.slice(-6)}.ts`
  const source = await Bun.file(new URL('./fixtures/unified-duet/probe.ts', import.meta.url)).text()
  await apiText(
    `${env.apiUrl}/v1/ws/${workspace.slug}/files/${probePath}`,
    { method: 'PUT', headers: bearer(apiToken, { 'content-type': 'text/plain' }), body: source },
    200,
    'managed CLI probe fixture',
    artifacts,
  )
  const config = {
    runtimeVersion: fresh.runtimeVersion,
    duetArtifact: fresh.duetArtifact,
    marker: runId,
  }
  const output: string[] = []
  const errors: string[] = []
  const localHome = await mkdtemp(join(tmpdir(), 'duet-unified-command-'))
  try {
    await saveConfig(
      { apiKey: apiToken, apiUrl: env.apiUrl, defaultWorkspace: workspace.slug },
      configPathForHome(localHome),
    )
    // A saved remote default must leave bare memory commands local.
    const localNote = `LOCAL-${runId}`
    const local = Bun.spawn(
      [
        process.execPath,
        new URL('../../duet/src/cli-entry.ts', import.meta.url).pathname,
        'memory',
        'add',
        '--store',
        join(localHome, 'memories'),
        '--json',
        localNote,
      ],
      {
        cwd: localHome,
        env: { PATH: process.env.PATH, HOME: localHome },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 60_000,
      },
    )
    const [exitCode, stdout] = await Promise.all([
      local.exited,
      new Response(local.stdout).text(),
      new Response(local.stderr).text(),
    ])
    assert.equal(exitCode, 0, 'Bare memory command did not stay local with a saved workspace')
    assert.equal((JSON.parse(stdout) as { content: string }).content, localNote)
    // Load the executable owner at runtime; its TUI source has its own compiler config.
    const cliPath = new URL('../../duet/src/cli.ts', import.meta.url).pathname
    const { runCli } = (await import(cliPath)) as {
      runCli: (args: string[], runtime: CliRuntime) => Promise<CliResult>
    }
    const { exitCode: remoteExit } = await runCli(
      [
        '--workspace',
        workspace.slug,
        '--json',
        'agent',
        'run',
        `Run exactly once from your current directory: bun /home/exedev/drive/${probePath} ${shellQuote(JSON.stringify(config))}. Do not change the script, delegate or substitute checks. Report its exit status.`,
      ],
      {
        home: localHome,
        env: {},
        io: {
          stdout: {
            write: chunk => {
              output.push(String(chunk))
              return true
            },
          },
          stderr: {
            write: chunk => {
              errors.push(String(chunk))
              return true
            },
          },
        },
        fetch: async (url, init) => {
          const response = await stagingFetch(url, {
            ...init,
            signal: AbortSignal.timeout(900_000),
          })
          if (
            init?.method === 'POST' &&
            new URL(String(url)).pathname.endsWith('/agent/sessions') &&
            response.ok
          ) {
            const created = (await response.clone().json()) as { session: { sessionId: string } }
            ledger.record({
              kind: 'session',
              id: created.session.sessionId,
              label: `${runId}:managed-cli`,
              cleanup: async () =>
                await deleteStagingSession(
                  env,
                  workspace.slug,
                  created.session.sessionId,
                  apiToken,
                ),
              verify: async () => await workspaceIsDeleted(convex, env.internalKey, workspace._id),
            })
          }
          return response
        },
      },
    )
    await artifacts.writeJson('unified-managed-command.json', {
      exitCode: remoteExit,
      stdout: output.join(''),
      stderr: errors.join(''),
    })
    assert.equal(remoteExit, 0, 'Explicit remote CLI command failed')
    const events = output
      .join('')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event?: { type: string; status?: string } })
    assert(
      events.some(row => row.event?.type === 'complete' && row.event.status === 'completed'),
      'Remote CLI stream did not observe a completed turn',
    )
    const receipt = JSON.parse(
      await apiText(
        `${env.apiUrl}/v1/ws/${workspace.slug}/files/unified-duet-receipt.json`,
        { headers: bearer(apiToken) },
        200,
        'native managed CLI receipt',
        artifacts,
      ),
    ) as { status: string; runtimeVersion: string; rpcCompleted: boolean; memoryContent: string }
    assert.equal(receipt.status, 'pass')
    assert.equal(receipt.runtimeVersion, fresh.runtimeVersion)
    assert.equal(receipt.rpcCompleted, true)
    assert.equal(receipt.memoryContent, runId)
    return { localMemoryContent: localNote, remoteCompleted: true, ...receipt }
  } finally {
    await rm(localHome, { recursive: true, force: true })
  }
}
