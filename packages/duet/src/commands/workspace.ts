import {
  ensureArgCount,
  ensureNoArgs,
  printJsonOrHuman,
  printResult,
  resolveWorkspace,
  responseJson,
  type CommandContext,
  type CommandRegistry,
} from '../cli-support.js'
import { saveConfig } from '../config.js'
import { EXIT_CODES, CliError, usageError } from '../exit-codes.js'

export function registerWorkspaceCommands(registry: CommandRegistry): void {
  registry.register('workspace', workspace)
}

async function workspace(args: string[], ctx: CommandContext): Promise<void> {
  const [subcommand, ...rest] = args
  if (subcommand === 'use') {
    ensureArgCount(rest, 1, 'workspace use <slug>')
    const nextConfig = {
      ...ctx.config,
      defaultWorkspace: resolveWorkspace(ctx, rest[0]),
    }
    await saveConfig(nextConfig, ctx.configPath)
    printResult(ctx, { ok: true, defaultWorkspace: rest[0] }, `Default workspace: ${rest[0]}\n`)
    return
  }
  if (subcommand === 'create') {
    ensureArgCount(rest, 1, 'workspace create <slug>')
    const slug = rest[0]!
    const response = await ctx.api.request('/workspaces', {
      method: 'POST',
      json: { slug, name: slug },
    })
    await printJsonOrHuman(response, ctx)
    return
  }
  if (subcommand === 'ls') {
    ensureNoArgs(rest, 'workspace ls')
    const workspaces = await loadWorkspaces(ctx)
    printResult(
      ctx,
      { workspaces },
      `${workspaces.map(workspace => String(workspace.slug ?? '')).join('\n')}${workspaces.length === 0 ? '' : '\n'}`,
    )
    return
  }
  if (subcommand === 'status') {
    if (rest.length > 1) throw usageError('Usage: workspace status [slug]')
    const slug = resolveWorkspace(ctx, rest[0])
    const workspace = (await loadWorkspaces(ctx)).find(candidate => candidate.slug === slug)
    if (workspace === undefined) {
      throw new CliError('not_found', `Workspace not found: ${slug}`, EXIT_CODES.notFound)
    }
    printResult(ctx, { workspace }, `${workspace.slug}: ${String(workspace.status ?? 'unknown')}\n`)
    return
  }
  throw usageError('Usage: workspace create|ls|status|use ...')
}

async function loadWorkspaces(ctx: CommandContext): Promise<Array<Record<string, unknown>>> {
  const body = await responseJson(await ctx.api.request('/whoami'))
  if (typeof body !== 'object' || body === null) return []
  const workspaces = (body as { workspaces?: unknown }).workspaces
  return Array.isArray(workspaces)
    ? workspaces.filter(
        (workspace): workspace is Record<string, unknown> =>
          typeof workspace === 'object' && workspace !== null,
      )
    : []
}
