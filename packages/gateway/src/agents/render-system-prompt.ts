import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { parentSystemPromptLayers } from '@repo/agent/turn-runner/prompts'
import { SkillContext } from '@repo/agent/turn-runner/skill-context'
import type {
  GatewayAgentConfig,
  GatewayAnchor,
  GatewayAppConfig,
} from '@repo/contract'

import { DEVELOPER_SYSTEM_PROMPT } from '../runner/developer-system-prompt'
import { resolveAgentCwd } from '../runner/process-runner'
import { resolveAgentContext } from './agent-context'

export interface RenderSystemPromptArgs {
  driveDir: string
  /** Receives the generated layer files, exactly as a launch would write them. */
  stateDir: string
  /** Drive-relative. Defaults to the drive root. */
  cwd?: string
  workspaceSlug?: string
  /** The roster the gateway would hold from vm-sync; absent means none has arrived. */
  agents?: readonly GatewayAgentConfig[]
  apps?: readonly GatewayAppConfig[]
  onboarding?: boolean
  defaultSession?: boolean
  createdBySessionId?: string
  /**
   * The home directory whose `.duet`/`.agents`/`.claude` skills count as
   * global. Pass an empty directory to keep this machine's own skills out of
   * the render.
   */
  skillsHome: string
  /** The tier runs an advisor beside the executor. */
  advisor?: boolean
}

export interface RenderedSystemPrompt {
  /** The exact string the model receives as its system prompt. */
  prompt: string
  /** One row per contribution, in prompt order. */
  layers: Array<{ name: string; chars: number }>
}

/**
 * Render the system prompt a session would start with, without a model.
 *
 * It exists because the prompt is assembled across two processes — the
 * gateway picks and writes the per-session layers, the agent runtime wraps
 * them with its own — and nobody could read the result without launching a
 * turn. Same resolver as a launch (`resolveAgentContext`), same argv contract
 * (`--system-prompt` is the developer prompt, each file its own
 * `<system_prompt_file>` block), same trailing layers as the live parent agent
 * (`parentSystemPromptLayers`). What it cannot carry is the per-turn material
 * that rides outside the system prompt: the memory observation block and the
 * conversation itself.
 */
export async function renderSystemPrompt(
  args: RenderSystemPromptArgs,
): Promise<RenderedSystemPrompt> {
  const anchors = anchorsFromRoster(args.agents ?? [])
  const context = resolveAgentContext({
    cwd: args.cwd,
    driveDir: args.driveDir,
    stateDir: args.stateDir,
    defaultMemoryDbPath: join(args.stateDir, 'memory.db'),
    anchors,
    onboarding: args.onboarding,
    ...(args.defaultSession === true ? { defaultSession: true as const } : {}),
    createdBySessionId: args.createdBySessionId,
    apps: args.apps === undefined ? undefined : () => args.apps ?? [],
    agents: args.agents === undefined ? undefined : () => args.agents,
    workspaceSlug: () => args.workspaceSlug,
  })
  const cwd = resolveAgentCwd(args.driveDir, args.cwd)
  const skillContext = new SkillContext({
    cwd,
    systemInstructions: DEVELOPER_SYSTEM_PROMPT,
    systemPromptFiles: [...context.systemPromptFiles],
    skillDiscovery: { includeDefaults: true, agentDir: join(args.skillsHome, '.agents') },
    memoryDbPath: context.memoryDbPath,
  })
  await skillContext.ensureLoaded()
  const prompt = skillContext.createSystemPromptWithAppendedLayers({
    append: parentSystemPromptLayers({
      mode: 'auto',
      recallMemory: true,
      advisor: args.advisor === true,
    }),
  })

  const fileLayers = context.systemPromptFiles.map(file => ({
    name: basename(file),
    chars: readFileSync(file, 'utf8').length,
  }))
  const accounted =
    DEVELOPER_SYSTEM_PROMPT.length + fileLayers.reduce((total, layer) => total + layer.chars, 0)
  return {
    prompt,
    layers: [
      { name: 'developer-system-prompt', chars: DEVELOPER_SYSTEM_PROMPT.length },
      ...fileLayers,
      { name: 'agent runtime (tools, cwd, skills, routing guidance)', chars: prompt.length - accounted },
    ],
  }
}

/**
 * The anchors a gateway would hold for this roster. Anchors own paths and
 * agents own identity, joined on `agentId`; a render needs only that join.
 */
function anchorsFromRoster(agents: readonly GatewayAgentConfig[]): GatewayAnchor[] {
  return agents.flatMap(member =>
    member.kind === 'root'
      ? []
      : [
          {
            id: member.anchorId,
            agentId: member.agentId,
            workspaceId: 'workspace',
            path: member.anchorPath,
            kind: 'agent' as const,
            settings: {},
            state: 'active' as const,
            createdAt: 0,
            updatedAt: 0,
            markerNonce: '',
          },
        ],
  )
}
