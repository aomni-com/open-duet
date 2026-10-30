import { expect, test } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

test('the default gate runs every file even when a test consumes stdin, and retains failures', async () => {
  const fixture = await createRunnerFixture()
  try {
    const result = await fixture.run([])
    expect(result.code).toBe(1)
    expect(result.calls.toSorted()).toEqual(
      [
        ['test', '--timeout', '60000', './test/a.test.ts'],
        ['test', '--timeout', '60000', './test/nested/b.spec.ts'],
        ['test', '--timeout', '60000', './src/c.test.ts'],
      ].toSorted(),
    )
  } finally {
    await fixture.dispose()
  }
})

test('focused container commands forward paths and Bun filters unchanged', async () => {
  const fixture = await createRunnerFixture()
  try {
    const args = ['test/nested/b.spec.ts', '-t', 'selected behavior', '--timeout', '120000']
    const result = await fixture.run(['--', ...args])
    expect(result.code).toBe(0)
    expect(result.calls).toEqual([['test', ...args]])
  } finally {
    await fixture.dispose()
  }
})

async function createRunnerFixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'duet-agent-runner-'))
  const bin = join(scratch, 'bin')
  const work = join(scratch, 'work')
  const calls = join(scratch, 'calls.jsonl')
  await mkdir(bin)
  await mkdir(join(scratch, 'scripts'))
  await copyFile(
    new URL('./agent-tests.sh', import.meta.url),
    join(scratch, 'scripts/agent-tests.sh'),
  )
  await writeFile(join(scratch, 'scripts/agent-tests.Dockerfile'), '')
  for (const file of [
    'test/a.test.ts',
    'test/nested/b.spec.ts',
    'src/c.test.ts',
    'test/helpers/support.ts',
  ]) {
    const path = join(work, 'packages/duet', file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '')
  }
  const executables = {
    docker: `#!/bin/bash
if [[ "$1" == build ]]; then printf 'fixture-image\\n'; exit 0; fi
while [[ "$1" != bash ]]; do shift; done
shift
cd "$TEST_WORKDIR"
exec bash "$@"
`,
    tar: '#!/bin/bash\nexit 0\n',
    bun: `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'test') {
  appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
  if (args.some(value => value.startsWith('./'))) readFileSync(0);
  if (args.includes('./test/a.test.ts')) process.exit(1);
}
`,
  }
  for (const [name, content] of Object.entries(executables)) {
    await writeFile(join(bin, name), content)
    await chmod(join(bin, name), 0o755)
  }
  return {
    async run(args: string[]) {
      await writeFile(calls, '')
      const child = Bun.spawn(['bash', join(scratch, 'scripts/agent-tests.sh'), 'duet', ...args], {
        cwd: scratch,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_WORKDIR: work,
          TEST_CALLS: calls,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      const contents = await readFile(calls, 'utf8')
      return {
        code,
        stderr,
        calls: contents
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line) as string[]),
      }
    },
    dispose: () => rm(scratch, { recursive: true, force: true }),
  }
}
