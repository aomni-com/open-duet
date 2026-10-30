import { z } from 'zod'

export const BACKEND_SCHEMA_VERSION = 1
export const WEB_CACHE_SCHEMA_VERSION = 16

export const ReleaseRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/)

export const BackendDeploymentSchema = z.object({
  revision: ReleaseRevisionSchema.nullable(),
  schema: z.number().int().positive(),
})

export const ApiDeploymentSchema = z.object({
  revision: ReleaseRevisionSchema.nullable(),
  backend: BackendDeploymentSchema,
  runtime: z.object({ version: z.string().min(1).nullable() }),
})

export const WebDeploymentSchema = z.object({
  revision: ReleaseRevisionSchema.nullable(),
  cacheSchema: z.number().int().positive(),
})

export const DocsDeploymentSchema = z.object({
  revision: ReleaseRevisionSchema.nullable(),
})

export type ApiDeployment = z.infer<typeof ApiDeploymentSchema>
export type WebDeployment = z.infer<typeof WebDeploymentSchema>
export type DocsDeployment = z.infer<typeof DocsDeploymentSchema>
