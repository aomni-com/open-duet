import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

import { TurnRunner, type AgentConfigInput } from '@repo/agent'

// Exercise the installed CLI's loader and transport header owner, without exposing
// either internal agent module as a production gateway dependency.
const require = createRequire(import.meta.url)
const agentRoot = dirname(require.resolve('@repo/agent/package.json'))
const { createAssistantMessageEventStream } = await import(
  Bun.resolveSync('@earendil-works/pi-ai', agentRoot)
)
const { duetGatewayHeaders } = await import('@repo/agent/model-resolution/gateway-headers')

// Routing fixtures exercise bound VM billing without a host-selected workspace.
delete process.env.DUET_WORKSPACE

class ControlledRunner extends TurnRunner {
  private loadedRouter?: ReturnType<TurnRunner['createModelRouter']>
  classifierCalls = 0
  requests: Array<{ model: string; header: Record<string, string> | undefined }> = []
  protected override createModelRouter(options: Parameters<TurnRunner['createModelRouter']>[0]) {
    this.loadedRouter = super.createModelRouter({
      ...options,
      classify: async () => {
        this.classifierCalls++
        if (process.argv.includes('--compound')) return { route: 'general' }
        throw new Error('Alias classification is forbidden')
      },
    })
    return this.loadedRouter
  }
  async exerciseMilestones() {
    const router = this.loadedRouter!
    router.noteTurnStart({ promptHasImages: true })
    router.noteCompaction()
    router.noteAssistantStep({ blockTypes: ['image'], text: '' })
    for (let i = 0; i < 20; i++) router.noteAssistantStep()
    await router.prepareTurn({})
  }
  protected override createAgent(
    input: AgentConfigInput,
    onControlResult?: Parameters<TurnRunner['createAgent']>[1],
  ) {
    const agent = super.createAgent(input, onControlResult)
    agent.streamFunction = model => {
      this.requests.push({ model: model.id, header: duetGatewayHeaders() })
      const stream = createAssistantMessageEventStream()
      queueMicrotask(async () => {
        if (process.argv.includes('--hold')) {
          process.send?.({ ready: true })
          await new Response(Bun.stdin.stream()).text()
        }
        const message = {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'done' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop' as const,
          timestamp: 0,
        }
        if (process.argv.includes('--fail')) {
          stream.push({
            type: 'error',
            reason: 'error',
            error: { ...message, stopReason: 'error', errorMessage: 'unsupported request fixture' },
          })
        } else stream.push({ type: 'done', reason: 'stop', message })
      })
      return stream
    }
    return agent
  }
}

const cwd = process.argv[2]!
const selection = process.argv[3]!
const runner = new ControlledRunner({
  model: selection,
  cwd,
  mode: 'agent',
  memoryDbPath: false,
  memoryStores: false,
  skillDiscovery: { includeDefaults: false },
})
const checkpoint = process.env.ROUTING_CHECKPOINT_PATH
await runner.start({
  type: 'start',
  ...(checkpoint && existsSync(checkpoint)
    ? { state: JSON.parse(readFileSync(checkpoint, 'utf8')) }
    : {}),
})
await runner.exerciseMilestones()
const status = runner.routeStatus()
if (process.argv.includes('--compound')) {
  if (!status) throw new Error('Managed compound routing status is missing')
}
const terminal = await runner.turn({
  type: 'prompt',
  message: 'Answer briefly.',
  behavior: 'follow_up',
})
if (checkpoint) writeFileSync(checkpoint, JSON.stringify(terminal.state))
console.log(
  JSON.stringify({
    selection: terminal.state.options?.model,
    status,
    classifierCalls: runner.classifierCalls,
    requests: runner.requests,
    terminal: terminal.type,
    errors: terminal.state.agent.messages.flatMap(message =>
      message.role === 'assistant' && message.stopReason === 'error' ? [message.model] : [],
    ),
  }),
)
