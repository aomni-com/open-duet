/**
 * Every owner's default chat lives in one route family, the drive root
 * included — it is addressed as the reserved slug `root` rather than through a
 * family of its own, so there is nothing here to branch on.
 */
export function defaultSessionApiPath(workspaceSlug: string, agentSlug: string): string {
  const workspace = encodeURIComponent(workspaceSlug)
  return `/api/duet/ws/${workspace}/agents/${encodeURIComponent(agentSlug)}/sessions/default`
}
