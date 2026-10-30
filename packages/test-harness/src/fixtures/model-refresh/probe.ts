// Copied into an ephemeral staging agent's cwd and executed once by its real runner.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const config = JSON.parse(process.argv[2]!) as {
  roles: Record<string, string>
  skillHash: string
  runtimeVersion: string
  duetArtifact: { sha256: string; byteLength: number; mode: number }
}
const receiptPath = 'model-refresh-receipt.json'
// An accidental second tool invocation must never repeat paid work.
await writeFile('model-refresh-started', 'started', { flag: 'wx' })
const scratch = await mkdtemp(join(tmpdir(), 'duet-model-refresh-'))
const commands: Array<Record<string, unknown>> = []
const receipt: Record<string, unknown> = {
  status: 'started',
  generations: [],
  nondefault: [],
  commands,
}
const save = () => writeFile(receiptPath, JSON.stringify(receipt))
async function cli(args: string[], timeout: number) {
  const startedAt = Date.now()
  const modelFlag = args.findIndex(arg => arg === '-m' || arg === '--model')
  const command: Record<string, unknown> = {
    command: args[0],
    ...(modelFlag < 0 ? {} : { model: args[modelFlag + 1] }),
    startedAt,
    timeoutMs: timeout,
    status: 'running',
  }
  commands.push(command)
  await save()
  const child = Bun.spawn(['duet', ...args], { stdout: 'pipe', stderr: 'pipe', timeout })
  try {
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    Object.assign(command, {
      elapsedMs: Date.now() - startedAt,
      exitCode,
      signal: child.signalCode ?? null,
      status: exitCode === 0 ? 'completed' : 'failed',
    })
    await save()
    assert.equal(exitCode, 0, `duet ${args[0]} failed (${exitCode}); inspect VM logs`)
    return { exitCode, stdout }
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}
try {
  await save()
  const binary = Bun.which('duet')
  assert(binary, 'installed duet CLI is missing')
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
    'installed CLI bytes differ from announced runtime',
  )
  assert.equal(
    byteLength,
    config.duetArtifact.byteLength,
    'installed CLI length differs from announced runtime',
  )
  assert.equal(
    (await stat(executable)).mode & 0o777,
    config.duetArtifact.mode,
    'installed CLI mode differs from announced runtime',
  )
  receipt.runtimeVersion = config.runtimeVersion
  receipt.duetArtifact = config.duetArtifact
  await cli(['skills'], 30_000)
  const skills = join(homedir(), '.agents/skills')
  const reference = JSON.parse(
    await readFile(join(skills, 'media-creation/reference/models.json'), 'utf8'),
  )
  receipt.roles = Object.fromEntries(
    Object.keys(config.roles).map(role => [
      role,
      reference.models.find((row: { id: string }) => row.id === role)?.gatewayModelId,
    ]),
  )
  assert.deepEqual(receipt.roles, config.roles, 'installed media catalog is stale')
  const skillHash = createHash('sha256')
    .update(await readFile(join(skills, 'build-apps/SKILL.md')))
    .digest('hex')
  assert.equal(
    skillHash,
    config.skillHash,
    'installed generated build-apps skill differs from release',
  )
  receipt.skillHash = skillHash
  await save()
  for (const role of ['image:google', 'video:google', 'video:grok', 'video:seedance']) {
    const image = role === 'image:google'
    const out = join(scratch, image ? 'image.png' : `${role.replace(':', '-')}.mp4`)
    const result = await cli(
      [
        'model',
        '-m',
        config.roles[role]!,
        '--type',
        image ? 'image' : 'video',
        '--n',
        '1',
        '-o',
        out,
        ...(image ? [] : ['--duration', '4', '--resolution', '1280x720']),
        ...(role === 'video:seedance' ? ['--image', join(scratch, 'image.png')] : []),
        'A blue circle on a plain white background. Static camera.',
      ],
      role === 'video:seedance' ? 600_000 : 300_000,
    )
    const bytes = await readFile(out)
    const validMedia = image
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : bytes.subarray(4, 8).toString() === 'ftyp'
    assert(validMedia, `${role} returned unrecognized media bytes`)
    ;(receipt.generations as unknown[]).push({
      role,
      model: config.roles[role],
      exitCode: result.exitCode,
      bytes: bytes.length,
      validMedia,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    await save()
  }
  await writeFile(
    join(scratch, 'policy.md'),
    'The model refresh acceptance project uses the codeword violet kestrel. Its release checklist always verifies generated content before promotion.',
  )
  // Use a separate source directory so generated media is never sent for training.
  const source = await mkdtemp(join(scratch, 'source-'))
  await writeFile(join(source, 'policy.md'), await readFile(join(scratch, 'policy.md')))
  receipt.trainExitCode = (
    await cli(['train', source, '--model', 'luna', '--store', join(scratch, 'memories')], 300_000)
  ).exitCode
  await save()
  for (const model of ['spacexai/grok-4.7', 'zai/glm-5.3']) {
    const response = await fetch(
      `${process.env.DUET_GATEWAY_BASE_URL!.replace(/\/$/, '')}/v1/chat/completions`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
        headers: {
          authorization: `Bearer ${process.env.DUET_API_KEY}`,
          'content-type': 'application/json',
          'x-duet-tier': 'services',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: 'Reply with the integer result of 19 + 23, without explanation.',
            },
          ],
          max_tokens: 256,
        }),
      },
    )
    assert.equal(
      response.status,
      200,
      `${model} live qualification failed with HTTP ${response.status}`,
    )
    const body = (await response.json()) as {
      model?: string
      choices?: Array<{ message?: { content?: string } }>
    }
    assert.equal(
      body.choices?.[0]?.message?.content?.trim(),
      '42',
      `${model} failed the checkable task`,
    )
    ;(receipt.nondefault as unknown[]).push({ model, responseModel: body.model, result: '42' })
    await save()
  }
  receipt.status = 'complete'
  await save()
} catch (error) {
  receipt.status = 'failed'
  receipt.error = error instanceof Error ? error.message : 'probe failed'
  await save()
  process.exitCode = 1
} finally {
  await rm(scratch, { recursive: true, force: true })
}
