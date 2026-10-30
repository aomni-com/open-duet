import { afterEach, describe, expect } from 'bun:test'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { CommandRunner } from '../src/container.js'
import { loadPrebuiltDuetArtifact, prepareDuetArtifact } from '../src/packaging.js'
import { testIfDocker } from './helpers/docker-only.js'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('SWE-bench Duet packaging', () => {
  testIfDocker('carries declared dependency patches into the isolated Linux build', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-swebench-package-'))
    const repoRoot = join(root, 'repo')
    const outputDir = join(repoRoot, 'packages/agent/benchmarks/swebench/runtime/build')
    const patchName = '@earendil-works%2Fpi-ai@0.79.10.patch'
    await mkdir(repoRoot)
    await Promise.all([
      writeFile(
        join(repoRoot, 'package.json'),
        `${JSON.stringify({
          workspaces: ['packages/*'],
          patchedDependencies: {
            '@earendil-works/pi-ai@0.79.10': `patches/${patchName}`,
          },
        })}\n`,
      ),
      writeFile(join(repoRoot, 'bun.lock'), ''),
      writeFile(join(repoRoot, 'tsconfig.json'), '{}\n'),
      mkdir(join(repoRoot, 'packages', 'agent', 'src'), { recursive: true }),
      mkdir(join(repoRoot, 'packages', 'duet', 'src'), { recursive: true }),
      mkdir(join(repoRoot, 'patches'), { recursive: true }),
      mkdir(join(repoRoot, 'packages', 'retired', 'node_modules'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(repoRoot, 'packages', 'duet', 'src', 'cli-entry.ts'), ''),
      writeFile(
        join(repoRoot, 'packages', 'agent', 'package.json'),
        JSON.stringify({ name: '@repo/agent' }),
      ),
      writeFile(
        join(repoRoot, 'packages', 'duet', 'package.json'),
        JSON.stringify({
          name: '@duetso/agent',
          dependencies: {
            '@repo/importers': 'workspace:*',
            '@repo/sync-tunnel': 'workspace:*',
          },
        }),
      ),
      writeFile(join(repoRoot, 'patches', patchName), 'dependency patch'),
    ])

    for (const name of ['contract', 'importers', 'sync-tunnel']) {
      await mkdir(join(repoRoot, 'packages', name, 'src'), { recursive: true })
      await writeFile(
        join(repoRoot, 'packages', name, 'package.json'),
        JSON.stringify({
          name: `@repo/${name}`,
          ...(name === 'importers' ? { dependencies: { '@repo/contract': 'workspace:*' } } : {}),
        }),
      )
      await writeFile(
        join(repoRoot, 'packages', name, 'src', 'index.ts'),
        `export const owner = '${name}'`,
      )
    }

    const commands: CommandRunner = {
      async run(argv, options) {
        const cwd = options?.cwd
        if (!cwd) throw new Error('Packaging command must have a working directory.')
        if (argv[1] === 'install') {
          try {
            await access(join(cwd, 'patches', patchName))
          } catch {
            return { stdout: '', stderr: 'declared patch is missing', exitCode: 1 }
          }
          await access(join(cwd, 'packages', 'duet', 'src', 'cli-entry.ts'))
          for (const name of ['contract', 'importers', 'sync-tunnel']) {
            await access(join(cwd, 'packages', name, 'src', 'index.ts'))
          }
          const piDir = join(cwd, 'node_modules', '@earendil-works', 'pi-coding-agent')
          await mkdir(piDir, { recursive: true })
          await writeFile(
            join(piDir, 'package.json'),
            JSON.stringify({ name: '@earendil-works/pi-coding-agent', main: 'index.js' }),
          )
          await writeFile(join(piDir, 'index.js'), '')
          const photonDir = join(cwd, 'node_modules', '@silvia-odwyer', 'photon-node')
          await mkdir(photonDir, { recursive: true })
          await writeFile(
            join(photonDir, 'package.json'),
            JSON.stringify({ name: '@silvia-odwyer/photon-node', main: 'photon_rs.js' }),
          )
          await writeFile(join(photonDir, 'photon_rs_bg.wasm'), 'photon-bundle')
          await writeFile(join(photonDir, 'photon_rs.js'), '')
          const pgliteDir = join(cwd, 'node_modules', '@electric-sql', 'pglite', 'dist')
          await mkdir(pgliteDir, { recursive: true })
          await writeFile(join(pgliteDir, 'index.js'), '')
          await writeFile(
            join(pgliteDir, '..', 'package.json'),
            JSON.stringify({ name: '@electric-sql/pglite', main: 'dist/index.js' }),
          )
          await Promise.all(
            ['pglite.data', 'pglite.wasm', 'initdb.wasm', 'vector.tar.gz'].map(name =>
              writeFile(join(pgliteDir, name), name),
            ),
          )
        } else if (argv[1] === 'build') {
          const outputIndex = argv.indexOf('--outfile')
          const output = argv[outputIndex + 1]
          if (!output) throw new Error('Packaging build must declare its output.')
          await writeFile(output, 'compiled duet')
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
      stream() {
        throw new Error('Packaging does not stream commands.')
      },
    }

    const artifact = await prepareDuetArtifact({ repoRoot, outputDir, commands })
    expect(artifact.localPath).toBe(join(outputDir, 'duet-linux-x64'))
    expect(artifact.runtimeAssets.map(asset => asset.name)).toEqual([
      'pglite.data',
      'pglite.wasm',
      'initdb.wasm',
      'vector.tar.gz',
      'photon_rs_bg.wasm',
    ])
  })

  testIfDocker('loads the exact prebuilt worker artifact without rebuilding it', async () => {
    root = await mkdtemp(join(tmpdir(), 'duet-swebench-package-'))
    const path = join(root, 'duet-linux-x64')
    await Promise.all([
      writeFile(path, 'prebuilt-duet'),
      writeFile(join(root, 'pglite.data'), 'pglite-data'),
      writeFile(join(root, 'pglite.wasm'), 'pglite-wasm'),
      writeFile(join(root, 'initdb.wasm'), 'initdb-wasm'),
      writeFile(join(root, 'vector.tar.gz'), 'vector-bundle'),
      writeFile(join(root, 'photon_rs_bg.wasm'), 'photon-bundle'),
    ])

    const artifact = await loadPrebuiltDuetArtifact(path)
    expect(artifact).toMatchObject({
      localPath: resolve(path),
      installPath: '/opt/duet/duet',
      sha256: '5b1407ebee7b098f71f5ad498f4b33f23affd72ea55a83bcbf14870f63f59936',
      packagingMode: 'compiled-linux-x64',
    })
    expect(artifact.runtimeAssets.find(asset => asset.name === 'photon_rs_bg.wasm')).toMatchObject({
      installPath: '/opt/duet/photon_rs_bg.wasm',
    })
    expect(artifact.runtimeAssets.filter(asset => asset.name !== 'photon_rs_bg.wasm')).toEqual([
      {
        name: 'pglite.data',
        localPath: resolve(root, 'pglite.data'),
        installPath: '/opt/duet/pglite.data',
        sha256: '1e080a964119f869f42c0c02ac868913f482a887724afa0c821b1a02da1c8447',
      },
      {
        name: 'pglite.wasm',
        localPath: resolve(root, 'pglite.wasm'),
        installPath: '/opt/duet/pglite.wasm',
        sha256: 'a6ca6c3ae6c10f6eb0b1e6d511c7f7ce906d93d53535b53d2e0b245ba8870399',
      },
      {
        name: 'initdb.wasm',
        localPath: resolve(root, 'initdb.wasm'),
        installPath: '/opt/duet/initdb.wasm',
        sha256: 'ed4af33b09e17be37145d476f812121d5e225393f54970d01aa6d26fb539b877',
      },
      {
        name: 'vector.tar.gz',
        localPath: resolve(root, 'vector.tar.gz'),
        installPath: '/opt/duet/vector.tar.gz',
        sha256: 'e9b62d5569b52f792a3ef57c5be23ee638036791344acecafe27b069744f06ea',
      },
    ])
  })
})
