import { normalizeBrowserFilePath } from './lib/paths'

/**
 * The open columns, derived from the folder you are standing in.
 *
 * The reference this is ported from kept the open chain in local state, which is
 * why it could not offer folder deep links. Duet already decided the opposite:
 * the drive's own destination keeps the folder in the address bar, and the agent
 * card keeps it in card state. Both hand the drive one `path`, so the chain is a
 * *derivation* of that path rather than a second copy of it — which is what lets
 * columns arrive without taking deep links, browser Back, or the agent card's
 * remembered folder away.
 *
 * A malformed path yields the root alone rather than throwing; the caller is
 * already rendering a not-found view for it.
 */
export function driveColumnChain(folderPath: string): string[] {
  let normalized: string
  try {
    normalized = normalizeBrowserFilePath(folderPath, true)
  } catch {
    return ['/']
  }
  if (normalized.length === 0) return ['/']
  const chain = ['/']
  let current = ''
  for (const segment of normalized.split('/')) {
    current = `${current}/${segment}`
    chain.push(current)
  }
  return chain
}
