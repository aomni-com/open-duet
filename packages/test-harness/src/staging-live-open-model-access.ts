import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { transportModelId } from '@repo/agent/model-resolution/catalog'
import { routingCatalogAdapter } from '@repo/agent/model-resolution/resolver'
import { resolveTierDefault } from '@repo/agent/model-routing/resolve'
import { BUILT_IN_ROUTING_TABLE } from '@repo/agent/model-routing/table'
import { APPROVED_MODELS, WhoamiResponseSchema, buildManagedRoutingTable } from '@repo/contract'

import { configPathForHome, saveConfig } from '../../duet/src/config'
import { safeRequestTarget } from './staging-live-artifacts'
import { fnQuery } from './staging-live-env'
import { waitForForwardProgress } from './staging-live-forward-progress'
import { apiJson, bearer, stagingFetch, timedFetch } from './staging-live-http'
import {
  extractFileResource,
  assertBareFileResponseHeaders,
} from './staging-live-mcp-file-resources'
import {
  inspectOpenModelSettlement,
  selectOpenModelProbes,
  waitForFailedOpenModelAccounting,
  type ExpectedGeneration,
  type OpenModelRow,
} from './staging-live-open-model-access-evidence'
import { listGenerations } from './staging-live-virtual-model-tiers'
import {
  runWorkspaceBrowserJourney,
  type WorkspaceBrowserJourneyContext,
} from './staging-live-workspace-browser'

export async function runOpenModelAccessJourney(
  options: { onProgress?: (stage: string) => void } = {},
) {
  const deadlineAt = Date.now() + 20 * 60_000
  assert(!process.env.CONVEX_DEPLOYMENT?.startsWith('prod:'), 'Open model access requires staging')
  const modelUrl = stagingOrigin('DUET_MODEL_GATEWAY_URL')
  const mcpUrl = stagingOrigin('DUET_MCP_PUBLIC_URL')
  const entry = resolve(import.meta.dir, '../../duet/dist/public-package/dist/cli-entry.js')
  assert(
    await Bun.file(entry).exists(),
    'Build the public CLI with packages/duet build:public before this journey',
  )
  return await runWorkspaceBrowserJourney({
    journey: 'open-model-access',
    label: 'Open model access',
    deadlineAt,
    onProgress: options.onProgress,
    run: context => runOpenModelAccessAcceptance(context, { deadlineAt, modelUrl, mcpUrl, entry }),
  })
}

async function runOpenModelAccessAcceptance(
  context: WorkspaceBrowserJourneyContext,
  options: { deadlineAt: number; modelUrl: string; mcpUrl: string; entry: string },
) {
  const { env, workspace, apiToken, artifacts, progress } = context
  const remaining = () => {
    const ms = options.deadlineAt - Date.now()
    assert(ms > 0, 'Open model access acceptance deadline expired')
    return ms
  }
  const startIds = new Set((await listGenerations(context)).map(row => row._id))
  const scratch = await mkdtemp(join(tmpdir(), 'duet-open-model-access-'))
  const client = new Client({ name: 'duet-open-model-access-acceptance', version: '1.0.0' })
  const attempts: Array<Record<string, unknown>> = []
  try {
    const home = join(scratch, 'home')
    await saveConfig(
      { apiKey: apiToken, apiUrl: env.apiUrl, defaultWorkspace: workspace.slug },
      configPathForHome(home),
    )
    await client.connect(
      new StreamableHTTPClientTransport(new URL(options.mcpUrl), {
        requestInit: {
          headers: bearer(apiToken, { 'x-vercel-protection-bypass': env.vercelBypassSecret }),
        },
        fetch: (input, init) =>
          stagingFetch(input, {
            ...init,
            signal: AbortSignal.any([
              AbortSignal.timeout(remaining()),
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
      }),
    )
    const tool = async (name: string, args: Record<string, unknown>) => {
      let result: CallToolResult
      try {
        result = CallToolResultSchema.parse(
          await client.callTool({ name, arguments: args }, CallToolResultSchema, {
            timeout: Math.min(13 * 60_000, remaining()),
          }),
        )
      } catch (error) {
        await artifacts.writeJson('open-model-mcp-failure.json', {
          name,
          error: error instanceof Error ? error.message : String(error),
        })
        throw new Error(
          `Official MCP client failed ${name}; inspect the existing generation before any paid retry`,
        )
      }
      if (result.isError === true) {
        await artifacts.writeJson('open-model-mcp-failure.json', { name, result })
        throw new Error(
          `${name} returned an MCP tool error; inspect the existing generation before any paid retry`,
        )
      }
      return result
    }
    progress('open-model-access:discovery')
    const catalog = await apiJson<{ data: OpenModelRow[] }>(
      `${options.modelUrl}/v1/models`,
      {
        headers: bearer(apiToken, { 'x-duet-workspace': workspace.slug }),
        signal: AbortSignal.timeout(remaining()),
      },
      200,
      'open upstream model discovery',
      artifacts,
    )
    const mcpModels: OpenModelRow[] = []
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      const result = await tool('list_models', {
        workspace: workspace.slug,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      })
      const text = result.content.find(block => block.type === 'text')
      assert(text?.type === 'text', 'MCP model discovery omitted its JSON result')
      const page = JSON.parse(text.text) as { data: OpenModelRow[]; nextCursor?: string | null }
      mcpModels.push(...page.data)
      cursor = page.nextCursor ?? undefined
      if (cursor !== undefined) {
        assert(!cursors.has(cursor), 'MCP discovery repeated a pagination cursor')
        cursors.add(cursor)
      }
    } while (cursor !== undefined)
    const probes = selectOpenModelProbes(
      catalog.data,
      new Set(APPROVED_MODELS.entries.map(row => row.gatewayModelId)),
    )
    for (const selected of [probes.image.model, probes.video.model, probes.languageImage.model]) {
      assert(
        mcpModels.some(row => row.id === selected.id && row.type === selected.type),
        `MCP omitted ${selected.id}`,
      )
    }
    const identity = WhoamiResponseSchema.parse(
      await apiJson(
        `${env.apiUrl}/v1/whoami`,
        {
          headers: bearer(apiToken),
          signal: AbortSignal.timeout(remaining()),
        },
        200,
        'effective workspace default',
        artifacts,
      ),
    )
    const selectedWorkspace = identity.workspaces.find(row => row.id === workspace._id)
    assert(selectedWorkspace, 'selected workspace absent from default lookup')
    await artifacts.writeJson('open-model-discovery.json', {
      probes,
      defaultTier: selectedWorkspace.defaultTier,
      gatewayModels: catalog.data.length,
      mcpModels: mcpModels.length,
    })

    const cli = async (args: string[]) => {
      const child = Bun.spawn(
        [
          process.execPath,
          '--preload',
          resolve(import.meta.dir, 'fixtures/open-model-access/staging-fetch.ts'),
          options.entry,
          'model',
          ...args,
        ],
        {
          cwd: scratch,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            DUET_API_URL: env.apiUrl,
            DUET_WORKSPACE: workspace.slug,
            DUET_GATEWAY_BASE_URL: options.modelUrl,
            VERCEL_AUTOMATION_BYPASS_SECRET: env.vercelBypassSecret,
            DUET_E2E_OPEN_MODEL_DEADLINE: String(options.deadlineAt),
          },
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
          timeout: remaining(),
          killSignal: 'SIGKILL',
        },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (exitCode !== 0) {
        await artifacts.writeJson('open-model-cli-failure.json', { exitCode, stderr })
        throw new Error(
          'Public CLI generation failed; inspect the existing generation before any paid retry',
        )
      }
      return stdout
    }
    const paid = async (
      operation: string,
      expected: Omit<ExpectedGeneration, 'workspaceId'>,
      generate: () => Promise<Record<string, unknown>>,
    ) => {
      remaining()
      assert(attempts.length < 4, 'Open model access exceeded four billable attempts')
      const before = new Set((await listGenerations(context)).map(row => row._id))
      const attempt: Record<string, unknown> = {
        operation,
        ...expected,
        startedAt: Date.now(),
        status: 'started',
      }
      attempts.push(attempt)
      await artifacts.writeJson('open-model-access.json', { attempts })
      const output = await generate()
      Object.assign(attempt, { output, status: 'output-produced' })
      await artifacts.writeJson('open-model-access.json', { attempts })
      const settled = await waitForForwardProgress({
        label: `${operation} actual-cost settlement`,
        timeoutMs: Math.min(300_000, remaining()),
        pollMs: 2_000,
        maxConsecutiveUnchangedObservations: 120,
        load: async () => {
          const [rows, transactions] = await Promise.all([
            listGenerations(context),
            context.convex.query(fnQuery('testing/credits:listWorkspaceTransactionsForTest'), {
              internalKey: env.internalKey,
              workspaceId: workspace._id,
            }) as Promise<Array<Record<string, unknown>>>,
          ])
          const fresh = rows.filter(row => !before.has(row._id))
          assert(fresh.length <= 1, `${operation} caused more than one billable generation`)
          const row = fresh[0]
          assert(
            !row || !['released', 'charge_failed', 'upstream_failed'].includes(String(row.status)),
            `${operation} failed accounting: ${row?.status}`,
          )
          return { row, transactions }
        },
        isComplete: state =>
          state.row?.status === 'settled' &&
          state.transactions.some(
            row =>
              row.reference ===
                (expected.billingMode === 'reservation'
                  ? state.row?.reservationId
                  : `ai_generation:${state.row?.upstreamGenerationId}`) &&
              (expected.billingMode !== 'reservation' ||
                (row.metadata as { status?: string } | undefined)?.status === 'settled'),
          ),
        hasProgress: (a, b) =>
          JSON.stringify(a.row) !== JSON.stringify(b.row) ||
          a.transactions.length !== b.transactions.length,
        summarize: state => ({ generation: state.row, transactions: state.transactions.length }),
      })
      assert(settled.row, 'settlement omitted its generation')
      const receipt = inspectOpenModelSettlement(settled.row, settled.transactions, {
        ...expected,
        workspaceId: workspace._id,
      })
      Object.assign(attempt, {
        output,
        settlement: receipt,
        status: 'settled',
        elapsedMs: Date.now() - Number(attempt.startedAt),
      })
      await artifacts.writeJson('open-model-access.json', { attempts })
    }

    progress('open-model-access:default-text')
    const target = resolveTierDefault(
      buildManagedRoutingTable(BUILT_IN_ROUTING_TABLE),
      selectedWorkspace.defaultTier.effective,
      { hasImages: false },
      routingCatalogAdapter,
    )
    const resolved = transportModelId('duet-gateway', target.modelName)
    assert(resolved, 'effective default did not resolve to a gateway model')
    await paid(
      'default-text-cli',
      { model: resolved, modality: 'text', billingMode: 'post_response' },
      async () => {
        const text = await cli([
          '--type',
          'text',
          '--max-retries',
          '0',
          'Reply with only OPEN_MODEL_OK.',
        ])
        assert(text.trim().length > 0, 'default text output was empty')
        return bytesReceipt(Buffer.from(text), 'text/plain')
      },
    )
    progress('open-model-access:uncatalogued-native-image')
    await paid(
      'native-image-cli',
      { model: probes.image.model.id, modality: 'image', billingMode: 'reservation' },
      async () => {
        const output = join(scratch, 'native-image')
        await cli([
          '-m',
          probes.image.model.id,
          '--type',
          'image',
          '--max-retries',
          '0',
          '--n',
          '1',
          '-o',
          output,
          'A small blue circle on a white background.',
        ])
        return mediaReceipt(await readFile(output), 'image')
      },
    )
    progress('open-model-access:uncatalogued-native-video')
    await paid(
      'native-video-mcp',
      { model: probes.video.model.id, modality: 'video', billingMode: 'reservation' },
      async () =>
        await mediaResourceReceipt(
          context,
          await tool('generate_media', {
            workspace: workspace.slug,
            kind: 'video',
            model: probes.video.model.id,
            duration: probes.video.duration,
            resolution: probes.video.resolution,
            prompt: 'A small blue circle moving once on a white background. Static camera.',
          }),
          'video',
          remaining,
        ),
    )
    progress('open-model-access:language-image')
    await paid(
      'language-image-mcp',
      { model: probes.languageImage.model.id, modality: 'text', billingMode: 'post_response' },
      async () =>
        await mediaResourceReceipt(
          context,
          await tool('generate_media', {
            workspace: workspace.slug,
            kind: 'image',
            model: probes.languageImage.model.id,
            prompt: 'Generate one image: a small blue circle on a white background.',
          }),
          'image',
          remaining,
        ),
    )
    const fresh = (await listGenerations(context)).filter(row => !startIds.has(row._id))
    assert.equal(fresh.length, 4, 'acceptance did not produce exactly four generations')
    return {
      defaultTier: selectedWorkspace.defaultTier,
      probes,
      attempts,
      generationAttempts: fresh.length,
    }
  } catch (error) {
    let accountingWaitError: string | undefined
    const generations = await waitForFailedOpenModelAccounting(async () =>
      (await listGenerations(context)).filter(row => !startIds.has(row._id)),
    ).catch(waitError => {
      accountingWaitError = waitError instanceof Error ? waitError.message : String(waitError)
      return listGenerations(context).catch(() => undefined)
    })
    await artifacts.writeJson('open-model-access.json', {
      attempts,
      generations: generations?.filter(row => !startIds.has(row._id)),
      error: error instanceof Error ? error.message : String(error),
      accountingWaitError,
    })
    throw error
  } finally {
    await client.close().catch(() => undefined)
    await rm(scratch, { recursive: true, force: true })
  }
}

async function mediaResourceReceipt(
  context: WorkspaceBrowserJourneyContext,
  result: CallToolResult,
  kind: 'image' | 'video',
  remaining: () => number,
) {
  const link = result.content[0]
  assert(
    link?.type === 'resource_link' &&
      typeof link.size === 'number' &&
      typeof link.mimeType === 'string',
    'generated media omitted its file link',
  )
  const resource = extractFileResource(result, {
    name: link.name,
    size: link.size,
    mimeType: link.mimeType,
  })
  const response = await timedFetch(
    resource.uri,
    { signal: AbortSignal.timeout(remaining()) },
    context.artifacts,
  )
  assert.equal(response.status, 200, 'generated Drive bytes unavailable')
  assertBareFileResponseHeaders(response, { mimeType: resource.mimeType, size: resource.size })
  const output = mediaReceipt(new Uint8Array(await response.arrayBuffer()), kind)
  assert.equal(output.mimeType, resource.mimeType, 'Drive media MIME differs from its bytes')
  assert.equal(output.size, resource.size, 'Drive bytes differ from resource size')
  return { ...output, path: resource.name, target: safeRequestTarget(resource.uri) }
}

function bytesReceipt(bytes: Uint8Array, mimeType: string) {
  return {
    mimeType,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function mediaReceipt(bytes: Uint8Array, kind: 'image' | 'video') {
  const data = Buffer.from(bytes)
  const mimeType = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      ? 'image/jpeg'
      : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'
        ? 'image/webp'
        : data.subarray(4, 8).toString() === 'ftyp'
          ? 'video/mp4'
          : undefined
  assert(mimeType && mimeType.startsWith(`${kind}/`), `unrecognized ${kind} output bytes`)
  return bytesReceipt(bytes, mimeType)
}

function stagingOrigin(name: string) {
  const value = process.env[name]?.trim().replace(/\/+$/, '')
  assert(value && new URL(value).hostname.includes('staging'), `${name} must select staging`)
  return value
}
