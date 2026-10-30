import { normalizeDrivePath } from '../drive/index'
import { WorkspaceSlugSchema } from '../slug/index'

export interface WorkspaceAddress {
  workspaceSlug: string
  path: string
}

type WorkspaceAddressParseResult =
  | { ok: true; address: WorkspaceAddress }
  | {
      ok: false
      reason: 'missing_workspace' | 'invalid_workspace' | 'invalid_path' | 'relative_path'
    }

interface WorkspaceAddressParseOptions {
  defaultWorkspace?: string | null
  allowRoot?: boolean
}

export function parseWorkspaceAddress(
  input: string,
  options: WorkspaceAddressParseOptions = {},
): WorkspaceAddressParseResult {
  const separator = input.indexOf(':/')
  if (separator >= 0) {
    const workspaceSlug = input.slice(0, separator)
    const path = input.slice(separator + 1)
    return parseParts(workspaceSlug, path, options.allowRoot === true)
  }

  if (!input.startsWith('/')) return { ok: false, reason: 'relative_path' }
  if (
    options.defaultWorkspace === undefined ||
    options.defaultWorkspace === null ||
    options.defaultWorkspace.length === 0
  ) {
    return { ok: false, reason: 'missing_workspace' }
  }
  return parseParts(options.defaultWorkspace, input, options.allowRoot === true)
}

function parseParts(
  workspaceSlug: string,
  path: string,
  allowRoot: boolean,
): WorkspaceAddressParseResult {
  if (!WorkspaceSlugSchema.safeParse(workspaceSlug).success)
    return { ok: false, reason: 'invalid_workspace' }
  const normalizedPath = normalizeAddressPath(path, allowRoot)
  if (normalizedPath === null) return { ok: false, reason: 'invalid_path' }
  return { ok: true, address: { workspaceSlug, path: normalizedPath } }
}

function normalizeAddressPath(path: string, allowRoot: boolean): string | null {
  if (!path.startsWith('/')) return null
  const normalized = normalizeDrivePath(path.slice(1), { allowRoot })
  if (!normalized.ok) return null
  return normalized.relativePath.length === 0 ? '/' : `/${normalized.relativePath}`
}
