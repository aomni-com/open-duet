import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { CliError, EXIT_CODES } from '../exit-codes.js'

// Syncthing acquisition for the Mac-side wrapper (spec file-attribution slice
// 21, MAP-SYNC K10/V1). The transfer engine is stock, official, unforked
// Syncthing — this module only LOCATES and VERIFIES the binary; it never drives
// sync itself. Two firewalls live here:
//   - V1 version pin: ONE place, matching the VM image pin
//     (packages/vm-image/scripts/verify-image.ts EXPECTED_SYNCTHING_VERSION and
//     the Dockerfile SYNCTHING_VERSION). The versions move together; a
//     mismatched major is refused before we ever spawn (event-shape drift is
//     not a thing we guess our way through).
//   - Supply-chain pin: each per-arch binary is sha256-verified on resolve
//     against the value recorded from the official signed release
//     (sha256sum.txt.asc on github.com/syncthing/syncthing v2.1.2). Upstream
//     macOS builds are Developer-ID signed + notarized (K10), so the OS gate is
//     Apple's; this hash gate is ours.

/**
 * The single Syncthing pin for the Mac wrapper. `version` is the exact release
 * tag and MUST equal the VM image's EXPECTED_SYNCTHING_VERSION — a test in this
 * package pins the literal so a one-sided bump fails loudly. `major` is the
 * only thing hard-enforced at runtime: a binary of a different major speaks a
 * potentially different events/config shape and is refused.
 */
export const SYNCTHING_PIN = {
  version: 'v2.1.2',
  major: 2,
} as const

/**
 * Per-arch stock binary, sha256 recorded from the official signed release. The
 * binaries ride in npm `optionalDependencies` platform packages named by this
 * scheme (K10) — published by the slice-22 release pipeline; slice 21 owns the
 * resolver + verification those packages plug into. `sha256` is the EXTRACTED
 * `syncthing` binary; `archiveSha256` is the upstream `.zip` (the value you can
 * cross-check against sha256sum.txt.asc without unpacking).
 */
export interface SyncthingBinaryPin {
  packageName: string
  /** sha256 of the extracted `syncthing` executable. */
  sha256: string
  /** sha256 of the upstream release archive (verifiable against sha256sum.txt.asc). */
  archiveSha256: string
}

export const SYNCTHING_BINARIES: Record<string, SyncthingBinaryPin> = {
  'darwin-arm64': {
    packageName: '@duetso/syncthing-darwin-arm64',
    sha256: '0325655f864024e0eecd78df07bdedbad46cefc91f480503ff615b6211081869',
    archiveSha256: 'fa2002f320170b64f226ff65831ccec516b59d7bba365acb51731dd079e52d1a',
  },
  'darwin-x64': {
    packageName: '@duetso/syncthing-darwin-x64',
    sha256: '24cd4219041087bf67a2773fe0aa8ad976b8e579b4768c31df365a58058f1743',
    archiveSha256: 'f04b3d7f1492457e929119b91561f0ddc6bada070f46b68bd2464cda04983424',
  },
}

/** Operator/E2E override: an explicit local binary path. Skips package
 * resolution and the sha256 gate (the operator vouches for the bytes) but is
 * STILL held to the major-version pin — we never drive an unexpected major. */
export const SYNCTHING_BIN_ENV = 'DUET_SYNCTHING_BIN'

export interface ResolveBinaryOptions {
  platform?: NodeJS.Platform
  arch?: string
  env?: Record<string, string | undefined>
  /** Resolve a platform package's `syncthing` entry to an absolute path. */
  resolvePackage?: (packageName: string) => string
  /** Run `<bin> --version` and return stdout. Injected in tests. */
  runVersion?: (binaryPath: string) => Promise<string>
  readFileImpl?: (path: string) => Promise<Buffer>
}

export interface ResolvedSyncthing {
  path: string
  version: string
  platformKey: string
}

export function platformKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`
}

/**
 * Locate, verify, and version-pin the Syncthing binary. Order matters: an
 * explicit override wins (still version-checked); otherwise resolve the
 * platform package, sha256-verify the bytes, then run --version and refuse a
 * non-`major` build.
 */
export async function resolveSyncthingBinary(
  options: ResolveBinaryOptions = {},
): Promise<ResolvedSyncthing> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const key = platformKey(platform, arch)
  const env = options.env ?? process.env
  const runVersion = options.runVersion ?? runSyncthingVersion

  const override = env[SYNCTHING_BIN_ENV]
  if (override !== undefined && override.length > 0) {
    const version = await assertSyncthingMajor(override, runVersion)
    return { path: override, version, platformKey: key }
  }

  if (platform !== 'darwin') {
    throw new CliError(
      'unsupported_platform',
      `duet sync bundles Syncthing for macOS only; ${platform} is not supported. ` +
        `Set ${SYNCTHING_BIN_ENV} to a Syncthing ${SYNCTHING_PIN.version} binary to override.`,
      EXIT_CODES.generic,
    )
  }

  const pin = SYNCTHING_BINARIES[key]
  if (pin === undefined) {
    throw new CliError(
      'unsupported_platform',
      `No pinned Syncthing binary for ${key}. ` +
        `Set ${SYNCTHING_BIN_ENV} to a Syncthing ${SYNCTHING_PIN.version} binary to override.`,
      EXIT_CODES.generic,
    )
  }

  const path = resolveBinaryPath(pin.packageName, options.resolvePackage)
  await verifySha256(path, pin.sha256, options.readFileImpl)
  const version = await assertSyncthingMajor(path, runVersion)
  return { path, version, platformKey: key }
}

function resolveBinaryPath(
  packageName: string,
  resolvePackage: ((packageName: string) => string) | undefined,
): string {
  const resolver = resolvePackage ?? defaultResolvePackage
  try {
    return resolver(packageName)
  } catch {
    throw new CliError(
      'syncthing_not_bundled',
      `Syncthing platform package ${packageName} is not installed. ` +
        `It ships with a duet release build; set ${SYNCTHING_BIN_ENV} to run from a local binary.`,
      EXIT_CODES.generic,
    )
  }
}

function defaultResolvePackage(packageName: string): string {
  const require = createRequire(import.meta.url)
  // The platform package exposes the executable at `<pkg>/bin/syncthing`.
  return require.resolve(`${packageName}/bin/syncthing`)
}

export async function verifySha256(
  path: string,
  expected: string,
  readFileImpl: ((path: string) => Promise<Buffer>) | undefined,
): Promise<void> {
  const read = readFileImpl ?? (p => readFile(p))
  const bytes = await read(path)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    throw new CliError(
      'syncthing_sha_mismatch',
      `Syncthing binary at ${path} failed sha256 verification ` +
        `(expected ${expected}, got ${actual}).`,
      EXIT_CODES.generic,
    )
  }
}

/**
 * Refuse a Syncthing whose major does not match the pin. Returns the full
 * version string (e.g. "v2.1.2") for the caller to surface. A mismatched minor
 * is tolerated (upgrade posture: opportunistic minors) but logged upstream; a
 * mismatched MAJOR is fatal — its config and events API may have moved.
 */
export async function assertSyncthingMajor(
  binaryPath: string,
  runVersion: (binaryPath: string) => Promise<string>,
): Promise<string> {
  const output = await runVersion(binaryPath)
  const match = output.match(/syncthing\s+v(\d+)\.(\d+)\.(\d+)/i)
  if (match === null) {
    throw new CliError(
      'syncthing_version_unreadable',
      `Could not read a Syncthing version from ${binaryPath}: ${output.trim().slice(0, 120)}`,
      EXIT_CODES.generic,
    )
  }
  const major = Number(match[1])
  if (major !== SYNCTHING_PIN.major) {
    throw new CliError(
      'syncthing_major_mismatch',
      `Refusing to drive Syncthing v${match[1]}.${match[2]}.${match[3]}: ` +
        `duet sync is pinned to the v${SYNCTHING_PIN.major}.x line (${SYNCTHING_PIN.version}).`,
      EXIT_CODES.generic,
    )
  }
  return `v${match[1]}.${match[2]}.${match[3]}`
}

async function runSyncthingVersion(binaryPath: string): Promise<string> {
  const proc = Bun.spawn([binaryPath, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return `${stdout}${stderr}`
}
