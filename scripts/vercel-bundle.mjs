#!/usr/bin/env node
// Produce a self-contained Vercel Build Output for a Hono app.
//
// Why this exists: @vercel/node transpiles the entry (index.ts -> index.js) but
// leaves the workspace source packages (@repo/*, which export raw `.ts` via their
// package `exports`) as runtime imports. Node cannot load a `.ts` at runtime, so
// every route crashes with ERR_MODULE_NOT_FOUND. Bundling with bun inlines those
// packages into one file, so there is nothing external to resolve.
//
// Run from an app directory (cwd = apps/<app>). Optional env:
//   VC_MAX_DURATION  — sets the function maxDuration (seconds).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = process.cwd()
const out = resolve(cwd, '.vercel/output')
const funcDir = resolve(out, 'functions/index.func')
rmSync(out, { recursive: true, force: true })
mkdirSync(funcDir, { recursive: true })

execFileSync(
  'bun',
  [
    'build',
    'src/index.ts',
    '--target=node',
    '--format=esm',
    `--outfile=${resolve(funcDir, 'index.mjs')}`,
  ],
  { stdio: 'inherit', cwd },
)

const environment = {}
const appName = existsSync(resolve(cwd, 'package.json'))
  ? JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')).name
  : undefined
if (appName === 'mcp') {
  // The SDK loads its Node URL downloader through createRequire, so bundling
  // cannot see this dependency. Undici has no package dependencies of its own.
  const require = createRequire(
    resolve(dirname(fileURLToPath(import.meta.url)), '../apps/mcp/package.json'),
  )
  cpSync(dirname(require.resolve('undici/package.json')), resolve(funcDir, 'node_modules/undici'), {
    recursive: true,
  })
}
// The API ships the constructor's exact inventory, including its executable modes.
// Verify content through the announcement owner; packaging also verifies the
// intended install modes before Vercel normalizes its mounted file permissions.
const runtimeReleaseDir = resolve(cwd, 'dist/runtime-release')
const isApi = appName === 'api'
if (isApi || existsSync(runtimeReleaseDir)) {
  const reader = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../apps/api/src/runtime/release.ts',
  )
  execFileSync(
    'bun',
    [
      '-e',
      `
    import { readdir, stat } from 'node:fs/promises';
    import { join } from 'node:path';
    import { readRuntimeReleaseManifest } from ${JSON.stringify(reader)};
    const path = ${JSON.stringify(runtimeReleaseDir)};
    const manifest = await readRuntimeReleaseManifest(path);
    if (manifest === null) throw new Error('Complete runtime release required for API packaging');
    for (const artifact of manifest.artifacts) {
      const metadata = await stat(join(path, artifact.name));
      if ((metadata.mode & 0o777) !== artifact.mode)
        throw new Error('Runtime artifact mode does not match manifest: ' + artifact.name);
    }
    const actual = (await readdir(path)).sort();
    const expected = [...manifest.artifacts.map(a => a.name), 'manifest.json'].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Runtime release contains unmanifested files');
  `,
    ],
    { stdio: 'inherit', cwd },
  )
  cpSync(runtimeReleaseDir, resolve(funcDir, 'runtime-release'), { recursive: true })
  environment.DUET_RUNTIME_RELEASE_DIR = 'runtime-release'
}

const maxDuration = process.env.VC_MAX_DURATION ? Number(process.env.VC_MAX_DURATION) : undefined
writeFileSync(
  resolve(funcDir, '.vc-config.json'),
  JSON.stringify(
    {
      handler: 'index.mjs',
      runtime: 'nodejs24.x',
      supportsResponseStreaming: true,
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      framework: { slug: 'hono' },
      ...(maxDuration ? { maxDuration } : {}),
      ...(Object.keys(environment).length ? { environment } : {}),
    },
    null,
    2,
  ),
)
writeFileSync(resolve(funcDir, 'package.json'), JSON.stringify({ type: 'module' }))
writeFileSync(
  resolve(out, 'config.json'),
  JSON.stringify({ version: 3, routes: [{ src: '/(.*)', dest: '/' }] }),
)
console.log('vercel build output ready:', funcDir)
