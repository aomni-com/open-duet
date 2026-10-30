import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  collect,
  inventoryMdxImports,
  inventoryRuntimeImports,
  inventoryVisualSymbols,
  type VisualCoverageEntry,
} from '../../../scripts/visual-coverage-core'

type AppName = 'lander' | 'web' | 'docs'
type SharedOwner = `${AppName}:${'fixture' | 'route'}:${string}`
type SharedEntry = {
  readonly target: string
  readonly kind: 'owned-by'
  readonly owner: SharedOwner
}

const REPO_ROOT = path.resolve(import.meta.dir, '../../..')
const UI_ROOT = path.join(REPO_ROOT, 'packages/ui')
const LEDGER_PATH = path.join(UI_ROOT, 'tests/visual/coverage-ledger.generated.json')
const appConfigs: readonly {
  name: AppName
  roots: readonly string[]
  ledger: string
}[] = [
  {
    name: 'lander',
    roots: ['apps/lander/app', 'apps/lander/components'],
    ledger: 'apps/lander/tests/visual/coverage-ledger.generated.json',
  },
  {
    name: 'web',
    roots: ['apps/web/app', 'apps/web/components', 'apps/web/spa'],
    ledger: 'apps/web/tests/visual/coverage-ledger.generated.json',
  },
  {
    name: 'docs',
    roots: ['apps/docs/app', 'apps/docs/components'],
    ledger: 'apps/docs/tests/visual/coverage-ledger.generated.json',
  },
]

const uiFiles = await sourceMap(UI_ROOT, ['src'])
const symbolsByFile = new Map<string, string[]>()
const inventory = new Set<string>()
for (const [moduleId, source] of uiFiles) {
  if (!moduleId.endsWith('.tsx')) continue
  const symbols = inventoryVisualSymbols(moduleId, source)
  symbolsByFile.set(moduleId, symbols)
  for (const symbol of symbols) inventory.add(symbol)
}

const dependenciesByFile = new Map(
  [...uiFiles].map(([moduleId, source]) => [
    moduleId,
    inventoryRuntimeImports(source).flatMap(specifier => {
      const resolved = resolveUiImport(specifier, uiFiles, moduleId)
      return resolved === undefined ? [] : [resolved]
    }),
  ]),
)
const candidatesByFile = new Map<string, Set<SharedOwner>>()

for (const app of appConfigs) {
  const appRoot = path.join(REPO_ROOT, `apps/${app.name}`)
  const appFiles = await sourceMap(REPO_ROOT, app.roots)
  const ledger = JSON.parse(
    await readFile(path.join(REPO_ROOT, app.ledger), 'utf8'),
  ) as VisualCoverageEntry[]
  const ownersByFile = new Map<string, Set<SharedOwner>>()
  for (const entry of ledger) {
    const owner = sharedOwner(app.name, entry)
    if (owner === undefined) continue
    const file = entry.target.slice(0, entry.target.lastIndexOf('#'))
    const owners = ownersByFile.get(file) ?? new Set<SharedOwner>()
    owners.add(owner)
    ownersByFile.set(file, owners)
  }

  for (const [repoModuleId, source] of appFiles) {
    const appModuleId = path
      .relative(appRoot, path.join(REPO_ROOT, repoModuleId))
      .split(path.sep)
      .join('/')
    const owners = ownersByFile.get(appModuleId)
    if (owners === undefined) continue
    const imports = repoModuleId.endsWith('.mdx')
      ? inventoryMdxImports(source)
      : inventoryRuntimeImports(source)
    for (const specifier of imports) {
      const uiModule = resolveUiImport(specifier, uiFiles)
      if (uiModule === undefined) continue
      const candidates = candidatesByFile.get(uiModule) ?? new Set<SharedOwner>()
      for (const owner of owners) candidates.add(owner)
      candidatesByFile.set(uiModule, candidates)
    }
  }
}

let changed = true
while (changed) {
  changed = false
  for (const [moduleId, dependencies] of dependenciesByFile) {
    const owners = candidatesByFile.get(moduleId)
    if (owners === undefined) continue
    for (const dependency of dependencies) {
      const candidates = candidatesByFile.get(dependency) ?? new Set<SharedOwner>()
      const previousSize = candidates.size
      for (const owner of owners) candidates.add(owner)
      candidatesByFile.set(dependency, candidates)
      if (candidates.size !== previousSize) changed = true
    }
  }
}

const failures: string[] = []
const coverage: SharedEntry[] = []
for (const [moduleId, symbols] of symbolsByFile) {
  const owner = preferredOwner(candidatesByFile.get(moduleId))
  for (const target of symbols) {
    if (owner === undefined) failures.push(`missing visual owner: ${target}`)
    else coverage.push({ target, kind: 'owned-by', owner })
  }
}
if (new Set(coverage.map(entry => entry.target)).size !== coverage.length) {
  failures.push('duplicate shared UI visual coverage targets')
}
for (const entry of coverage) {
  if (!inventory.has(entry.target)) failures.push(`stale shared UI target: ${entry.target}`)
}

const ledger = `${JSON.stringify(
  coverage.sort((left, right) => left.target.localeCompare(right.target)),
  null,
  2,
)}\n`
if (process.argv.includes('--write')) {
  await writeFile(LEDGER_PATH, ledger)
  console.log(`Wrote ${path.relative(UI_ROOT, LEDGER_PATH)} with ${coverage.length} exact owners.`)
} else {
  const committed = await readFile(LEDGER_PATH, 'utf8').catch(() => '')
  if (committed !== ledger)
    failures.push('shared UI coverage ledger drifted; run visual:coverage:write')
}

if (failures.length > 0) {
  console.error(
    ['Shared UI visual coverage is incomplete:', ...failures.map(failure => `- ${failure}`)].join(
      '\n',
    ),
  )
  process.exit(1)
}
console.log(`Shared UI visual coverage verified for ${coverage.length} rendered symbols.`)

function sharedOwner(app: AppName, entry: VisualCoverageEntry): SharedOwner | undefined {
  if (entry.kind === 'nonvisual') return undefined
  if (entry.kind === 'fixture') return `${app}:fixture:${entry.fixture}`
  if (entry.kind === 'route') return `${app}:route:${entry.route}`
  return `${app}:${entry.owner}`
}

function preferredOwner(owners: ReadonlySet<SharedOwner> | undefined): SharedOwner | undefined {
  if (owners === undefined || owners.size === 0) return undefined
  return [...owners].sort(
    (left, right) => ownerRank(left) - ownerRank(right) || left.localeCompare(right),
  )[0]
}

function ownerRank(owner: SharedOwner): number {
  if (owner === 'web:fixture:ui-primitives') return 0
  if (owner.startsWith('web:fixture:')) return 1
  if (owner.startsWith('lander:route:')) return 2
  if (owner.startsWith('web:route:')) return 3
  return 4
}

function resolveUiImport(
  specifier: string,
  modules: ReadonlyMap<string, string>,
  fromModuleId?: string,
): string | undefined {
  const base = specifier.startsWith('@repo/ui/')
    ? `src/${specifier.slice('@repo/ui/'.length)}`
    : specifier.startsWith('.') && fromModuleId
      ? path.posix.normalize(path.posix.join(path.posix.dirname(fromModuleId), specifier))
      : undefined
  if (base === undefined) return undefined
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (modules.has(candidate)) return candidate
  }
  return undefined
}

async function sourceMap(root: string, roots: readonly string[]): Promise<Map<string, string>> {
  const files = (
    await Promise.all(roots.map(relative => collect(path.join(root, relative))))
  ).flat()
  return new Map(
    await Promise.all(
      files
        .filter(file => /\.(?:[cm]?[jt]sx?|mdx)$/.test(file))
        .map(
          async file =>
            [
              path.relative(root, file).split(path.sep).join('/'),
              await readFile(file, 'utf8'),
            ] as const,
        ),
    ),
  )
}
