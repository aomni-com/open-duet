import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DUET_RUNTIME_ASSET_NAMES } from '../../../packages/agent/src/runtime-assets.ts'
import {
  canonicalRuntimeReleaseIdentityInput,
  RuntimeReleaseManifestSchema,
} from '../../../packages/contract/src/vm/index.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = join(repoRoot, 'apps/api/dist/runtime-release')
const staging = `${output}.next`
const compiled = join(repoRoot, 'apps/api/dist/.compiled-payload')
const payloadIndex = process.argv.indexOf('--payload-dir')
const preparedPayload = payloadIndex < 0 ? undefined : process.argv[payloadIndex + 1]
if (payloadIndex >= 0 && preparedPayload === undefined)
  throw new Error('--payload-dir requires a directory')

await rm(staging, { recursive: true, force: true })
try {
  const payload = preparedPayload === undefined ? compiled : resolve(preparedPayload)
  if (preparedPayload === undefined) {
    const { prepareDuetArtifact } =
      await import('../../../packages/agent/benchmarks/swebench/src/packaging.ts')
    await prepareDuetArtifact({ repoRoot, outputDir: payload })
  }
  await mkdir(staging, { recursive: true })
  const inputs = [
    { name: 'index.js', source: join(repoRoot, 'packages/gateway/dist/index.js'), mode: 0o644 },
    { name: 'helper.js', source: join(repoRoot, 'packages/gateway/dist/helper.js'), mode: 0o644 },
    { name: 'duet', source: join(payload, 'duet-linux-x64'), mode: 0o755 },
    ...DUET_RUNTIME_ASSET_NAMES.map(name => ({ name, source: join(payload, name), mode: 0o644 })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const artifacts = []
  for (const { name, source, mode } of inputs) {
    const path = join(staging, name)
    await copyFile(source, path)
    await chmod(path, mode)
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size === 0)
      throw new Error(`Empty runtime artifact: ${name}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    artifacts.push({ name, sha256: hash.digest('hex'), byteLength: metadata.size, mode })
  }
  const identity = createHash('sha256')
    .update(canonicalRuntimeReleaseIdentityInput(artifacts))
    .digest('hex')
  const manifest = RuntimeReleaseManifestSchema.parse({
    formatVersion: 1,
    version: `0.0.0+${identity}`,
    artifacts,
  })
  await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o644,
  })
  await rm(output, { recursive: true, force: true })
  await rename(staging, output)
  console.log(`runtime release ${manifest.version} ${output}`)
} finally {
  await rm(staging, { recursive: true, force: true })
  if (preparedPayload === undefined) await rm(compiled, { recursive: true, force: true })
}
