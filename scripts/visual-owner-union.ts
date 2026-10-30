import type { VisualCoverageEntry } from './visual-coverage-core'

export const REQUIRED_VISUAL_OWNERS = ['lander', 'web', 'docs', 'ui', 'official-apps'] as const

export type VisualOwnerName = (typeof REQUIRED_VISUAL_OWNERS)[number]
export type SharedUiEntry = {
  readonly target: string
  readonly kind: 'owned-by'
  readonly owner: `${Exclude<VisualOwnerName, 'ui' | 'official-apps'>}:${'fixture' | 'route'}:${string}`
}

export function validateVisualOwnerUnion(
  ledgers: ReadonlyMap<VisualOwnerName, readonly (VisualCoverageEntry | SharedUiEntry)[]>,
): string[] {
  const failures: string[] = []
  for (const owner of REQUIRED_VISUAL_OWNERS) {
    const entries = ledgers.get(owner)
    if (entries === undefined) {
      failures.push(`missing visual owner ledger: ${owner}`)
      continue
    }
    if (entries.length === 0) failures.push(`empty visual owner ledger: ${owner}`)
    const targets = entries.map(entry => entry.target)
    if (new Set(targets).size !== targets.length) {
      failures.push(`duplicate targets in visual owner ledger: ${owner}`)
    }
  }

  const ownerKeys = new Set<string>()
  for (const app of ['lander', 'web', 'docs'] as const) {
    for (const entry of ledgers.get(app) ?? []) {
      if (entry.kind === 'fixture') ownerKeys.add(`${app}:fixture:${entry.fixture}`)
      if (entry.kind === 'route') ownerKeys.add(`${app}:route:${entry.route}`)
      if (entry.kind === 'owned-by') ownerKeys.add(`${app}:${entry.owner}`)
    }
  }
  for (const entry of (ledgers.get('ui') ?? []) as readonly SharedUiEntry[]) {
    if (!ownerKeys.has(entry.owner))
      failures.push(`shared UI references unknown owner: ${entry.owner}`)
  }
  return failures
}

export function missingVisualFilters(source: string): string[] {
  return REQUIRED_VISUAL_OWNERS.filter(owner => {
    const filter =
      owner === 'ui' ? '@repo/ui' : owner === 'official-apps' ? '@repo/official-agents-seed' : owner
    return !source.includes(`--filter=${filter}`)
  })
}
