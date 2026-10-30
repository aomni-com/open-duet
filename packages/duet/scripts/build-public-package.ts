import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { nextReleaseVersion } from './next-public-version.ts'

const packageDir = resolve(import.meta.dir, '..')
const agentDir = resolve(packageDir, '../agent')
const exec = promisify(execFile)
const args = process.argv.slice(2)
const autoVersion = args.includes('--auto-version')
const output = resolve(
  args.find(argument => argument !== '--auto-version') ?? join(packageDir, 'dist/public-package'),
)
const requireCli = createRequire(join(packageDir, 'package.json'))
const requireAgent = createRequire(join(agentDir, 'package.json'))
const requirePi = createRequire(Bun.resolveSync('@earendil-works/pi-coding-agent', agentDir))
const source = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))

if (autoVersion) {
  try {
    const result = await exec('npm', [
      'view',
      source.name,
      'version',
      '--json',
      '--fetch-retries=0',
    ])
    const publishedVersion = String(JSON.parse(result.stdout))
    source.version = nextReleaseVersion(source.version, publishedVersion)
    console.log(`selected public CLI version ${source.version}`)
  } catch (error) {
    const failure = error as { stdout?: string }
    let code: unknown
    try {
      code = JSON.parse(failure.stdout ?? '').error?.code
    } catch {
      code = undefined
    }
    if (code !== 'E404') throw error
  }
}

async function packageAt(
  path: string,
): Promise<{ directory: string; manifest: Record<string, unknown> }> {
  let directory = dirname(path)
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      if (manifest.name) return { directory, manifest }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Package owner not found for ${path}`)
    directory = parent
  }
}

const nativeOwners = {
  '@opentui/core': requireCli,
  '@electric-sql/pglite': requireAgent,
  '@silvia-odwyer/photon-node': requirePi,
  '@vscode/ripgrep': requireAgent,
}
const dependencies: Record<string, string> = {}
for (const [name, requireOwner] of Object.entries(nativeOwners)) {
  const { manifest } = await packageAt(requireOwner.resolve(name))
  dependencies[name] = String(manifest.version)
}
// Pi resolves clipboard through createRequire at runtime; its native optional
// owner must remain installed beside the bundle rather than auto-downloaded.
const clipboardOwner = await packageAt(requirePi.resolve('@mariozechner/clipboard'))
const optionalDependencies = {
  ...source.optionalDependencies,
  '@mariozechner/clipboard': String(clipboardOwner.manifest.version),
}

await rm(output, { recursive: true, force: true })
await mkdir(join(output, 'dist'), { recursive: true })
const build = await Bun.build({
  entrypoints: [join(packageDir, 'src/cli-entry.ts')],
  target: 'bun',
  outdir: join(output, 'dist'),
  metafile: true,
  external: Object.keys(nativeOwners),
  plugins: [
    {
      name: 'public-package-metadata',
      setup(builder) {
        // The CLI uses its identity, not its development dependency manifest.
        builder.onLoad({ filter: /\/package\.json$/ }, args =>
          args.path === join(packageDir, 'package.json')
            ? {
                loader: 'json',
                contents: JSON.stringify({ name: source.name, version: source.version }),
              }
            : undefined,
        )
      },
    },
  ],
})
if (!build.success) throw new Error(build.logs.map(log => log.message).join('\n'))
await chmod(join(output, 'dist/cli-entry.js'), 0o755)

// Bundled dependencies cannot carry their licenses through npm's normal dependency install.
const bundled = new Map<string, { directory: string; manifest: Record<string, unknown> }>()
for (const input of Object.keys(build.metafile!.inputs)) {
  if (!input.includes('node_modules/')) continue
  const owner = await packageAt(resolve(input))
  bundled.set(`${owner.manifest.name}@${owner.manifest.version}`, owner)
}
let notices = '# Bundled dependency notices\n'
for (const [identity, owner] of [...bundled].sort(([a], [b]) => a.localeCompare(b))) {
  notices += `\n## ${identity}\n\nLicense: ${owner.manifest.license ?? 'see upstream package'}\n`
  for (const name of (await readdir(owner.directory)).sort()) {
    if (!/^(licen[cs]e|copying|notice)(\.|$)/i.test(name)) continue
    notices += `\n${await readFile(join(owner.directory, name), 'utf8')}\n`
  }
}
await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), notices)
const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  type: 'module',
  license: source.license,
  repository: source.repository,
  engines: { ...source.engines, bun: '1.3.14' },
  bin: { duet: 'dist/cli-entry.js' },
  files: ['dist', 'LICENSE', 'README.md', 'THIRD-PARTY-NOTICES.txt'],
  publishConfig: source.publishConfig,
  dependencies,
  optionalDependencies,
}
if (source.optionalDependencies?.['@duetso/syncthing-darwin-arm64']) {
  await copyFile(
    join(packageDir, 'src/sync/NOTICE-syncthing.md'),
    join(output, 'NOTICE-syncthing.md'),
  )
  manifest.files.push('NOTICE-syncthing.md')
}
await writeFile(join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
await Promise.all(
  ['LICENSE', 'README.md'].map(name => copyFile(join(packageDir, name), join(output, name))),
)
console.log(`Public package directory: ${output}`)
