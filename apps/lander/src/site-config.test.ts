import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devicePairingBlock, emailSignInBlock, mcpConfigBlock } from './install-copy'
import { siteConfig } from './site-config'

describe('public install MCP origin', () => {
  test('advertises the canonical root resource from DUET_MCP_PUBLIC_URL', () => {
    const config = siteConfig({
      DUET_API_URL: 'https://ctl-staging.duet.so/',
      DUET_MCP_PUBLIC_URL: 'https://mcp-staging.duet.so///',
    })

    expect(config.mcpUrl).toBe('https://mcp-staging.duet.so')
    expect(mcpConfigBlock(config)).toContain('DUET_MCP_PUBLIC_URL="https://mcp-staging.duet.so"')
    expect(mcpConfigBlock(config)).toContain('url: process.env.DUET_MCP_PUBLIC_URL')
  })

  test('sends both doors at the configured API origin, never a hardcoded one', async () => {
    const config = siteConfig({
      DUET_API_URL: 'https://ctl-staging.duet.so/',
      DUET_MCP_PUBLIC_URL: 'https://mcp-staging.duet.so///',
    })

    expect(devicePairingBlock(config)).toContain('duet --api-url https://ctl-staging.duet.so')
    expect(emailSignInBlock(config)).toContain('DUET_API_URL="https://ctl-staging.duet.so"')
    const home = await mkdtemp(join(tmpdir(), 'duet-email-start-'))
    try {
      const argsPath = join(home, 'curl-arguments.json')
      const curl = join(home, 'curl')
      await Bun.write(
        curl,
        '#!/usr/bin/env node\n' +
          'require("node:fs").writeFileSync(process.env.FIXTURE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));\n' +
          'process.stdout.write(JSON.stringify({request_id:"fixture-request"}));\n',
      )
      await chmod(curl, 0o755)
      const block = emailSignInBlock(config)
      const program = block.slice(0, block.indexOf('# 2.')) + '\nprintf \'%s\' "$DUET_REQUEST_ID"'
      const child = Bun.spawn(['sh', '-c', program], {
        env: { PATH: `${home}:${process.env.PATH}`, HOME: home, FIXTURE_ARGS_PATH: argsPath },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exit, stderr).toBe(0)
      expect(stdout).toBe('fixture-request')
      const args: string[] = JSON.parse(await readFile(argsPath, 'utf8'))
      expect(args).toContain('https://ctl-staging.duet.so/v1/auth/email/start')
      expect(JSON.parse(args[args.indexOf('-d') + 1]!)).toEqual({
        email: 'human@example.com',
        client_name: 'Claude Code',
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
