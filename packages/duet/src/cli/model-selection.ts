import { transportModelId } from '@repo/agent/model-resolution/catalog'
import { modelGatewayTransport } from '@repo/agent/model-resolution/model-gateway'
import { routingCatalogAdapter } from '@repo/agent/model-resolution/resolver'
import { loadRoutingTable } from '@repo/agent/model-routing/loader'
import { resolveTierDefault } from '@repo/agent/model-routing/resolve'
import {
  buildManagedRoutingTable,
  ModelSelectionIdSchema,
  WhoamiResponseSchema,
} from '@repo/contract'

import { effectiveApiUrl, loadConfig } from '../config.js'
import { ApiClient } from '../http.js'

/** Concrete IDs never require workspace discovery or a valid local routing file. */
export async function selectTextModel(
  model: string | undefined,
  hasImages: boolean,
): Promise<string> {
  if (model !== undefined && !ModelSelectionIdSchema.safeParse(model).success) return model
  const transport = modelGatewayTransport()
  let selection = model
  if (selection === undefined && transport === 'duet-gateway') {
    const config = await loadConfig()
    const api = new ApiClient({
      baseUrl: effectiveApiUrl(config, process.env),
      apiKey: process.env.DUET_API_KEY,
    })
    const identity = WhoamiResponseSchema.parse(await (await api.request('/whoami')).json())
    const selector = process.env.DUET_WORKSPACE
    const bound =
      identity.credential?.kind === 'app' ||
      identity.credential?.kind === 'system_vm' ||
      identity.credential?.kind === 'oauth'
    const workspace = selector
      ? identity.workspaces.find(item => item.slug === selector)
      : bound && identity.workspaces.length === 1
        ? identity.workspaces[0]
        : undefined
    if (!workspace)
      throw new Error(
        selector
          ? `Workspace ${selector} is not accessible.`
          : 'Select a workspace with duet workspace use <slug>.',
      )
    selection = workspace.defaultTier.effective
  }
  const loaded = await loadRoutingTable({
    cwd: process.cwd(),
    catalogAdapter: routingCatalogAdapter,
  })
  const table = buildManagedRoutingTable(loaded.table)
  const target = resolveTierDefault(
    table,
    selection ?? table.defaultTier,
    { hasImages },
    routingCatalogAdapter,
  )
  const id = transportModelId(transport ?? 'duet-gateway', target.modelName)
  if (!id)
    throw new Error(`Model ${target.modelName} is unavailable on ${transport ?? 'duet-gateway'}.`)
  return id
}
