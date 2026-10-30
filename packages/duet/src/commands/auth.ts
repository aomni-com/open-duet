import { ensureNoArgs, printJsonOrHuman, type CommandRegistry } from '../cli-support.js'
import { runLoginCommand } from '../cli/login.js'

export function registerAuthCommands(registry: CommandRegistry): void {
  registry.register('login', runLoginCommand)
  registry.register('whoami', async (args, ctx) => {
    ensureNoArgs(args, 'whoami')
    await printJsonOrHuman(await ctx.api.request('/whoami'), ctx)
  })
}
