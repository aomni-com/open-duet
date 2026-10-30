import { expect, test } from 'bun:test'
import { chmod, cp, mkdtemp, readFile, rm, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createApprovedModelCatalog } from '@repo/contract'
import { renderDefaultSkills } from '@repo/skills-registry'

import { writeRuntimeReleaseFixture } from './runtime/release.fixture'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const FUNCTION_APPS = ['api', 'mcp', 'model-gateway'] as const

// The live bug this pins: a function app whose buildCommand omits VC_MAX_DURATION
// deploys at the platform default duration, which decapitates long-lived SSE
// responses (agent events today, the file-events feed next). Every Hono function
// app must declare it, they must agree, and the value must reach the deployed
// .vc-config.json emitted by scripts/vercel-bundle.mjs.

async function declaredMaxDuration(app: (typeof FUNCTION_APPS)[number]): Promise<string> {
  const config = JSON.parse(
    await readFile(join(REPO_ROOT, 'apps', app, 'vercel.json'), 'utf8'),
  ) as { buildCommand?: string }
  const match = config.buildCommand?.match(/\bVC_MAX_DURATION=(?<seconds>\d+)\b/)
  expect(match?.groups?.seconds, `apps/${app} buildCommand must set VC_MAX_DURATION`).toBeDefined()
  return match!.groups!.seconds!
}

test('every function app pins the same VC_MAX_DURATION in its build command', async () => {
  const durations = await Promise.all(FUNCTION_APPS.map(app => declaredMaxDuration(app)))
  expect(new Set(durations).size).toBe(1)
})

test('the emitted .vc-config.json carries the declared maxDuration', async () => {
  const declared = Number(await declaredMaxDuration('api'))
  const scratch = await mkdtemp(join(tmpdir(), 'vercel-bundle-config-'))
  try {
    await mkdir(join(scratch, 'src'), { recursive: true })
    await writeFile(
      join(scratch, 'src/index.ts'),
      'export default { fetch: () => new Response("ok") }\n',
    )
    const bundle = Bun.spawn(['node', join(REPO_ROOT, 'scripts/vercel-bundle.mjs')], {
      cwd: scratch,
      env: { ...process.env, VC_MAX_DURATION: String(declared) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(bundle.stdout).text(),
      new Response(bundle.stderr).text(),
      bundle.exited,
    ])
    if (exitCode !== 0) throw new Error(`vercel-bundle failed\n${stdout}\n${stderr}`)

    const vcConfig = JSON.parse(
      await readFile(join(scratch, '.vercel/output/functions/index.func/.vc-config.json'), 'utf8'),
    ) as { maxDuration?: unknown; supportsResponseStreaming?: unknown }
    expect(vcConfig.maxDuration).toBe(declared)
    expect(vcConfig.supportsResponseStreaming).toBe(true)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('the emitted function embeds generated skills without a runtime copy directory', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'vercel-skills-embed-'))
  try {
    await mkdir(join(scratch, 'src'), { recursive: true })
    const registryEntry = join(REPO_ROOT, 'packages/skills-registry/src/index.ts')
    const contractEntry = join(REPO_ROOT, 'packages/contract/src/index.ts')
    await writeFile(
      join(scratch, 'src/index.ts'),
      [
        `import { renderDefaultSkills } from ${JSON.stringify(registryEntry)}`,
        `import { createApprovedModelCatalog } from ${JSON.stringify(contractEntry)}`,
        "const model = { id: 'fixture:chat', gatewayModelId: 'fixture/chat', kind: 'chat', name: 'Fixture', simpleName: 'fixture', description: 'Synthetic model', internal: true }",
        'const catalog = createApprovedModelCatalog([model])',
        "export default { fetch: () => Response.json(renderDefaultSkills({ appUrl: 'https://app.test/w/fixture', catalog })) }",
        '',
      ].join('\n'),
    )
    const bundle = Bun.spawn(['node', join(REPO_ROOT, 'scripts/vercel-bundle.mjs')], {
      cwd: scratch,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(bundle.stdout).text(),
      new Response(bundle.stderr).text(),
      bundle.exited,
    ])
    if (exitCode !== 0) throw new Error(`vercel-bundle failed\n${stdout}\n${stderr}`)

    const functionDir = join(scratch, '.vercel/output/functions/index.func')
    const runtime = Bun.spawnSync({
      cmd: [
        'node',
        '--input-type=module',
        '-e',
        `const { default: app } = await import(${JSON.stringify(pathToFileURL(join(functionDir, 'index.mjs')).href)}); console.log(JSON.stringify(await (await app.fetch()).json()));`,
      ],
      cwd: scratch,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(runtime.exitCode, runtime.stderr.toString()).toBe(0)
    const vcConfig = JSON.parse(await readFile(join(functionDir, '.vc-config.json'), 'utf8')) as {
      environment?: Record<string, string>
    }
    const catalog = createApprovedModelCatalog([
      {
        id: 'fixture:chat',
        gatewayModelId: 'fixture/chat',
        kind: 'chat',
        name: 'Fixture',
        simpleName: 'fixture',
        description: 'Synthetic model',
        internal: true,
      },
    ])
    expect(JSON.parse(runtime.stdout.toString())).toEqual(
      renderDefaultSkills({ appUrl: 'https://app.test/w/fixture', catalog }),
    )
    expect(vcConfig.environment?.DUET_SKILLS_BUNDLE_DIR).toBeUndefined()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('the API function preserves the exact constructed runtime inventory and executable mode', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'vercel-runtime-'))
  try {
    await mkdir(join(scratch, 'src'), { recursive: true })
    await writeFile(
      join(scratch, 'src/index.ts'),
      'export default { fetch: () => new Response("ok") }\n',
    )
    await writeFile(join(scratch, 'package.json'), JSON.stringify({ name: 'api' }))
    const release = join(scratch, 'dist/runtime-release')
    await mkdir(release, { recursive: true })
    const manifest = await writeRuntimeReleaseFixture(release)
    async function build() {
      const child = Bun.spawn(['node', join(REPO_ROOT, 'scripts/vercel-bundle.mjs')], {
        cwd: scratch,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    }
    const result = await build()
    expect(result.code, result.stderr).toBe(0)
    const output = join(scratch, '.vercel/output/functions/index.func')
    const config = JSON.parse(await readFile(join(output, '.vc-config.json'), 'utf8'))
    expect(config.environment).toEqual({ DUET_RUNTIME_RELEASE_DIR: 'runtime-release' })
    const { readdir, stat } = await import('node:fs/promises')
    expect((await readdir(join(output, 'runtime-release'))).sort()).toEqual(
      [...manifest.artifacts.map(a => a.name), 'manifest.json'].sort(),
    )
    for (const artifact of manifest.artifacts) {
      expect(await readFile(join(output, 'runtime-release', artifact.name))).toEqual(
        await readFile(join(release, artifact.name)),
      )
      expect((await stat(join(output, 'runtime-release', artifact.name))).mode & 0o777).toBe(
        artifact.mode,
      )
    }
    await chmod(join(release, 'duet'), 0o644)
    const wrongMode = await build()
    expect(wrongMode.code).not.toBe(0)
    expect(wrongMode.stderr).toContain('Runtime artifact mode does not match manifest: duet')
    await writeRuntimeReleaseFixture(release)
    await rm(join(release, 'photon_rs_bg.wasm'))
    expect((await build()).code).not.toBe(0)
    await writeRuntimeReleaseFixture(release)
    await mkdir(join(release, '.build-input'))
    expect((await build()).code).not.toBe(0)
    await rm(release, { recursive: true })
    expect((await build()).code).not.toBe(0)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('a relocated cold Vercel function serves its inventory from an executable-normalized mount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duet-vercel-bundle-'))
  try {
    const app = join(directory, 'build-app')
    const inventory = join(app, 'dist/runtime-release')
    await mkdir(inventory, { recursive: true })
    await symlink(join(REPO_ROOT, 'apps/api/src'), join(app, 'src'))
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'api', type: 'module' }))
    const manifest = await writeRuntimeReleaseFixture(inventory)
    const duetBytes = await readFile(join(inventory, 'duet'))
    const helperBytes = await readFile(join(inventory, 'helper.js'))
    const build = Bun.spawnSync({
      cmd: ['node', join(REPO_ROOT, 'scripts/vercel-bundle.mjs')],
      cwd: app,
      env: { ...process.env, DUET_RUNTIME_RELEASE_DIR: undefined },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(build.exitCode, build.stderr.toString()).toBe(0)

    const deployed = join(directory, 'deployed-function')
    await cp(join(app, '.vercel/output/functions/index.func'), deployed, { recursive: true })
    // Observed Vercel mount: intended data modes remain in the manifest, while
    // all mounted files have 0755 permissions. Hosting never executes these bytes.
    for (const artifact of manifest.artifacts) {
      await chmod(join(deployed, 'runtime-release', artifact.name), 0o755)
    }
    const config = JSON.parse(await readFile(join(deployed, '.vc-config.json'), 'utf8'))
    await rm(app, { recursive: true, force: true })
    const cwd = join(directory, 'unrelated')
    await mkdir(cwd)
    const revision = '1'.repeat(40)
    function coldProbe() {
      const probe = Bun.spawnSync({
        cmd: [
          'node',
          '--input-type=module',
          '-e',
          `
      globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        if (String(url) !== 'https://packaging-fixture.convex.cloud/api/query')
          throw new Error('Unexpected network request');
        const value = body.path === 'deployment:identity'
          ? { revision: ${JSON.stringify(revision)}, schema: 1 }
          : body.path === 'domains/workspaces/provisioning:gatewayConnectionByVmToken'
            ? { workspaceId: 'packaging-workspace', vmName: 'packaging-vm' }
            : undefined;
        if (value === undefined) throw new Error('Unexpected backend query');
        return Response.json({ status: 'success', value });
      };
      const { default: app } = await import(${JSON.stringify(pathToFileURL(join(deployed, config.handler)).href)});
      const response = await app.fetch(new Request('https://api.test/deployment'));
      const inventory = await app.fetch(new Request('https://api.test/v1/vm/runtime-release/manifest', {
        headers: { authorization: 'Bearer duet_vm_packaging-fixture' },
      }));
      const artifact = await app.fetch(new Request('https://api.test/v1/vm/runtime-release/artifacts/duet', {
        headers: { authorization: 'Bearer duet_vm_packaging-fixture' },
      }));
      const helper = await app.fetch(new Request('https://api.test/v1/vm/runtime-release/artifacts/helper.js', {
        headers: { authorization: 'Bearer duet_vm_packaging-fixture' },
      }));
      console.log(JSON.stringify({
        status: response.status, body: await response.json(),
        inventory: { status: inventory.status, body: await inventory.json() },
        artifact: { status: artifact.status, bytes: Buffer.from(await artifact.arrayBuffer()).toString('base64') },
        helper: { status: helper.status, bytes: Buffer.from(await helper.arrayBuffer()).toString('base64') },
      }));
      `,
        ],
        cwd,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          CONVEX_DEPLOYMENT: 'packaging-fixture',
          DUET_API_INTERNAL_KEY: 'packaging-fixture-internal',
          VERCEL_GIT_COMMIT_SHA: revision,
          ...config.environment,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(probe.exitCode, probe.stderr.toString()).toBe(0)
      return JSON.parse(probe.stdout.toString())
    }
    expect(coldProbe()).toEqual({
      status: 200,
      body: { revision, backend: { revision, schema: 1 }, runtime: { version: manifest.version } },
      inventory: { status: 200, body: manifest },
      artifact: { status: 200, bytes: duetBytes.toString('base64') },
      helper: { status: 200, bytes: helperBytes.toString('base64') },
    })
    for (const defect of ['tampered', 'missing', 'length'] as const) {
      const release = join(deployed, 'runtime-release')
      await writeRuntimeReleaseFixture(release)
      for (const artifact of manifest.artifacts) await chmod(join(release, artifact.name), 0o755)
      const helperPath = join(release, 'helper.js')
      if (defect === 'missing') await rm(helperPath)
      else {
        await writeFile(
          helperPath,
          defect === 'tampered'
            ? Buffer.alloc(helperBytes.length, 'x')
            : Buffer.concat([helperBytes, Buffer.from('x')]),
        )
      }
      expect(coldProbe(), defect).toMatchObject({
        status: 200,
        body: { runtime: { version: null } },
        inventory: { status: 503 },
        artifact: { status: 503 },
        helper: { status: 503 },
      })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
