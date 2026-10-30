import type {
  AgentTurnCommand,
  AgentTurnEvent,
  AgentTurnStartedEvent,
  AgentTurnState,
  McpServersConfig,
} from '@repo/contract'

export interface AgentTurnStartCommand {
  type: 'start'
  mode?: unknown
  state?: unknown
  options?: Record<string, unknown>
  mcpServers?: McpServersConfig
}

export type AgentTurnPromptCommand = Extract<AgentTurnCommand, { type: 'prompt' }> & {
  requestId: string
}

export type AgentTurnAnswerCommand = Extract<AgentTurnCommand, { type: 'answer' }> & {
  requestId: string
}

export interface AgentTurnInterruptCommand {
  type: 'interrupt'
}

export type AgentTurnWakeCommand = Extract<AgentTurnCommand, { type: 'wake' }> & {
  requestId: string
}

export type AgentRunnerCommand =
  | AgentTurnStartCommand
  | AgentTurnPromptCommand
  | AgentTurnAnswerCommand
  | AgentTurnWakeCommand
  | AgentTurnInterruptCommand

export type AgentRunnerEvent = AgentTurnEvent | { type: 'checkpoint'; state: AgentTurnState }
export type AgentRunnerStartedEvent = AgentTurnStartedEvent
