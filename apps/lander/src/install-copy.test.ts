import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SIGN_IN_CODE_TTL_SECONDS } from '@repo/contract'

import { agentInstallText, emailSignInBlock } from './install-copy'
import { siteConfig } from './site-config'

const installText = () =>
  agentInstallText(
    siteConfig({
      DUET_API_URL: 'https://ctl-staging.duet.so/',
      DUET_MCP_PUBLIC_URL: 'https://mcp-staging.duet.so///',
    }),
  )

describe('agent install copy', () => {
  test('documents both sign-in rails and forbids neither', () => {
    const text = installText()

    expect(text).toContain('npm i -g @duetso/agent')
    expect(text).toContain('Bun 1.3.14')
    expect(text).toContain('Node 22')
    expect(text).toContain('duet --api-url https://ctl-staging.duet.so login')
    expect(text).not.toContain('duetfs')
    expect(text).toContain('/v1/auth/email/start')
    expect(text).toContain('/v1/auth/email/verify')
    expect(text).not.toContain('do not bypass')
    expect(text).not.toContain('bypass token')
  })

  test('one human login follows memberships without a separate sync grant', () => {
    const text = installText()

    expect(text).toContain('Never print the key.')
    expect(text).toContain('human identity key')
    expect(text).toMatch(/current membership and role/i)
    expect(text).toContain('duet sync install')
    expect(text).toContain('duet memory recall')
    expect(text).toContain('--workspace')
    expect(text).not.toContain('workspace-scoped API key')
    expect(text).not.toContain('browser-only')
    expect(text).not.toContain('login --sync')
  })

  // `expires_in` and the code TTL are the same number owned by @repo/contract.
  // A literal here would drift the day the contract moves, and public copy that
  // states its own number is exactly what the lander boundary forbids.
  test('reads the code lifetime from the contract rather than restating it', () => {
    expect(installText()).toContain(`"expires_in":${SIGN_IN_CODE_TTL_SECONDS}`)
  })

  test('the published email exchange preserves machine configuration while replacing login', async () => {
    const home = await mkdtemp(join(tmpdir(), 'duet-install-example-'))
    const key = 'duet_sk_synthetic_install_example'
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe('/v1/auth/email/verify')
        expect(await request.json()).toEqual({ request_id: 'fixture-request', code: 'ABCD-2345' })
        return Response.json({ access_token: key, workspace: { slug: 'demo' } })
      },
    })
    try {
      await mkdir(join(home, '.duet'))
      const configPath = join(home, '.duet/config.json')
      const previous = {
        apiKey: 'old-fixture',
        machineId: 'keep-this-mac',
        defaultWorkspace: 'old',
      }
      await Bun.write(configPath, JSON.stringify(previous))
      const block = emailSignInBlock(siteConfig({ DUET_API_URL: server.url.origin }))
      const script = block.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)?.[1]
      expect(script).toBeDefined()
      const child = Bun.spawn(['node', '--input-type=module', '-e', script!], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          DUET_API_URL: server.url.origin,
          DUET_REQUEST_ID: 'fixture-request',
          DUET_CODE: 'ABCD-2345',
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode, stderr).toBe(0)
      expect(stdout + stderr).not.toContain(key)
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
        ...previous,
        apiKey: key,
        defaultWorkspace: 'demo',
        apiUrl: server.url.origin,
      })
      expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    } finally {
      server.stop(true)
      await rm(home, { recursive: true, force: true })
    }
  })
})
