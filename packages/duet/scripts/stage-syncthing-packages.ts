/**
 * Stage the pinned stock macOS Syncthing binaries and verify npm's packed files.
 * The pin and archive/executable hashes belong to src/sync/binary.ts. Binary
 * payloads are gitignored and acquired only for package staging.
 *
 * Offline staging can provide SYNCTHING_STAGE_DARWIN_ARM64 and
 * SYNCTHING_STAGE_DARWIN_X64 paths; otherwise official release archives are used.
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SYNCTHING_BINARIES, SYNCTHING_PIN } from '../src/sync/binary.js'

const REPO_PACKAGES = join(import.meta.dir, '..', '..')

interface StagedPackage {
  key: string
  packageDir: string
}

async function main(): Promise<void> {
  if (process.argv.length > 2)
    throw new Error('Stock staging accepts no arguments; it does not publish')
  const staged: StagedPackage[] = []

  for (const [key, pin] of Object.entries(SYNCTHING_BINARIES)) {
    const arch = key.slice('darwin-'.length)
    const packageDir = join(REPO_PACKAGES, `syncthing-${key}`)
    const binOut = join(packageDir, 'bin', 'syncthing')
    await mkdir(join(packageDir, 'bin'), { recursive: true })

    const binary = await acquireBinary(key, arch, pin.archiveSha256)
    const actual = createHash('sha256').update(binary).digest('hex')
    if (actual !== pin.sha256) {
      throw new Error(
        `${pin.packageName}: extracted binary sha256 ${actual} != pinned ${pin.sha256}`,
      )
    }
    await writeFile(binOut, binary)
    await chmod(binOut, 0o755)
    staged.push({ key, packageDir })
    console.log(`✓ staged ${pin.packageName} bin/syncthing (${fmtBytes(binary.byteLength)})`)
  }

  for (const pkg of staged) {
    const files = await npmPackDryRun(pkg.packageDir)
    if (!files.includes('bin/syncthing')) {
      throw new Error(`${pkg.key}: npm pack dry-run does not include bin/syncthing`)
    }
    console.log(`✓ npm pack --dry-run ${pkg.key}: ${files.length} files, includes bin/syncthing`)
  }

  console.log('Stock binary staging and package validation complete.')
}

/** Prefer an explicit staged binary; otherwise download + verify the archive. */
async function acquireBinary(key: string, arch: string, archiveSha256: string): Promise<Buffer> {
  const override = process.env[`SYNCTHING_STAGE_${key.replace(/-/g, '_').toUpperCase()}`]
  if (override !== undefined && override.length > 0) {
    console.log(`  · staging ${key} from ${override}`)
    return readFile(override)
  }
  const asset = arch === 'x64' ? 'amd64' : arch
  const name = `syncthing-macos-${asset}-${SYNCTHING_PIN.version}`
  const url = `https://github.com/syncthing/syncthing/releases/download/${SYNCTHING_PIN.version}/${name}.zip`
  console.log(`  · downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${url}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const archiveHash = createHash('sha256').update(archive).digest('hex')
  if (archiveHash !== archiveSha256) {
    throw new Error(`${name}.zip sha256 ${archiveHash} != pinned ${archiveSha256}`)
  }
  return extractSyncthing(archive, name)
}

/** Unzip the archive to a temp dir and read `<name>/syncthing`. */
async function extractSyncthing(archive: Buffer, name: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'duet-syncthing-zip-'))
  try {
    const zipPath = join(dir, `${name}.zip`)
    await writeFile(zipPath, archive)
    const proc = Bun.spawn(['unzip', '-o', '-q', zipPath, '-d', dir], {
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0)
      throw new Error(`unzip exited ${code}: ${await new Response(proc.stderr).text()}`)
    return await readFile(join(dir, name, 'syncthing'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function npmPackDryRun(packageDir: string): Promise<string[]> {
  const proc = Bun.spawn(['npm', 'pack', '--dry-run', '--json'], {
    cwd: packageDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(
      `npm pack --dry-run failed in ${packageDir}: ${await new Response(proc.stderr).text()}`,
    )
  }
  const parsed = JSON.parse(stdout) as Array<{ files?: Array<{ path: string }> }>
  return (parsed[0]?.files ?? []).map(file => file.path)
}

function fmtBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

await main()
