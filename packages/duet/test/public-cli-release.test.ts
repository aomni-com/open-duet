import { expect } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { testIfDocker } from '../../agent/test/helpers/docker-only.js'

const revision = '0123456789abcdef0123456789abcdef01234567'

async function fixture(
  options: {
    existing?: boolean
    status?: number
    privateDependency?: boolean
    largeEntry?: boolean
    missingRevision?: boolean
    malformedDeployment?: boolean
    deploymentStatus?: number
    pendingDeployment?: boolean
    corruptIntegrity?: boolean
    stalePackumentReads?: number
    deployment?: {
      revision: string
      backend: { revision: string; schema: number }
      gateway: { version: string }
    }
  } = {},
) {
  if (!Bun.which('npm'))
    throw new Error('Public release tests require actual Node24/npm11 alongside Bun1.3.14')
  const root = await mkdtemp(join(tmpdir(), 'duet-release-'))
  const requests: string[] = []
  let metadata: Record<string, unknown> | undefined
  let tarball: Buffer | undefined
  let deploymentReads = 0
  let stalePackumentReads = 0
  const publicationCheckpoints: (Record<string, unknown> | undefined)[] = []
  const oldPackument = {
    _id: '@duetso/agent',
    name: '@duetso/agent',
    'dist-tags': { latest: '0.9.0' },
    versions: { '0.9.0': { name: '@duetso/agent', version: '0.9.0' } },
  }
  const registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push(request.method)
      const url = new URL(request.url)
      if (url.pathname === '/deployment') {
        deploymentReads++
        if (options.malformedDeployment)
          return Response.json({ revision: 'not a release identity' })
        if (options.deploymentStatus)
          return Response.json(
            { error: 'Deployment unavailable' },
            { status: options.deploymentStatus },
          )
        return Response.json(
          options.pendingDeployment && deploymentReads === 1
            ? {
                revision: 'a'.repeat(40),
                backend: { revision: 'a'.repeat(40), schema: 1 },
                gateway: { version: 'fixture' },
              }
            : (options.deployment ?? {
                revision,
                backend: { revision, schema: 1 },
                gateway: { version: 'fixture' },
              }),
        )
      }
      if (request.method === 'PUT') {
        if (options.pendingDeployment && deploymentReads < 2)
          return Response.json({ error: 'Deployment not ready' }, { status: 503 })
        metadata = (await request.json()) as Record<string, unknown>
        const attachments = metadata!._attachments as Record<string, { data: string }>
        tarball = Buffer.from(Object.values(attachments)[0]!.data, 'base64')
        return Response.json({ ok: true })
      }
      if (url.pathname === '/tarball.tgz' && tarball)
        return new Response(new Uint8Array(tarball).buffer)
      if (metadata) {
        if (stalePackumentReads++ < (options.stalePackumentReads ?? 0)) {
          try {
            publicationCheckpoints.push(JSON.parse(await readFile(receiptPath, 'utf8')))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            publicationCheckpoints.push(undefined)
          }
          return Response.json(oldPackument)
        }
        const versions = metadata.versions as Record<string, { dist: { tarball: string } }>
        versions['1.0.0']!.dist.tarball = new URL('/tarball.tgz', registry.url).href
        if (options.corruptIntegrity)
          Object.assign(versions['1.0.0']!.dist, { integrity: 'sha512-invalid' })
        return Response.json(metadata)
      }
      if (options.existing)
        return Response.json({
          name: '@duetso/agent',
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { name: '@duetso/agent', version: '1.0.0' } },
        })
      if (options.stalePackumentReads) return Response.json(oldPackument)
      return Response.json({ error: 'Registry fixture failure' }, { status: options.status ?? 404 })
    },
  })
  const packageDir = join(root, 'package')
  await mkdir(join(packageDir, 'dist'), { recursive: true })
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@duetso/agent',
      version: '1.0.0',
      type: 'module',
      bin: { duet: 'dist/cli-entry.js' },
      files: ['dist', 'LICENSE'],
      ...(options.privateDependency ? { dependencies: { '@repo/agent': 'workspace:*' } } : {}),
      repository: { type: 'git', url: 'https://github.com/aomni-com/duet.git' },
    }),
  )
  await writeFile(
    join(packageDir, 'dist/cli-entry.js'),
    '#!/usr/bin/env bun\nconsole.log("1.0.0")\n' +
      (options.largeEntry ? '// ' + 'x'.repeat(5 * 1024 * 1024) : ''),
  )
  await writeFile(join(packageDir, 'LICENSE'), 'Fixture license\n')
  const config = join(root, 'npmrc')
  await writeFile(
    config,
    `registry=${registry.url}\nfetch-retries=0\n//${registry.url.host}/:_authToken=fixture\n`,
  )
  const receiptPath = join(root, 'receipt.json')
  return {
    requests,
    publicationCheckpoints,
    async run(...args: string[]) {
      const proc = Bun.spawn(
        [
          'bun',
          resolve(import.meta.dir, '../scripts/release-public-cli.ts'),
          packageDir,
          '--receipt',
          receiptPath,
          ...args,
        ],
        {
          env: {
            PATH: process.env.PATH!,
            HOME: root,
            GITHUB_SHA: options.missingRevision ? undefined : revision,
            DUET_RELEASE_READINESS_URL: new URL('/deployment', registry.url).href,
            DUET_RELEASE_WAIT_MS: options.pendingDeployment ? '2500' : '500',
            DUET_RELEASE_POLL_MS: '10',
            NPM_CONFIG_USERCONFIG: config,
            NPM_CONFIG_CACHE: join(root, 'cache'),
          },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      let receipt:
        | {
            status: string
            package: string
            artifact: { integrity: string }
            registryInstallVerified: boolean
            deployment: { revision: string; backend: { revision: string } }
          }
        | undefined
      try {
        receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return { code, output: stdout + stderr, receipt }
    },
    async close() {
      registry.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}

testIfDocker(
  'the default release validates the packed artifact without publishing',
  async () => {
    const registry = await fixture()
    try {
      const result = await registry.run()
      expect(result.code, result.output).toBe(0)
      expect(result.receipt?.status).toBe('validated')
      expect(result.receipt?.package).toBe('@duetso/agent@1.0.0')
      expect(result.receipt?.artifact.integrity).toStartWith('sha512-')
      expect(registry.requests).toContain('GET')
      expect(registry.requests.every(method => method === 'GET' || method === 'HEAD')).toBe(true)
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'an existing immutable version is skipped without a write',
  async () => {
    const registry = await fixture({ existing: true })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).toBe(0)
      expect(result.receipt?.status).toBe('existing')
      expect(result.receipt?.package).toBe('@duetso/agent@1.0.0')
      expect(registry.requests.every(method => method === 'GET' || method === 'HEAD')).toBe(true)
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker.each([401, 503])(
  'registry failure %i fails without publishing or a success receipt',
  async status => {
    const registry = await fixture({ status })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).not.toBe(0)
      expect(result.receipt).toBeUndefined()
      expect(registry.requests).not.toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'the complete bundled entry is validated without truncation',
  async () => {
    const registry = await fixture({ largeEntry: true })
    try {
      const result = await registry.run()
      expect(result.code, result.output).toBe(0)
      expect(result.receipt?.status).toBe('validated')
      expect(registry.requests).not.toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'private workspace dependencies fail before publication',
  async () => {
    const registry = await fixture({ privateDependency: true })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).not.toBe(0)
      expect(result.output).toContain('Private workspace dependency in public tarball')
      expect(result.receipt).toBeUndefined()
      expect(registry.requests).not.toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'explicit publication verifies registry bytes and a fresh external install',
  async () => {
    const registry = await fixture()
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).toBe(0)
      expect(result.receipt?.status).toBe('published')
      expect(result.receipt?.package).toBe('@duetso/agent@1.0.0')
      expect(result.receipt?.registryInstallVerified).toBe(true)
      expect(registry.requests).toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'publication retains its checkpoint while an old packument hides the new version',
  async () => {
    const registry = await fixture({ stalePackumentReads: 2 })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).toBe(0)
      expect(result.receipt?.registryInstallVerified).toBe(true)
      expect(registry.publicationCheckpoints).toEqual([
        expect.objectContaining({
          status: 'published',
          package: '@duetso/agent@1.0.0',
          revision,
          artifact: expect.objectContaining({ integrity: result.receipt?.artifact.integrity }),
          deployment: { revision, backend: { revision, schema: 1 } },
          registryInstallVerified: false,
        }),
        expect.objectContaining({ registryInstallVerified: false }),
      ])
      expect(registry.requests).toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'different registry bytes retain publication evidence without claiming verification',
  async () => {
    const registry = await fixture({ corruptIntegrity: true })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).not.toBe(0)
      expect(result.output).toContain('Published registry bytes differ from the validated tarball')
      expect(result.receipt).toMatchObject({
        status: 'published',
        package: '@duetso/agent@1.0.0',
        registryInstallVerified: false,
        deployment: { revision, backend: { revision } },
      })
      expect(result.receipt?.artifact.integrity).toStartWith('sha512-')
      expect(result.receipt?.artifact.integrity).not.toBe('sha512-invalid')
      expect(registry.requests).toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'a failed retry removes the prior success receipt and a recovered registry validates again',
  async () => {
    const options: { status?: number } = {}
    const registry = await fixture(options)
    try {
      const first = await registry.run()
      expect(first.code, first.output).toBe(0)
      expect(first.receipt?.status).toBe('validated')
      options.status = 503
      const failure = await registry.run()
      expect(failure.code, failure.output).not.toBe(0)
      expect(failure.receipt).toBeUndefined()
      delete options.status
      const recovered = await registry.run()
      expect(recovered.code, recovered.output).toBe(0)
      expect(recovered.receipt?.status).toBe('validated')
      expect(registry.requests).not.toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'a stale API revision times out before npm receives a write',
  async () => {
    const registry = await fixture({
      deployment: {
        revision: 'a'.repeat(40),
        backend: { revision, schema: 1 },
        gateway: { version: 'fixture' },
      },
    })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).not.toBe(0)
      expect(result.output).toContain('Production API/backend did not reach release revision')
      expect(result.receipt).toBeUndefined()
      expect(registry.requests).not.toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'a matching API with stale backend cannot publish',
  async () => {
    const registry = await fixture({
      deployment: {
        revision,
        backend: { revision: 'a'.repeat(40), schema: 1 },
        gateway: { version: 'fixture' },
      },
    })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).not.toBe(0)
      expect(result.output).toContain('Production API/backend did not reach release revision')
      expect(result.receipt).toBeUndefined()
      expect(registry.requests).not.toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'a pending deployment can become ready before the new version is published',
  async () => {
    const registry = await fixture({ pendingDeployment: true })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).toBe(0)
      expect(result.receipt?.status).toBe('published')
      expect(result.receipt?.deployment.revision).toBe(revision)
      expect(result.receipt?.deployment.backend.revision).toBe(revision)
      expect(registry.requests).toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'failed deployment HTTP responses cannot permit publication',
  async () => {
    const registry = await fixture({ deploymentStatus: 503 })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).not.toBe(0)
      expect(result.output).toContain('readiness HTTP 503')
      expect(result.receipt).toBeUndefined()
      expect(registry.requests).not.toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'malformed deployment identity cannot permit publication',
  async () => {
    const registry = await fixture({ malformedDeployment: true })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).not.toBe(0)
      expect(result.output).toContain('readiness malformed deployment')
      expect(result.receipt).toBeUndefined()
      expect(registry.requests).not.toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)

testIfDocker(
  'actual publication requires an explicit full Git revision',
  async () => {
    const registry = await fixture({ missingRevision: true })
    try {
      const result = await registry.run('--publish')
      expect(result.code, result.output).not.toBe(0)
      expect(result.output).toContain(
        'Actual publication requires GITHUB_SHA with a full lowercase revision',
      )
      expect(result.receipt).toBeUndefined()
      expect(registry.requests).not.toContain('PUT')
    } finally {
      await registry.close()
    }
  },
  45_000,
)
