import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { collect, type VisualCoverageEntry } from './visual-coverage-core'
import {
  missingVisualFilters,
  REQUIRED_VISUAL_OWNERS,
  type SharedUiEntry,
  validateVisualOwnerUnion,
  type VisualOwnerName,
} from './visual-owner-union'

const REPO_ROOT = path.resolve(import.meta.dir, '..')
const OUTPUT_PATH = path.join(REPO_ROOT, 'visual-coverage/index.generated.html')
const configs: readonly {
  name: VisualOwnerName
  ledger: string
  screenshots?: string
}[] = [
  {
    name: 'lander',
    ledger: 'apps/lander/tests/visual/coverage-ledger.generated.json',
    screenshots: 'apps/lander/tests/visual/__screenshots__',
  },
  {
    name: 'web',
    ledger: 'apps/web/tests/visual/coverage-ledger.generated.json',
    screenshots: 'apps/web/tests/visual/__screenshots__',
  },
  {
    name: 'docs',
    ledger: 'apps/docs/tests/visual/coverage-ledger.generated.json',
    screenshots: 'apps/docs/tests/visual/__screenshots__',
  },
  { name: 'ui', ledger: 'packages/ui/tests/visual/coverage-ledger.generated.json' },
  {
    name: 'official-apps',
    ledger: 'packages/official-agents-seed/tests/visual/coverage-ledger.generated.json',
    screenshots: 'packages/official-agents-seed/tests/visual/__screenshots__',
  },
]

const ledgers = new Map<VisualOwnerName, readonly (VisualCoverageEntry | SharedUiEntry)[]>()
for (const config of configs) {
  ledgers.set(
    config.name,
    JSON.parse(await readFile(path.join(REPO_ROOT, config.ledger), 'utf8')) as readonly (
      | VisualCoverageEntry
      | SharedUiEntry
    )[],
  )
}

const failures = validateVisualOwnerUnion(ledgers)
for (const sourcePath of ['scripts/ui-playground.sh', 'package.json']) {
  const missing = missingVisualFilters(await readFile(path.join(REPO_ROOT, sourcePath), 'utf8'))
  for (const owner of missing) failures.push(`${sourcePath} omits visual owner filter: ${owner}`)
}

const html = formatHtml(await renderIndex())
if (process.argv.includes('--write')) {
  await writeFile(OUTPUT_PATH, html)
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}.`)
} else {
  const committed = await readFile(OUTPUT_PATH, 'utf8').catch(() => '')
  if (committed !== html) failures.push('visual owner index drifted; run visual:union:write')
}

if (failures.length > 0) {
  console.error(
    ['Visual owner union verification failed:', ...failures.map(failure => `- ${failure}`)].join(
      '\n',
    ),
  )
  process.exit(1)
}
console.log(
  `Verified the complete ${REQUIRED_VISUAL_OWNERS.join('/')} visual owner union and contact-sheet index.`,
)

async function renderIndex(): Promise<string> {
  const sections: string[] = []
  for (const config of configs) {
    const entries = ledgers.get(config.name) ?? []
    const images =
      config.screenshots === undefined
        ? []
        : (await collect(path.join(REPO_ROOT, config.screenshots)))
            .filter(file => file.endsWith('.png'))
            .map(file => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
            .sort()
    sections.push(`<section id="${config.name}">
<h2>${config.name} — ${entries.length} inventory rows · ${images.length} baselines</h2>
<p><a href="../${config.ledger}">Coverage ledger</a></p>
${
  images.length === 0
    ? '<p>Shared UI rows point to their sole app-owned fixture or route; no duplicate baseline corpus is stored.</p>'
    : `<div class="shots">${images
        .map(
          image =>
            `<figure><a href="../${image}"><img loading="lazy" src="../${image}" alt="${escapeHtml(image)}"></a><figcaption>${escapeHtml(image)}</figcaption></figure>`,
        )
        .join('')}</div>`
}
<details><summary>Every inventory row</summary><table><thead><tr><th>Target</th><th>Disposition</th></tr></thead><tbody>${entries
      .map(
        entry =>
          `<tr><td><code>${escapeHtml(entry.target)}</code></td><td><code>${escapeHtml(disposition(entry))}</code></td></tr>`,
      )
      .join('')}</tbody></table></details>
</section>`)
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Duet visual owner index</title><style>
body{font:14px system-ui;margin:0 auto;max-width:1600px;padding:24px;color:#171717}nav{display:flex;gap:16px;position:sticky;top:0;background:#fff;padding:12px 0;border-bottom:1px solid #ddd;z-index:2}section{margin:36px 0}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}figure{margin:0;border:1px solid #ddd;border-radius:8px;overflow:hidden;background:#fafafa}img{display:block;width:100%;height:240px;object-fit:contain;object-position:top}figcaption{padding:8px;font-size:10px;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}td,th{padding:6px;border:1px solid #ddd;text-align:left;vertical-align:top}code{overflow-wrap:anywhere}
</style></head><body><h1>Duet visual owner index</h1><p>Generated from code-derived ledgers and existing baselines. This page stores no copied images.</p><nav>${configs.map(config => `<a href="#${config.name}">${config.name}</a>`).join('')}</nav>${sections.join('')}</body></html>
`
}

function disposition(entry: VisualCoverageEntry | SharedUiEntry): string {
  if (entry.kind === 'nonvisual') return `nonvisual:${entry.reason}`
  if (entry.kind === 'fixture') return `fixture:${entry.fixture}`
  if (entry.kind === 'route') return `route:${entry.route}`
  return entry.owner
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function formatHtml(source: string): string {
  const result = Bun.spawnSync(
    ['bunx', 'oxfmt', '--stdin-filepath=visual-coverage/index.generated.html'],
    {
      cwd: REPO_ROOT,
      stdin: new Blob([source]),
    },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}
