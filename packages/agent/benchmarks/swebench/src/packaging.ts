import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  PGLITE_RUNTIME_ASSET_NAMES,
  DUET_RUNTIME_ASSET_NAMES,
  type DuetRuntimeAssetName,
} from '../../../src/runtime-assets.js'
import { LocalCommandRunner, type CommandRunner } from './container.js'

/** Linux artifact installed into every official instance image. */
export interface DuetArtifact {
  /** Compiled Duet executable copied into every official instance container. */
  localPath: string
  installPath: '/opt/duet/duet'
  sha256: string
  /** Filesystem and image WASM sidecars loaded beside the compiled executable. */
  runtimeAssets: Array<{
    name: DuetRuntimeAssetName
    localPath: string
    installPath: `/opt/duet/${DuetRuntimeAssetName}`
    sha256: string
  }>
  packagingMode: 'compiled-linux-x64'
}

export interface PrepareDuetArtifactOptions {
  /** Monorepo root containing the root lockfile and owned agent/duet workspaces. */
  repoRoot: string
  /** Durable host directory for the resulting binary. */
  outputDir: string
  /** Injectable command boundary used by deterministic tests. */
  commands?: CommandRunner
}

/**
 * Load a binary built into an immutable worker image instead of rebuilding it
 * independently in every sandbox.
 */
export async function loadPrebuiltDuetArtifact(localPath: string): Promise<DuetArtifact> {
  const resolvedPath = resolve(localPath)
  return {
    localPath: resolvedPath,
    installPath: '/opt/duet/duet',
    sha256: await sha256File(resolvedPath),
    runtimeAssets: await loadRuntimeAssets(dirname(resolvedPath)),
    packagingMode: 'compiled-linux-x64',
  }
}

/**
 * Cross-compile duet for the official x86_64 images from an Apple-Silicon Mac.
 *
 * Bun resolves optional native packages for the install host by default. A
 * target-platform install in an isolated source tree is therefore required
 * before `--target=bun-linux-x64`; compiling against the Mac's node_modules
 * cannot resolve OpenTUI's Linux package.
 */
export async function prepareDuetArtifact(
  options: PrepareDuetArtifactOptions,
): Promise<DuetArtifact> {
  const commands = options.commands ?? new LocalCommandRunner()
  const outputDir = resolve(options.outputDir)
  const buildRoot = join(
    tmpdir(),
    'duet-runtime-build',
    createHash('sha256').update(outputDir).digest('hex').slice(0, 24),
  )
  await rm(buildRoot, { recursive: true, force: true })
  await mkdir(buildRoot, { recursive: true })
  const localPath = join(outputDir, 'duet-linux-x64')

  try {
    await Promise.all([
      cp(join(options.repoRoot, 'package.json'), join(buildRoot, 'package.json')),
      cp(join(options.repoRoot, 'bun.lock'), join(buildRoot, 'bun.lock')),
      cp(join(options.repoRoot, 'patches'), join(buildRoot, 'patches'), { recursive: true }),
      ...(await runtimeWorkspaceClosure(options.repoRoot)).map(path =>
        cp(join(options.repoRoot, path), join(buildRoot, path), {
          recursive: true,
          verbatimSymlinks: true,
          filter: path =>
            resolve(path) !== outputDir &&
            !['node_modules', 'dist', '.cache', '.venv', 'runs', '.git'].includes(
              path.split('/').at(-1)!,
            ) &&
            !path.split('/').at(-1)!.startsWith('.env'),
        }),
      ),
    ])
    // The frozen root lockfile names all workspaces, including those outside the CLI closure.
    for (const group of ['packages', 'apps']) {
      const entries = await readdir(join(options.repoRoot, group), { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        },
      )
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const destination = join(buildRoot, group, entry.name)
        await mkdir(destination, { recursive: true })
        await cp(
          join(options.repoRoot, group, entry.name, 'package.json'),
          join(destination, 'package.json'),
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    }
    await mkdir(outputDir, { recursive: true })

    await requireSuccess(
      commands,
      [
        'bun',
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--os',
        'linux',
        '--cpu',
        'x64',
        '--filter',
        '@repo/agent',
        '--filter',
        '@duetso/agent',
      ],
      buildRoot,
    )
    await requireSuccess(
      commands,
      [
        'bun',
        'build',
        'packages/duet/src/cli-entry.ts',
        '--compile',
        '--target=bun-linux-x64',
        '--outfile',
        localPath,
      ],
      buildRoot,
    )
    const requireAgent = createRequire(join(buildRoot, 'packages', 'agent', 'package.json'))
    const pgliteDir = dirname(requireAgent.resolve('@electric-sql/pglite'))
    const requirePi = createRequire(
      Bun.resolveSync('@earendil-works/pi-coding-agent', join(buildRoot, 'packages', 'agent')),
    )
    const photonDir = dirname(requirePi.resolve('@silvia-odwyer/photon-node'))
    await Promise.all(
      PGLITE_RUNTIME_ASSET_NAMES.map(name =>
        copyFile(join(pgliteDir, name), join(outputDir, name)),
      ),
    )

    await copyFile(join(photonDir, 'photon_rs_bg.wasm'), join(outputDir, 'photon_rs_bg.wasm'))

    return {
      localPath,
      installPath: '/opt/duet/duet',
      sha256: await sha256File(localPath),
      runtimeAssets: await loadRuntimeAssets(outputDir),
      packagingMode: 'compiled-linux-x64',
    }
  } finally {
    await rm(buildRoot, { recursive: true, force: true })
  }
}

async function loadRuntimeAssets(directory: string): Promise<DuetArtifact['runtimeAssets']> {
  return Promise.all(
    DUET_RUNTIME_ASSET_NAMES.map(async name => {
      const localPath = join(directory, name)
      return {
        name,
        localPath,
        installPath: `/opt/duet/${name}`,
        sha256: await sha256File(localPath),
      }
    }),
  )
}

async function requireSuccess(
  commands: CommandRunner,
  argv: readonly string[],
  cwd: string,
): Promise<void> {
  const result = await commands.run(argv, { cwd })
  if (result.exitCode === 0) return
  throw new Error(
    `Packaging command failed (${result.exitCode}): ${argv.join(' ')}\n${result.stderr || result.stdout}`,
  )
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Copy source for every owned runtime dependency, not just its lockfile manifest. */
async function runtimeWorkspaceClosure(repoRoot: string): Promise<string[]> {
  const workspaces = new Map<string, { path: string; dependencies: Record<string, string> }>()
  for (const group of ['packages', 'apps']) {
    for (const entry of await readdir(join(repoRoot, group), { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    )) {
      if (!entry.isDirectory()) continue
      const path = join(group, entry.name)
      const manifestBytes = await readFile(join(repoRoot, path, 'package.json'), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        },
      )
      if (manifestBytes === undefined) continue
      const manifest = JSON.parse(manifestBytes) as {
        name: string
        dependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
      }
      workspaces.set(manifest.name, {
        path,
        dependencies: { ...manifest.dependencies, ...manifest.optionalDependencies },
      })
    }
  }
  const selected = new Set<string>()
  const queue = ['@repo/agent', '@duetso/agent']
  while (queue.length) {
    const name = queue.shift()!
    if (selected.has(name)) continue
    const workspace = workspaces.get(name)
    if (!workspace) throw new Error(`Runtime workspace missing: ${name}`)
    selected.add(name)
    for (const [dependency, version] of Object.entries(workspace.dependencies)) {
      if (workspaces.has(dependency) && (version === '*' || version.startsWith('workspace:')))
        queue.push(dependency)
    }
  }
  return [...selected].map(name => workspaces.get(name)!.path).sort()
}
