import { useMemo } from 'react'

type WorkspaceCacheScope = { isActive(): boolean }

const workspaceEpochs = new Map<string, number>()

export function captureWorkspaceCacheScope(workspaceSlug: string): WorkspaceCacheScope {
  const epoch = workspaceEpochs.get(workspaceSlug) ?? 0
  return { isActive: () => (workspaceEpochs.get(workspaceSlug) ?? 0) === epoch }
}

export function useWorkspaceCacheScope(workspaceSlug: string): WorkspaceCacheScope {
  return useMemo(() => captureWorkspaceCacheScope(workspaceSlug), [workspaceSlug])
}

export function expireWorkspaceCacheScope(workspaceSlug: string): void {
  workspaceEpochs.set(workspaceSlug, (workspaceEpochs.get(workspaceSlug) ?? 0) + 1)
}
