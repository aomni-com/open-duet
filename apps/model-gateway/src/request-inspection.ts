import {
  modelByGatewayId,
  type ApprovedModelCatalog,
  type ApprovedModelKind,
  type GatewayBlock,
  type AttributionTierId,
} from '@repo/contract'

import { attributeTier } from './tier-attribution'

// The request headers the Vercel gateway reads to route by model, in the
// precedence inspection trusts as a body fallback. This is the single source
// of truth: the forwarder MUST pin every one of these to the inspected slug
// (index.ts), or a header inspection trusts but the pin misses reopens the
// body-approved/header-served bypass.
export const MODEL_ROUTING_HEADERS = ['ai-model-id', 'ai-language-model-id'] as const

export type InspectedGatewayRequest = {
  kind: 'catalog' | 'generation'
  model?: string
  modality: 'chat' | 'image' | 'video' | 'embedding'
  billingMode: 'post_response' | 'reservation'
  tier?: AttributionTierId
  jsonBody?: Record<string, unknown>
}

export class GatewayRequestInspectionError extends Error {
  readonly body: { error: string; code: 'invalid_request' | 'model_required' }

  constructor(body: { error: string; code: 'invalid_request' | 'model_required' }) {
    super(body.error)
    this.body = body
  }
}

export class GatewayTierAttributionError extends Error {
  constructor(readonly block: GatewayBlock) {
    super(block.body.error)
  }
}

export async function inspectGatewayRequest(
  request: Request,
  catalog: ApprovedModelCatalog,
): Promise<InspectedGatewayRequest> {
  // Catalog = model-less reads (GET/HEAD), exactly the pre-inspection
  // classification: /v1/models and /v1/models/<id> stay ungated passthroughs.
  if (request.method === 'GET' || request.method === 'HEAD') {
    return { kind: 'catalog', modality: 'chat', billingMode: 'post_response' }
  }

  const declaredJson = (request.headers.get('content-type') ?? '').includes('application/json')
  let jsonBody: Record<string, unknown> | undefined
  let bodyModel: string | undefined

  if (declaredJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await request.text())
    } catch {
      throw invalidRequest('Malformed JSON request body.')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidRequest('JSON request body must be an object.')
    }
    jsonBody = parsed as Record<string, unknown>
    if (Object.hasOwn(jsonBody, 'model')) {
      if (typeof jsonBody.model !== 'string' || jsonBody.model.trim().length === 0) {
        throw invalidRequest('The model field must be a nonempty string.')
      }
      bodyModel = jsonBody.model
    }
  }

  const model = bodyModel ?? headerModel(request.headers)
  if (model === undefined || model.trim().length === 0) {
    throw new GatewayRequestInspectionError({
      error: 'Unable to determine the requested model. Specify a model to proceed.',
      code: 'model_required',
    })
  }

  const modality =
    endpointModality(new URL(request.url).pathname) ??
    modelByGatewayId(catalog, model)?.kind ??
    'chat'
  const attribution =
    modality === 'chat' || modality === 'embedding'
      ? attributeTier(request.headers, model, catalog)
      : undefined
  if (attribution !== undefined && 'block' in attribution) {
    throw new GatewayTierAttributionError(attribution.block)
  }
  return {
    kind: 'generation',
    model,
    modality,
    billingMode: billingModeFor(modality),
    ...(attribution !== undefined && 'tier' in attribution ? { tier: attribution.tier } : {}),
    ...(jsonBody === undefined ? {} : { jsonBody }),
  }
}

function endpointModality(pathname: string): ApprovedModelKind | undefined {
  switch (pathname) {
    case '/image-model':
    case '/v4/ai/image-model':
    case '/v4/ai/image':
    case '/v1/images/generations':
      return 'image'
    case '/video-model':
    case '/v4/ai/video-model':
    case '/v4/ai/video':
      return 'video'
    case '/embedding-model':
    case '/v4/ai/embedding-model':
    case '/v1/embeddings':
      return 'embedding'
    default:
      return undefined
  }
}

function headerModel(headers: Headers): string | undefined {
  for (const name of MODEL_ROUTING_HEADERS) {
    const value = headers.get(name)
    if (value !== null) return value
  }
  return undefined
}

function billingModeFor(kind: ApprovedModelKind): 'post_response' | 'reservation' {
  return kind === 'image' || kind === 'video' ? 'reservation' : 'post_response'
}

function invalidRequest(error: string): GatewayRequestInspectionError {
  return new GatewayRequestInspectionError({ error, code: 'invalid_request' })
}
