import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function buildVercelOutput(
  outputDirectory = path.resolve(import.meta.dir, '../.vercel/output'),
): Promise<void> {
  const functionsDirectory = path.join(outputDirectory, 'functions')
  const functionDirectory = path.join(functionsDirectory, 'api.func')
  await rm(functionsDirectory, { recursive: true, force: true })
  await mkdir(functionDirectory, { recursive: true })

  const build = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, '../src/vercel-entry.ts')],
    outdir: functionDirectory,
    target: 'node',
    format: 'esm',
  })
  if (!build.success) {
    throw new AggregateError(build.logs, 'Failed to bundle the edge Vercel function')
  }

  await Promise.all([
    writeJson(path.join(functionDirectory, '.vc-config.json'), {
      runtime: 'nodejs24.x',
      handler: 'vercel-entry.js',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      supportsCancellation: true,
    }),
    writeJson(path.join(functionDirectory, 'package.json'), { type: 'module' }),
    writeJson(path.join(outputDirectory, 'config.json'), {
      version: 3,
      routes: [{ src: '^/(.*)$', dest: '/api' }],
    }),
  ])
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`)
}

if (import.meta.main) await buildVercelOutput()
