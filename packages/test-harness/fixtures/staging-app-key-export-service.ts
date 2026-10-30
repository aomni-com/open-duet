import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export async function managedAuthenticationDiagnostic(
  env: Record<string, string | undefined>,
  workspaceSlug: string,
  fetchImpl: Fetch = fetch,
): Promise<{ managedKeyPresent: boolean; managedAuthenticated: boolean }> {
  const key = env.DUET_APP_API_KEY
  if (!key || !env.DUET_API_URL)
    return { managedKeyPresent: Boolean(key), managedAuthenticated: false }
  try {
    const response = await fetchImpl(`${env.DUET_API_URL.replace(/\/+$/, '')}/v1/whoami`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    })
    const body = await response.json()
    return {
      managedKeyPresent: true,
      managedAuthenticated:
        response.status === 200 &&
        body.credential?.kind === 'app' &&
        body.workspaces?.length === 1 &&
        body.workspaces[0].slug === workspaceSlug,
    }
  } catch {
    return { managedKeyPresent: true, managedAuthenticated: false }
  }
}

if (import.meta.main) {
  async function command(args: string[]) {
    const child = Bun.spawn(['duet', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, DUET_API_KEY: process.env.DUET_APP_API_KEY },
    })
    const stdout = new Response(child.stdout).text()
    // Drain, then discard stderr: a failed command must not expose diagnostics.
    const stderr = new Response(child.stderr).text()
    const timeout = setTimeout(() => child.kill(9), 30_000)
    try {
      const [exitCode, output] = await Promise.all([child.exited, stdout, stderr])
      if (exitCode !== 0) throw new Error('fixture CLI command failed')
      return output
    } finally {
      clearTimeout(timeout)
    }
  }
  Bun.serve({
    port: Number(process.env.PORT),
    async fetch(request) {
      const url = new URL(request.url)
      const workspaceSlug = request.headers.get('x-expected-workspace') ?? ''
      const appSlug = request.headers.get('x-expected-app') ?? ''
      try {
        if (url.pathname === '/diagnostics') {
          const skill = await Bun.file(
            path.join(homedir(), '.agents/skills/build-apps/SKILL.md'),
          ).text()
          return Response.json({
            ...(await managedAuthenticationDiagnostic(process.env, workspaceSlug)),
            cliVersion: (await command(['--version'])).trim(),
            cliCommandAvailable: (await command(['--help'])).includes('app credentials export'),
            buildAppsSkillHash: createHash('sha256').update(skill).digest('hex'),
          })
        }
        if (url.pathname === '/cli-export' && request.method === 'POST') {
          const output = await command([
            'app',
            'credentials',
            'export',
            '--workspace',
            workspaceSlug,
            '--app',
            appSlug,
            '--expiration',
            'never',
            '--json',
          ])
          return Response.json(JSON.parse(output), { status: 201 })
        }
        if (url.pathname === '/cli-list') {
          const output = await command([
            'app',
            'credentials',
            'ls',
            '--workspace',
            workspaceSlug,
            '--app',
            appSlug,
            '--json',
          ])
          return Response.json(JSON.parse(output))
        }
        if (url.pathname === '/cli-revoke' && request.method === 'POST') {
          const body = await request.json()
          if (typeof body.credentialId !== 'string')
            return Response.json({ error: 'invalid_request' }, { status: 400 })
          const output = await command([
            'app',
            'credentials',
            'revoke',
            body.credentialId,
            '--workspace',
            workspaceSlug,
            '--app',
            appSlug,
            '--json',
          ])
          return Response.json(JSON.parse(output))
        }
        return new Response('Externally hosted app credential fixture', {
          headers: { 'cache-control': 'no-store' },
        })
      } catch {
        return Response.json({ error: 'fixture_command_failed' }, { status: 500 })
      }
    },
  })
}
