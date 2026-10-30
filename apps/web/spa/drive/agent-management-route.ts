export type AgentManagementDestination = {
  mode: 'settings' | 'train'
  agentSlug: string
}

/**
 * The two agent control-centre addresses that share one persistent rail.
 *
 * The URL keeps owning the selected agent and pane. This projection only tells
 * the workspace shell when those otherwise separate routes should share
 * furniture, so the rail can remain mounted while the right-hand pane changes.
 */
export function agentManagementDestinationForPath(
  pathname: string,
  workspaceSlug: string,
): AgentManagementDestination | null {
  const root = `/w/${encodeURIComponent(workspaceSlug)}`
  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const settings = pathname.match(new RegExp(`^${escapedRoot}/agents/([^/?#]+)/settings/?$`))
  const train = pathname.match(new RegExp(`^${escapedRoot}/train/([^/?#]+)(?:/[^/?#]+)?/?$`))

  const settingsSlug = decodeSegment(settings?.[1])
  if (settingsSlug !== undefined) return { mode: 'settings', agentSlug: settingsSlug }

  const trainSlug = decodeSegment(train?.[1])
  if (trainSlug !== undefined) return { mode: 'train', agentSlug: trainSlug }

  return null
}

function decodeSegment(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  try {
    const decoded = decodeURIComponent(value)
    return decoded.length === 0 || decoded.includes('/') ? undefined : decoded
  } catch {
    return undefined
  }
}
