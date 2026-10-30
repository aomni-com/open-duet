import { createApprovedModelCatalog } from './catalog'
import { APPROVED_MODEL_ENTRIES } from './data'

export const APPROVED_MODELS = createApprovedModelCatalog(APPROVED_MODEL_ENTRIES)

export * from './types'
export * from './catalog'
