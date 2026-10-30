import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  ApiDeploymentSchema,
  BACKEND_SCHEMA_VERSION,
  ReleaseRevisionSchema,
} from '../../contract/src/deployment/index.ts'
import { DUET_API_ORIGIN } from '../../contract/src/http/index.ts'

const exec = promisify(execFile)
const args = process.argv.slice(2)
const packageDir = resolve(
  args[0] && !args[0].startsWith('--')
    ? args.shift()!
    : join(import.meta.dir, '../dist/public-package'),
)
let publish = false
let receiptPath = resolve(packageDir, '../public-release/receipt.json')
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--publish') publish = true
  else if (args[index] === '--dry-run') publish = false
  else if (args[index] === '--receipt' && args[index + 1]) receiptPath = resolve(args[++index]!)
  else throw new Error(`Unknown release argument: ${args[index]}`)
}

async function run(argv: string[], cwd = packageDir, timeout = 60_000) {
  const [command, ...arguments_] = argv
  return exec(command!, arguments_, {
    cwd,
    env: process.env,
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  })
}

function npmErrorCode(error: unknown) {
  const failure = error as { stdout?: string }
  try {
    return JSON.parse(failure.stdout ?? '').error?.code
  } catch {
    return undefined
  }
}

async function versionExists(name: string, version: string) {
  try {
    const result = await run([
      'npm',
      'view',
      `${name}@${version}`,
      'version',
      '--json',
      '--fetch-retries=0',
    ])
    assert.equal(JSON.parse(result.stdout), version, 'Registry returned a different version')
    return true
  } catch (error) {
    if (npmErrorCode(error) === 'E404') return false
    throw error
  }
}

async function waitForPublishedVersion(identity: string) {
  // npm can still serve an older packument immediately after accepting a publication.
  const deadline = Date.now() + 5 * 60_000
  while (true) {
    try {
      return JSON.parse(
        (
          await run(
            ['npm', 'view', identity, '--json', '--fetch-retries=0'],
            packageDir,
            Math.max(1, deadline - Date.now()),
          )
        ).stdout,
      )
    } catch (error) {
      if (npmErrorCode(error) !== 'E404' || Date.now() >= deadline) throw error
      console.log(`registry awaiting visibility of ${identity}`)
      await Bun.sleep(Math.min(1_000, deadline - Date.now()))
      if (Date.now() >= deadline) throw error
    }
  }
}

async function waitForProductionDeployment() {
  const expected = ReleaseRevisionSchema.safeParse(process.env.GITHUB_SHA)
  assert(expected.success, 'Actual publication requires GITHUB_SHA with a full lowercase revision')
  const revision = expected.data
  const url = new URL(process.env.DUET_RELEASE_READINESS_URL ?? '/deployment', DUET_API_ORIGIN)
  assert(
    url.href === `${DUET_API_ORIGIN}/deployment` ||
      (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/deployment'),
    'Readiness must use the production API or an explicit loopback fixture',
  )
  const budget = Number(process.env.DUET_RELEASE_WAIT_MS ?? 600_000)
  const interval = Number(process.env.DUET_RELEASE_POLL_MS ?? 5_000)
  assert(
    Number.isFinite(budget) && budget > 0 && budget <= 600_000,
    'Release wait must be positive and at most ten minutes',
  )
  assert(
    Number.isFinite(interval) && interval > 0 && interval <= 5_000,
    'Release polling interval must be positive and at most five seconds',
  )
  const deadline = Date.now() + budget
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
      })
      if (!response.ok) console.log(`readiness HTTP ${response.status}`)
      else {
        const result = ApiDeploymentSchema.pick({ revision: true, backend: true }).safeParse(
          await response.json(),
        )
        if (!result.success) console.log('readiness malformed deployment')
        else {
          const deployment = result.data
          console.log(`readiness api=${deployment.revision} backend=${deployment.backend.revision}`)
          if (
            deployment.revision === revision &&
            deployment.backend.revision === revision &&
            deployment.backend.schema === BACKEND_SCHEMA_VERSION
          )
            return deployment
        }
      }
    } catch {
      console.log('readiness request failed')
    }
    await Bun.sleep(Math.max(0, Math.min(interval, deadline - Date.now())))
  }
  throw new Error(
    `Production API/backend did not reach release revision ${revision} within ${budget}ms`,
  )
}

async function record(receipt: Record<string, unknown>) {
  await mkdir(dirname(receiptPath), { recursive: true })
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `published=${receipt.status === 'published'}\nversion=${receipt.version}\n`,
    )
  }
  console.log(JSON.stringify(receipt))
}

await rm(receiptPath, { force: true })
const packagePath = join(packageDir, 'package.json')
const source = JSON.parse(await readFile(packagePath, 'utf8'))
assert.equal(source.name, '@duetso/agent', 'The release owns only @duetso/agent')
const identity = `${source.name}@${source.version}`
if (await versionExists(source.name, source.version)) {
  await record({ status: 'existing', package: identity, version: source.version })
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'duet-public-release-'))
  try {
    const packed = JSON.parse(
      (await run(['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', scratch]))
        .stdout,
    )[0]
    const tarball = join(scratch, packed.filename)
    const manifest = JSON.parse(
      (await run(['tar', '-xOf', tarball, 'package/package.json'])).stdout,
    )
    assert.equal(manifest.name, source.name)
    assert.equal(manifest.version, source.version)
    assert.deepEqual(
      Object.keys(manifest.bin ?? {}),
      ['duet'],
      'The public package exposes only duet',
    )
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'devDependencies',
    ]) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        assert(
          !name.startsWith('@repo/') && !String(version).startsWith('workspace:'),
          'Private workspace dependency in public tarball',
        )
      }
    }
    await run(['tar', '-xf', tarball, '-C', scratch, `package/${manifest.bin.duet}`])
    const entry = await readFile(join(scratch, 'package', manifest.bin.duet), 'utf8')
    assert(
      entry.startsWith('#!/usr/bin/env bun'),
      'The public CLI requires its Bun executable entry',
    )
    assert(!/(?:from|import\()\s*["']@repo\//.test(entry), 'Private import in public executable')
    const bytes = await readFile(tarball)
    assert.equal(packed.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`)
    const artifact = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: packed.integrity,
      bytes: bytes.byteLength,
    }
    const deployment = publish ? await waitForProductionDeployment() : null
    await run([
      'npm',
      'publish',
      tarball,
      '--access',
      'public',
      '--provenance=false',
      ...(!publish ? ['--dry-run'] : []),
    ])
    const receipt = {
      status: publish ? 'published' : 'validated',
      package: identity,
      version: source.version,
      revision: process.env.GITHUB_SHA ?? null,
      artifact,
      registryInstallVerified: false,
      deployment,
    }
    await record(receipt)
    if (publish) {
      const metadata = await waitForPublishedVersion(identity)
      assert.equal(metadata.name, source.name)
      assert.equal(metadata.version, source.version)
      assert.equal(
        metadata.dist.integrity,
        packed.integrity,
        'Published registry bytes differ from the validated tarball',
      )
      const installed = join(scratch, 'installed')
      await run([
        'npm',
        'install',
        '--prefix',
        installed,
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        identity,
      ])
      const result = await run([join(installed, 'node_modules/.bin/duet'), '--version'], installed)
      assert.equal(
        result.stdout.trim(),
        source.version,
        'Fresh registry install reports a different version',
      )
      await record({ ...receipt, registryInstallVerified: true })
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
