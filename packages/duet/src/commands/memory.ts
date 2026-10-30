import {
  parseNamedOptions,
  printJsonOrHuman,
  resolveWorkspace,
  type CommandContext,
  type CommandRegistry,
} from '../cli-support.js'
import { usageError } from '../exit-codes.js'

export function registerMemoryCommands(registry: CommandRegistry): void {
  registry.register('memory', memory)
}

async function memory(args: string[], ctx: CommandContext): Promise<void> {
  const [subcommand, ...rest] = args
  if (subcommand === 'add') {
    const options = parseNamedOptions(rest, ['source'])
    if (options.positionals.length !== 1)
      throw usageError('Usage: memory add <content> [--source <source>]')
    const addressWorkspace = resolveWorkspace(ctx)
    const response = await ctx.api.request(`/ws/${encodeURIComponent(addressWorkspace)}/memories`, {
      method: 'POST',
      json: {
        content: options.positionals[0],
        source: options.values.source?.[0] ?? 'user',
      },
    })
    await printJsonOrHuman(response, ctx)
    return
  }
  if (subcommand === 'recall') {
    const options = parseNamedOptions(rest, ['limit'])
    if (options.positionals.length !== 1) throw usageError('Usage: memory recall <q> [--limit <n>]')
    const limit = options.values.limit?.[0] ?? '10'
    const workspaceSlug = resolveWorkspace(ctx)
    const response = await ctx.api.request(
      `/ws/${encodeURIComponent(workspaceSlug)}/memories/search?q=${encodeURIComponent(options.positionals[0]!)}&limit=${encodeURIComponent(limit)}`,
    )
    await printJsonOrHuman(response, ctx)
    return
  }
  throw usageError('Usage: memory add|recall ...')
}
