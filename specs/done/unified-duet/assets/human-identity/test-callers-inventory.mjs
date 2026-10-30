import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Run from the checkout; use its frozen source compiler's parser.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const ts = createRequire(join(root, 'packages/agent/package.json'))('typescript')
const scope = ['apps/api', 'packages/backend', 'packages/test-harness']
const baseline = process.argv[2]

function calls(files, read) {
  const rows = []
  for (const file of files) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true)
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'issueKey') {
        const options = node.arguments[1]
        const invalidOptions =
          options !== undefined &&
          (!ts.isObjectLiteralExpression(options) ||
            options.properties.some(
              property =>
                !ts.isPropertyAssignment(property) ||
                !['name', 'expiresAt'].includes(
                  property.name.getText(source).replace(/^['"]|['"]$/g, ''),
                ),
            ))
        rows.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          legacyArray: options !== undefined && ts.isArrayLiteralExpression(options),
          invalid: node.arguments.length > 2 || invalidOptions,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return {
    total: rows.length,
    files: Object.fromEntries(
      [...new Set(rows.map(row => row.file))]
        .sort()
        .map(file => [file, rows.filter(row => row.file === file).length]),
    ),
    legacyArrayCount: rows.filter(row => row.legacyArray).length,
    invalidCalls: rows.filter(row => row.invalid),
  }
}
const files = execFileSync('rg', ['-l', '-g', '*.ts', 'issueKey', ...scope], {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
const current = calls(files, file => readFileSync(join(root, file), 'utf8'))
let previous
if (baseline) {
  const entries = execFileSync('git', ['grep', '-l', 'issueKey', baseline, '--', ...scope], {
    cwd: root,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
  const baseFiles = entries
    .map(entry => entry.slice(entry.indexOf(':') + 1))
    .filter(file => file.endsWith('.ts'))
  previous = calls(baseFiles, file =>
    execFileSync('git', ['show', `${baseline}:${file}`], {
      cwd: root,
      encoding: 'utf8',
    }),
  )
}
console.log(JSON.stringify({ baseline, previous, current }, null, 2))
if (current.invalidCalls.length > 0) process.exitCode = 1
