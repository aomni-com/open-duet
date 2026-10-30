import { z } from 'zod'

import { isDrivePathWithin, normalizeDrivePath } from '../drive/index'

export const AppsScopeSchema = z.enum(['subtree', 'children', 'self'])
export type AppsScope = z.infer<typeof AppsScopeSchema>

export function matchesAppsPathScope(anchorPath: string, path: string, scope: AppsScope): boolean {
  if (path === '') {
    if (scope === 'subtree') return true
    if (scope === 'self') return false
    return !anchorPath.includes('/')
  }
  if (scope === 'subtree') return isDrivePathWithin(path, anchorPath)
  if (scope === 'self') return anchorPath === path
  const parentSeparator = `${path}/`
  const relativePath = anchorPath.slice(parentSeparator.length)
  return anchorPath.startsWith(parentSeparator) && !relativePath.includes('/')
}

export function appsUnderPath<T extends { anchorPath: string }>(
  apps: readonly T[],
  path: string,
  scope: AppsScope = 'subtree',
): T[] {
  return apps.filter(app => matchesAppsPathScope(app.anchorPath, path, scope))
}

export function browserPathToDrivePath(path: string): string {
  if (!path.startsWith('/')) throw new Error('Browser path must start with /')
  const normalized = normalizeDrivePath(path.slice(1), { allowRoot: true })
  if (!normalized.ok) throw new Error(`Invalid browser path: ${normalized.reason}`)
  return normalized.relativePath
}
