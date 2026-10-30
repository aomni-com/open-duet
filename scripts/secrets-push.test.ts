import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { SECRETS } from './secret-topology.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'duet-secret-fanout-'))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'bin'))
  await mkdir(join(root, 'private'))
  await mkdir(join(root, 'home'))
  await mkdir(join(root, 'packages/backend'), { recursive: true })
  for (const name of ['secrets-push.mjs', 'secret-topology.mjs'])
    await cp(join(import.meta.dir, name), join(root, 'scripts', name))
  const values = Object.fromEntries(
    Object.keys(SECRETS).map(key => [
      key,
      `PRIVATE-${key}\n"quotes" \\ slash $() \u2603\nPRIVATE-end-${key}`,
    ]),
  )
  values.SITE_URL = values.DUET_APP_URL!
  const projects = [...new Set(Object.values(SECRETS).flatMap(t => t.vercel))]
  for (const project of projects) {
    const path = join(root, 'apps', project, '.vercel')
    await mkdir(path, { recursive: true })
    await writeFile(
      join(path, 'project.json'),
      JSON.stringify({ projectId: `project-${project}`, orgId: 'team-fixture' }),
    )
  }
  for (const environment of ['staging', 'production'])
    await writeFile(
      join(root, `.env.${environment}`),
      Object.keys(values)
        .map(key => `${key}="encrypted:fixture-ciphertext"`)
        .join('\n'),
    )
  const state = join(root, 'stored.json')
  const requests = join(root, 'requests.jsonl')
  await writeFile(state, JSON.stringify({ vercel: {}, convex: {} }))
  const fake = `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(process.env.FIXTURE_STATE, 'utf8'))
const kind = basename(process.argv[1])
const cwd = args[args.indexOf('--cwd') + 1]
let data, privateFile
if (kind === 'vercel' && args[0] === 'api') {
  privateFile = args[args.indexOf('--input') + 1]
  data = JSON.parse(readFileSync(privateFile, 'utf8'))
  const url = new URL(args[1], 'https://api.vercel.test')
  const project = url.pathname.split('/')[3].replace('project-', '')
  if (url.searchParams.get('upsert') !== 'true' || url.searchParams.get('teamId') !== 'team-fixture') throw Error('Wrong project/team operation')
  if (data.type !== 'encrypted') throw Error('Wrong value type')
  appendFileSync(process.env.FIXTURE_REQUESTS, JSON.stringify({ args, privateFile, fileMode: statSync(privateFile).mode & 511, directoryMode: statSync(dirname(privateFile)).mode & 511 }) + '\\n')
  if (process.env.FIXTURE_FAIL === data.key && project === 'api') {
    console.error(data.value)
    process.exit(1)
  }
  for (const target of data.target) state.vercel[project + ':' + target + ':' + data.key] = data.value
  console.log(JSON.stringify(data)) // Even an echoed response must stay out of fanout output.
} else if (kind === 'vercel') {
  const project = cwd.replace('apps/', '')
  if (args[1] === 'ls') console.log(Object.keys(state.vercel).filter(k => k.startsWith(project + ':' + args[2] + ':')).map(k => k.split(':')[2]).join('\\n'))
  else {
    const key = project + ':' + args[3] + ':' + args[2]
    if (args[1] === 'rm') delete state.vercel[key]
    else if (args[1] === 'add') {
      if (process.env.FIXTURE_FAIL === args[2] && project === 'api') { console.error(process.env[args[2]]); process.exit(1) }
      state.vercel[key] = '' // Observed CLI env-add behavior: acknowledges but loses stdin.
    } else throw Error('Unexpected command')
    appendFileSync(process.env.FIXTURE_REQUESTS, JSON.stringify({ args }) + '\\n')
  }
} else if (args[2] === 'list') console.log([...Object.keys(state.convex), 'JWKS', 'JWT_PRIVATE_KEY'].join('\\n'))
else if (args[2] === 'set') state.convex[args[3]] = args[4]
else throw Error('Unexpected Convex command')
writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state))
`
  for (const cli of ['vercel', 'bunx'])
    await writeFile(join(root, 'bin', cli), fake, { mode: 0o755 })
  async function run(environment = 'staging', failure?: string) {
    const child = Bun.spawn(
      [process.execPath, join(root, 'scripts/secrets-push.mjs'), environment, '--apply'],
      {
        cwd: root,
        env: {
          PATH: `${join(root, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: join(root, 'home'),
          TMPDIR: join(root, 'private'),
          ...values,
          FIXTURE_STATE: state,
          FIXTURE_REQUESTS: requests,
          ...(failure ? { FIXTURE_FAIL: failure } : {}),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exitCode, stored: JSON.parse(await readFile(state, 'utf8')) }
  }
  function expected(environment: string) {
    const vercel: Record<string, string> = {},
      convex: Record<string, string> = {}
    for (const [key, t] of Object.entries(SECRETS)) {
      if ('environments' in t && !t.environments.includes(environment)) continue
      const value = values['valueFrom' in t ? t.valueFrom : key]!
      for (const project of t.vercel)
        vercel[`${project}:${environment === 'staging' ? 'preview' : 'production'}:${key}`] = value
      if (t.convex) convex[key] = value
    }
    return { vercel, convex }
  }
  return { root, run, expected, requests, state, values }
}

test('fanout stores every managed Vercel value byte-exactly through the CLI boundary', async () => {
  const f = await fixture()
  try {
    const result = await f.run()
    expect(result.exitCode).toBe(0)
    expect(result.stored).toEqual(f.expected('staging'))
    expect(result.stdout + result.stderr).not.toContain('PRIVATE-')
    const requests = (await readFile(f.requests, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    for (const request of requests) {
      expect(JSON.stringify(request.args)).not.toContain('PRIVATE-')
      expect(request.fileMode).toBe(0o600)
      expect(request.directoryMode).toBe(0o700)
      expect(await Bun.file(request.privateFile).exists()).toBeFalse()
    }
    expect(await Array.fromAsync(new Bun.Glob('*').scan(join(f.root, 'private')))).toEqual([])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('failed upsert preserves the prior value, cleans private input and permits retry', async () => {
  const f = await fixture()
  try {
    const key = 'api:production:DUET_API_INTERNAL_KEY'
    await writeFile(f.state, JSON.stringify({ vercel: { [key]: 'previous-secret' }, convex: {} }))
    const failed = await f.run('production', 'DUET_API_INTERNAL_KEY')
    expect(failed.exitCode).toBe(1)
    expect(failed.stored.vercel[key]).toBe('previous-secret')
    expect(failed.stdout + failed.stderr).not.toContain('PRIVATE-')
    expect(await Array.fromAsync(new Bun.Glob('*').scan(join(f.root, 'private')))).toEqual([])
    const retry = await f.run('production')
    expect(retry.exitCode).toBe(0)
    expect(retry.stored).toEqual(f.expected('production'))
    expect(retry.stdout + retry.stderr).not.toContain('PRIVATE-')
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
}, 15_000)
