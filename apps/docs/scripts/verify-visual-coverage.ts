import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  collect,
  deriveRouteCoverage,
  inventoryMdxImports,
  inventoryPageModules,
  inventoryRuntimeImports,
  inventoryVisualSymbols,
  validateCoverage,
} from '../../../scripts/visual-coverage-core'
import { DOCS_VISUAL_ROUTES } from '../tests/visual/registry'
import { routeFromMdxPath } from './verify-content-core'

const DOCS_ROOT = path.resolve(import.meta.dir, '..')
const LEDGER_PATH = path.join(DOCS_ROOT, 'tests/visual/coverage-ledger.generated.json')
const files = (
  await Promise.all(['app', 'components'].map(root => collect(path.join(DOCS_ROOT, root))))
).flat()
files.push(path.join(DOCS_ROOT, 'mdx-components.tsx'))

const sourceByFile = new Map<string, string>()
const symbolsByFile = new Map<string, string[]>()
const inventory = new Set<string>()
for (const absolutePath of files.filter(file => /\.(?:ts|tsx|mdx)$/.test(file))) {
  const moduleId = path.relative(DOCS_ROOT, absolutePath).split(path.sep).join('/')
  const source = await readFile(absolutePath, 'utf8')
  sourceByFile.set(moduleId, source)
  if (!moduleId.endsWith('.tsx')) continue
  const symbols = inventoryVisualSymbols(moduleId, source)
  symbolsByFile.set(moduleId, symbols)
  for (const symbol of symbols) inventory.add(symbol)
}

const pageFiles = [...sourceByFile.keys()].filter(file => /(?:^|\/)page\.(?:tsx|mdx)$/.test(file))
for (const target of inventoryPageModules(pageFiles)) {
  const file = target.slice(0, target.lastIndexOf('#'))
  inventory.add(target)
  symbolsByFile.set(file, [...(symbolsByFile.get(file) ?? []), target].sort())
}

const dependenciesByFile = new Map(
  [...sourceByFile].map(([moduleId, source]) => [
    moduleId,
    (moduleId.endsWith('.mdx')
      ? inventoryMdxImports(source)
      : inventoryRuntimeImports(source)
    ).flatMap(specifier => {
      const resolved = resolveImport(moduleId, specifier, sourceByFile)
      return resolved ? [resolved] : []
    }),
  ]),
)
const pageByRoute = new Map(pageFiles.map(file => [routeFromMdxPath(file), file]))
const resolutionFailures: string[] = []
const routeRoots = DOCS_VISUAL_ROUTES.flatMap(entry => {
  const page = entry.route === '/404' ? 'app/not-found.tsx' : pageByRoute.get(entry.route)
  if (!page || !sourceByFile.has(page)) {
    resolutionFailures.push(`${entry.route} has no visual module`)
    return []
  }
  return [{ route: entry.route, files: [page, 'app/layout.tsx', 'mdx-components.tsx'] }]
})
const coverage = deriveRouteCoverage({ symbolsByFile, dependenciesByFile, routeRoots })
const failures = [
  ...resolutionFailures,
  ...validateCoverage({
    inventory,
    fixtures: [],
    routes: DOCS_VISUAL_ROUTES.map(entry => entry.route),
    entries: coverage,
  }),
]
const ledger = `${JSON.stringify(coverage, null, 2)}\n`

if (process.argv.includes('--write')) {
  await writeFile(LEDGER_PATH, ledger)
  console.log(`Wrote ${path.relative(DOCS_ROOT, LEDGER_PATH)}.`)
} else {
  const committed = await readFile(LEDGER_PATH, 'utf8').catch(() => '')
  if (committed !== ledger) {
    failures.push('visual coverage ledger drifted; run visual:coverage:write')
  }
}

if (failures.length > 0) {
  console.error(
    ['Visual coverage verification failed:', ...failures.map(failure => `- ${failure}`)].join('\n'),
  )
  process.exit(1)
}

console.log(
  `Verified ${coverage.length} code-derived docs page and component owners across ${DOCS_VISUAL_ROUTES.length} routes.`,
)

function resolveImport(
  importer: string,
  specifier: string,
  modules: ReadonlyMap<string, string>,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
  for (const candidate of [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
  ]) {
    if (modules.has(candidate)) return candidate
  }
  return undefined
}
