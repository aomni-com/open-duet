import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const WEB_ROOT = path.resolve(import.meta.dir, '..')
const SOURCE_ROOTS = ['app', 'components', 'spa', 'src'] as const
const FORBIDDEN_MODULES = [
  /^@repo\/backend(?:\/|$)/,
  /^convex(?:\/|$)/,
  /^@convex-dev(?:\/|$)/,
  /workos/i,
  /^ably(?:\/|$)/,
]
const PLAYGROUND_PREFIXES = ['app/playground/', 'components/playground/', 'tests/visual/']
const ALLOWED_PRODUCT_NETWORK_OWNERS = new Set([
  'spa/api/client.ts',
  'spa/api/file-previews.ts',
  'spa/api/train-uploads.ts',
  'spa/api/vm-uploads.ts',
  'spa/api/stream.ts',
  'spa/files/lib/attribution-source.ts',
  'spa/files/lib/public-provider.ts',
  'src/server/duet-proxy.ts',
])
// Deployment identity is not product data: it is the shell asking its own
// origin which build is being served, so it never crosses the Duet API.
const ALLOWED_ORIGIN_NETWORK_OWNERS = new Set(['spa/shell/app-version.ts'])
const ALLOWED_IDENTITY_NETWORK_OWNERS = new Set([
  'app/sign-in/sign-in-client.tsx',
  'app/sign-out/page.tsx',
])
const ALLOWED_CONVEX_IDENTITY_OWNERS = new Set([
  'app/sign-in/sign-in-client.tsx',
  'app/sign-out/page.tsx',
  'src/auth/bootstrap.ts',
  'src/auth/provider.tsx',
  'src/auth/send-magic-link.ts',
  'src/server/convex-browser-session.ts',
])
// A playground reading its own fixture out of `public/` is not product code
// reaching the network: the bytes ship with the app, the request never leaves
// the origin, and no Duet API or backend is involved — which the
// backend-independence rule below still checks on its own. Handing these to an
// api owner instead would stop the fixture exercising the real file-viewer
// path it exists to exercise.
const ALLOWED_FIXTURE_NETWORK_OWNERS = new Set([
  'components/playground/attachment-cards-playground.tsx',
  'components/playground/session-inline-media-playground.tsx',
])
const ALLOWED_NETWORK_OWNERS = new Set([
  ...ALLOWED_PRODUCT_NETWORK_OWNERS,
  ...ALLOWED_ORIGIN_NETWORK_OWNERS,
  ...ALLOWED_IDENTITY_NETWORK_OWNERS,
  ...ALLOWED_CONVEX_IDENTITY_OWNERS,
  ...ALLOWED_FIXTURE_NETWORK_OWNERS,
])

const files = (
  await Promise.all(SOURCE_ROOTS.map(root => collect(path.join(WEB_ROOT, root))))
).flat()
const failures: string[] = []

for (const absolutePath of files) {
  if (!/\.[cm]?[jt]sx?$/.test(absolutePath)) continue
  const relativePath = path.relative(WEB_ROOT, absolutePath)
  const sourceText = await readFile(absolutePath, 'utf8')
  if (/\bcomposio\b/i.test(sourceText)) {
    failures.push(`${relativePath}: integration provider branding is private infrastructure`)
  }
  const moduleSpecifiers = [
    ...sourceText.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g),
  ].flatMap(match => (match[1] ? [match[1]] : []))

  for (const specifier of moduleSpecifiers) {
    const identityAuthImport =
      ALLOWED_CONVEX_IDENTITY_OWNERS.has(relativePath) &&
      (specifier === 'convex' ||
        specifier.startsWith('convex/') ||
        specifier.startsWith('@convex-dev/auth'))
    if (!identityAuthImport && FORBIDDEN_MODULES.some(pattern => pattern.test(specifier))) {
      failures.push(`${relativePath}: forbidden module ${specifier}`)
    }
  }

  if (
    !relativePath.includes('.test.') &&
    !ALLOWED_NETWORK_OWNERS.has(relativePath) &&
    hasNetworkCall(sourceText)
  ) {
    failures.push(
      `${relativePath}: network access belongs in an exact identity, proxy, or spa/api owner`,
    )
  }

  if (relativePath === 'app/device/page.tsx') {
    const dynamicServerApi = moduleSpecifiers.some(specifier => specifier === 'next/headers')
    if (dynamicServerApi || /\b(cookies|headers|unstable_noStore)\s*\(/.test(sourceText)) {
      failures.push(`${relativePath}: static public owner reads request-time server state`)
    }
  }

  if (PLAYGROUND_PREFIXES.some(prefix => relativePath.startsWith(prefix))) {
    if (
      moduleSpecifiers.some(specifier =>
        /stripe|@repo\/backend|convex|ably|workos/i.test(specifier),
      )
    ) {
      failures.push(`${relativePath}: playground must remain backend-independent`)
    }
  }
}

if (failures.length > 0) {
  console.error(['Web boundary violations:', ...failures.map(failure => `- ${failure}`)].join('\n'))
  process.exit(1)
}

console.log(`Web boundaries verified across ${files.length} source files.`)

async function collect(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(entry => {
      const absolutePath = path.join(directory, entry.name)
      return entry.isDirectory() ? collect(absolutePath) : Promise.resolve([absolutePath])
    }),
  )
  return nested.flat()
}

function hasNetworkCall(sourceText: string): boolean {
  return (
    /\b(?:globalThis|window)\s*\.\s*(?:fetch|EventSource|WebSocket)\s*\(/.test(sourceText) ||
    /(?<![.A-Za-z0-9_$])(?:fetch|EventSource|WebSocket)\s*\(/.test(sourceText) ||
    /(?<![.A-Za-z0-9_$])(?:fetch[A-Z][A-Za-z0-9_$]*|[A-Za-z0-9_$]+Fetch|EventSourceImpl|WebSocketImpl)\s*\(/.test(
      sourceText,
    ) ||
    /\.(?:fetchImpl|eventSourceImpl|webSocketImpl)\s*\(/i.test(sourceText)
  )
}
