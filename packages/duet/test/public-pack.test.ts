import { expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { testIfDocker } from '../../agent/test/helpers/docker-only.js'

testIfDocker(
  'the public tarball installs away from the checkout and retains native agent behavior',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-public-pack-'))
    try {
      const packageDir = resolve(import.meta.dir, '..')
      const sourceManifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
      const publishDir = join(root, 'publish')
      async function run(argv: string[], cwd = root) {
        const proc = Bun.spawn(argv, {
          cwd,
          env: { ...process.env, HOME: join(root, 'home') },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 60_000,
          killSignal: 'SIGKILL',
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        expect(code, stderr).toBe(0)
        return stdout
      }
      await run(['bun', join(packageDir, 'scripts/build-public-package.ts'), publishDir])
      const tarball = join(root, 'duet.tgz')
      await run(['bun', 'pm', 'pack', '--filename', tarball], publishDir)
      const installedRoot = await mkdtemp(join(root, 'installed-'))
      await run(['bun', 'add', '--production', tarball], installedRoot)
      const installed = join(installedRoot, 'node_modules/@duetso/agent')
      const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
      expect(manifest.bin).toEqual({ duet: 'dist/cli-entry.js' })
      expect(manifest.name).toBe('@duetso/agent')
      expect(manifest.version).toBe(sourceManifest.version)
      expect(JSON.stringify(manifest)).not.toContain('workspace:')
      const entry = await readFile(join(installed, 'dist/cli-entry.js'), 'utf8')
      expect(entry).not.toContain('"workspace:*"')
      expect(entry).not.toMatch(/(?:from|import\()\s*["']@repo\//)
      expect(await readFile(join(installed, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toContain(
        '## @earendil-works/pi-ai@',
      )
      expect(await run([join(installedRoot, 'node_modules/.bin/duet'), '--version'])).toBe(
        `${sourceManifest.version}\n`,
      )
      // Pi loads this optional native owner dynamically. Bundling its callers
      // must not turn that dependency into a Bun runtime registry download.
      expect(
        await run([
          'bun',
          '--no-install',
          '-e',
          'import { createRequire } from "node:module"; const require = createRequire(process.argv[1]); console.log(require.resolve("@mariozechner/clipboard"));',
          join(installed, 'dist/cli-entry.js'),
        ]),
      ).toStartWith(`${installedRoot}/node_modules/`)
      const probe = resolve(packageDir, '../../specs/done/unified-duet/assets/packaging/probe.ts')
      const proc = Bun.spawn(['timeout', '--signal=KILL', '90s', 'bun', probe], {
        cwd: root,
        env: {
          ...process.env,
          PROBE_COMMAND: JSON.stringify(['bun', join(installed, 'dist/cli-entry.js')]),
          PROBE_EVIDENCE: join(root, 'evidence'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(code, stdout + stderr).toBe(0)
      const requestPath = join(root, 'oauth-requests.ndjson')
      const connect = Bun.spawn(
        [
          'bun',
          '--preload',
          join(packageDir, 'test/fixtures/public-oauth-preload.ts'),
          join(installed, 'dist/cli-entry.js'),
          'connect',
          'chatgpt',
          '--json',
          '--no-browser',
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH!,
            HOME: join(root, 'oauth-home'),
            PUBLIC_PATCH_REQUESTS: requestPath,
            DUET_CODEX_ORIGINATOR: 'public-package-fixture',
          },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 30_000,
          killSignal: 'SIGKILL',
        },
      )
      const [connectOut, connectErr, connectCode] = await Promise.all([
        new Response(connect.stdout).text(),
        new Response(connect.stderr).text(),
        connect.exited,
      ])
      expect(connectCode, connectOut + connectErr).toBe(0)
      expect(connectOut).toContain('"state":"plan_ineligible"')
      const requests = (await readFile(requestPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      expect(requests.find(request => request.url.endsWith('/responses'))?.headers.originator).toBe(
        'public-package-fixture',
      )
      const transcript = join(root, 'tui.ansi')
      const tui = Bun.spawn(
        [
          'timeout',
          '--signal=INT',
          '4s',
          'script',
          '-q',
          '-c',
          'stty rows 40 cols 120; bun "$DUET_PACKAGED_ENTRY" --incognito --no-auto-upgrade --model duet:anthropic/claude-haiku-4-5',
          transcript,
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH!,
            HOME: join(root, 'tui-home'),
            TERM: 'xterm-256color',
            DUET_PACKAGED_ENTRY: join(installed, 'dist/cli-entry.js'),
          },
          stdout: 'ignore',
          stderr: 'pipe',
        },
      )
      const [tuiError, tuiCode] = await Promise.all([new Response(tui.stderr).text(), tui.exited])
      expect(tuiCode, tuiError).toBe(124)
      const frame = Bun.stripANSI(await readFile(transcript, 'utf8'))
      for (const label of ['DUET AGENT', 'todos', 'relays', 'context'])
        expect(frame).toContain(label)
      expect(frame).not.toMatch(/dlopen|ModuleNotFound|Fatal:|error:/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)
