import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { DOCS_ROUTES } from '../lib/docs'
import { EXAMPLE_SCHEMAS } from '../lib/schema-examples'
import { headingAnchor, routeFromMdxPath } from './verify-content-core'

const DOCS_ROOT = path.resolve(import.meta.dir, '..')
const appRoot = path.join(DOCS_ROOT, 'app')
const mdxFiles = (await collect(appRoot)).filter(file => file.endsWith('page.mdx'))
const sources = new Map<string, string>()
const anchors = new Map<string, Set<string>>()
const failures: string[] = []
const allowedLanguages = new Set(['bash', 'json', 'text', 'ts'])

for (const absolutePath of mdxFiles) {
  const relativePath = path.relative(DOCS_ROOT, absolutePath)
  const route = routeFromMdxPath(relativePath)
  const source = await readFile(absolutePath, 'utf8')
  sources.set(route, source)
  anchors.set(
    route,
    new Set(
      [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => headingAnchor(match[1]?.trim() ?? '')),
    ),
  )
  if (!/export const metadata\s*=/.test(source)) failures.push(`${relativePath}: missing metadata`)

  for (const block of source.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)) {
    const language = block[1]?.trim() ?? ''
    if (!allowedLanguages.has(language)) {
      failures.push(`${relativePath}: unsupported or missing code language "${language}"`)
      continue
    }
    if (language !== 'json') continue

    let value: unknown
    try {
      value = JSON.parse(block[2] ?? '')
    } catch (error) {
      failures.push(`${relativePath}: invalid JSON example (${String(error)})`)
      continue
    }
    const prefix = source.slice(Math.max(0, (block.index ?? 0) - 120), block.index ?? 0)
    const marker = prefix.match(/\{\/\*\s*schema:\s*(\w+)\s*\*\/\}\s*$/)
    const schemaName = marker?.[1]
    if (schemaName === undefined) {
      failures.push(`${relativePath}: JSON example is missing a schema marker`)
      continue
    }
    const schema = EXAMPLE_SCHEMAS[schemaName as keyof typeof EXAMPLE_SCHEMAS]
    if (schema === undefined) {
      failures.push(`${relativePath}: unknown example schema ${schemaName}`)
      continue
    }
    const result = schema.safeParse(value)
    if (!result.success) {
      failures.push(`${relativePath}: example fails ${schemaName}: ${result.error.message}`)
    }
  }
}

const registryRoutes = new Set(DOCS_ROUTES.map(route => route.href))
const fileRoutes = new Set(sources.keys())
for (const route of registryRoutes)
  if (!fileRoutes.has(route)) failures.push(`missing MDX page: ${route}`)
for (const route of fileRoutes)
  if (!registryRoutes.has(route as never)) failures.push(`unregistered MDX page: ${route}`)

for (const [sourceRoute, source] of sources) {
  for (const link of source.matchAll(/\[[^\]]+\]\((\/[^)\s]*)\)/g)) {
    const href = link[1] ?? ''
    const [pathnameValue, fragment] = href.split('#')
    const pathname = pathnameValue === '' ? sourceRoute : pathnameValue?.replace(/\/$/, '') || '/'
    if (!fileRoutes.has(pathname)) {
      failures.push(`${sourceRoute}: broken internal link ${href}`)
      continue
    }
    if (fragment !== undefined && !anchors.get(pathname)?.has(fragment)) {
      failures.push(`${sourceRoute}: broken anchor ${href}`)
    }
  }
}

if (failures.length > 0) {
  console.error(
    ['Docs content verification failed:', ...failures.map(failure => `- ${failure}`)].join('\n'),
  )
  process.exit(1)
}

console.log(`Verified ${mdxFiles.length} MDX routes, links, anchors, and schema-bound examples.`)

async function collect(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
      entries.map(entry => {
        const absolutePath = path.join(directory, entry.name)
        return entry.isDirectory() ? collect(absolutePath) : Promise.resolve([absolutePath])
      }),
    )
  ).flat()
}
