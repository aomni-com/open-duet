import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createGateway, type GeneratedFile } from 'ai'

import { generateMedia } from '@repo/agent/model-resolution/generate-media'
import {
  APPROVED_MODELS,
  McpGenerateMediaInputSchema,
  McpListModelsInputSchema,
  driveFileExtensionForMimeType,
  modelByRole,
  scopeSetSatisfies,
  visibleModels,
  vmUploadUrl,
  type FetchLike,
  type McpGenerateMediaInput,
} from '@repo/contract'

import { createFileResource, createFileUploadGrant, toResourceLink } from '../file-resources'
import { defineMcpTool, type McpToolContext, type McpToolRegistry } from '../server'
import { internalToolError, toolErrorFromApi } from '../tool-results'

const CATALOG_TIMEOUT_MS = 10_000
const GENERATION_TIMEOUT_MS = 15 * 60 * 1000
const GENERATED_MEDIA_PATH_PREFIX = 'mcp/generated-media'
const MEDIA_ROLE_IDS = visibleModels(APPROVED_MODELS)
  .filter(model => model.kind === 'image' || model.kind === 'video')
  .map(model => model.id)

export function registerMediaTools(registry: McpToolRegistry): void {
  registry.register(
    defineMcpTool({
      name: 'list_models',
      description:
        'Discover upstream gateway model metadata. Filter by kind before paging. Reuse a cursor with the same filter; restart if the upstream list changes.',
      capabilities: ['services'],
      inputSchema: McpListModelsInputSchema,
      scopeRequirements: input => [`ws:${input.workspace}:services`],
      execute: async (input, context) => {
        const requiredScopes = [`ws:${input.workspace}:services`]
        const scopeError = await validateScopes(context, requiredScopes)
        if (scopeError !== null) return scopeError
        try {
          const response = await fetchModels(context, input.workspace)
          if (!response.ok) return await toolErrorFromApi(response, requiredScopes)
          const models = await modelMetadata(response)
          const filtered =
            input.kind === undefined ? models : models.filter(model => model.type === input.kind)
          const offset = Number(input.cursor ?? 0)
          const end = offset + input.limit
          const page = {
            data: filtered.slice(offset, end),
            nextCursor: end < filtered.length ? String(end) : null,
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(page) }],
            structuredContent: page,
          }
        } catch (error) {
          return toolErrorFromGatewayError(error, requiredScopes)
        }
      },
    }),
  )
  registry.register(
    defineMcpTool({
      name: 'generate_media',
      description: `Generate image or video media through the Duet model gateway using an exact upstream model ID or role. Roles: ${MEDIA_ROLE_IDS.join(', ')}. Omit model to use the role matching kind. Optional video controls: duration in seconds and resolution as WIDTHxHEIGHT.`,
      capabilities: ['services', 'files:write', 'files:read'],
      inputSchema: McpGenerateMediaInputSchema,
      scopeRequirements: input => mediaScopeRequirements(input.workspace),
      execute: async (input, context) =>
        await generateMediaWithGateway(input, context, mediaScopeRequirements(input.workspace)),
    }),
  )
}

async function generateMediaWithGateway(
  input: McpGenerateMediaInput,
  context: McpToolContext,
  requiredScopes: readonly string[],
): Promise<CallToolResult> {
  const requestedModel = input.model ?? input.kind
  const roleModel = modelByRole(context.approvedModelCatalog, requestedModel)
  if (roleModel === undefined && input.model === undefined) {
    return internalToolError('model_not_found', requiredScopes, { model: requestedModel })
  }
  if (roleModel !== undefined && roleModel.kind !== input.kind) {
    return internalToolError('unsupported_model', requiredScopes, {
      model: requestedModel,
      type: roleModel.kind,
    })
  }
  const model = roleModel?.gatewayModelId ?? requestedModel

  const scopeError = await validateScopes(context, requiredScopes)
  if (scopeError !== null) return scopeError

  let capability: 'language' | undefined
  if (input.kind === 'image') {
    // Discovery chooses the SDK operation; it never admits or replaces an ID.
    // Missing or unavailable metadata leaves the explicit image operation intact.
    try {
      const response = await fetchModels(context, input.workspace)
      if (
        response.ok &&
        (await modelMetadata(response)).find(entry => entry.id === model)?.type === 'language'
      ) {
        capability = 'language'
      }
    } catch {}
  }

  const gateway = createGateway({
    baseURL: `${context.modelGatewayBaseUrl}/v4/ai`,
    apiKey: context.bearerToken,
    headers: { 'x-duet-workspace': input.workspace },
    fetch: gatewayFetch(context.fetch),
  })

  let generatedFile: GeneratedFile
  try {
    const result = await generateMedia({
      gateway,
      model,
      kind: input.kind,
      capability,
      prompt: input.prompt,
      duration: input.duration,
      resolution: input.resolution,
      maxRetries: 0,
    })
    if (result.files[0] === undefined) {
      return internalToolError('no_media_generated', requiredScopes)
    }
    generatedFile = result.files[0]
  } catch (error) {
    return toolErrorFromGatewayError(error, requiredScopes)
  }
  return await persistGeneratedFile(input.workspace, generatedFile, context, requiredScopes)
}

function fetchModels(context: McpToolContext, workspace: string): Promise<Response> {
  return context.fetch(`${context.modelGatewayBaseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${context.bearerToken}`, 'x-duet-workspace': workspace },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  })
}

async function modelMetadata(response: Response): Promise<Array<Record<string, unknown>>> {
  const body = (await response.json()) as { data?: unknown }
  if (!Array.isArray(body.data)) throw new Error('invalid_model_catalog')
  return body.data
}

async function validateScopes(
  context: McpToolContext,
  requiredScopes: readonly string[],
): Promise<CallToolResult | null> {
  const response = await context.fetch(`${context.apiBaseUrl}/v1/whoami`, {
    headers: { authorization: `Bearer ${context.bearerToken}` },
  })
  if (!response.ok) return await toolErrorFromApi(response, requiredScopes)
  const body = (await response.json()) as { scopes?: unknown }
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((scope): scope is string => typeof scope === 'string')
    : []
  const missingScopes = requiredScopes.filter(scope => !scopeSetSatisfies(scopes, scope))
  if (missingScopes.length === 0) return null
  const toolError = {
    error: 'insufficient_scope',
    status: 403,
    requiredScopes,
    missingScopes,
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(toolError) }],
    structuredContent: toolError,
  }
}

async function persistGeneratedFile(
  workspace: string,
  file: GeneratedFile,
  context: McpToolContext,
  requiredScopes: readonly string[],
): Promise<CallToolResult> {
  const extension = driveFileExtensionForMimeType(file.mediaType)
  if (extension === undefined) {
    return internalToolError('unsupported_media_type', requiredScopes, {
      mimeType: file.mediaType,
    })
  }

  const filename = `${crypto.randomUUID()}.${extension}`
  const path = `${GENERATED_MEDIA_PATH_PREFIX}/${filename}`
  const uploadGrant = await createFileUploadGrant(
    context,
    workspace,
    GENERATED_MEDIA_PATH_PREFIX,
    requiredScopes,
  )
  if (!uploadGrant.ok) return uploadGrant.result

  let upload: Response
  try {
    upload = await context.fetch(vmUploadUrl(uploadGrant.grant, filename), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${uploadGrant.grant.uploadToken}`,
        'content-type': file.mediaType,
      },
      body: file.uint8Array.slice().buffer as ArrayBuffer,
    })
  } catch {
    return internalToolError('file_upload_failed', requiredScopes, { path })
  }
  if (!upload.ok) return await toolErrorFromApi(upload, requiredScopes)

  const created = await createFileResource(context, workspace, path, requiredScopes, { path })
  if (!created.ok) return created.result
  return { content: [toResourceLink(created.resource)] }
}

function toolErrorFromGatewayError(
  error: unknown,
  requiredScopes: readonly string[],
): CallToolResult {
  const status = (error as { statusCode?: unknown })?.statusCode
  if (typeof status !== 'number') {
    return internalToolError(
      error instanceof Error ? error.message : 'model_gateway_failed',
      requiredScopes,
    )
  }
  const responseBody =
    (error as { responseBody?: unknown })?.responseBody ??
    (error as { cause?: { responseBody?: unknown } })?.cause?.responseBody
  const body = {
    ...sdkErrorData(error),
    ...parseErrorBody(typeof responseBody === 'string' ? responseBody : undefined),
  }
  const code = typeof body.error === 'string' ? body.error : `http_${status}`
  const toolError = {
    error: code,
    status,
    requiredScopes,
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(toolError) }],
    structuredContent: toolError,
  }
}

function mediaScopeRequirements(workspace: string): readonly [string, string, string] {
  return [`ws:${workspace}:services`, `ws:${workspace}:files:write`, `ws:${workspace}:files:read`]
}

function sdkErrorData(error: unknown): Record<string, unknown> {
  const data =
    (error as { data?: unknown })?.data ?? (error as { cause?: { data?: unknown } })?.cause?.data
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

function gatewayFetch(fetchImpl: FetchLike): typeof fetch {
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetchImpl(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(GENERATION_TIMEOUT_MS)])
          : AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      }),
    'preconnect' in fetch ? { preconnect: fetch.preconnect } : {},
  ) as typeof fetch
}

function parseErrorBody(text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.length === 0) return {}
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  } catch {}
  return { message: text }
}
