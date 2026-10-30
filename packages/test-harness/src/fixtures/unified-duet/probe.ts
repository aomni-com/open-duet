// Executed once by an ordinary session on the disposable fresh VM.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const config = JSON.parse(process.argv[2]!) as {
  runtimeVersion: string
  duetArtifact: { sha256: string; byteLength: number; mode: number }
  marker: string
}
const output = new URL('unified-duet-receipt.json', import.meta.url)
// A repeated agent tool call cannot repeat paid RPC work.
await writeFile(new URL('unified-duet-started', import.meta.url), 'started', { flag: 'wx' })
const scratch = await mkdtemp(join(tmpdir(), 'duet-unified-native-'))
const commands: Array<{ command: string; exitCode: number }> = []
const receipt: Record<string, unknown> = { status: 'started', commands }
const save = () => writeFile(output, JSON.stringify(receipt))
await save()
async function cli(args: string[], stdin?: string, timeout = 180_000) {
  const child = Bun.spawn(['duet', ...args], {
    cwd: scratch,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    timeout,
  })
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  commands.push({ command: args[0]!, exitCode })
  await save()
  assert.equal(exitCode, 0, `Native duet ${args[0]} failed; inspect disposable VM logs`)
  return stdout
}
try {
  const binary = Bun.which('duet')
  assert(binary, 'Native duet is missing')
  assert.equal(Bun.which('duetfs'), null, 'Retired duetfs is still on PATH')
  const executable = await realpath(binary)
  const hash = createHash('sha256')
  let byteLength = 0
  for await (const bytes of createReadStream(executable)) {
    hash.update(bytes)
    byteLength += bytes.length
  }
  assert.equal(
    hash.digest('hex'),
    config.duetArtifact.sha256,
    'Managed CLI differs from the announced release',
  )
  assert.equal(byteLength, config.duetArtifact.byteLength)
  assert.equal((await stat(executable)).mode & 0o777, config.duetArtifact.mode)
  receipt.executable = executable
  receipt.duetArtifact = config.duetArtifact
  receipt.runtimeVersion = config.runtimeVersion
  await cli(['skills'])
  const db = join(scratch, 'memory.db')
  const added = JSON.parse(await cli(['memory', 'add', '--db', db, '--json', config.marker])) as {
    content: string
  }
  assert.equal(added.content, config.marker)
  const memories = JSON.parse(await cli(['memory', '--db', db, '--json'])) as Array<{
    content: string
  }>
  assert(
    memories.some(row => row.content === config.marker),
    'Native memory command did not persist the note',
  )
  receipt.memoryContent = config.marker
  const rpc = await cli(
    ['--rpc', '--incognito', '--workdir', scratch, '--db', db, '-m', 'luna'],
    [
      JSON.stringify({ type: 'start' }),
      JSON.stringify({
        type: 'prompt',
        requestId: `rpc-${config.marker}`,
        message: 'Reply with exactly RPC_OK. Do not use tools or delegate.',
        behavior: 'follow_up',
      }),
      '',
    ].join('\n'),
    600_000,
  )
  const events = rpc
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { type: string; status?: string; requestId?: string })
  assert(
    events.some(row => row.type === 'turn_started'),
    'RPC did not initialize a native runner',
  )
  assert(
    events.some(row => row.type === 'command_accepted' && row.requestId === `rpc-${config.marker}`),
    'RPC did not accept the correlated prompt',
  )
  assert(
    events.some(row => row.type === 'complete' && row.status === 'completed'),
    'RPC did not complete the real turn',
  )
  receipt.rpcCompleted = true
  receipt.status = 'pass'
  await save()
} catch (error) {
  receipt.status = 'fail'
  receipt.error = error instanceof Error ? error.message : String(error)
  await save()
  throw error
} finally {
  await rm(scratch, { recursive: true, force: true })
}
