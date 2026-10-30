import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { SkillsBundleFile } from '@repo/contract'

const packageRoot = path.resolve(import.meta.dir, '..')
const skillsDir = path.join(packageRoot, 'skills')
const outputFile = path.join(packageRoot, 'src/generated.ts')

async function walkDirectory(dir: string): Promise<SkillsBundleFile[]> {
  const files: SkillsBundleFile[] = []
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(fullPath)))
    } else if (entry.isFile()) {
      files.push({
        path: path.relative(skillsDir, fullPath).split(path.sep).join('/'),
        content: await readFile(fullPath, 'utf8'),
      })
    }
  }

  return files
}

const files = (await walkDirectory(skillsDir)).sort((left, right) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
)
function singleQuotedString(value: string): string {
  return `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')}'`
}

const embeddedFiles = files
  .map(
    file => `  {
    path: ${singleQuotedString(file.path)},
    content:
      ${JSON.stringify(file.content)},
  },`,
  )
  .join('\n')
const generated = `// Generated file - do not edit manually
// Run 'bun run codegen' to regenerate

export const generatedSkills: { path: string; content: string }[] = [
${embeddedFiles}
]
`

await writeFile(outputFile, generated, 'utf8')

const format = Bun.spawnSync(['oxfmt', '--write', outputFile], {
  cwd: packageRoot,
  stderr: 'pipe',
  stdout: 'pipe',
})
if (format.exitCode !== 0) {
  throw new Error(
    `Failed to format generated skills source: ${new TextDecoder().decode(format.stderr).trim()}`,
  )
}
