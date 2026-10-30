import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { collect } from './visual-coverage-core'

const REPO_ROOT = path.resolve(import.meta.dir, '..')
const PUBLIC_ROOTS = ['apps/lander/public', 'apps/web/public', 'apps/docs/public']
const APPROVED_CROSS_APP_DUPLICATES = new Set([
  'apps/lander/public/fonts/mono-bold.otf|apps/web/public/fonts/mono-bold.otf',
  'apps/lander/public/fonts/mono-medium.otf|apps/web/public/fonts/mono-medium.otf',
  'apps/lander/public/fonts/mono-regular.otf|apps/web/public/fonts/mono-regular.otf',
  'apps/lander/public/fonts/mono-semibold.otf|apps/web/public/fonts/mono-semibold.otf',
  'apps/lander/public/fonts/sans-italic-variable.woff2|apps/web/public/fonts/sans-italic-variable.woff2',
  'apps/lander/public/fonts/sans-variable.woff2|apps/web/public/fonts/sans-variable.woff2',
  'apps/lander/public/icons/apple-touch-icon.png|apps/web/public/icons/apple-touch-icon.png',
  'apps/lander/public/icons/icon-192.png|apps/web/public/icons/icon-192.png',
  'apps/lander/public/icons/icon-512.png|apps/web/public/icons/icon-512.png',
  'apps/lander/public/landing/hero-poster-light.jpg|apps/web/public/playground/session-image.jpg',
])

const failures: string[] = []
const publicFiles = (
  await Promise.all(PUBLIC_ROOTS.map(root => collect(path.join(REPO_ROOT, root))))
)
  .flat()
  .map(file => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
  .sort()
const filesByHash = new Map<string, string[]>()
for (const file of publicFiles) {
  const bytes = await Bun.file(path.join(REPO_ROOT, file)).arrayBuffer()
  const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  const files = filesByHash.get(hash) ?? []
  files.push(file)
  filesByHash.set(hash, files)
}
const actualDuplicates = new Set(
  [...filesByHash.values()]
    .filter(files => new Set(files.map(file => file.split('/').slice(0, 2).join('/'))).size > 1)
    .map(files => files.sort().join('|')),
)
for (const duplicate of actualDuplicates) {
  if (!APPROVED_CROSS_APP_DUPLICATES.has(duplicate)) {
    failures.push(`unreviewed cross-app duplicate asset: ${duplicate}`)
  }
}
for (const approved of APPROVED_CROSS_APP_DUPLICATES) {
  if (!actualDuplicates.has(approved))
    failures.push(`approved duplicate asset disappeared: ${approved}`)
}

const webPublic = publicFiles.filter(file => file.startsWith('apps/web/public/'))
const webReferences = new Set<string>()
for (const sourceRoot of ['apps/web/app', 'apps/web/components', 'apps/web/spa']) {
  for (const file of await collect(path.join(REPO_ROOT, sourceRoot))) {
    if (!/\.(?:[cm]?[jt]sx?|json|css)$/.test(file)) continue
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(
      /(?:\.\.\/public)?\/(agents\/[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp)|fonts\/[A-Za-z0-9_.-]+\.(?:woff2?|otf)|icons\/[A-Za-z0-9_.-]+\.(?:png|svg|ico)|playground\/(?:session-files\/)?[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp|pdf|docx|pptx))/g,
    )) {
      if (match[1] !== undefined) webReferences.add(`apps/web/public/${match[1]}`)
    }
  }
}
for (const file of webPublic) {
  if (!webReferences.has(file)) failures.push(`unreachable web public asset: ${file}`)
}
for (const file of webReferences) {
  if (!webPublic.includes(file)) failures.push(`missing web public asset: ${file}`)
}

const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: REPO_ROOT }).stdout.toString().split('\n')
for (const file of tracked) {
  if (/(?:^|\/)(?:test-results|playwright-report|\.next|out)\//.test(file)) {
    failures.push(`tracked generated runtime artifact: ${file}`)
  }
}

if (failures.length > 0) {
  console.error(['Asset ownership verification failed:', ...failures.map(x => `- ${x}`)].join('\n'))
  process.exit(1)
}
console.log(
  `Verified ${publicFiles.length} public asset paths, exact web reachability, ${actualDuplicates.size} approved cross-app hash groups, and no tracked runtime artifacts.`,
)
