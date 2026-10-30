import { z } from 'zod'

const MODEL_TYPES = [
  'language',
  'image',
  'video',
  'embedding',
  'realtime',
  'reranking',
  'speech',
  'transcription',
] as const

export const ModelTypeSchema = z.enum(MODEL_TYPES)
type ModelType = z.infer<typeof ModelTypeSchema>

export type ModelCatalog = Map<string, ModelType>
type ModelCatalogFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function isModelType(value: unknown): value is ModelType {
  return ModelTypeSchema.safeParse(value).success
}

export async function fetchModelCatalog(
  baseUrl: string,
  bearerToken: string,
  fetchImpl: ModelCatalogFetch,
): Promise<ModelCatalog | Response> {
  const response = await fetchImpl(`${baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${bearerToken}` },
  })
  if (!response.ok) return response
  const body = (await response.json()) as { data?: Array<{ id?: unknown; type?: unknown }> }
  const catalog: ModelCatalog = new Map()
  for (const model of body.data ?? []) {
    if (typeof model.id === 'string' && isModelType(model.type)) {
      catalog.set(model.id, model.type)
    }
  }
  return catalog
}
