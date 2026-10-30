/// <reference path="./next-babel-parser.d.ts" />

import { readdir } from 'node:fs/promises'
import path from 'node:path'

import babelParser from 'next/dist/compiled/babel/parser.js'

export type VisualCoverageEntry =
  | { readonly target: string; readonly kind: 'fixture'; readonly fixture: string }
  | { readonly target: string; readonly kind: 'route'; readonly route: string }
  | {
      readonly target: string
      readonly kind: 'owned-by'
      readonly owner: `fixture:${string}` | `route:${string}`
    }
  | { readonly target: string; readonly kind: 'nonvisual'; readonly reason: string }

type BabelNode = {
  type: string
  [key: string]: unknown
}

export async function collect(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
      entries.map(entry => {
        const target = path.join(directory, entry.name)
        return entry.isDirectory() ? collect(target) : Promise.resolve([target])
      }),
    )
  ).flat()
}

export function matchNextPage(pathname: string, pageFiles: readonly string[]): string | undefined {
  const candidates = pageFiles
    .map(file => ({ file, pattern: pagePattern(file) }))
    .filter(candidate => candidate.pattern && candidate.pattern.regex.test(pathname))
    .sort((left, right) => {
      const specificity = (right.pattern?.specificity ?? 0) - (left.pattern?.specificity ?? 0)
      return specificity || left.file.localeCompare(right.file)
    })

  return candidates[0]?.file
}

export function inventoryVisualSymbols(relativePath: string, sourceText: string): string[] {
  const ast = babelParser.parse(sourceText, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  }) as BabelNode
  const program = asNode(ast.program)
  const body = Array.isArray(program?.body) ? program.body : []
  const symbols = new Set<string>()

  for (const statementValue of body) {
    const statement = asNode(statementValue)
    if (!statement) continue
    const exported =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
    const declaration = exported ? asNode(statement.declaration) : statement
    if (statement.type === 'ExportNamedDeclaration' && Array.isArray(statement.specifiers)) {
      for (const specifierValue of statement.specifiers) {
        const specifier = asNode(specifierValue)
        if (specifier?.exportKind === 'type') continue
        const exportedName = identifierName(asNode(specifier?.exported))
        if (exportedName && isComponentExportName(exportedName)) {
          symbols.add(`${relativePath}#${exportedName}`)
        }
      }
    }
    if (statement.type === 'ExportDefaultDeclaration' && declaration?.type === 'Identifier') {
      symbols.add(`${relativePath}#default`)
    }
    if (!declaration) continue

    if (declaration.type === 'FunctionDeclaration') {
      const name = asNode(declaration.id)?.name
      if (
        typeof name === 'string' &&
        (containsJsx(declaration.body) || (exported && isComponentExportName(name)))
      ) {
        symbols.add(`${relativePath}#${name}`)
      } else if (statement.type === 'ExportDefaultDeclaration') {
        symbols.add(`${relativePath}#default`)
      }
      continue
    }

    if (declaration.type === 'ClassDeclaration' && exported) {
      const name = asNode(declaration.id)?.name
      symbols.add(`${relativePath}#${typeof name === 'string' ? name : 'default'}`)
      continue
    }

    if (declaration.type === 'VariableDeclaration' && Array.isArray(declaration.declarations)) {
      for (const declaratorValue of declaration.declarations) {
        const declarator = asNode(declaratorValue)
        const initializer = asNode(declarator?.init)
        const name = asNode(declarator?.id)?.name
        if (
          typeof name === 'string' &&
          initializer &&
          (isVisualInitializer(initializer) || (exported && isComponentExportName(name)))
        ) {
          symbols.add(`${relativePath}#${name}`)
        }
      }
      continue
    }

    if (
      statement.type === 'ExportDefaultDeclaration' &&
      (declaration.type === 'ArrowFunctionExpression' || declaration.type === 'FunctionExpression')
    ) {
      symbols.add(`${relativePath}#default`)
    }
  }

  return [...symbols].sort()
}

export function inventoryPageModules(relativePaths: Iterable<string>): string[] {
  return [...relativePaths]
    .filter(relativePath => /(?:^|\/)page\.(?:tsx|mdx)$/.test(relativePath))
    .map(relativePath => `${relativePath}#page-module`)
    .sort()
}

function isVisualInitializer(initializer: BabelNode): boolean {
  if (
    (initializer.type === 'ArrowFunctionExpression' || initializer.type === 'FunctionExpression') &&
    containsJsx(initializer.body)
  ) {
    return true
  }

  if (initializer.type !== 'CallExpression' || !isVisualWrapper(initializer.callee)) return false
  const firstArgument = Array.isArray(initializer.arguments)
    ? asNode(initializer.arguments[0])
    : undefined
  return firstArgument ? isVisualInitializer(firstArgument) : false
}

function isVisualWrapper(value: unknown): boolean {
  const callee = asNode(value)
  if (!callee) return false
  if (callee.type === 'Identifier') return callee.name === 'memo' || callee.name === 'forwardRef'
  if (callee.type !== 'MemberExpression') return false
  const property = asNode(callee.property)
  return property?.name === 'memo' || property?.name === 'forwardRef'
}

export function inventoryRuntimeImports(sourceText: string): string[] {
  const ast = babelParser.parse(sourceText, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  }) as BabelNode
  const imports = new Set<string>()

  visit(asNode(ast.program), node => {
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.importKind !== 'type' &&
      node.exportKind !== 'type'
    ) {
      const source = asNode(node.source)?.value
      if (typeof source === 'string') imports.add(source)
    }

    if (node.type === 'CallExpression' && asNode(node.callee)?.type === 'Import') {
      const firstArgument = Array.isArray(node.arguments) ? asNode(node.arguments[0]) : undefined
      if (typeof firstArgument?.value === 'string') imports.add(firstArgument.value)
    }
  })

  return [...imports].sort()
}

export function inventoryMdxImports(sourceText: string): string[] {
  const imports = new Set<string>()
  for (const match of sourceText.matchAll(
    /^\s*(?:import[\s\S]*?from\s+|export\s+(?:\*|\{[^}]*\})\s+from\s+)['"]([^'"]+)['"]/gm,
  )) {
    if (match[1]) imports.add(match[1])
  }
  return [...imports].sort()
}

export function deriveRouteCoverage({
  symbolsByFile,
  dependenciesByFile,
  routeRoots,
}: {
  symbolsByFile: ReadonlyMap<string, readonly string[]>
  dependenciesByFile: ReadonlyMap<string, readonly string[]>
  routeRoots: readonly { readonly route: string; readonly files: readonly string[] }[]
}): VisualCoverageEntry[] {
  return deriveImportClosureOwners({
    symbolsByFile,
    dependenciesByFile,
    roots: routeRoots.map(({ route, files }) => ({ owner: `route:${route}` as const, files })),
  })
}

export function deriveFixtureCoverage({
  symbolsByFile,
  dependenciesByFile,
  fixtureRoots,
}: {
  symbolsByFile: ReadonlyMap<string, readonly string[]>
  dependenciesByFile: ReadonlyMap<string, readonly string[]>
  fixtureRoots: readonly { readonly fixture: string; readonly files: readonly string[] }[]
}): VisualCoverageEntry[] {
  return deriveImportClosureOwners({
    symbolsByFile,
    dependenciesByFile,
    roots: fixtureRoots.map(({ fixture, files }) => ({
      owner: `fixture:${fixture}` as const,
      files,
    })),
  })
}

function deriveImportClosureOwners({
  symbolsByFile,
  dependenciesByFile,
  roots,
}: {
  symbolsByFile: ReadonlyMap<string, readonly string[]>
  dependenciesByFile: ReadonlyMap<string, readonly string[]>
  roots: readonly {
    readonly owner: `fixture:${string}` | `route:${string}`
    readonly files: readonly string[]
  }[]
}): VisualCoverageEntry[] {
  const ownerByFile = new Map<string, `fixture:${string}` | `route:${string}`>()

  for (const { owner, files } of [...roots].sort((left, right) =>
    left.owner.localeCompare(right.owner),
  )) {
    const pending = [...files]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const file = pending.pop()
      if (!file || visited.has(file)) continue
      visited.add(file)
      if (!ownerByFile.has(file)) ownerByFile.set(file, owner)
      pending.push(...(dependenciesByFile.get(file) ?? []))
    }
  }

  return [...ownerByFile.entries()]
    .flatMap(([file, owner]) =>
      (symbolsByFile.get(file) ?? []).map(
        target =>
          ({
            target,
            kind: 'owned-by',
            owner,
          }) satisfies VisualCoverageEntry,
      ),
    )
    .sort((left, right) => left.target.localeCompare(right.target))
}

export function validateCoverage({
  inventory,
  fixtures,
  routes = [],
  entries,
}: {
  inventory: Iterable<string>
  fixtures: Iterable<string>
  routes?: Iterable<string>
  entries: readonly VisualCoverageEntry[]
}): string[] {
  const inventorySet = new Set(inventory)
  const fixtureSet = new Set(fixtures)
  const routeSet = new Set(routes)
  const targets = new Set(entries.map(entry => entry.target))
  const failures: string[] = []

  for (const target of [...inventorySet].sort()) {
    if (!targets.has(target)) failures.push(`missing coverage: ${target}`)
  }
  for (const entry of entries) {
    if (!inventorySet.has(entry.target)) failures.push(`stale coverage: ${entry.target}`)
    if (/[?*]/.test(entry.target)) failures.push(`broad target is forbidden: ${entry.target}`)
    if (entry.kind === 'fixture' && !fixtureSet.has(entry.fixture)) {
      failures.push(`unknown fixture ${entry.fixture} for ${entry.target}`)
    }
    if (
      entry.kind === 'owned-by' &&
      entry.owner.startsWith('fixture:') &&
      !fixtureSet.has(entry.owner.slice('fixture:'.length))
    ) {
      failures.push(`unknown fixture owner ${entry.owner} for ${entry.target}`)
    }
    if (
      entry.kind === 'owned-by' &&
      entry.owner.startsWith('route:') &&
      !routeSet.has(entry.owner.slice('route:'.length))
    ) {
      failures.push(`unknown route owner ${entry.owner.slice('route:'.length)} for ${entry.target}`)
    }
    if (entry.kind === 'route' && !routeSet.has(entry.route)) {
      failures.push(`unknown route ${entry.route} for ${entry.target}`)
    }
    if (entry.kind === 'nonvisual' && entry.reason.trim().length < 12) {
      failures.push(`nonvisual reason is too vague: ${entry.target}`)
    }
  }
  if (targets.size !== entries.length) failures.push('duplicate visual coverage targets')

  return failures
}

function containsJsx(value: unknown): boolean {
  const node = asNode(value)
  if (!node) return false
  if (
    node.type === 'JSXElement' ||
    node.type === 'JSXFragment' ||
    node.type === 'JSXSelfClosingElement'
  ) {
    return true
  }

  return Object.entries(node).some(([key, child]) => {
    if (key === 'loc' || key === 'start' || key === 'end') return false
    if (Array.isArray(child)) return child.some(containsJsx)
    return containsJsx(child)
  })
}

function visit(value: unknown, callback: (node: BabelNode) => void): void {
  const node = asNode(value)
  if (!node) return
  callback(node)
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    if (Array.isArray(child)) child.forEach(value => visit(value, callback))
    else visit(child, callback)
  }
}

function asNode(value: unknown): BabelNode | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) return undefined
  const type = Reflect.get(value, 'type')
  return typeof type === 'string' ? (value as BabelNode) : undefined
}

function identifierName(value: BabelNode | undefined): string | undefined {
  if (value?.type === 'Identifier' && typeof value.name === 'string') return value.name
  if (value?.type === 'StringLiteral' && typeof value.value === 'string') return value.value
  return undefined
}

function isComponentExportName(value: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(value) && /[a-z]/.test(value)
}

function pagePattern(file: string): { regex: RegExp; specificity: number } | undefined {
  const suffix = file.endsWith('/page.tsx')
    ? '/page.tsx'
    : file.endsWith('/page.mdx')
      ? '/page.mdx'
      : undefined
  if (!file.startsWith('app/') || !suffix) return undefined
  const segments = file.slice('app/'.length, -suffix.length).split('/').filter(Boolean)
  let specificity = 0
  const parts = segments.flatMap(segment => {
    if (/^\(.+\)$/.test(segment) || segment.startsWith('@')) return []
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) return ['(?:/.*)?']
    if (/^\[\.\.\..+\]$/.test(segment)) return ['/[^/]+(?:/[^/]+)*']
    if (/^\[.+\]$/.test(segment)) return ['/[^/]+']
    specificity += 1
    return [`/${escapeRegExp(segment)}`]
  })
  return { regex: new RegExp(`^${parts.join('') || '/'}$`), specificity }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
