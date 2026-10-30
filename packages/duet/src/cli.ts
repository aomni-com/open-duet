#!/usr/bin/env bun
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import packageJson from '../package.json' with { type: 'json' }
import { agent } from './agent.js'
import { billing } from './billing.js'
import {
  CommandRegistry,
  cliErrorFromUnknown,
  createCommandContext,
  hasJsonFlag,
  redactDetails,
  resolveWorkspace,
  writeJson,
  writeText,
  type CliResult,
  type CliRuntime,
  type CommandContext,
} from './cli-support.js'
import { runHelpText } from './cli/help.js'
import { registerAppCommands } from './commands/apps.js'
import { registerAuthCommands } from './commands/auth.js'
import { registerFileCommands } from './commands/files.js'
import { registerMemoryCommands } from './commands/memory.js'
import { registerWorkspaceCommands } from './commands/workspace.js'
import { registerServiceCommands } from './commands/services.js'
import { importSessions } from './import.js'
import { registerSyncCommands } from './sync/run.js'
import { train } from './train.js'

export type { CliIo, CliResult, CliRuntime, WritableSink } from './cli-support.js'
const PACKAGE_METADATA = { name: packageJson.name, version: packageJson.version }

/** One dispatch owner; saved defaults select targets, never local/remote mode. */
export async function runCli(
  argv = process.argv.slice(2),
  runtime: CliRuntime = {},
): Promise<CliResult> {
  const io = runtime.io ?? { stdout: process.stdout, stderr: process.stderr }
  try {
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
      writeText(io.stdout, `${packageJson.version}\n`)
      return { exitCode: 0 }
    }
    const { parsed, ctx } = await createCommandContext(argv, runtime)
    const [command, ...args] = parsed.args
    if ((!command && ctx.global.help) || command === 'help') {
      writeText(io.stdout, runHelpText(PACKAGE_METADATA.name))
      return { exitCode: 0 }
    }
    const registry = new CommandRegistry()
    registerAuthCommands(registry)
    registerAppCommands(registry)
    registerFileCommands(registry)
    registerWorkspaceCommands(registry)
    registerServiceCommands(registry)
    registerSyncCommands(registry)
    registry.register('agent', agent)
    registry.register('billing', billing)
    registry.register('import', importSessions)
    if (ctx.global.workspace) {
      registerMemoryCommands(registry)
      registry.register('memories', (args, ctx) => registry.dispatch(['memory', ...args], ctx))
      registry.register('train', (args, ctx) => train([resolveWorkspace(ctx), ...args], ctx))
    }
    if (command && registry.commands.has(command)) {
      if (ctx.global.help) writeText(io.stdout, runHelpText(PACKAGE_METADATA.name))
      else await registry.dispatch(parsed.args, ctx)
    } else {
      await runLocalCommand(command, args, ctx)
      return { exitCode: Number(process.exitCode ?? 0) }
    }
    return { exitCode: 0 }
  } catch (error) {
    const cliError = cliErrorFromUnknown(error)
    if (hasJsonFlag(argv))
      writeJson(io.stderr, {
        error: cliError.code,
        message: cliError.message,
        ...redactDetails(cliError.details),
      })
    else writeText(io.stderr, `${cliError.message}\n`)
    return { exitCode: cliError.exitCode }
  }
}

async function runLocalCommand(
  command: string | undefined,
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  if (ctx.global.workspace) process.env.DUET_WORKSPACE = ctx.global.workspace
  if (ctx.global.apiUrl) process.env.DUET_API_URL = ctx.global.apiUrl
  if (ctx.global.json) args.push('--json')
  if (ctx.global.help) args.push('--help')
  const { loadConnectedTransportSnapshot } =
    await import('@repo/agent/connected-providers/snapshot')
  await loadConnectedTransportSnapshot()
  switch (command) {
    case 'upgrade':
      return await (await import('./cli/upgrade.js')).runUpgradeCommand(args, PACKAGE_METADATA.name)
    case 'skills':
      return (await import('./cli/skills.js')).runSkillsCommand(args)
    case 'env':
      return await (await import('./cli/env.js')).runEnvCommand(args)
    case 'connect':
      return await (await import('./cli/connect.js')).runConnectCommand(args)
    case 'memory':
    case 'memories':
      return await (await import('./cli/memory.js')).runMemoryCommand(args)
    case 'model':
      return await (await import('./cli/model.js')).runModelCommand(args)
    case 'route':
      await (await import('./cli/route.js')).runRouteCommand(args)
      return
    case 'config':
      return await (await import('./cli/config.js')).runConfigCommand(args)
    case 'train':
      return await (await import('./cli/train.js')).runTrainCommand(args)
    case 'send-feedback':
      return await (await import('./cli/send-feedback.js')).runSendFeedbackCommand(args)
  }
  const runArgs = command === undefined ? args : [command, ...args]
  if (runArgs.includes('--rpc'))
    return await (await import('./cli/rpc.js')).runRpcCommand(runArgs, PACKAGE_METADATA)
  await (await import('./cli/run.js')).runRunCommand(runArgs, PACKAGE_METADATA)
}

/** True only when the dispatcher file itself, rather than cli-entry or a test, was invoked. */
export function isDirectCliInvocation(moduleUrl: string, invokedPath: string | undefined): boolean {
  if (!invokedPath) return false
  const moduleName = basename(fileURLToPath(moduleUrl))
  return ['cli.ts', 'cli.js'].includes(moduleName) && basename(invokedPath) === moduleName
}

// Bun's single-file compiler gives dynamically imported modules the executable's
// URL. The explicit filename check keeps cli-entry as the sole compiled owner.
if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  void runCli().then(result => {
    process.exitCode = result.exitCode
  })
}
