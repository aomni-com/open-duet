import { spawn } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { stageBrowserExtension } from './browser-extension-identity'
import { run, recordDigestRef } from './image-utils'
import { stageRuntime } from './stage-runtime'
import { verifyImage } from './verify-image'

const imageRef = process.env.IMAGE_REF
if (!imageRef) {
  throw new Error('IMAGE_REF is required, for example IMAGE_REF=ttl.sh/duet-gateway-<unique>:1h')
}
const localOnly = imageRef === 'duet-vm-image:local'

const repoRoot = join(import.meta.dir, '../../..')
const contextDir = await mkdtemp(join(tmpdir(), 'duet-vm-image-'))

try {
  const suppliedRelease = process.env.DUET_RUNTIME_RELEASE_DIR
  if (!suppliedRelease) {
    await run('bun', ['run', '--cwd', join(repoRoot, 'packages/gateway'), 'build'])
    await run('bun', [join(repoRoot, 'apps/api/scripts/build-runtime-release.mjs')])
  }
  const bootstrapPath = process.env.DUET_RUNTIME_BOOTSTRAP_PATH
    ? resolve(process.env.DUET_RUNTIME_BOOTSTRAP_PATH)
    : join(contextDir, 'runtime-bootstrap.js')
  if (!process.env.DUET_RUNTIME_BOOTSTRAP_PATH) {
    await run('bun', [
      'build',
      join(repoRoot, 'packages/gateway/src/runtime-bootstrap.ts'),
      '--target=bun',
      '--outfile',
      bootstrapPath,
    ])
  }
  await stageRuntime(
    suppliedRelease ? resolve(suppliedRelease) : join(repoRoot, 'apps/api/dist/runtime-release'),
    bootstrapPath,
    join(contextDir, 'runtime'),
  )
  await cp(join(repoRoot, 'packages/vm-image'), join(contextDir, 'packages/vm-image'), {
    recursive: true,
    filter: source => !['node_modules', 'dist', '.turbo'].includes(source.split('/').at(-1)!),
  })
  const extensionKeyPath = join(contextDir, 'browser-extension-key.pem')
  await stageBrowserExtension(
    join(contextDir, 'packages/vm-image/desktop/chrome-extension'),
    extensionKeyPath,
  )
  await writeFile(join(contextDir, '.dockerignore'), 'browser-extension-key.pem\n')
  await cp(
    join(repoRoot, 'apps/web/public/icons/duet-avatar.png'),
    join(contextDir, 'apps/web/public/icons/duet-avatar.png'),
  )
  await cp(join(import.meta.dir, '..', 'Dockerfile'), join(contextDir, 'Dockerfile'))
  await cp(join(import.meta.dir, '..', 'systemd'), join(contextDir, 'systemd'), { recursive: true })
  await cp(join(import.meta.dir, '..', 'sudoers'), join(contextDir, 'sudoers'), { recursive: true })

  const baseImage = await resolveExeuntuBase()
  await run('docker', [
    'build',
    '--pull=false',
    '--platform',
    'linux/amd64',
    '--secret',
    `id=browser-extension-key,src=${extensionKeyPath}`,
    '--build-arg',
    `BASE_IMAGE=${baseImage}`,
    '-t',
    imageRef,
    contextDir,
  ])
  await verifyImage(imageRef, process.env.DESKTOP_FRAMEBUFFER_PATH)
  if (localOnly) console.log(`built ${imageRef} locally`)
  else {
    await run('docker', ['push', imageRef])
    console.log(`pushed ${imageRef}`)
  }

  // Record the immutable digest so VMs boot by digest, not the (exe.dev-cached)
  // moving tag. When DUET_IMAGE_ENV_FILE is set (the build-image:<env> scripts),
  // it's written straight into that .env; otherwise just print it.
  const envFile = process.env.DUET_IMAGE_ENV_FILE
  if (envFile && !localOnly) {
    const digestRef = await recordDigestRef(imageRef, envFile)
    console.log(`recorded DUET_VM_IMAGE_REF=${digestRef} in ${envFile}`)
  }
} finally {
  await rm(contextDir, { recursive: true, force: true })
}

async function resolveExeuntuBase(): Promise<string> {
  const dockerHub = await runAllowFailure('docker', [
    'manifest',
    'inspect',
    'docker.io/boldsoftware/exeuntu:latest',
  ])
  if (dockerHub === 0) return 'boldsoftware/exeuntu:latest'
  if (await dockerImageExists('ghcr.io/boldsoftware/exeuntu:latest')) {
    return 'ghcr.io/boldsoftware/exeuntu:latest'
  }
  await run('docker', ['pull', '--platform', 'linux/amd64', 'ghcr.io/boldsoftware/exeuntu:latest'])
  return 'ghcr.io/boldsoftware/exeuntu:latest'
}

async function dockerImageExists(image: string): Promise<boolean> {
  return (await runAllowFailure('docker', ['image', 'inspect', image])) === 0
}

function runAllowFailure(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', code => resolve(code ?? 1))
  })
}
