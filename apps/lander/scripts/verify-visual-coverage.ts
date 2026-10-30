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
import { PUBLIC_ROUTE_MANIFEST } from '../src/public-route-manifest'
import { VISUAL_COVERAGE } from '../tests/visual/coverage'
import {
  NO_JS_PUBLIC_ROUTES,
  publicRouteId,
  VISUAL_PUBLIC_ROUTES,
} from '../tests/visual/public-visual-contract'

const LANDER_ROOT = path.resolve(import.meta.dir, '..')
const LEDGER_PATH = path.join(LANDER_ROOT, 'tests/visual/coverage-ledger.generated.json')
const sourceRoots = ['app', 'components'].map(root => ({
  absolutePath: path.join(LANDER_ROOT, root),
  moduleId: (absolutePath: string) => path.relative(LANDER_ROOT, absolutePath),
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
const publicRouteRoots = VISUAL_PUBLIC_ROUTES.flatMap(route => {
  const pageFile = matchNextPage(route.prerenderPath, pageFiles)
  if (!pageFile) {
    routeResolutionFailures.push(
      `${route.publicPath} has no matching page for ${route.prerenderPath}`,
    )
    return []
  }
  return [{ route: route.publicPath, files: [pageFile, ...layoutFiles(pageFile, sourceByFile)] }]
})
// The playground shell and menu are real prerendered routes; owning them as
// route roots keeps their page modules and chrome covered without listing
// each file by hand.
const playgroundRouteRoots = ['/playground', `/playground/${PLAYGROUND_ENTRIES[0]!.id}`].flatMap(
  route => {
    const pageFile = matchNextPage(route, pageFiles)
    if (!pageFile) {
      routeResolutionFailures.push(`${route} has no matching page`)
      return []
    }
    return [{ route, files: [pageFile, ...layoutFiles(pageFile, sourceByFile)] }]
  },
)
const routeRoots = [...publicRouteRoots, ...playgroundRouteRoots]
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
const fixtureOwnedTargets = new Set(derivedFixtureCoverage.map(entry => entry.target))
const explicitlyOwnedTargets = new Set<string>(VISUAL_COVERAGE.map(entry => entry.target))
const explicitPageCoverage = pageFiles.flatMap(file => {
  const owner = VISUAL_COVERAGE.find(entry => entry.target.startsWith(`${file}#`))
  if (!owner) return []
  return [{ ...owner, target: `${file}#page-module` }]
})
for (const entry of explicitPageCoverage) explicitlyOwnedTargets.add(entry.target)
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
failures.push(...(await verifySnapshotInventory()))

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
  console.log(
    `Wrote ${path.relative(LANDER_ROOT, LEDGER_PATH)} with ${coverage.length} exact owners.`,
  )
} else {
  const committed = await readFile(LEDGER_PATH, 'utf8').catch(() => '')
  if (committed !== ledger) {
    console.error(
      'Visual coverage ledger drifted. Run bun run visual:coverage:write and commit the result.',
    )
    process.exit(1)
  }
  console.log(
    `Lander visual coverage verified for ${coverage.length} rendered symbols across ${VISUAL_PUBLIC_ROUTES.length} representative routes; all ${PUBLIC_ROUTE_MANIFEST.length} routes remain build-verified.`,
  )
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

async function verifySnapshotInventory(): Promise<string[]> {
  const screenshotRoot = path.join(LANDER_ROOT, 'tests/visual/__screenshots__')
  const expected = new Set<string>()
  for (const project of ['desktop', 'mobile']) {
    for (const route of VISUAL_PUBLIC_ROUTES) {
      expected.add(`${project}/public-pages.spec.ts/public-${publicRouteId(route.publicPath)}.png`)
    }
    for (const route of NO_JS_PUBLIC_ROUTES) {
      expected.add(`${project}/public-no-js.spec.ts/no-js-${publicRouteId(route)}.png`)
    }
    expected.add(`${project}/public-pages.spec.ts/home-train-source-scene.png`)
    for (const entry of PLAYGROUND_ENTRIES) {
      expected.add(`${project}/playground.spec.ts/${entry.id}.png`)
    }
  }
  const actual = new Set(
    (await collect(screenshotRoot))
      .filter(file => file.endsWith('.png'))
      .map(file => path.relative(screenshotRoot, file).split(path.sep).join('/')),
  )
  return [...actual]
    .filter(file => !expected.has(file))
    .sort()
    .map(file => `orphaned non-representative snapshot: ${file}`)
}
