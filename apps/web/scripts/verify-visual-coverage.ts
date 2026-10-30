import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  collect,
  deriveFixtureCoverage,
  deriveRouteCoverage,
  inventoryPageModules,
  inventoryRuntimeImports,
  inventoryVisualSymbols,
  matchNextPage,
  validateCoverage,
} from '../../../scripts/visual-coverage-core'
import { PLAYGROUND_ENTRIES } from '../app/playground/registry'
import { VISUAL_COVERAGE } from '../tests/visual/coverage'

const WEB_ROOT = path.resolve(import.meta.dir, '..')
const LEDGER_PATH = path.join(WEB_ROOT, 'tests/visual/coverage-ledger.generated.json')
const sourceRoots = ['app', 'components', 'spa'].map(root => ({
  absolutePath: path.join(WEB_ROOT, root),
  moduleId: (absolutePath: string) => path.relative(WEB_ROOT, absolutePath),
}))
const sourceFiles = (
  await Promise.all(
    sourceRoots.map(async sourceRoot =>
      (await collect(sourceRoot.absolutePath)).map(absolutePath => ({
        absolutePath,
        moduleId: sourceRoot.moduleId(absolutePath).split(path.sep).join('/'),
      })),
    ),
  )
).flat()
const inventory = new Set<string>()
const symbolsByFile = new Map<string, string[]>()
const sourceByFile = new Map<string, string>()

for (const { absolutePath, moduleId } of sourceFiles.filter(({ absolutePath }) =>
  /\.[cm]?[jt]sx?$/.test(absolutePath),
)) {
  const sourceText = await readFile(absolutePath, 'utf8')
  sourceByFile.set(moduleId, sourceText)
  if (!absolutePath.endsWith('.tsx')) continue
  const symbols = inventoryVisualSymbols(moduleId, sourceText)
  symbolsByFile.set(moduleId, symbols)
  for (const symbol of symbols) inventory.add(symbol)
}

const dependenciesByFile = new Map(
  [...sourceByFile].map(([relativePath, sourceText]) => [
    relativePath,
    inventoryRuntimeImports(sourceText).flatMap(specifier => {
      const resolved = resolveImport(relativePath, specifier, sourceByFile)
      return resolved ? [resolved] : []
    }),
  ]),
)
const pageFiles = [...sourceByFile.keys()].filter(
  file => file.startsWith('app/') && file.endsWith('/page.tsx'),
)
for (const target of inventoryPageModules(pageFiles)) {
  const file = target.slice(0, target.lastIndexOf('#'))
  inventory.add(target)
  symbolsByFile.set(file, [...(symbolsByFile.get(file) ?? []), target].sort())
}

const routeResolutionFailures: string[] = []
const routeRoots = [
  { route: '/w/demo/sessions', prerenderPath: '/' },
  { route: '/sign-in', prerenderPath: '/sign-in' },
  { route: '/playground', prerenderPath: '/playground' },
  { route: '/playground/spa-shell', prerenderPath: '/playground/spa-shell' },
].flatMap(route => {
  const pageFile = matchNextPage(route.prerenderPath, pageFiles)
  if (!pageFile) {
    routeResolutionFailures.push(`${route.route} has no matching page for ${route.prerenderPath}`)
    return []
  }
  return [{ route: route.route, files: [pageFile, ...layoutFiles(pageFile, sourceByFile)] }]
})
const derivedRouteCoverage = deriveRouteCoverage({
  symbolsByFile,
  dependenciesByFile,
  routeRoots,
})
const derivedFixtureCoverage = deriveFixtureCoverage({
  symbolsByFile,
  dependenciesByFile,
  fixtureRoots: VISUAL_COVERAGE.flatMap(entry =>
    entry.kind === 'fixture'
      ? [{ fixture: entry.fixture, files: [entry.target.slice(0, entry.target.lastIndexOf('#'))] }]
      : [],
  ),
})
const explicitlyOwnedTargets = new Set<string>(VISUAL_COVERAGE.map(entry => entry.target))
const explicitPageCoverage = pageFiles.flatMap(file => {
  const owner = VISUAL_COVERAGE.find(entry => entry.target.startsWith(`${file}#`))
  if (!owner) return []
  return [{ ...owner, target: `${file}#page-module` }]
})
for (const entry of explicitPageCoverage) explicitlyOwnedTargets.add(entry.target)
const fixtureOwnedTargets = new Set<string>(derivedFixtureCoverage.map(entry => entry.target))
const coverage = [
  ...VISUAL_COVERAGE,
  ...explicitPageCoverage,
  ...derivedFixtureCoverage.filter(entry => !explicitlyOwnedTargets.has(entry.target)),
  ...derivedRouteCoverage.filter(
    entry => !explicitlyOwnedTargets.has(entry.target) && !fixtureOwnedTargets.has(entry.target),
  ),
]
const capturedRoutes = new Set(routeRoots.map(root => root.route))
const failures = validateCoverage({
  inventory,
  fixtures: PLAYGROUND_ENTRIES.map(entry => entry.id),
  routes: capturedRoutes,
  entries: coverage,
})
failures.unshift(...routeResolutionFailures)

if (failures.length > 0) {
  console.error(
    ['Visual coverage ledger is incomplete:', ...failures.map(failure => `- ${failure}`)].join(
      '\n',
    ),
  )
  process.exit(1)
}

const ledger = `${JSON.stringify(
  [...coverage].sort((left, right) => left.target.localeCompare(right.target)),
  null,
  2,
)}\n`

if (process.argv.includes('--write')) {
  await writeFile(LEDGER_PATH, ledger)
  console.log(`Wrote ${path.relative(WEB_ROOT, LEDGER_PATH)} with ${coverage.length} exact owners.`)
} else {
  const committed = await readFile(LEDGER_PATH, 'utf8').catch(() => '')
  if (committed !== ledger) {
    console.error(
      'Visual coverage ledger drifted. Run bun run visual:coverage:write and commit the result.',
    )
    process.exit(1)
  }
  console.log(`Web visual coverage verified for ${coverage.length} product rendered symbols.`)
}

function resolveImport(
  importer: string,
  specifier: string,
  modules: ReadonlyMap<string, string>,
): string | undefined {
  let base: string
  if (specifier.startsWith('@/')) base = specifier.slice(2)
  else if (specifier.startsWith('.')) base = path.join(path.dirname(importer), specifier)
  else return undefined

  const normalized = base.split(path.sep).join('/')
  for (const candidate of [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `${normalized}/index.js`,
    `${normalized}/index.jsx`,
  ]) {
    if (modules.has(candidate)) return candidate
  }
  return undefined
}

function layoutFiles(pageFile: string, modules: ReadonlyMap<string, string>): string[] {
  const layouts: string[] = []
  let directory = path.posix.dirname(pageFile)
  while (directory === 'app' || directory.startsWith('app/')) {
    const layout = `${directory}/layout.tsx`
    if (modules.has(layout)) layouts.push(layout)
    if (directory === 'app') break
    directory = path.posix.dirname(directory)
  }
  return layouts
}
