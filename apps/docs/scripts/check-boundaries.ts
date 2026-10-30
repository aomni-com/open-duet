import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const DOCS_ROOT = path.resolve(import.meta.dir, '..')
const roots = ['app', 'components', 'lib']
const files = (await Promise.all(roots.map(root => collect(path.join(DOCS_ROOT, root))))).flat()
const failures: string[] = []
const forbidden = [
  { pattern: /(?:from\s+|import\s*)['"][^'"]*apps\/web/, reason: 'apps/web import' },
  { pattern: /(?:from\s+|import\s*)['"]@repo\/backend/, reason: 'backend import' },
  { pattern: /(?:from\s+|import\s*)['"]convex(?:\/|['"])/, reason: 'Convex import' },
  { pattern: /browser_session/, reason: 'private browser credential name' },
  { pattern: /\bcomposio\b/i, reason: 'private integration provider branding' },
]

for (const absolutePath of files.filter(file => /\.(?:ts|tsx|mdx)$/.test(file))) {
  const source = await readFile(absolutePath, 'utf8')
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) {
      failures.push(`${path.relative(DOCS_ROOT, absolutePath)}: ${rule.reason}`)
    }
  }
}

if (failures.length > 0) {
  console.error(
    ['Docs boundary violations:', ...failures.map(failure => `- ${failure}`)].join('\n'),
  )
  process.exit(1)
}

console.log(`Docs boundaries verified across ${files.length} source files.`)

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
