import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, type FrameLocator } from '@playwright/test'

import type { ProviderCall } from '@repo/agent/workflow-fixtures'
import {
  AppResponseSchema,
  MODEL_TIERS,
  SessionCreateResponseSchema,
  SessionInputResponseSchema,
  SessionInterruptResponseSchema,
  type App,
} from '@repo/contract'

import type { WorkflowDiskEvidence } from './fixtures/workflow/dependency.ts'
import { provisionStagingAgent } from './staging-live-agent-fixture.ts'
import {
  deleteStagingSession,
  warmWorkflowRuntime,
  loadSessionHistory,
  loadSessionSnapshot,
} from './staging-live-agent-sessions.ts'
import { markExpectedBrowserTransition, navigateDeployedPage } from './staging-live-browser.ts'
import { fnQuery } from './staging-live-env.ts'
import { waitForForwardProgress } from './staging-live-forward-progress.ts'
import { apiJson, apiText, bearer, bearerJson, stagingFetch } from './staging-live-http.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import { readAnnouncedRuntime } from './staging-live-runtime'
import { listGenerations } from './staging-live-virtual-model-tiers.ts'
import {
  assertWorkflowRoutingOff,
  findWorkflowGeneration,
  historyHasTerminalAfter,
  inspectWorkflowHistory,
  record,
  waitForWorkflowRuntime,
} from './staging-live-workflow-evidence.ts'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
} from './staging-live-workspace-browser.ts'

type ScenarioId = 'correction-release' | 'populated-search'
type WorkflowFixtures = typeof import('@repo/agent/workflow-fixtures')

export async function runAgentCorrectionCompletionJourney(
  options: { onProgress?: (stage: string) => void } = {},
) {
  return await runWorkspaceBrowserJourney({
    journey: 'agent-correction-completion',
    label: 'Agent correction completion',
    onProgress: options.onProgress,
    run: context => runWorkflow(context, 'correction-release'),
  })
}
export async function runAgentPopulatedSearchJourney(
  options: { onProgress?: (stage: string) => void } = {},
) {
  return await runWorkspaceBrowserJourney({
    journey: 'agent-populated-search',
    label: 'Agent populated search',
    onProgress: options.onProgress,
    run: context => runWorkflow(context, 'populated-search'),
  })
}

async function loadFixture() {
  const moduleName = '@repo/agent/workflow-fixtures'
  const modulePath = fileURLToPath(import.meta.resolve(moduleName))
  const manifest = (await Bun.file(
    fileURLToPath(import.meta.resolve(`${moduleName}/manifest`)),
  ).json()) as {
    packageVersion: string
    sha256: string
  }
  const bytes = await Bun.file(fileURLToPath(import.meta.resolve(`${moduleName}/archive`))).text()
  const fixtures = (await import(modulePath)) as WorkflowFixtures
  return { fixtures, archive: fixtures.readWorkflowArchive(bytes, manifest), manifest, modulePath }
}

async function runWorkflow(context: WorkspaceBrowserJourneyContext, scenarioId: ScenarioId) {
  const { env, workspace, apiToken, artifacts, runId, progress } = context
  const fixture = await loadFixture()
  const { fixtures, archive, manifest } = fixture
  await artifacts.writeJson('workflow-fixture.json', { manifest, archive })
  const scenario = archive.scenarios.find(item => item.id === scenarioId)
  assert(scenario, `Missing workflow scenario ${scenarioId}`)
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  progress('workflow:release-preflight')
  const connection = (await context.convex.query(
    fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
    { internalKey: env.internalKey, slug: workspace.slug },
  )) as { vmToken: string; httpsUrl: string }
  assert(connection?.vmToken, 'workspace gateway connection missing')
  const loadAnnouncement = () =>
    readAnnouncedRuntime({
      apiUrl: env.apiUrl,
      vmToken: connection.vmToken,
      artifacts,
      label: 'workflow runtime manifest',
    })
  await warmWorkflowRuntime(context)
  const { health, announced } = await waitForWorkflowRuntime({
    loadAnnouncement,
    load: () =>
      apiJson<{ runtimeVersion?: string }>(
        `${connection.httpsUrl.replace(/\/+$/, '')}/health`,
        { headers: bearer(connection.vmToken) },
        200,
        'workflow runtime health',
        artifacts,
      ),
  })
  await artifacts.writeJson('workflow-runtime.json', { health, announced })
  const slug = `wf-${runId.slice(-6)}`
  const anchor = `agents/${slug}`
  const repo = `${anchor}/task`
  const dependency = `${anchor}/dependency`
  await provisionStagingAgent({
    ...context,
    slug,
    anchorPath: anchor,
    name: 'Workflow fixture',
    description:
      'Work only in the task directory on the requested outcome. The sibling dependency is an external test provider; do not modify it.',
  })
  const mkdir = async (target: string) =>
    apiJson(
      `${base}/files/actions`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ operation: 'mkdir', path: target, recursive: true }),
      },
      200,
      'workflow fixture directory',
      artifacts,
    )
  const put = async (target: string, body: string) =>
    apiText(
      `${base}/files/${target}`,
      { method: 'PUT', headers: bearer(apiToken, { 'content-type': 'text/plain' }), body },
      200,
      'workflow fixture write',
      artifacts,
    )
  await mkdir(repo)
  await mkdir(dependency)
  for (const [name, bytes] of Object.entries(archive.files)) {
    assert(
      !path.posix.isAbsolute(name) && !name.split('/').includes('..'),
      'unsafe fixture archive path',
    )
    if (name.includes('/')) await mkdir(`${repo}/${path.posix.dirname(name)}`)
    await put(`${repo}/${name}`, bytes)
  }
  const dependencySource = await bundleDependency(fixture.modulePath, archive.unchangedPaths)
  await put(`${dependency}/server.js`, dependencySource)
  const providerApp = await registerApp(context, `${slug}-provider`, dependency, 'bun server.js')
  await put(
    `${repo}/provider.json`,
    JSON.stringify({ url: `http://127.0.0.1:${providerApp.port}` }),
  )
  let frame = await openApp(context, slug, providerApp)
  assert.equal(
    (await frameRequest(frame, '/init', 'POST')).status,
    200,
    'fixture git initialization failed',
  )
  const generationsBefore = new Set((await listGenerations(context)).map(row => row._id))
  const startedAt = Date.now()
  const deadline = startedAt + archive.limits.wallClockMs
  let sessionId: string | undefined
  let lastHistory: Awaited<ReturnType<typeof loadSessionHistory>> | undefined
  try {
    progress(`workflow:${scenarioId}:start`)
    const prompt =
      scenarioId === 'correction-release'
        ? `Create this supplied relay with create_state_machine_definition and firstState "release", then execute it: ${JSON.stringify({ definition: fixtures.workflowReleaseDefinition(scenario.prompt), firstState: 'release' })}`
        : scenario.prompt
    const created = SessionCreateResponseSchema.parse(
      await apiJson(
        `${base}/agent/sessions`,
        {
          method: 'POST',
          headers: bearerJson(apiToken),
          body: JSON.stringify({ cwd: repo, prompt, tier: 'balanced' }),
        },
        201,
        'workflow session create',
        artifacts,
      ),
    )
    sessionId = created.session.sessionId
    const id = sessionId
    context.ledger.record({
      kind: 'session',
      id,
      label: `${runId}:workflow:${id}`,
      cleanup: () => deleteStagingSession(env, workspace.slug, id, apiToken),
      verify: () => workspaceIsDeleted(context.convex, env.internalKey, workspace._id),
    })
    assert.equal(created.snapshot.tier, 'balanced', 'workflow creation lost the selected tier')
    const wait = async (
      label: string,
      predicate: (
        snapshot: Awaited<ReturnType<typeof loadSessionSnapshot>>,
        history: Awaited<ReturnType<typeof loadSessionHistory>>,
      ) => boolean,
    ) => {
      return await waitForForwardProgress({
        label,
        timeoutMs: Math.max(1, deadline - Date.now()),
        pollMs: 1_000,
        maxConsecutiveUnchangedObservations: 240,
        load: async () => {
          const [snapshot, history] = await Promise.all([
            loadSessionSnapshot(env, workspace.slug, id, apiToken),
            loadSessionHistory(env, workspace.slug, id, apiToken),
          ])
          lastHistory = history
          inspectWorkflowHistory(history.events, archive.limits.toolCalls)
          return { snapshot, history }
        },
        isComplete: value => predicate(value.snapshot, value.history),
        hasProgress: (a, b) =>
          a.history.events.at(-1)?.seq !== b.history.events.at(-1)?.seq ||
          a.snapshot.turnStatus !== b.snapshot.turnStatus,
        summarize: value => ({
          status: value.snapshot.turnStatus,
          state: value.snapshot.machineState?.currentState,
          seq: value.history.events.at(-1)?.seq,
        }),
      })
    }
    let latestPrompt = prompt
    const message = async (prompt: string) => {
      latestPrompt = prompt
      return SessionInputResponseSchema.parse(
        await apiJson(
          `${base}/agent/sessions/${id}/messages`,
          {
            method: 'POST',
            headers: bearerJson(apiToken),
            body: JSON.stringify({ behavior: 'steer', prompt }),
          },
          202,
          'workflow user input',
          artifacts,
        ),
      )
    }
    let correctionPersisted = false
    let initialExecutionId: unknown
    let correctedDefinition: unknown
    if (scenarioId === 'correction-release') {
      const blocked = await wait(
        'first worker blocked on circular prerequisite',
        (snapshot, history) =>
          snapshot.machineState?.currentState === 'awaiting_correction' &&
          history.events.some(
            row =>
              record(row.event).type === 'task_settled' &&
              JSON.stringify(record(row.event).settlement).includes('CANDIDATE_SHA_REQUIRED'),
          ),
      )
      initialExecutionId = record(
        record(blocked.snapshot.machineState?.history.find(event => event.type === 'state_started'))
          .execution,
      ).id
      assert(
        typeof initialExecutionId === 'string',
        'first worker omitted admitted execution receipt',
      )
      assert(scenario.correction, 'correction fixture omitted user correction')
      await message(scenario.correction)
      const corrected = await wait(
        'correction persisted before interruption',
        (snapshot, history) => {
          const release = snapshot.machineState?.definition.states.find(
            state => state.name === 'release',
          )
          return (
            snapshot.turnStatus !== 'running' &&
            historyHasTerminalAfter(history.events, latestPrompt) &&
            snapshot.machineState?.currentState === 'awaiting_correction' &&
            release?.kind === 'agent' &&
            !release.prompt.includes('Before creating any commit, require') &&
            history.events.some(
              row =>
                record(row.event).type === 'prompt_submitted' &&
                record(row.event).prompt === scenario.correction,
            )
          )
        },
      )
      correctedDefinition = corrected.snapshot.machineState?.definition
      await artifacts.writeJson('workflow-corrected-definition.json', correctedDefinition)
      SessionInterruptResponseSchema.parse(
        await apiJson(
          `${base}/agent/sessions/${id}/interrupt`,
          { method: 'POST', headers: bearer(apiToken) },
          200,
          'workflow interrupt checkpoint',
          artifacts,
        ),
      )
      await wait('durable interruption', snapshot => snapshot.turnStatus === 'interrupted')
      await message(
        'Status only: what remains? Do not execute or change the saved release instructions yet.',
      )
      const status = await wait(
        'resumed status answer',
        (snapshot, history) =>
          snapshot.turnStatus !== 'running' &&
          snapshot.turnStatus !== 'interrupted' &&
          historyHasTerminalAfter(history.events, latestPrompt),
      )
      assert.deepEqual(
        status.snapshot.machineState?.definition,
        correctedDefinition,
        'status/resume lost the saved correction',
      )
      assert.equal(status.snapshot.tier, 'balanced', 'workflow resume lost the selected tier')
      correctionPersisted = true
      await message(
        'Continue the release using the saved correction. Finish the requested change and local release; leave unrelated files unchanged.',
      )
    }
    const terminal = await wait(
      'workflow outcome terminal',
      (snapshot, history) =>
        snapshot.turnStatus !== 'running' &&
        snapshot.turnStatus !== 'sleep' &&
        historyHasTerminalAfter(history.events, latestPrompt),
    )
    assert.equal(terminal.snapshot.turnStatus, 'complete', 'workflow stopped without completion')
    assert.equal(terminal.snapshot.tier, 'balanced', 'workflow completion lost the selected tier')
    const historyEvidence = inspectWorkflowHistory(
      terminal.history.events,
      archive.limits.toolCalls,
    )
    if (scenarioId === 'correction-release') {
      const effective =
        terminal.snapshot.machineState?.history
          .filter(event => event.type === 'state_started')
          .map(event => record(event).execution)
          .filter(Boolean) ?? []
      assert(effective.length >= 2, 'missing original and corrected admitted execution receipts')
      assert(
        effective.some(item => record(item).id === initialExecutionId),
        'restart discarded the original execution receipt',
      )
      assert(
        effective.every(item => typeof record(item).fingerprint === 'string'),
        'admitted execution omitted its effective fingerprint',
      )
      assert(
        historyEvidence.unchangedRetriesAfterDiagnostic <= 1,
        'workflow repeated unchanged execution after recovery diagnostic',
      )
      assert(
        new Set(effective.map(item => record(item).fingerprint)).size >= 2,
        'correction did not change effective worker execution',
      )
      await artifacts.writeJson('workflow-execution-receipts.json', effective)
    }
    const configUrl = new URL(`${connection.httpsUrl.replace(/\/+$/, '')}/v1/internal-admin/file`)
    configUrl.searchParams.set('path', `${repo}/.duet/models.json`)
    const config = await apiJson<{ content: string; truncated: boolean }>(
      configUrl.href,
      { headers: bearer(connection.vmToken) },
      200,
      'workflow managed routing',
      artifacts,
    )
    assert.equal(config.truncated, false)
    const routing: unknown = JSON.parse(config.content)
    assertWorkflowRoutingOff(routing)
    const appPath = scenarioId === 'correction-release' ? `${repo}/release` : repo
    if (scenarioId === 'correction-release') {
      // Exercise the released implementation, with the immutable fixture server/data.
      for (const name of ['server.ts', 'data.json', 'display.ts'])
        await put(`${appPath}/${name}`, archive.files[name]!)
      await put(
        `${appPath}/provider.json`,
        JSON.stringify({ url: `http://127.0.0.1:${providerApp.port}` }),
      )
    }
    const taskApp = await registerApp(context, `${slug}-search`, appPath, 'bun server.ts')
    frame = await openApp(context, slug, taskApp)
    const probes = fixtures.workflowSearchProbes()
    const responses = []
    for (const probe of probes) {
      await frame.getByLabel('Category', { exact: true }).selectOption(probe.category)
      await frame.getByLabel('Search', { exact: true }).fill(probe.query)
      const responsePromise = context.page.waitForResponse(
        response => {
          const url = new URL(response.url())
          return (
            url.pathname === '/api/search' &&
            url.searchParams.get('category') === probe.category &&
            url.searchParams.get('q') === probe.query
          )
        },
        { timeout: 30_000 },
      )
      await frame.getByRole('button', { name: 'Search', exact: true }).click()
      const response = await responsePromise
      const nonce = new URL(response.url()).searchParams.get('nonce')
      assert(nonce && nonce.length > 0, 'browser search omitted fresh request nonce')
      probe.nonce = nonce
      const body: unknown = await response.json()
      responses.push({ nonce, status: response.status(), body })
      await artifacts.writeJson('workflow-search-probes.json', { probes, responses })
      await expect(frame.locator('#results')).toHaveText(JSON.stringify(body), { timeout: 30_000 })
    }
    frame = await openApp(context, slug, providerApp)
    const providerCalls = (await frameRequest(frame, '/calls')).body as ProviderCall[]
    const disk = (await frameRequest(frame, '/evidence')).body as WorkflowDiskEvidence
    const unchangedFiles = (
      disk.unchangedFiles as Array<{ path: string; after: string | null }>
    ).map(item => ({ ...item, before: archive.files[item.path]! }))
    const retries = fixtures.verifyWorkflowRetries(
      historyEvidence.receipts.map(({ execution }) => ({
        id: String(execution.id),
        state: String(execution.state),
        fingerprint: String(execution.fingerprint),
      })),
    )
    const search = fixtures.verifySearchOutcome({
      probes,
      responses,
      providerCalls,
      unchangedFiles,
    })
    const release =
      scenarioId === 'correction-release'
        ? fixtures.verifyReleaseOutcome({
            ...disk,
            unchangedFiles,
            correctionPersisted,
            behaviorFailures: search.failures,
          })
        : undefined
    const dependencyAfter = await apiText(
      `${base}/files/${dependency}/server.js`,
      { headers: bearer(apiToken) },
      200,
      'independent dependency integrity',
      artifacts,
    )
    assert.equal(
      dependencyAfter,
      dependencySource,
      'agent changed independent dependency/oracle evidence code',
    )
    const advertisedModels = MODEL_TIERS.balanced.disclosedModels.map(model => model.gatewayModelId)
    assert(advertisedModels.length > 0, 'Balanced metadata omitted its advertised models')
    const generations = await waitForForwardProgress({
      label: 'settled execution of an advertised Balanced model',
      load: async () =>
        (await listGenerations(context)).filter(row => !generationsBefore.has(row._id)),
      isComplete: rows => findWorkflowGeneration(rows, advertisedModels) !== undefined,
      hasProgress: (before, after) => JSON.stringify(before) !== JSON.stringify(after),
      timeoutMs: Math.max(0, deadline - Date.now()),
      pollMs: 1_000,
      maxConsecutiveUnchangedObservations: 60,
    })
    const generation = findWorkflowGeneration(generations, advertisedModels)
    assert(generation, 'settled Balanced generation missing after readiness')
    const evidence = {
      advertisedModels,
      generation,
      scenarioId,
      fixture: manifest,
      revision: archive.revision,
      runtime: { ...health, announced },
      sessionId: id,
      tier: terminal.snapshot.tier,
      elapsedMs: Date.now() - startedAt,
      history: historyEvidence,
      routing,
      probes,
      responses,
      providerCalls,
      disk,
      search,
      release,
      retries,
      generations,
    }
    await artifacts.writeJson('workflow-outcome.json', evidence)
    assert.deepEqual(search.failures, [], 'populated search/provider oracle failed')
    assert.deepEqual(retries.failures, [], 'unchanged retry oracle failed')
    if (release) assert.deepEqual(release.failures, [], 'corrected local release oracle failed')
    return evidence
  } catch (error) {
    await artifacts.writeJson('workflow-failure.json', {
      scenarioId,
      sessionId,
      elapsedMs: Date.now() - startedAt,
      error: String(error),
    })
    throw error
  } finally {
    if (lastHistory) await artifacts.writeJson('workflow-history.json', lastHistory)
    if (sessionId)
      await apiJson(
        `${base}/agent/sessions/${sessionId}/interrupt`,
        { method: 'POST', headers: bearer(apiToken) },
        200,
        'workflow stop before cleanup',
        artifacts,
      ).catch(async error => {
        await artifacts.writeJson('workflow-interrupt-error.json', { message: String(error) })
      })
    // Keep provider and artifact observations even when a browser or model assertion fails.
    try {
      frame = await openApp(context, slug, providerApp)
      await artifacts.writeJson('workflow-dependency-evidence.json', {
        calls: await frameRequest(frame, '/calls'),
        disk: await frameRequest(frame, '/evidence'),
        generations: (await listGenerations(context)).filter(
          row => !generationsBefore.has(row._id),
        ),
      })
    } catch (error) {
      await artifacts.writeJson('workflow-evidence-error.json', { error: String(error) })
    }
  }
}

async function registerApp(
  context: WorkspaceBrowserJourneyContext,
  slug: string,
  anchorPath: string,
  command: string,
): Promise<App> {
  const { env, workspace, apiToken, artifacts, ledger, runId } = context
  const base = `${env.apiUrl}/v1/ws/${workspace.slug}`
  const result = AppResponseSchema.parse(
    await apiJson(
      `${base}/apps`,
      {
        method: 'POST',
        headers: bearerJson(apiToken),
        body: JSON.stringify({ path: anchorPath, slug, name: slug, command, apiScopes: [] }),
      },
      201,
      'workflow app register',
      artifacts,
    ),
  )
  ledger.record({
    kind: 'app',
    id: result.app.id,
    label: `${runId}:workflow-app:${slug}`,
    cleanup: async () => {
      const response = await stagingFetch(`${base}/apps/${slug}`, {
        method: 'DELETE',
        headers: bearer(apiToken),
      })
      assert(
        [200, 204, 404].includes(response.status),
        `workflow app cleanup returned ${response.status}`,
      )
    },
    verify: () => workspaceIsDeleted(context.convex, env.internalKey, workspace._id),
  })
  return result.app
}

async function openApp(
  context: WorkspaceBrowserJourneyContext,
  agentSlug: string,
  app: App,
): Promise<FrameLocator> {
  markExpectedBrowserTransition(context.page)
  await navigateDeployedPage(
    context.page,
    `${context.env.appUrl}/w/${context.workspace.slug}/agents/${agentSlug}/apps/${app.slug}`,
  )
  const iframe = context.page
    .locator('iframe')
    .and(context.page.getByTitle(app.name ?? app.slug, { exact: true }))
  await iframe.waitFor({ timeout: 120_000 })
  const frame = iframe.contentFrame()
  if (app.slug.endsWith('-provider'))
    await frame
      .getByText('Workflow dependency ready', { exact: true })
      .waitFor({ timeout: 120_000 })
  else await frame.getByLabel('Category', { exact: true }).waitFor({ timeout: 120_000 })
  return frame
}
async function frameRequest(
  frame: FrameLocator,
  url: string,
  method = 'GET',
): Promise<{ status: number; body: unknown }> {
  return await frame.locator('body').evaluate(
    async (_body, args) => {
      const response = await fetch(args.url, { method: args.method })
      const text = await response.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      return { status: response.status, body }
    },
    { url, method },
  )
}
async function bundleDependency(modulePath: string, unchangedPaths: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-dependency-'))
  try {
    const entry = path.join(directory, 'entry.ts')
    await writeFile(
      entry,
      `import { createWorkflowProvider } from ${JSON.stringify(modulePath)};\nimport { createWorkflowDependency } from ${JSON.stringify(new URL('./fixtures/workflow/dependency.ts', import.meta.url).pathname)};\nimport { resolve } from 'node:path';\nconst handler = createWorkflowDependency({root:resolve('../task'),unchangedPaths:${JSON.stringify(unchangedPaths)},provider:createWorkflowProvider()});\nBun.serve({hostname:'0.0.0.0',port:Number(process.env.PORT),fetch:handler});\n`,
    )
    const built = await Bun.build({ entrypoints: [entry], target: 'bun', minify: false })
    assert(built.success, `workflow dependency build failed: ${built.logs}`)
    return await built.outputs[0]!.text()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
