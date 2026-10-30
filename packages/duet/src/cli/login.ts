import { spawn } from 'node:child_process'

import {
  DeviceCodeRequestSchema,
  DeviceCodeResponseSchema,
  DeviceTokenResponseSchema,
} from '@repo/contract'

import { parseNamedOptions, writeJson, writeText, type CommandContext } from '../cli-support.js'
import { effectiveApiUrl, loadConfig, saveConfig } from '../config.js'
import { CliError, EXIT_CODES, usageError } from '../exit-codes.js'

/** One human login, saved in the same configuration used by every command. */
export async function runLoginCommand(args: string[], ctx: CommandContext): Promise<void> {
  const options = parseNamedOptions(
    args.filter(arg => arg !== '--no-browser'),
    ['client-name'],
  )
  if (options.positionals.length)
    throw usageError('Usage: login [--no-browser] [--client-name <name>]')
  const request = DeviceCodeRequestSchema.safeParse({
    client_name: options.values['client-name']?.[0] ?? 'Duet CLI',
  })
  if (!request.success) throw usageError('Invalid login client name.')
  const code = DeviceCodeResponseSchema.parse(
    await (
      await ctx.api.request('/device/code', {
        method: 'POST',
        json: request.data,
        auth: false,
      })
    ).json(),
  )
  if (ctx.global.json)
    writeJson(ctx.io.stdout, {
      status: 'pending_user',
      user_code: code.user_code,
      verification_uri: code.verification_uri,
      expires_in: code.expires_in,
      interval: code.interval,
    })
  else
    writeText(
      ctx.io.stdout,
      `User code: ${code.user_code}\nVerification URL: ${code.verification_uri}\n`,
    )
  if (!args.includes('--no-browser') && !ctx.global.json) {
    const command =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'explorer'
          : 'xdg-open'
    const child = spawn(command, [code.verification_uri], { detached: true, stdio: 'ignore' })
    child.on('error', () =>
      writeText(ctx.io.stderr, 'Open the verification URL in your browser.\n'),
    )
    child.unref()
  }
  let intervalMs = code.interval * 1000
  const deadline = ctx.now() + code.expires_in * 1000
  while (ctx.now() < deadline) {
    const token = DeviceTokenResponseSchema.parse(
      await (
        await ctx.api.request('/device/token', {
          method: 'POST',
          json: { device_code: code.device_code },
          auth: false,
        })
      ).json(),
    )
    if (token.status === 'approved') {
      await saveConfig(
        {
          ...(await loadConfig(ctx.configPath)),
          apiKey: token.access_token,
          apiUrl: effectiveApiUrl(ctx.config, ctx.env, ctx.global.apiUrl),
        },
        ctx.configPath,
      )
      if (ctx.global.json)
        writeJson(ctx.io.stdout, { status: 'approved', configPath: ctx.configPath })
      else writeText(ctx.io.stdout, `Logged in. Config: ${ctx.configPath}\n`)
      return
    }
    if (token.status === 'slow_down')
      intervalMs = Math.max(intervalMs + 5000, token.interval * 1000)
    else if (token.status === 'pending') intervalMs = Math.max(intervalMs, token.interval * 1000)
    else
      throw new CliError(
        `device_${token.status}`,
        `Device login ${token.status}.`,
        EXIT_CODES.generic,
      )
    if (ctx.now() + intervalMs >= deadline) break
    await ctx.sleep(intervalMs)
  }
  throw new CliError(
    'device_expired',
    'Device login expired. Run duet login again.',
    EXIT_CODES.generic,
  )
}
