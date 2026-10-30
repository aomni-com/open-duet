import { UsageReportGroupSchema, UsageReportPeriodSchema } from '@repo/contract'

import { parseNamedOptions, resolveWorkspace } from './cli-support.js'
import { type DuetConfig } from './config.js'
import { usageError } from './exit-codes.js'
import { type ApiClient } from './http.js'

// Help text and validation errors compose the choices from the schema that
// validates them, so adding a period or group cannot leave a surface behind.
const PERIODS = UsageReportPeriodSchema.options.join('|')
const GROUPS = UsageReportGroupSchema.options.join('|')

export const BILLING_USAGE_SYNOPSIS = `billing usage [workspace] [--period ${PERIODS}] [--group ${GROUPS}]`

interface BillingContext {
  global: { json: boolean; workspace?: string }
  config: DuetConfig
  api: ApiClient
  io: { stdout: { write(chunk: string): unknown } }
}

export async function billing(args: string[], ctx: BillingContext): Promise<void> {
  const [subcommand, ...rest] = args
  if (subcommand === 'usage') return await usage(rest, ctx)
  throw usageError(`Usage: ${BILLING_USAGE_SYNOPSIS} [--start <key>] [--end <key>] [--json]`)
}

async function usage(args: string[], ctx: BillingContext): Promise<void> {
  const options = parseNamedOptions(args, ['period', 'group', 'start', 'end'])
  if (options.positionals.length > 1) throw usageError(`Usage: ${BILLING_USAGE_SYNOPSIS}`)
  const workspace = resolveWorkspace(ctx, options.positionals[0])
  const period = UsageReportPeriodSchema.safeParse(options.values.period?.[0] ?? 'monthly')
  const group = UsageReportGroupSchema.safeParse(options.values.group?.[0] ?? 'workspace')
  if (!period.success) throw usageError(`Usage period must be one of: ${PERIODS}.`)
  if (!group.success) throw usageError(`Usage group must be one of: ${GROUPS}.`)
  const params = new URLSearchParams({ period: period.data, group: group.data })
  if (options.values.start?.[0] !== undefined) params.set('start', options.values.start[0])
  if (options.values.end?.[0] !== undefined) params.set('end', options.values.end[0])
  const response = await ctx.api.request(
    `/ws/${encodeURIComponent(workspace)}/billing/usage?${params}`,
  )
  const body = await response.json()
  if (ctx.global.json) {
    ctx.io.stdout.write(`${JSON.stringify(body)}\n`)
    return
  }
  ctx.io.stdout.write(`${JSON.stringify(body, null, 2)}\n`)
}
