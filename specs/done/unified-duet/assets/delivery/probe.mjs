import { execFileSync, spawnSync } from 'node:child_process'
// Preview-only transport proof. Run with Node24 after `apps/api build:vercel`:
// node probe.mjs <payload-directory> <existing-api-project.json> <receipt.json> [frozen-api-checkout]
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [payloadDirectory, projectLink, receiptPath, sourceDirectory] = process.argv.slice(2)
const root = resolve(
  sourceDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..'),
)
if (!receiptPath) throw new Error('Expected payload-directory, API project.json, receipt.json')
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
const scratch = await mkdtemp(join(tmpdir(), 'duet-delivery-'))
const token = randomBytes(32).toString('hex')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const run = (command, args, cwd = scratch) => execFileSync(command, args, { cwd, encoding: 'utf8' })
const receipt = {
  capturedAt: new Date().toISOString(),
  sourceRevision,
  artifacts: [],
  controls: {},
}
let deployment
let deploymentId
let cleanupFailure
try {
  await mkdir(join(scratch, '.vercel'), { recursive: true })
  await mkdir(join(scratch, 'apps/api'), { recursive: true })
  await cp(projectLink, join(scratch, '.vercel/project.json'))
  const output = join(scratch, '.vercel/output')
  await cp(join(root, 'apps/api/.vercel/output'), output, { recursive: true })
  const func = join(output, 'functions/index.func')
  await cp(join(func, 'index.mjs'), join(func, 'api-baseline.mjs'))
  const baseline = await readFile(join(func, 'api-baseline.mjs'))
  receipt.apiBaseline = { byteLength: baseline.byteLength, sha256: sha(baseline) }
  receipt.apiStreamReaderSha256 = sha(await readFile(join(root, 'apps/api/src/gateway/release.ts')))
  for (const name of await readdir(payloadDirectory)) {
    const path = join(payloadDirectory, name)
    if (!(await stat(path)).isFile()) throw new Error(`Payload must be flat: ${name}`)
    const bytes = await readFile(path)
    const descriptor = { name, byteLength: bytes.byteLength, sha256: sha(bytes) }
    receipt.artifacts.push(descriptor)
    const release = join(func, 'probe-artifacts', name)
    await mkdir(release, { recursive: true })
    await cp(path, join(release, 'index.js'))
    await writeFile(
      join(release, 'manifest.json'),
      JSON.stringify({
        version: '0.0.0+probe',
        sha256: descriptor.sha256,
        helperSha256: '0'.repeat(64),
      }),
    )
  }
  // A complete-length wrong body must be refused by the production verifier.
  await mkdir(join(func, 'probe-artifacts/corrupt'), { recursive: true })
  await writeFile(join(func, 'probe-artifacts/corrupt/index.js'), 'corrupt')
  await writeFile(
    join(func, 'probe-artifacts/corrupt/manifest.json'),
    JSON.stringify({
      version: '0.0.0+probe',
      sha256: sha(Buffer.from('correct')),
      helperSha256: '0'.repeat(64),
    }),
  )
  const entry = join(scratch, 'handler.mjs')
  await writeFile(
    entry,
    `
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readGatewayReleaseBundle } from ${JSON.stringify(join(root, 'apps/api/src/gateway/release.ts'))};
const allowed = new Set(${JSON.stringify([...receipt.artifacts.map(a => a.name), 'corrupt'])});
export default { async fetch(request) {
  const auth = request.headers.get('authorization') ?? '';
  if (createHash('sha256').update(auth).digest('hex') !== ${JSON.stringify(sha(Buffer.from(`Bearer ${token}`)))}) return new Response('', {status:401});
  const name = new URL(request.url).pathname.slice(1);
  if (!allowed.has(name)) return new Response('', {status:404});
  const release = await readGatewayReleaseBundle(resolve('probe-artifacts', name));
  if (!release) return new Response('', {status:503});
  return new Response(release.body, {headers:{'content-type':'application/octet-stream','content-length':String(release.byteLength),'cache-control':'no-store'}});
}};
`,
  )
  run(
    'bun',
    ['build', entry, '--target=node', '--format=esm', `--outfile=${join(func, 'index.mjs')}`],
    root,
  )
  const config = JSON.parse(await readFile(join(func, '.vc-config.json'), 'utf8'))
  config.maxDuration = 800
  await writeFile(join(func, '.vc-config.json'), JSON.stringify(config))
  const size = async path => {
    const info = await stat(path)
    return info.isFile()
      ? info.size
      : (await Promise.all((await readdir(path)).map(name => size(join(path, name))))).reduce(
          (a, b) => a + b,
          0,
        )
  }
  receipt.functionBytes = await size(func)
  receipt.functionConfiguration = config
  const deployedOutput = JSON.parse(
    run('vercel', ['deploy', '--prebuilt', '--target=preview', '--yes', '--format=json']),
  )
  const deployed = deployedOutput.deployment ?? deployedOutput
  deploymentId = deployed.id
  deployment = deployed.url.startsWith('https://') ? deployed.url : `https://${deployed.url}`
  if (!/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(deployment))
    throw new Error('Missing unique preview URL')
  receipt.deployment = deployment
  receipt.deploymentId = deploymentId
  const request = async (name, authorized = true) => {
    const destination = join(scratch, 'download')
    const headers = join(scratch, 'headers')
    const metrics = run('vercel', [
      'curl',
      `/${name}`,
      '--deployment',
      deployment,
      '--',
      '--silent',
      '--show-error',
      '--max-time',
      '180',
      ...(authorized ? ['--header', `Authorization: Bearer ${token}`] : []),
      '--dump-header',
      headers,
      '--output',
      destination,
      '--write-out',
      '%{json}',
    ])
    const measured = JSON.parse(metrics)
    const body = await readFile(destination)
    return {
      status: measured.http_code,
      byteLength: body.byteLength,
      sha256: sha(body),
      timeToFirstByteSeconds: measured.time_starttransfer,
      totalSeconds: measured.time_total,
      vercelId: (await readFile(headers, 'utf8')).match(/^x-vercel-id: (.+)$/im)?.[1].trim(),
    }
  }
  receipt.controls.unauthorized = await request(receipt.artifacts[0].name, false)
  if (receipt.controls.unauthorized.status !== 401) throw new Error('Unauthorized request accepted')
  receipt.controls.corrupt = await request('corrupt')
  if (receipt.controls.corrupt.status !== 503) throw new Error('Corrupt artifact accepted')
  for (const artifact of receipt.artifacts) {
    artifact.download = await request(artifact.name)
    if (
      artifact.download.status !== 200 ||
      artifact.download.byteLength !== artifact.byteLength ||
      artifact.download.sha256 !== artifact.sha256
    )
      throw new Error(`Incomplete artifact: ${artifact.name}`)
  }
  receipt.transport = 'authenticated-api-stream'
} finally {
  try {
    if (deployment) {
      const link = JSON.parse(await readFile(projectLink, 'utf8'))
      run('vercel', [
        'api',
        `/v13/deployments/${deploymentId}?teamId=${link.orgId}`,
        '--method=DELETE',
        '--dangerously-skip-permissions',
        '--silent',
      ])
      receipt.deploymentRemoved = true
      const lookup = spawnSync(
        'vercel',
        ['api', `/v13/deployments/${deploymentId}?teamId=${link.orgId}`, '--raw'],
        { cwd: scratch, encoding: 'utf8' },
      )
      if (
        lookup.status === 0 ||
        !/not_found|not found/i.test(`${lookup.stdout}\n${lookup.stderr}`)
      ) {
        cleanupFailure = new Error('Deleted preview lookup did not report not found')
      } else {
        receipt.deploymentRemovalVerifiedByGetNotFound = true
      }
    }
  } catch (error) {
    cleanupFailure = error
  } finally {
    if (cleanupFailure) receipt.cleanupError = cleanupFailure.message
    await writeFile(resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`).finally(() =>
      rm(scratch, { recursive: true, force: true }),
    )
  }
}
if (cleanupFailure) throw cleanupFailure
