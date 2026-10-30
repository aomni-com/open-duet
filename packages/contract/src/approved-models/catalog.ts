import type { ApprovedModel, ApprovedModelCatalog, ApprovedModelKind } from './types'

function hasNumericKeys(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return keys.every(key => typeof record[key] === 'number' && Number.isFinite(record[key]))
}

function hasValidPricing(entry: ApprovedModel): boolean {
  if (entry.kind === 'image') return hasNumericKeys(entry.pricing, ['perImage'])
  if (entry.kind === 'video') return hasNumericKeys(entry.pricing, ['perSecond'])
  return !('pricing' in entry)
}

function enforcementPolicy(entry: ApprovedModel): string {
  return JSON.stringify({
    kind: entry.kind,
    isFree: entry.isFree === true,
    internal: entry.internal === true,
    providerLock: entry.providerLock ?? null,
  })
}

export function createApprovedModelCatalog(
  entries: readonly ApprovedModel[],
): ApprovedModelCatalog {
  const catalogIds = new Set<string>()
  const policiesByGatewayId = new Map<string, string>()
  for (const entry of entries) {
    if (catalogIds.has(entry.id)) throw new Error(`Duplicate catalog id: ${entry.id}`)
    catalogIds.add(entry.id)
    if (!hasValidPricing(entry)) {
      throw new Error(`Pricing does not match kind for catalog entry: ${entry.id}`)
    }
    const policy = enforcementPolicy(entry)
    const existingPolicy = policiesByGatewayId.get(entry.gatewayModelId)
    if (existingPolicy !== undefined && existingPolicy !== policy) {
      throw new Error(`Gateway model id has divergent policy: ${entry.gatewayModelId}`)
    }
    policiesByGatewayId.set(entry.gatewayModelId, policy)
  }

  return { entries: [...entries] }
}

function isModelRole(entry: ApprovedModel): boolean {
  return (
    entry.id !== entry.gatewayModelId &&
    (entry.kind === 'image' || entry.kind === 'video' || entry.internal === true)
  )
}

export function modelByRole(
  catalog: ApprovedModelCatalog,
  role: string,
): ApprovedModel | undefined {
  return catalog.entries.find(entry => isModelRole(entry) && entry.id === role)
}

export function modelByGatewayId(
  catalog: ApprovedModelCatalog,
  gatewayModelId: string,
): ApprovedModel | undefined {
  return catalog.entries.find(entry => entry.gatewayModelId === gatewayModelId)
}

export function visibleModels(
  catalog: ApprovedModelCatalog,
  kind?: ApprovedModelKind,
): ApprovedModel[] {
  return catalog.entries.filter(
    entry => isModelRole(entry) && entry.hidden !== true && (!kind || entry.kind === kind),
  )
}

export function gatewayModelIds(catalog: ApprovedModelCatalog): ReadonlySet<string> {
  return new Set(catalog.entries.map(entry => entry.gatewayModelId))
}

export function renderModelsReference(catalog: ApprovedModelCatalog): string {
  const models = catalog.entries
    .filter(isModelRole)
    .sort((left, right) => left.id.localeCompare(right.id))
  return `${JSON.stringify({ models }, null, 2)}\n`
}
