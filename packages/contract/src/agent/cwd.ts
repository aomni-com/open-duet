import { z } from 'zod'

import { normalizeDrivePath } from '../drive/index'

// Relative path under the workspace drive root; the gateway's resolveAgentCwd
// re-checks against the real filesystem root at dispatch time.
export const AgentCwdSchema = z
  .string()
  .min(1)
  .max(1024)
  // NUL or another control character would pass to spawn() and fail only after the session persists.
  // oxlint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'cwd must not contain control characters')
  .refine(cwd => !cwd.startsWith('/') && staysUnderRoot(cwd), 'cwd must stay inside the drive')

export function canonicalAgentCwd(cwd: string): string | undefined {
  if (!AgentCwdSchema.safeParse(cwd).success) return undefined
  const segments: string[] = []
  for (const segment of cwd.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  const normalized = normalizeDrivePath(segments.join('/'), { allowRoot: true })
  if (!normalized.ok || normalized.relativePath === '') return undefined
  return normalized.relativePath
}

function staysUnderRoot(cwd: string): boolean {
  let depth = 0
  for (const segment of cwd.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') depth -= 1
    else depth += 1
    if (depth < 0) return false
  }
  return true
}
