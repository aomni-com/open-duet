import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import JSZip from 'jszip'

import {
  BACKUP_UPLOAD_GRANT_MS,
  BACKUP_UPLOAD_SETTLE_MS,
  BackupCaptureRecordSchema,
  BackupInventoryEntrySchema,
  BackupResponseSchema,
  BackupDownloadResponseSchema,
  AppResponseSchema,
  AgentResponseSchema,
  SessionWaitResponseSchema,
  WorkspaceCreateResultSchema,
  type BackupInventoryEntry,
  type Backup,
} from '@repo/contract'

import { provisionStagingAgent } from './staging-live-agent-fixture'
import { verifyFreshWorkspaceAppsAndFilesApi } from './staging-live-apps-files'
import { navigateDeployedPage, markExpectedBrowserTransition } from './staging-live-browser'
import { fnAction, fnMutation, fnQuery } from './staging-live-env'
import { apiJson, bearer, bearerJson, stagingFetch } from './staging-live-http'
import { recordWorkspaceCleanup } from './staging-live-resource-ledger'
import { waitForWorkspace } from './staging-live-streaming'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
} from './staging-live-workspace-browser'

/** Independent reader: the production encoder never participates in this check. */
export async function inspectWorkspaceBackup(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  const text = async (path: string) => {
    const entry = zip.file(path)
    assert(entry, `Backup omitted ${path}`)
    return entry.async('text')
  }
  assert((await text('README.md')).length > 0, 'Backup omitted recovery instructions')
  const manifest = JSON.parse(await text('manifest.json')) as { completeness: string }
  assert(
    ['complete', 'partial'].includes(manifest.completeness),
    'Backup has no completeness verdict',
  )
  const inventory = new Map<string, BackupInventoryEntry>()
  for (const line of (await text('inventory.ndjson')).split('\n').filter(Boolean)) {
    const row = BackupInventoryEntrySchema.parse(JSON.parse(line))
    assert(!inventory.has(row.path), `Duplicate inventory entry ${row.path}`)
    inventory.set(row.path, row)
    const entry = zip.files[row.path]
    assert(entry, `Backup omitted inventoried ${row.path}`)
    if (row.type === 'directory') {
      assert(entry.dir, `${row.path} is not a directory`)
      continue
    }
    const content = await entry.async('uint8array')
    assert.equal(content.length, row.bytes, `Wrong byte count for ${row.path}`)
    if (row.sha256)
      assert.equal(
        createHash('sha256').update(content).digest('hex'),
        row.sha256,
        `Wrong digest for ${row.path}`,
      )
    if (row.type === 'symlink')
      assert.equal(Buffer.from(content).toString(), row.target, `Wrong link target for ${row.path}`)
  }
  for (const entry of Object.values(zip.files)) {
    assert(
      !entry.name.startsWith('/') && !entry.name.split('/').includes('..'),
      `Unsafe path ${entry.name}`,
    )
    if (!entry.dir && /^(drive|workspace)\//.test(entry.name))
      assert(inventory.has(entry.name), `Missing inventory for ${entry.name}`)
  }
  const warnings = (await text('warnings.ndjson'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  assert(
    manifest.completeness !== 'complete' || warnings.length === 0,
    'Complete backup hides warnings',
  )
  return { zip, inventory, manifest, warnings }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

export function runWorkspaceBackupJourney(options: { onProgress?: (stage: string) => void } = {}) {
  return runWorkspaceBrowserJourney({
    journey: 'workspace-backup',
    label: 'Workspace Backup',
    onProgress: options.onProgress,
    run: runWorkspaceBackupAcceptance,
  })
}

async function runWorkspaceBackupAcceptance(context: WorkspaceBrowserJourneyContext) {
  const { env, workspace, apiToken, runId, convex, artifacts, page, progress } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const marker = `BACKUP-${runId}`
  const slug = `backup-${runId.slice(-6)}`
  const fixtureRoot = 'backup-fixture'
  const appPath = `${fixtureRoot}/app`
  progress('backup:seed-files-through-agent')
  const script = `import os,json,pathlib,urllib.request
root=pathlib.Path('/home/exedev/drive')
p=root/'${fixtureRoot}'
p.mkdir(exist_ok=True)
for folder in ['.hidden','ignored','node_modules/package','.cache','empty']:(p/folder).mkdir(parents=True,exist_ok=True)
for name in ['.env','.hidden/value','ignored/value','node_modules/package/index.js','.cache/value']:(p/name).write_text(${JSON.stringify(marker)})
(p/'.gitignore').write_text('ignored/\\nnode_modules/\\n.cache/\\n')
(p/'binary.bin').write_bytes(bytes(range(256))*4096)
(p/'tool.sh').write_text('#!/bin/sh\\nprintf backup\\n')
(p/'tool.sh').chmod(0o751)
for name,target in [('relative-link','binary.bin'),('outside-link','/etc/hostname'),('dangling-link','not-present')]:
 if not os.path.lexists(p/name):os.symlink(target,p/name)
if not os.path.exists(p/'unsupported.fifo'):os.mkfifo(p/'unsupported.fifo')
outside=pathlib.Path('/home/exedev/.duet/backup-outside-marker.txt')
outside.parent.mkdir(parents=True,exist_ok=True)
outside.write_text(${JSON.stringify(marker)})
request=urllib.request.Request(os.environ['DUET_API_URL'].rstrip('/')+'/v1/ws/${workspace.slug}/backups',headers={'Authorization':'Bearer '+os.environ['DUET_API_KEY']})
with urllib.request.urlopen(request) as response:
 assert response.status==200
(p/'agent-admin-proof.json').write_text(json.dumps({'backupAdminRead':True}))
print(${JSON.stringify(marker)})`
  const command = `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(script).toString('base64')}'))"`
  const turn = SessionWaitResponseSchema.parse(
    await apiJson(
      `${base}/agent/sessions/wait`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          prompt: `Execute this exact shell command once. Do not inspect other files or print environment values. Then reply ${marker}.\n\n${command}`,
        }),
        signal: AbortSignal.timeout(780_000),
      },
      200,
      'backup fixture shell',
      artifacts,
    ),
  )
  assert(
    'terminal' in turn && turn.terminal.event.type === 'complete',
    'Fixture agent did not finish',
  )
  const proof = await apiJson<{ backupAdminRead: boolean }>(
    `${base}/files/${fixtureRoot}/agent-admin-proof.json`,
    { headers: bearer(apiToken) },
    200,
    'agent backup scope proof',
    artifacts,
  )
  assert.equal(proof.backupAdminRead, true)

  const agent = await provisionStagingAgent({
    ...context,
    slug,
    name: 'Backup fixture agent',
    description: 'Portable backup recreation fixture.',
  })
  const appSource = `Bun.serve({port:Number(process.env.PORT),fetch:()=>new Response(${JSON.stringify(marker)})})\n`
  await writeFileThroughApi(
    context,
    workspace.slug,
    `${appPath}/app.ts`,
    Buffer.from(appSource),
  )
  const app = AppResponseSchema.parse(
    await apiJson(
      `${base}/apps`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          path: appPath,
          slug,
          command: 'bun app.ts',
          port: 4123,
          apiScopes: [],
        }),
      },
      201,
      'backup fixture app',
      artifacts,
    ),
  ).app
  const images = (await convex.action(fnAction('domains/agentSessions/model:storeInputImages'), {
    internalKey: env.internalKey,
    images: [{ mimeType: 'image/png', data: PNG.toString('base64') }],
  })) as Array<{ storageId: string; bytes: number }>
  const history = (await convex.mutation(fnMutation('testing/workspaceBackups:seedMetadata'), {
    internalKey: env.internalKey,
    workspaceId: workspace._id,
    agentId: agent.id,
    imageStorageId: images[0]!.storageId,
    imageBytes: PNG.length,
    marker,
  })) as { parentId: string; childId: string; eventCount: number }

  progress('backup:partial-capture')
  const partial = await startBackup(context, 'partial')
  const partialReady = await waitForBackup(context, partial.id)
  assert.equal(partialReady.completeness, 'partial', 'Unsupported FIFO was silently omitted')
  const partialDownload = await downloadBackup(context, partial.id)
  const partialZip = await inspectWorkspaceBackup(partialDownload.bytes)
  assert(
    partialZip.warnings.some(
      w => w.code === 'unsupported_node' && w.path.includes('unsupported.fifo'),
    ),
    'Partial backup omitted its source warning',
  )
  const removed = await stagingFetch(`${base}/files/${fixtureRoot}/unsupported.fifo`, {
    method: 'DELETE',
    headers: bearer(apiToken),
  })
  assert.equal(removed.status, 200, 'Could not remove the controlled partial fixture')

  progress('backup:background-and-settings')
  const backup = await startBackup(context, 'complete')
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/settings/backups`)
  await page.locator('[data-backups-card]').waitFor()
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/files`)
  const ready = await waitForBackup(context, backup.id)
  assert.equal(
    ready.completeness,
    'complete',
    `Unexpected warnings: ${JSON.stringify(ready.progress.warningSummary)}`,
  )
  markExpectedBrowserTransition(page)
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/settings/backups`)
  const row = page.locator(`[data-backup-id="${backup.id}"]`)
  await row.getByRole('button', { name: 'Download', exact: true }).waitFor()
  await artifacts.reservePrivateFile(path.join(artifacts.directory, 'backups-settings.png'))
  await page.screenshot({
    path: path.join(artifacts.directory, 'backups-settings.png'),
    fullPage: true,
  })
  const downloadEvent = page.waitForEvent('download')
  await row.getByRole('button', { name: 'Download', exact: true }).click()
  const browserDownload = await downloadEvent
  assert((await browserDownload.failure()) === null, 'Settings backup download failed')
  await browserDownload.delete()

  const downloaded = await downloadBackup(context, backup.id)
  assert.equal(createHash('sha256').update(downloaded.bytes).digest('hex'), ready.sha256)
  const inspected = await inspectWorkspaceBackup(downloaded.bytes)
  const zip = inspected.zip
  // Keep only the inspected archive's recovery instructions and synthetic fixture
  // records, never its runtime-bearing .env or arbitrary Drive content.
  const readmePath = path.join(artifacts.directory, 'backup-recovery-README.md')
  await artifacts.reservePrivateFile(readmePath)
  await writeFile(readmePath, await zip.file('README.md')!.async('text'))
  const records = async (file: string) =>
    (await zip.file(file)!.async('text'))
      .split('\n')
      .filter(Boolean)
      .map(line => BackupCaptureRecordSchema.parse(JSON.parse(line)))
  const archivedAgent = (await records('workspace/agents.ndjson')).find(
    record => record.kind === 'agent' && record.key === agent.id,
  )
  const archivedApp = (await records('workspace/apps.ndjson')).find(
    record => record.kind === 'app' && record.key === app.id,
  )
  assert(
    archivedAgent?.kind === 'agent' && archivedApp?.kind === 'app',
    'Archive omitted fixture agent/app configuration',
  )

  for (const name of [
    '.env',
    '.hidden/value',
    'ignored/value',
    'node_modules/package/index.js',
    '.cache/value',
  ])
    assert.equal(await zip.file(`drive/${fixtureRoot}/${name}`)!.async('text'), marker)
  const binaryFixture = Uint8Array.from({ length: 1_048_576 }, (_, index) => index % 256)
  assert.deepEqual(
    await zip.file(`drive/${fixtureRoot}/binary.bin`)!.async('uint8array'),
    binaryFixture,
  )
  assert.equal(inspected.inventory.get(`drive/${fixtureRoot}/tool.sh`)!.mode & 0o7777, 0o751)
  assert(inspected.inventory.get(`drive/${fixtureRoot}/empty/`)?.type === 'directory')
  for (const [name, target] of [
    ['relative-link', 'binary.bin'],
    ['outside-link', '/etc/hostname'],
    ['dangling-link', 'not-present'],
  ])
    assert.equal(inspected.inventory.get(`drive/${fixtureRoot}/${name}`)!.target, target)
  assert(
    !Object.keys(zip.files).some(name => name.includes('backup-outside-marker')),
    'Backup crossed the Drive boundary',
  )
  const sessionDir = (id: string) => `workspace/sessions/${Buffer.from(id).toString('base64url')}`
  const parent = JSON.parse(
    await zip.file(`${sessionDir(history.parentId)}/session.json`)!.async('text'),
  )
  const child = JSON.parse(
    await zip.file(`${sessionDir(history.childId)}/session.json`)!.async('text'),
  )
  assert(parent.archived && !parent.visible && child.parentKey === history.parentId)
  const eventsText = await zip.file(`${sessionDir(history.parentId)}/events.ndjson`)!.async('text')
  const events = eventsText
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.deepEqual(
    events.map(event => event.seq),
    Array.from({ length: history.eventCount }, (_, index) => index + 1),
    'Paged history omitted or reordered events',
  )
  assert(
    !eventsText.includes('excluded-backup-fixture-request'),
    'Operational request metadata escaped',
  )
  assert(!eventsText.includes('submittingActorId'), 'Submitting credential metadata escaped')
  const image = events[0].event.images[0]
  assert.deepEqual(
    await zip.file(`${sessionDir(history.parentId)}/${image.archivePath}`)!.async('nodebuffer'),
    PNG,
  )
  assert(
    (await zip.file(`${sessionDir(history.parentId)}/transcript.md`)!.async('text')).includes(
      marker,
    ),
  )
  const integrations = await records('workspace/integrations.ndjson')
  const archivedPolicy = integrations.find(
    record => record.kind === 'toolkitPolicy' && record.toolkitSlug === 'github',
  )
  assert(archivedPolicy?.kind === 'toolkitPolicy', 'Archive omitted fixture policy')
  assert.deepEqual(archivedPolicy.allowedAgentIds, [agent.id])
  await artifacts.writeJson('backup-recovery-fixture.json', {
    marker,
    agent: archivedAgent,
    app: archivedApp,
    policy: archivedPolicy,
    sourceFiles: {
      [`${fixtureRoot}/.env`]: marker,
      [`agents/${slug}/AGENTS.md`]: await zip.file(`drive/agents/${slug}/AGENTS.md`)!.async('text'),
      [`${appPath}/app.ts`]: await zip.file(`drive/${appPath}/app.ts`)!.async('text'),
    },
  })
  assert(
    integrations.some(
      record => record.kind === 'mcpServer' && record.token === 'synthetic-backup-static-token',
    ),
  )
  assert(
    !Object.keys(zip.files).some(name => /workspace\/(members|auth|billing|apiKeys)/.test(name)),
  )
  await artifacts.writeJson('backup-artifact-evidence.json', {
    backupId: backup.id,
    sha256: ready.sha256,
    bytes: ready.bytes,
    counts: ready.progress,
    archivedSession: history.parentId,
    childSession: history.childId,
    fullEventCeiling: events.at(-1).seq,
  })

  progress('backup:replacement')
  const original = await waitForWorkspace(
    convex,
    env.internalKey,
    workspace._id,
    w => w.status === 'active' && !!w.vmTokenNonce,
  )
  const replacement = (await convex.mutation(
    fnMutation('domains/workspaces/lifecycle:requestReprovision'),
    {
      internalKey: env.internalKey,
      workspaceId: workspace._id,
    },
  )) as { status: string; backupId?: string }
  assert.equal(
    replacement.status,
    'backup_pending',
    'Replacement did not begin through a durable backup',
  )
  assert(replacement.backupId, 'Replacement omitted its backup identity')
  recordBackupCleanup(context, replacement.backupId)
  const replacementBackup = await waitForBackup(context, replacement.backupId, true)
  assert.equal(replacementBackup.completeness, 'complete')
  const replaced = await waitForWorkspace(
    convex,
    env.internalKey,
    workspace._id,
    w => w.status === 'active' && !!w.vmTokenNonce && w.vmTokenNonce !== original.vmTokenNonce,
    600_000,
  )
  assert(
    replaced.vmTokenNonce !== original.vmTokenNonce,
    'Replacement reused the VM credential generation',
  )
  await waitForFileBytes(context, `${fixtureRoot}/.env`, Buffer.from(marker))
  await waitForFileBytes(context, `${fixtureRoot}/binary.bin`, binaryFixture)
  const retained = await downloadBackup(context, backup.id)
  assert.equal(
    createHash('sha256').update(retained.bytes).digest('hex'),
    ready.sha256,
    'Original backup was lost with its VM',
  )

  progress('backup:recreate-with-existing-apis')
  await convex.mutation(
    fnMutation('testing/workspaces:activateSyntheticSubscriptionByEmailForTest'),
    {
      internalKey: env.internalKey,
      email: context.email,
      plan: 'pro',
    },
  )
  const destination = WorkspaceCreateResultSchema.parse(
    await apiJson(
      `${env.apiUrl}/v1/workspaces`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          slug: `backup-recovery-${runId.slice(-6)}`,
          name: `Backup recovery ${runId}`,
        }),
      },
      202,
      'fresh recovery workspace',
      artifacts,
    ),
  )
  recordWorkspaceCleanup({
    ledger: context.ledger,
    convex,
    env,
    output: { vmNames: context.vmNames },
    workspaceId: destination.workspaceId,
    slug: destination.slug,
  })
  await waitForWorkspace(
    convex,
    env.internalKey,
    destination.workspaceId,
    w => w.status === 'active',
  )
  await verifyFreshWorkspaceAppsAndFilesApi({
    env,
    apiToken,
    workspace: { _id: destination.workspaceId, slug: destination.slug, status: 'active' },
    artifacts,
  })
  for (const file of [`${fixtureRoot}/.env`, `agents/${slug}/AGENTS.md`, `${appPath}/app.ts`])
    await writeFileThroughApi(
      context,
      destination.slug,
      file,
      await zip.file(`drive/${file}`)!.async('nodebuffer'),
    )
  await waitForFileBytes(
    { ...context, workspace: { ...workspace, slug: destination.slug } },
    `${fixtureRoot}/.env`,
    Buffer.from(marker),
  )
  const destinationBase = `${env.apiUrl}/v1/ws/${destination.slug}`
  const recoveredAgent = AgentResponseSchema.parse(
    await apiJson(
      `${destinationBase}/agents`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          path: archivedAgent.path,
          slug: archivedAgent.slug,
          name: archivedAgent.name,
        }),
      },
      201,
      'recreate agent',
      artifacts,
    ),
  ).agent
  const recoveredApp = AppResponseSchema.parse(
    await apiJson(
      `${destinationBase}/apps`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({
          path: archivedApp.path,
          slug: archivedApp.slug,
          command: archivedApp.command,
          port: archivedApp.port,
          apiScopes: archivedApp.apiScopes,
        }),
      },
      201,
      'recreate app',
      artifacts,
    ),
  ).app
  const policy = await apiJson<{ allowedAgentIds: string[] }>(
    `${destinationBase}/integrations/github/agent-policy`,
    {
      method: 'PUT',
      headers: bearerJson(apiToken),
      body: JSON.stringify({
        allowedAgentIds: archivedPolicy.allowedAgentIds.map(id => {
          assert.equal(id, archivedAgent.key)
          return recoveredAgent.id
        }),
      }),
    },
    200,
    'recreate integration policy with remapped IDs',
    artifacts,
  )
  assert.deepEqual(policy.allowedAgentIds, [recoveredAgent.id])
  assert.notEqual(recoveredAgent.id, agent.id)
  assert.notEqual(recoveredApp.id, app.id)

  progress('backup:delete')
  await navigateDeployedPage(page, `${env.appUrl}/w/${workspace.slug}/settings/backups`)
  const deletingRow = page.locator(`[data-backup-id="${backup.id}"]`)
  await deletingRow.getByRole('button', { name: 'Delete', exact: true }).click()
  await deletingRow.getByRole('button', { name: 'Delete backup', exact: true }).click()
  await deletingRow.waitFor({ state: 'detached', timeout: 90_000 })
  const denied = await stagingFetch(`${base}/backups/${backup.id}/download`, {
    method: 'POST',
    headers: bearer(apiToken),
  })
  assert.equal(denied.status, 404, 'Deleted backup still admitted downloads')
  const revoked = await fetch(downloaded.grant.url)
  await revoked.body?.cancel()
  assert.equal(
    revoked.status,
    404,
    'Deleted private object remained readable through an uncached grant',
  )
  await deleteBackup(context, partial.id)
  await deleteBackup(context, replacement.backupId)
  return {
    backupId: backup.id,
    bytes: ready.bytes,
    sha256: ready.sha256,
    partialWarning: 'unsupported_node',
    eventCeiling: events.at(-1).seq,
    retainedAfterReplacement: true,
    freshRecoveryWorkspaceId: destination.workspaceId,
    deletedObjectStatus: revoked.status,
  }
}

async function writeFileThroughApi(
  context: WorkspaceBrowserJourneyContext,
  slug: string,
  file: string,
  bytes: Uint8Array,
) {
  const response = await stagingFetch(`${context.env.apiUrl}/v1/ws/${slug}/files/${file}`, {
    method: 'PUT',
    headers: bearer(context.apiToken, { 'content-type': 'application/octet-stream' }),
    body: Buffer.from(bytes),
  })
  assert.equal(response.status, 200, `File recreation failed: ${file}`)
}

async function startBackup(context: WorkspaceBrowserJourneyContext, purpose: string) {
  const url = `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/backups`
  const request = { requestId: `${context.runId}:${purpose}` }
  const create = async () =>
    BackupResponseSchema.parse(
      await apiJson(
        url,
        {
          method: 'POST',
          headers: bearerJson(context.apiToken),
          body: JSON.stringify(request),
        },
        202,
        'create backup',
        context.artifacts,
      ),
    ).backup
  const backup = await create()
  recordBackupCleanup(context, backup.id)
  assert.equal((await create()).id, backup.id, 'Creation retry allocated another backup')
  return backup
}

async function waitForBackup(
  context: WorkspaceBrowserJourneyContext,
  id: string,
  awaitReplacement = false,
): Promise<Backup> {
  const deadline = Date.now() + 600_000
  for (;;) {
    const { backup } = BackupResponseSchema.parse(
      await apiJson(
        `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/backups/${id}`,
        { headers: bearer(context.apiToken) },
        200,
        'backup status',
        context.artifacts,
      ),
    )
    assert(
      !['failed', 'deleting'].includes(backup.status),
      `Backup failed: ${JSON.stringify(backup.error)}`,
    )
    if (awaitReplacement) {
      assert(
        !['failed', 'deferred', 'abandoned'].includes(backup.lifecycle?.status ?? ''),
        `Replacement failed: ${JSON.stringify(backup.lifecycle)}`,
      )
    }
    if (backup.status === 'ready' && (!awaitReplacement || backup.lifecycle?.status === 'complete'))
      return backup
    assert(Date.now() < deadline, `Backup stopped progressing: ${JSON.stringify(backup.progress)}`)
    await Bun.sleep(1_000)
  }
}

async function downloadBackup(context: WorkspaceBrowserJourneyContext, id: string) {
  const grant = BackupDownloadResponseSchema.parse(
    await apiJson(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/backups/${id}/download`,
      { method: 'POST', headers: bearer(context.apiToken) },
      200,
      'backup download grant',
      context.artifacts,
    ),
  )
  const unsigned = new URL(grant.url)
  unsigned.search = ''
  const privateRead = await fetch(unsigned)
  await privateRead.body?.cancel()
  assert.equal(privateRead.status, 403, 'Backup was readable without a signed grant')
  const response = await fetch(grant.url)
  assert.equal(response.status, 200, 'Signed backup read failed')
  assert(response.headers.get('content-disposition')?.startsWith('attachment;'))
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.equal(bytes.length, grant.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), grant.sha256)
  return { grant, bytes }
}

export async function deleteBackup(
  context: { env: { apiUrl: string }; workspace: { slug: string }; apiToken: string },
  id: string,
) {
  const url = `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/backups/${id}`
  const response = await stagingFetch(url, { method: 'DELETE', headers: bearer(context.apiToken) })
  await response.body?.cancel()
  if (response.status === 404) return
  assert([200, 202].includes(response.status), `Backup deletion refused: ${response.status}`)
  const deadline = Date.now() + 90_000
  for (;;) {
    const read = await stagingFetch(url, { headers: bearer(context.apiToken) })
    await read.body?.cancel()
    if (read.status === 404) return
    assert(Date.now() < deadline, `Backup ${id} cleanup did not settle`)
    await Bun.sleep(1_000)
  }
}

export function recordBackupCleanup(
  context: Pick<WorkspaceBrowserJourneyContext, 'runId' | 'ledger' | 'convex'> & {
    env: { apiUrl: string; internalKey: string }
    workspace: { _id: string; slug: string }
    apiToken: string
  },
  id: string,
) {
  const removed = async () =>
    (await context.convex.query(fnQuery('domains/workspaceBackups/jobs:get'), {
      internalKey: context.env.internalKey,
      workspaceId: context.workspace._id,
      backupId: id,
    })) === null
  context.ledger.record({
    kind: 'backup',
    id,
    label: `${context.runId}:backup:${id}`,
    // Workspace deletion releases lifecycle pins and owns cancellation. Wait
    // afterward, before retiring identity, for any issued upload grant to expire.
    cleanupPriority: -10,
    cleanup: async () => {
      const deadline = Date.now() + BACKUP_UPLOAD_GRANT_MS + BACKUP_UPLOAD_SETTLE_MS + 90_000
      for (;;) {
        if (await removed()) return
        assert(
          Date.now() < deadline,
          `Backup ${id} cleanup did not settle after workspace deletion`,
        )
        await Bun.sleep(1_000)
      }
    },
    verify: removed,
  })
}

async function waitForFileBytes(
  context: WorkspaceBrowserJourneyContext,
  file: string,
  expected: Uint8Array,
) {
  const deadline = Date.now() + 180_000
  for (;;) {
    const response = await stagingFetch(
      `${context.env.apiUrl}/v1/ws/${context.workspace.slug}/files/${file}`,
      { headers: bearer(context.apiToken) },
    )
    if (response.status === 200) {
      if (Buffer.from(await response.arrayBuffer()).equals(expected)) return
    } else await response.body?.cancel()
    assert(Date.now() < deadline, `Restored Drive omitted ${file}`)
    await Bun.sleep(1_000)
  }
}
