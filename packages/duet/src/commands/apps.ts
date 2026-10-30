import {
  AppCredentialExpirationSchema,
  AppCredentialListResponseSchema,
  ExportAppCredentialResponseSchema,
  RevokeAppCredentialResponseSchema,
} from '@repo/contract'

import { writeJson, writeText, type CommandContext, type CommandRegistry } from '../cli-support.js'
import { CliError, EXIT_CODES, usageError } from '../exit-codes.js'

export function registerAppCommands(registry: CommandRegistry): void {
  registry.register('app', appCredentials)
}

async function appCredentials(args: string[], ctx: CommandContext): Promise<void> {
  const [group, operation, ...flags] = args
  if (group !== 'credentials' || !['export', 'ls', 'revoke'].includes(operation!))
    throw usageError('Usage: duet app credentials export|ls|revoke ...')
  const credentialId = operation === 'revoke' ? flags.shift() : undefined
  if (operation === 'revoke' && (!credentialId || credentialId.startsWith('-')))
    throw usageError('revoke requires a credential ID.')
  if (!ctx.global.workspace) throw usageError('--workspace is required.')
  let app: string | undefined
  let expiration: string | undefined
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]
    if (flag !== '--app' && flag !== '--expiration')
      throw usageError('Unknown app credentials option.')
    const value = flags[++index]
    if (!value || value.startsWith('-')) throw usageError('Missing app credentials option value.')
    if (flag === '--app') app = value
    else expiration = value
  }
  if (!app) throw usageError('--app is required.')
  const seconds = expiration === undefined ? undefined : Number(expiration)
  const choice = AppCredentialExpirationSchema.safeParse(
    expiration === 'never' ? 'never' : { seconds },
  )
  if (
    operation === 'export' &&
    (!choice.success ||
      (choice.data !== 'never' &&
        (!/^\d+$/.test(expiration!) ||
          !Number.isSafeInteger(choice.data.seconds * 1000 + ctx.now()))))
  )
    throw usageError('--expiration must be never or positive integer seconds.')
  if (operation !== 'export' && expiration !== undefined)
    throw usageError('--expiration is only valid for export.')
  const path = `/ws/${encodeURIComponent(ctx.global.workspace)}/apps/${encodeURIComponent(app)}/credentials`
  const suffix =
    operation === 'export'
      ? '/export'
      : operation === 'revoke'
        ? `/${encodeURIComponent(credentialId!)}`
        : ''
  let response: Response
  try {
    response = await ctx.api.request(`${path}${suffix}`, {
      method: operation === 'export' ? 'POST' : operation === 'ls' ? 'GET' : 'DELETE',
      ...(operation !== 'export'
        ? {}
        : { json: { expiration: choice.success ? choice.data : undefined } }),
      redirect: 'error',
      errorMode: 'status',
    })
  } catch (error) {
    const failure = error instanceof CliError ? error : undefined
    const status = failure?.details.status
    const code =
      failure?.code === 'network'
        ? 'network_error'
        : ['unauthorized', 'insufficient_scope', 'not_found'].includes(failure?.code ?? '')
          ? failure!.code
          : 'request_failed'
    const recovery = recoveryMessage(operation, code === 'network_error')
    throw new CliError(
      code,
      recovery ?? 'App credentials request failed.',
      failure?.exitCode ?? EXIT_CODES.generic,
      typeof status === 'number' ? { status } : {},
    )
  }
  try {
    const body: unknown = await response.json()
    if (operation === 'export') {
      const result = ExportAppCredentialResponseSchema.parse(body)
      if (ctx.global.json) writeJson(ctx.io.stdout, result)
      else {
        const { key, ...metadata } = result
        writeText(ctx.io.stdout, `${key}\n`)
        writeJson(ctx.io.stderr, metadata)
      }
    } else
      writeJson(
        ctx.io.stdout,
        operation === 'ls'
          ? AppCredentialListResponseSchema.parse(body)
          : RevokeAppCredentialResponseSchema.parse(body),
      )
  } catch {
    throw new CliError(
      'invalid_response',
      recoveryMessage(operation, true) ?? 'Invalid app credentials response.',
      EXIT_CODES.generic,
      { status: response.status },
    )
  }
}

function recoveryMessage(operation: string | undefined, ambiguous: boolean): string | undefined {
  return operation === 'export' && ambiguous
    ? 'Export result is unknown. List credentials and revoke unwanted entries before exporting again.'
    : undefined
}
