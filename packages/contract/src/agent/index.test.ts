import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { MAX_MCP_SERVERS_PER_WORKSPACE } from '../mcp/index'
import { ModelTierIdSchema } from '../model-tiers/index'
import {
  DefaultSessionMessageRequestSchema,
  DefaultSessionMessageWaitRequestSchema,
} from '../sessions/index'
import { WORKSPACE_MEMBER_LIMIT } from '../workspaces/index'
import {
  AgentVmRelayEventRequestSchema,
  isTranscriptEvent,
  CONVEX_EVENT_BUDGET_BYTES,
  AgentAnswerSubmittedEventSchema,
  AgentCwdSchema,
  canonicalAgentCwd,
  GatewaySessionCwdReceiptSchema,
  GatewaySessionCwdRequestSchema,
  GatewaySessionIntegrationsRefreshResponseSchema,
  GatewayRunnerInputReceiptSchema,
  GatewayRunnerInputRequestSchema,
  type AgentEventClass,
  AGENT_INPUT_IMAGE_MAX_COUNT,
  AGENT_INPUT_IMAGE_MAX_BYTES,
  MIN_SCHEDULE_INTERVAL_MS,
  AGENT_SESSION_EVENT_TYPES,
  AGENT_SESSION_STATUSES,
  AGENT_TERMINAL_STATES,
  type AgentTurnEvent,
  AgentInputImageSchema,
  AgentMessageRequestSchema,
  AgentMessageWaitRequestSchema,
  AgentNoteRequestSchema,
  AgentAnswerRequestSchema,
  AgentAnswerWaitRequestSchema,
  AgentStartSessionRequestSchema,
  AgentStartSessionWaitRequestSchema,
  AgentStartNestedSessionRequestSchema,
  AgentStartNestedSessionWaitRequestSchema,
  AgentSessionTimelineEventSchema,
  AgentTurnEventSchema,
  AgentTurnStateSchema,
  AgentStateMachineSessionSchema,
  AgentFollowUpQueueEntrySchema,
  AgentRpcCommandAcceptedEventSchema,
  AgentTodoSchema,
  AgentNoteSubmittedEventSchema,
  AgentPromptSubmittedEventSchema,
  RunnerDeliveryAttemptSchema,
  RUNNER_DELIVERY_KINDS,
  SessionInputSenderSchema,
  TurnStepSchema,
  classifyAgentTurnEvent,
  collectRunnerImages,
  isCanonicalEvent,
  isEphemeralEvent,
  isRunnerDeliverableInputEvent,
} from './index'

const runningTurnState = {
  status: 'running' as const,
  mode: 'agent' as const,
  agent: { status: 'running' as const, messages: [] },
}

const emptyTokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const emptyUsageFields = {
  turnUsage: emptyTokenUsage,
  usageByModel: [],
  lastMessageUsage: emptyTokenUsage,
  effectiveContextWindow: 200_000,
  contextWindowUsage: { systemPrompt: 0, messages: 0, localMemory: 0, globalMemory: 0 },
}

describe('agent timeline contract', () => {
  test('wait requests require one idempotency key', () => {
    const clientRequestId = '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91'

    for (const [schema, body] of [
      [AgentMessageWaitRequestSchema, { prompt: 'continue' }],
      [AgentAnswerWaitRequestSchema, { answer: 'approved' }],
    ] as const) {
      expect(schema.safeParse(body).success).toBe(false)
      expect(schema.safeParse({ ...body, clientRequestId }).success).toBe(true)
      expect(schema.safeParse({ ...body, clientRequestId, unexpected: true }).success).toBe(true)
    }
    expect(AgentStartSessionWaitRequestSchema.safeParse({ prompt: 'start' }).success).toBe(false)
    expect(
      AgentStartSessionWaitRequestSchema.safeParse({ prompt: 'start', clientRequestId }).success,
    ).toBe(true)
    expect(
      AgentStartSessionWaitRequestSchema.safeParse({
        prompt: 'start',
        clientRequestId,
        unexpected: true,
      }).success,
    ).toBe(false)

    expect(
      AgentStartSessionRequestSchema.parse({ prompt: 'async' }).clientRequestId,
    ).toBeUndefined()
    expect(AgentMessageRequestSchema.parse({ prompt: 'async' }).clientRequestId).toBeUndefined()
    expect(AgentAnswerRequestSchema.parse({ answer: 'async' }).clientRequestId).toBeUndefined()
  })

  test('ordinary and nested creation have separate strict transports', () => {
    const clientRequestId = '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91'

    expect(
      AgentStartSessionRequestSchema.safeParse({ prompt: 'start', unexpected: true }).success,
    ).toBe(false)
    expect(
      AgentStartNestedSessionRequestSchema.safeParse({
        prompt: 'child',
        audience: { kind: 'workspace' },
      }).success,
    ).toBe(false)
    expect(
      AgentStartNestedSessionWaitRequestSchema.safeParse({
        prompt: 'child',
        clientRequestId,
        audience: { kind: 'specific', memberUserIds: ['user_1'] },
      }).success,
    ).toBe(false)

    expect(AgentStartSessionRequestSchema.parse({ prompt: 'workspace' }).audience).toBeUndefined()
    expect(
      AgentStartSessionRequestSchema.parse({
        prompt: 'specific',
        audience: { kind: 'specific', memberUserIds: ['user_2', 'user_1', 'user_1'] },
      }).audience,
    ).toEqual({ kind: 'specific', memberUserIds: ['user_2', 'user_1', 'user_1'] })
    expect(
      AgentStartSessionRequestSchema.safeParse({
        prompt: 'maximum audience',
        audience: {
          kind: 'specific',
          memberUserIds: Array.from(
            { length: WORKSPACE_MEMBER_LIMIT },
            (_, index) => `user_${index}`,
          ),
        },
      }).success,
    ).toBe(true)
    for (const audience of [
      { kind: 'workspace' },
      {
        kind: 'specific',
        memberUserIds: Array.from(
          { length: WORKSPACE_MEMBER_LIMIT + 1 },
          (_, index) => `u${index}`,
        ),
      },
      { kind: 'specific', memberUserIds: ['user_1'], unexpected: true },
    ]) {
      expect(
        AgentStartSessionRequestSchema.safeParse({ prompt: 'invalid', audience }).success,
      ).toBe(false)
      expect(
        AgentStartSessionWaitRequestSchema.safeParse({
          prompt: 'invalid',
          clientRequestId,
          audience,
        }).success,
      ).toBe(false)
    }
  })

  test('accepts transport-bearing usage from @duetso/agent and rejects legacy rows', () => {
    const usageByModel = [
      {
        model: 'gpt-5.6-sol',
        transport: { provider: 'openai-codex' as const, billing: 'plan-covered' as const },
        usage: emptyTokenUsage,
      },
      {
        model: 'anthropic/claude-opus-4.8',
        transport: { provider: 'duet-gateway' as const, billing: 'metered' as const },
        usage: emptyTokenUsage,
      },
    ]
    const event = { type: 'usage' as const, ...emptyUsageFields, usageByModel }

    expect(AgentTurnEventSchema.parse(event)).toEqual(event)
    expect(
      AgentTurnEventSchema.safeParse({
        ...event,
        usageByModel: [{ model: 'gpt-5.6-sol', usage: emptyTokenUsage }],
      }).success,
    ).toBe(false)
  })

  test('defaults prompt behavior to steer and preserves an explicit follow-up', () => {
    expect(AgentStartSessionRequestSchema.parse({ prompt: 'start' })).toEqual({
      prompt: 'start',
      behavior: 'steer',
    })
    expect(
      AgentStartSessionRequestSchema.parse({ prompt: 'start later', behavior: 'follow_up' }),
    ).toEqual({
      prompt: 'start later',
      behavior: 'follow_up',
    })
    expect(AgentMessageRequestSchema.parse({ prompt: 'continue now' })).toEqual({
      prompt: 'continue now',
      behavior: 'steer',
    })
    expect(
      AgentMessageRequestSchema.parse({ prompt: 'after this', behavior: 'follow_up' }),
    ).toEqual({
      prompt: 'after this',
      behavior: 'follow_up',
    })
  })

  test('accepts input that carries only media, and rejects input that carries nothing', () => {
    const file = { path: 'uploads/brief.pdf', name: 'brief.pdf', bytes: 1024 }
    const image = { data: 'aGk=', mimeType: 'image/png' as const }
    const requestId = { clientRequestId: '00000000-0000-4000-8000-000000000000' }
    const routes = [
      { schema: AgentStartSessionRequestSchema, text: 'prompt' },
      { schema: AgentStartSessionWaitRequestSchema, text: 'prompt', ...requestId },
      { schema: AgentStartNestedSessionWaitRequestSchema, text: 'prompt', ...requestId },
      { schema: AgentMessageRequestSchema, text: 'prompt' },
      { schema: AgentMessageWaitRequestSchema, text: 'prompt', ...requestId },
      { schema: DefaultSessionMessageRequestSchema, text: 'prompt' },
      { schema: DefaultSessionMessageWaitRequestSchema, text: 'prompt', ...requestId },
      { schema: AgentNoteRequestSchema, text: 'note' },
      { schema: AgentAnswerRequestSchema, text: 'answer' },
      { schema: AgentAnswerWaitRequestSchema, text: 'answer', ...requestId },
    ] as const
    for (const { schema, text, ...rest } of routes) {
      const base = { ...rest, [text]: '' }
      expect(schema.safeParse({ ...base, attachments: [file] }).success).toBe(true)
      expect(schema.safeParse({ ...base, images: [image] }).success).toBe(true)
      expect(schema.safeParse(base).success).toBe(false)
      expect(schema.safeParse({ ...base, attachments: [], images: [] }).success).toBe(false)
      // Whitespace is not words: it says nothing on its own, and alongside a
      // file it is still a file-only message.
      expect(schema.safeParse({ ...base, [text]: ' \n ' }).success).toBe(false)
      expect(schema.safeParse({ ...base, [text]: ' ', attachments: [file] }).success).toBe(true)
    }
  })

  test('accepts sourceSessionId on injected input requests and never on creation', () => {
    for (const schema of [
      AgentMessageRequestSchema,
      AgentNoteRequestSchema,
      AgentAnswerRequestSchema,
    ]) {
      const content =
        schema === AgentMessageRequestSchema
          ? { prompt: 'continue' }
          : schema === AgentNoteRequestSchema
            ? { note: 'context' }
            : { answer: 'approved' }
      expect(schema.parse({ ...content, sourceSessionId: 'session-123' })).toMatchObject({
        sourceSessionId: 'session-123',
      })
      expect(schema.parse(content)).not.toHaveProperty('sourceSessionId')
      expect(schema.safeParse({ ...content, sourceSessionId: '' }).success).toBe(false)
      // The old origin request field is gone: a tolerant wire strips it rather
      // than honoring it, so it can never reach durable history.
      expect(schema.parse({ ...content, origin: 'session:parent-123' })).not.toHaveProperty(
        'origin',
      )
    }
    expect(
      AgentStartSessionRequestSchema.safeParse({ prompt: 'start', sourceSessionId: 'session-123' })
        .success,
    ).toBe(false)
    expect(
      AgentStartSessionWaitRequestSchema.safeParse({
        prompt: 'start',
        clientRequestId: '3b241101-e2bb-4255-8caf-4136c566a962',
        sourceSessionId: 'session-123',
      }).success,
    ).toBe(false)
  })

  test('rejects a poll interval below the session-create schedule floor', () => {
    const parsed = AgentStartSessionRequestSchema.safeParse({
      prompt: 'watch the deployment',
      mode: {
        name: 'deployment-watch',
        prompt: 'Wait for the deployment to finish.',
        states: [
          {
            name: 'poll-deployment',
            kind: 'poll',
            command: 'check deployment',
            intervalMs: `${MIN_SCHEDULE_INTERVAL_MS - 1}ms`,
          },
        ],
      },
    })

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues).toContainEqual(
      expect.objectContaining({ message: 'schedule_below_minimum' }),
    )
  })

  test('rejects a relative timer below the session-create schedule floor', () => {
    const parsed = AgentStartSessionRequestSchema.safeParse({
      prompt: 'remind me',
      mode: {
        name: 'reminder',
        prompt: 'Remind the user.',
        states: [{ name: 'wait', kind: 'timer', wakeAfterMs: MIN_SCHEDULE_INTERVAL_MS - 1 }],
      },
    })

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues).toContainEqual(
      expect.objectContaining({ message: 'schedule_below_minimum' }),
    )
  })

  test('accepts absolute timers, omitted mode, and unparseable duration strings at the wire', () => {
    const nearFutureAbsoluteTimer = {
      name: 'absolute-reminder',
      prompt: 'Remind the user at the requested instant.',
      states: [{ name: 'wait', kind: 'timer' as const, wakeAt: Date.now() + 5_000 }],
    }
    const runnerValidatedDuration = {
      name: 'runner-validated',
      prompt: 'Let the runner validate its duration grammar.',
      states: [{ name: 'wait', kind: 'timer' as const, wakeAfterMs: 'next Tuesday' }],
    }

    expect(
      AgentStartSessionRequestSchema.parse({
        prompt: 'remind me soon',
        mode: nearFutureAbsoluteTimer,
      }).mode,
    ).toEqual(nearFutureAbsoluteTimer)
    expect(AgentStartSessionRequestSchema.parse({ prompt: 'use auto mode' }).mode).toBeUndefined()
    expect(
      AgentStartSessionRequestSchema.parse({
        prompt: 'validate downstream',
        mode: runnerValidatedDuration,
      }).mode,
    ).toEqual(runnerValidatedDuration)
  })

  test('accepts virtual tiers and rejects the retired model field', () => {
    const model = { id: 'fixture/concrete-model', gatewayModelId: 'fixture/concrete-model' }
    const tier = ModelTierIdSchema.parse('frontier')

    expect(
      AgentStartSessionRequestSchema.parse({
        prompt: 'start',
        tier,
        clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
      }),
    ).toEqual({
      prompt: 'start',
      tier,
      clientRequestId: '018f47a0-4dd1-7c2e-9cb7-8f4e71da8b91',
      behavior: 'steer',
    })
    expect(AgentMessageRequestSchema.parse({ prompt: 'continue', tier })).toEqual({
      prompt: 'continue',
      tier,
      behavior: 'steer',
    })
    // Session creation is one of the deliberately strict transport families:
    // a retired field is rejected instead of silently changing launch policy.
    expect(
      AgentStartSessionRequestSchema.safeParse({ prompt: 'start', model: model.id }).success,
    ).toBe(false)
    expect(AgentMessageRequestSchema.parse({ prompt: 'continue', model: model.id })).toEqual({
      prompt: 'continue',
      behavior: 'steer',
    })
    expect(
      AgentStartSessionRequestSchema.safeParse({ prompt: 'start', tier: 'recommended' }).success,
    ).toBe(false)
    expect(
      AgentMessageRequestSchema.safeParse({ prompt: 'continue', tier: model.gatewayModelId })
        .success,
    ).toBe(false)

    expect(
      GatewayRunnerInputRequestSchema.parse({
        attemptId: 'attempt-1',
        throughSeq: 7,
        input: { kind: 'prompt', message: 'start', behavior: 'follow_up' },
        launch: { cwd: 'projects/demo', tier },
      }),
    ).toMatchObject({
      throughSeq: 7,
      input: { kind: 'prompt', behavior: 'follow_up' },
      launch: { cwd: 'projects/demo', tier },
    })
    expect(
      GatewayRunnerInputRequestSchema.safeParse({
        attemptId: 'attempt-legacy',
        throughSeq: 8,
        input: { kind: 'prompt', message: 'legacy', behavior: 'steer' },
        launch: { gatewayModelId: model.gatewayModelId },
      }).success,
    ).toBe(false)
    expect(
      GatewayRunnerInputReceiptSchema.parse({
        acceptedThroughSeq: 7,
        disposition: 'hydrated',
      }),
    ).toEqual({ acceptedThroughSeq: 7, disposition: 'hydrated' })
  })

  /* A route switch explains itself the way whichever classifier answered does —
     prose from a chat model, a probability per route from an evaluation model
     (`typesafe-ai/jev` since agent 0.3.24). A turn that ran one path must not
     have to invent the other's field, and an older runner sends neither. */
  test('accepts either classifier explanation on a route switch, or none', () => {
    const base = {
      type: 'router_switch' as const,
      tier: 'balanced',
      route: 'implement',
      fromModel: 'a',
      toModel: 'b',
      thinkingLevel: 'medium' as const,
      trigger: 'cadence' as const,
      visionFallback: false,
    }

    expect(AgentSessionTimelineEventSchema.parse({ ...base, rationale: 'long context' })).toEqual({
      ...base,
      rationale: 'long context',
    })
    expect(
      AgentSessionTimelineEventSchema.parse({ ...base, probabilities: { implement: 0.82 } }),
    ).toEqual({ ...base, probabilities: { implement: 0.82 } })
    expect(AgentSessionTimelineEventSchema.parse(base)).toEqual(base)
  })

  test('a stored terminal marker keeps its usage tally through the timeline parse', () => {
    // The backend stores terminals as lean markers (no runner state). The
    // marker member of the timeline union must declare the usage fields, or
    // this parse silently strips the tally on every history read.
    const turnUsage = {
      input: 1_200,
      output: 480,
      cacheRead: 9_000,
      cacheWrite: 300,
      totalTokens: 10_980,
      cost: { input: 0.0036, output: 0.0072, cacheRead: 0.0009, cacheWrite: 0.0011, total: 0.0128 },
    }
    const usageByModel = [
      {
        model: 'claude-sonnet-5',
        transport: { provider: 'duet-gateway' as const, billing: 'plan-covered' as const },
        usage: turnUsage,
      },
    ]
    const stored = {
      type: 'complete' as const,
      status: 'completed' as const,
      result: 'done',
      turnUsage,
      usageByModel,
    }

    expect(AgentSessionTimelineEventSchema.parse(stored)).toEqual(stored)
  })

  test('carries onboarding on launch and never rejects a request for an unknown field', () => {
    const base = {
      attemptId: 'attempt-1',
      throughSeq: 1,
      input: { kind: 'prompt' as const, message: 'start', behavior: 'follow_up' as const },
      launch: { cwd: 'agents/ads', tier: 'balanced' as const },
    }

    expect(
      GatewayRunnerInputRequestSchema.parse({
        ...base,
        launch: { ...base.launch, onboarding: true },
      }).launch.onboarding,
    ).toBe(true)
    expect(GatewayRunnerInputRequestSchema.parse(base).launch.onboarding).toBeUndefined()
    expect(
      GatewayRunnerInputRequestSchema.safeParse({
        ...base,
        launch: { ...base.launch, onboarding: 'yes' },
      }).success,
    ).toBe(false)

    // A gateway one release behind must ignore a field it does not know, not
    // 400 the input: its route rejects the whole request on a parse failure, so
    // a strict wire would fail every turn of any session carrying the new
    // field. The API only attaches `onboarding` to onboarding sessions, so the
    // skew window strands those specific sessions rather than the whole fleet.
    const forwardCompatible = GatewayRunnerInputRequestSchema.safeParse({
      ...base,
      futureTopLevel: 'ok',
      launch: { ...base.launch, futureLaunchField: 'ok' },
    })
    expect(forwardCompatible.success).toBe(true)
    expect(forwardCompatible.data?.launch.tier).toBe('balanced')
  })

  test('projects lineage and default identity through the gateway launch envelope', () => {
    const base = {
      attemptId: 'attempt-lineage',
      throughSeq: 2,
      input: { kind: 'prompt' as const, message: 'start', behavior: 'steer' as const },
      launch: { tier: 'balanced' as const },
    }
    const projected = GatewayRunnerInputRequestSchema.parse({
      ...base,
      launch: {
        ...base.launch,
        createdBySessionId: 'parent-session',
        defaultSession: true,
      },
    })

    expect(projected.launch).toMatchObject({
      createdBySessionId: 'parent-session',
      defaultSession: true,
    })
    expect(GatewayRunnerInputRequestSchema.parse(base).launch).toEqual({ tier: 'balanced' })
    expect(
      GatewayRunnerInputRequestSchema.safeParse({
        ...base,
        launch: { ...base.launch, defaultSession: false },
      }).success,
    ).toBe(false)
  })

  test('marks gateway launches that have a prepared integration session', () => {
    const base = {
      attemptId: 'attempt-integrations',
      throughSeq: 3,
      input: { kind: 'prompt' as const, message: 'start', behavior: 'steer' as const },
      launch: { tier: 'balanced' as const },
    }
    expect(
      GatewayRunnerInputRequestSchema.parse({
        ...base,
        launch: { ...base.launch, integrations: true },
      }).launch.integrations,
    ).toBe(true)
    expect(GatewayRunnerInputRequestSchema.parse(base).launch.integrations).toBeUndefined()
    expect(
      GatewayRunnerInputRequestSchema.safeParse({
        ...base,
        launch: {
          ...base.launch,
          integrations: { configId: 'internal-row-id' },
        },
      }).success,
    ).toBe(false)
  })

  test('represents a refreshed integrations launch or a fail-closed omission', () => {
    expect(GatewaySessionIntegrationsRefreshResponseSchema.parse({ integrations: true })).toEqual({
      integrations: true,
    })
    expect(GatewaySessionIntegrationsRefreshResponseSchema.parse({})).toEqual({})
  })

  // Custom MCP servers ride a second, independent launch field: a Composio
  // outage must not be able to take them out, and vice versa.
  test('carries custom mcp servers as names on their own launch field', () => {
    const base = {
      attemptId: 'attempt-mcp-servers',
      throughSeq: 4,
      input: { kind: 'prompt' as const, message: 'start', behavior: 'steer' as const },
      launch: { tier: 'balanced' as const },
    }

    expect(
      GatewayRunnerInputRequestSchema.parse({
        ...base,
        launch: { ...base.launch, mcpServers: [{ name: 'deepwiki' }, { name: 'acme_internal' }] },
      }).launch.mcpServers,
    ).toEqual([{ name: 'deepwiki' }, { name: 'acme_internal' }])

    // Absent means "this turn gets none", not "fail closed on the other field".
    expect(GatewayRunnerInputRequestSchema.parse(base).launch.mcpServers).toBeUndefined()
    expect(
      GatewayRunnerInputRequestSchema.parse({
        ...base,
        launch: { ...base.launch, integrations: true },
      }).launch.mcpServers,
    ).toBeUndefined()

    // An entry is an object so a later per-server field can ride along without
    // a second wire change; the extra field survives the parse rather than
    // being stripped by a version-skewed reader.
    expect(
      GatewayRunnerInputRequestSchema.parse({
        ...base,
        launch: { ...base.launch, mcpServers: [{ name: 'deepwiki', futureKnob: 1 }] },
      }).launch.mcpServers,
    ).toEqual([{ name: 'deepwiki', futureKnob: 1 }])

    // The name grammar is the contract's, not the route's: a bare string array,
    // a reserved name, and a name carrying the tool separator are all refused.
    for (const mcpServers of [
      ['deepwiki'],
      [{ name: 'integrations' }],
      [{ name: 'my__server' }],
      [{ name: '' }],
      [{}],
      Array.from({ length: MAX_MCP_SERVERS_PER_WORKSPACE + 1 }, (_, index) => ({
        name: `server-${index}`,
      })),
    ]) {
      expect(
        GatewayRunnerInputRequestSchema.safeParse({
          ...base,
          launch: { ...base.launch, mcpServers },
        }).success,
        JSON.stringify(mcpServers).slice(0, 60),
      ).toBe(false)
    }
  })

  test('represents a refreshed mcp-server launch or its absence', () => {
    expect(
      GatewaySessionIntegrationsRefreshResponseSchema.parse({
        integrations: true,
        mcpServers: [{ name: 'deepwiki' }],
      }),
    ).toEqual({ integrations: true, mcpServers: [{ name: 'deepwiki' }] })
    expect(
      GatewaySessionIntegrationsRefreshResponseSchema.parse({ mcpServers: [] }).mcpServers,
    ).toEqual([])
    expect(GatewaySessionIntegrationsRefreshResponseSchema.parse({}).mcpServers).toBeUndefined()
  })

  test('round-trips a validated state-machine mode through the gateway launch wire', () => {
    const base = {
      attemptId: 'attempt-mode',
      throughSeq: 1,
      input: { kind: 'prompt' as const, message: 'start', behavior: 'steer' as const },
      launch: { tier: 'balanced' as const },
    }
    const mode = {
      name: 'deployment-watch',
      prompt: 'Watch the deployment.',
      states: [
        {
          name: 'poll',
          kind: 'poll' as const,
          command: 'check deployment',
          intervalMs: '30s',
        },
      ],
    }

    expect(
      GatewayRunnerInputRequestSchema.parse({
        ...base,
        launch: { ...base.launch, mode },
      }).launch.mode,
    ).toEqual(mode)
    expect(
      GatewayRunnerInputRequestSchema.safeParse({
        ...base,
        launch: { ...base.launch, mode: { name: 'missing-definition-fields' } },
      }).success,
    ).toBe(false)
  })

  test('parses the loose gateway session cwd request and canonical receipt wire', () => {
    expect(
      GatewaySessionCwdRequestSchema.parse({
        cwd: 'one/../two',
        futureRequestField: 'retained',
      }),
    ).toEqual({ cwd: 'one/../two', futureRequestField: 'retained' })
    expect(
      GatewaySessionCwdReceiptSchema.parse({
        cwd: 'two',
        futureReceiptField: 'retained',
      }),
    ).toEqual({ cwd: 'two', futureReceiptField: 'retained' })
    expect(GatewaySessionCwdRequestSchema.safeParse({ cwd: '../outside' }).success).toBe(false)
  })

  test('carries the accepted input boundary beside a relayed terminal', () => {
    expect(
      AgentVmRelayEventRequestSchema.parse({
        relayId: 'relay-1',
        event: { type: 'step', step: { type: 'text', text: 'done' } },
        acceptedThroughSeq: 4,
      }),
    ).toMatchObject({ relayId: 'relay-1', acceptedThroughSeq: 4 })
    expect(
      AgentVmRelayEventRequestSchema.safeParse({
        relayId: 'relay-1',
        event: { type: 'step', step: { type: 'text', text: 'done' } },
        acceptedThroughSeq: -1,
      }).success,
    ).toBe(false)
    expect(
      AgentVmRelayEventRequestSchema.parse({
        relayId: 'old-relay',
        event: { type: 'step', step: { type: 'text', text: 'done' } },
      }),
    ).toEqual({
      relayId: 'old-relay',
      event: { type: 'step', step: { type: 'text', text: 'done' } },
    })
    expect(() =>
      AgentVmRelayEventRequestSchema.parse({
        event: { type: 'step', step: { type: 'text', text: 'done' } },
      }),
    ).toThrow()
  })

  test('parses submitted prompt events and rejects malformed prompt events', () => {
    expect(
      AgentPromptSubmittedEventSchema.parse({
        type: 'prompt_submitted',
        prompt: 'summarize demo:/reports',
        inputKind: 'initial',
        behavior: 'steer',
        sender: { kind: 'user', userId: 'user-1' },
      }),
    ).toEqual({
      type: 'prompt_submitted',
      prompt: 'summarize demo:/reports',
      inputKind: 'initial',
      behavior: 'steer',
      sender: { kind: 'user', userId: 'user-1' },
    })
    expect(
      AgentPromptSubmittedEventSchema.safeParse({
        type: 'prompt_submitted',
        prompt: 'follow up',
        inputKind: 'retry',
        behavior: 'steer',
        sender: { kind: 'system' },
      }).success,
    ).toBe(false)
    expect(
      AgentPromptSubmittedEventSchema.safeParse({
        type: 'prompt_submitted',
        prompt: 'missing behavior',
        inputKind: 'message',
        sender: { kind: 'system' },
      }).success,
    ).toBe(false)
    expect(
      AgentPromptSubmittedEventSchema.safeParse({
        type: 'prompt_submitted',
        inputKind: 'message',
        behavior: 'steer',
        sender: { kind: 'system' },
      }).success,
    ).toBe(false)
  })

  test('requires one typed sender on every durable input event', () => {
    const cases = [
      [
        AgentPromptSubmittedEventSchema,
        {
          type: 'prompt_submitted',
          prompt: 'continue',
          inputKind: 'message',
          behavior: 'steer',
        },
      ],
      [
        AgentNoteSubmittedEventSchema,
        {
          type: 'note_submitted',
          note: 'context',
        },
      ],
      [
        AgentAnswerSubmittedEventSchema,
        {
          type: 'answer_submitted',
          answer: 'approved',
        },
      ],
    ] as const

    const senders = [
      { kind: 'user', userId: 'user-1' },
      { kind: 'app', appId: 'app-1' },
      { kind: 'session', sessionId: 'session-parent-123' },
      { kind: 'system' },
    ] as const

    for (const [schema, event] of cases) {
      for (const sender of senders) {
        expect(schema.parse({ ...event, sender })).toMatchObject({ sender })
      }
      // sender is required, exact, and identity-only
      expect(schema.safeParse(event).success).toBe(false)
      expect(schema.safeParse({ ...event, sender: { kind: 'user' } }).success).toBe(false)
      expect(schema.safeParse({ ...event, sender: { kind: 'app', appId: '' } }).success).toBe(false)
      expect(schema.safeParse({ ...event, sender: 'user' }).success).toBe(false)
      // origin and submittedAt are deleted concepts: a tolerant wire strips them
      const parsed = schema.parse({
        ...event,
        sender: { kind: 'system' },
        origin: 'session:parent-123',
        submittedAt: '2026-07-07T00:00:00.000Z',
      })
      expect(parsed).not.toHaveProperty('origin')
      expect(parsed).not.toHaveProperty('submittedAt')
    }
  })

  test('parses the identity-only sender union and rejects impostor shapes', () => {
    expect(SessionInputSenderSchema.parse({ kind: 'user', userId: 'user-1' })).toEqual({
      kind: 'user',
      userId: 'user-1',
    })
    expect(SessionInputSenderSchema.parse({ kind: 'system' })).toEqual({ kind: 'system' })
    expect(SessionInputSenderSchema.safeParse({ kind: 'session' }).success).toBe(false)
    expect(SessionInputSenderSchema.safeParse({ kind: 'viewer' }).success).toBe(false)
    // No display identity ever persists inside a sender.
    expect(
      SessionInputSenderSchema.parse({ kind: 'user', userId: 'user-1', email: 'a@b.c' }),
    ).not.toHaveProperty('email')
  })

  test('parses submitted note events and rejects malformed note events', () => {
    expect(
      AgentNoteSubmittedEventSchema.parse({
        type: 'note_submitted',
        note: 'Prefer the shorter patch.',
        sender: { kind: 'user', userId: 'user-1' },
      }),
    ).toEqual({
      type: 'note_submitted',
      note: 'Prefer the shorter patch.',
      sender: { kind: 'user', userId: 'user-1' },
    })
    expect(
      AgentNoteSubmittedEventSchema.safeParse({
        type: 'note_submitted',
        sender: { kind: 'user', userId: 'user-1' },
      }).success,
    ).toBe(false)
    expect(
      AgentNoteSubmittedEventSchema.safeParse({
        type: 'user_note',
        note: 'Prefer the shorter patch.',
        sender: { kind: 'user', userId: 'user-1' },
      }).success,
    ).toBe(false)
  })

  test('parses submitted answer events and rejects malformed answer events', () => {
    expect(
      AgentAnswerSubmittedEventSchema.parse({
        type: 'answer_submitted',
        answer: 'Use option A.',
        sender: { kind: 'user', userId: 'user-1' },
      }),
    ).toEqual({
      type: 'answer_submitted',
      answer: 'Use option A.',
      sender: { kind: 'user', userId: 'user-1' },
    })
    expect(
      AgentAnswerSubmittedEventSchema.safeParse({
        type: 'answer_submitted',
        sender: { kind: 'user', userId: 'user-1' },
      }).success,
    ).toBe(false)
    expect(
      AgentAnswerSubmittedEventSchema.safeParse({
        type: 'answer_submitted',
        answer: 'Use option A.',
      }).success,
    ).toBe(false)
  })

  test('parses session timeline events across session, runner, and user shapes', () => {
    expect(
      AgentSessionTimelineEventSchema.safeParse({
        type: 'session_created',
        prompt: 'summarize demo:/reports',
        createdAt: '2026-07-07T00:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      AgentSessionTimelineEventSchema.safeParse({
        type: 'turn_started',
        state: runningTurnState,
      }).success,
    ).toBe(true)
    expect(
      AgentSessionTimelineEventSchema.safeParse({
        type: 'complete',
        result: 'done',
      }).success,
    ).toBe(true)
    expect(AgentTurnEventSchema.safeParse({ type: 'turn_started' }).success).toBe(false)
    expect(
      AgentSessionTimelineEventSchema.safeParse({
        type: 'interrupt_requested',
        requestedAt: '2026-07-07T00:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      AgentSessionTimelineEventSchema.safeParse({
        type: 'note_submitted',
        note: 'Prefer the shorter patch.',
        sender: { kind: 'user', userId: 'user-1' },
      }).success,
    ).toBe(true)
    expect(
      AgentSessionTimelineEventSchema.safeParse({
        type: 'note_submitted',
        note: 'Prefer the shorter patch.',
      }).success,
    ).toBe(false)
    // The renamed discriminants must fail parsing outright — no aliases.
    expect(
      AgentSessionTimelineEventSchema.safeParse({
        type: 'user_note',
        note: 'Prefer the shorter patch.',
        submittedAt: '2026-07-07T00:00:00.000Z',
      }).success,
    ).toBe(false)
    expect(
      AgentSessionTimelineEventSchema.safeParse({
        type: 'user_prompt',
        prompt: 'continue',
        inputKind: 'message',
        behavior: 'steer',
        submittedAt: '2026-07-07T00:00:00.000Z',
      }).success,
    ).toBe(false)
  })

  test('keeps lean stored ask markers on the exact runner question contract', () => {
    expect(
      AgentSessionTimelineEventSchema.parse({
        type: 'ask',
        questions: [
          {
            question: 'Ship it?',
            header: 'Release',
            options: [{ label: 'Yes', description: 'Deploy now.' }],
          },
        ],
      }),
    ).toEqual({
      type: 'ask',
      questions: [
        {
          question: 'Ship it?',
          header: 'Release',
          options: [{ label: 'Yes', description: 'Deploy now.' }],
        },
      ],
    })
    expect(
      AgentSessionTimelineEventSchema.safeParse({
        type: 'ask',
        questions: [{ prompt: 'Legacy question' }],
      }).success,
    ).toBe(false)
  })

  test('keeps lean terminal marker statuses on the exact session literals', () => {
    for (const event of [
      { type: 'complete', status: 'not-complete' },
      { type: 'ask', status: 'not-ask', questions: [] },
      { type: 'interrupted', status: 'not-interrupted' },
      { type: 'sleep', status: 'not-sleep', wakeAt: 1_800_000_000_000 },
    ]) {
      expect(AgentSessionTimelineEventSchema.safeParse(event).success).toBe(false)
    }
  })

  test('keeps the SSE listener roster in lockstep with the timeline union', () => {
    // stream.ts registers one SSE listener per roster entry; a timeline
    // discriminant missing from the roster is a silently dropped event class.
    const literals = new Set(
      (AgentSessionTimelineEventSchema.options as readonly z.ZodType[]).flatMap(member =>
        'options' in member ? schemaTypeLiterals(member) : [schemaTypeLiteral(member)],
      ),
    )
    expect([...literals].sort()).toEqual([...AGENT_SESSION_EVENT_TYPES].sort())
  })

  test('keeps runner and input event type literals disjoint', () => {
    const runnerTypes = schemaTypeLiterals(AgentTurnEventSchema)
    const inputTypes = [
      schemaTypeLiteral(AgentPromptSubmittedEventSchema),
      schemaTypeLiteral(AgentNoteSubmittedEventSchema),
      schemaTypeLiteral(AgentAnswerSubmittedEventSchema),
    ]

    expect(inputTypes.filter(type => runnerTypes.includes(type))).toEqual([])
  })

  test('classifies runner events with the frozen membership table', () => {
    const cases: Array<{ event: AgentTurnEvent; eventClass: AgentEventClass }> = [
      {
        event: { type: 'step', step: { type: 'text_delta', delta: 'hel' } },
        eventClass: 'ephemeral',
      },
      {
        event: { type: 'step', step: { type: 'reasoning_delta', delta: 'thinking' } },
        eventClass: 'ephemeral',
      },
      {
        // Durable, unlike the deltas: a reader who loads mid-turn must see the
        // tool call that is executing right now, not a transcript that stops
        // at the last finished step. The completed tool_call upserts over it
        // by toolCallId in the projection.
        event: {
          type: 'step',
          step: { type: 'tool_call_start', toolName: 'read_file', toolCallId: 'call-1' },
        },
        eventClass: 'canonical',
      },
      { event: { type: 'step', step: { type: 'text', text: 'hello' } }, eventClass: 'canonical' },
      {
        event: { type: 'step', step: { type: 'reasoning', text: 'because' } },
        eventClass: 'canonical',
      },
      {
        event: {
          type: 'step',
          step: {
            type: 'tool_call',
            toolName: 'read_file',
            toolCallId: 'call-1',
            input: { path: 'README.md' },
            isError: false,
            output: [{ type: 'text', text: 'ok' }],
          },
        },
        eventClass: 'canonical',
      },
      {
        event: { type: 'step', step: { type: 'system', message: 'nested system message' } },
        eventClass: 'canonical',
      },
      { event: { type: 'turn_started', state: runningTurnState }, eventClass: 'canonical' },
      { event: { type: 'todos', todos: [] }, eventClass: 'doc_patch' },
      { event: { type: 'follow_up_queue', followUpQueue: [] }, eventClass: 'doc_patch' },
      {
        event: {
          type: 'state_machine',
          stateMachine: {
            definition: { name: 'draft', prompt: 'Draft.', states: [] },
            prompt: 'Draft it.',
            currentState: 'draft',
            history: [],
            createdAt: 1,
            updatedAt: 1,
          },
        },
        eventClass: 'doc_patch',
      },
      {
        event: {
          type: 'memory',
          phase: 'observation',
          status: 'running',
          message: 'Indexing',
        },
        eventClass: 'ephemeral',
      },
      { event: { type: 'usage', ...emptyUsageFields }, eventClass: 'ephemeral' },
      {
        event: { type: 'system', level: 'info', message: 'top-level system message' },
        eventClass: 'ephemeral',
      },
      {
        event: { type: 'system', level: 'debug', message: 'chatty internal detail' },
        eventClass: 'ephemeral',
      },
      // Severity is the discriminator, not a code list: a warning worth
      // interrupting a reader for is worth keeping for the reader who comes
      // back later, whether or not anyone remembered to mint a code for it.
      {
        event: { type: 'system', level: 'warn', message: 'Retrying provider' },
        eventClass: 'canonical',
      },
      {
        event: { type: 'system', level: 'error', message: 'uncoded failure' },
        eventClass: 'canonical',
      },
      {
        event: {
          type: 'system',
          level: 'error',
          message: 'localized copy is not the discriminator',
          metadata: { code: 'storage_full' },
        },
        eventClass: 'canonical',
      },
      {
        event: {
          type: 'system',
          level: 'warn',
          message: 'cwd fallback',
          metadata: { code: 'session_cwd_fallback' },
        },
        eventClass: 'canonical',
      },
      {
        event: {
          type: 'system',
          level: 'error',
          message: 'bound root unavailable',
          metadata: { code: 'bound_agent_root_unavailable' },
        },
        eventClass: 'canonical',
      },
      {
        event: { type: 'complete', state: runningTurnState, status: 'completed' },
        eventClass: 'canonical',
      },
      { event: { type: 'ask', state: runningTurnState, questions: [] }, eventClass: 'canonical' },
      { event: { type: 'interrupted', state: runningTurnState }, eventClass: 'canonical' },
      {
        event: { type: 'sleep', state: runningTurnState, wakeAt: 1_789_000_000_000 },
        eventClass: 'canonical',
      },
    ]

    for (const { event, eventClass } of cases) {
      expect(classifyAgentTurnEvent(event)).toBe(eventClass)
      expect(isCanonicalEvent(event)).toBe(eventClass === 'canonical')
      expect(isEphemeralEvent(event)).toBe(eventClass === 'ephemeral')
    }
  })

  test('parses installed runner turn step shapes', () => {
    expect(TurnStepSchema.parse({ type: 'text_delta', delta: 'hel' })).toEqual({
      type: 'text_delta',
      delta: 'hel',
    })
    expect(
      TurnStepSchema.parse({
        type: 'tool_call',
        toolName: 'read_file',
        toolCallId: 'call-1',
        input: { path: 'README.md' },
        isError: false,
        output: [{ type: 'text', text: 'ok' }],
      }),
    ).toEqual({
      type: 'tool_call',
      toolName: 'read_file',
      toolCallId: 'call-1',
      input: { path: 'README.md' },
      isError: false,
      output: [{ type: 'text', text: 'ok' }],
    })
  })

  test('round-trips task-origin tool details from the pinned runner', () => {
    const event = {
      type: 'step' as const,
      origin: { taskId: 't3' as const },
      step: {
        type: 'tool_call' as const,
        toolName: 'ask_user_question',
        toolCallId: 'call-3',
        input: { question: 'Ship it?' },
        isError: false,
        output: [{ type: 'text' as const, text: 'Waiting for an answer.' }],
        details: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] },
      },
    }

    expect(AgentTurnEventSchema.parse(event)).toEqual(event)
  })

  test('validates runner-owned todo, follow-up, and state-machine documents', () => {
    for (const status of ['pending', 'in_progress', 'completed', 'failed'] as const) {
      expect(AgentTodoSchema.parse({ id: `todo-${status}`, content: status, status })).toEqual({
        id: `todo-${status}`,
        content: status,
        status,
      })
    }

    const followUp = {
      message: 'Inspect this image next.',
      images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
    }
    expect(AgentFollowUpQueueEntrySchema.parse(followUp)).toEqual(followUp)

    const stateMachine = {
      definition: {
        name: 'durable reminder',
        prompt: 'Remind the user after an hour.',
        states: [
          {
            name: 'wait',
            kind: 'timer' as const,
            wakeAfterMs: '1h',
            futureRunnerField: { keep: true },
          },
          { name: 'done', kind: 'terminal' as const, status: 'completed' as const },
        ],
      },
      prompt: 'Get milk.',
      currentState: 'wait',
      currentInput: { store: 'corner shop' },
      progress: { states: { wait: { runs: 1, sleeps: 1, futureCounter: 2 } } },
      history: [
        { type: 'state_started' as const, timestamp: 1, state: 'wait', futureAudit: 'kept' },
      ],
      createdAt: 1,
      updatedAt: 2,
    }
    expect(AgentStateMachineSessionSchema.parse(stateMachine)).toEqual(stateMachine)
    expect(
      AgentStateMachineSessionSchema.parse({ ...stateMachine, legacyFirstState: 'wait' }),
    ).toEqual(stateMachine)
  })

  test('round-trips the full resumable turn state and rejects partial legacy snapshots', () => {
    const state = {
      status: 'running' as const,
      mode: 'auto' as const,
      options: { model: 'anthropic/claude-sonnet', thinkingLevel: 'high' as const },
      agent: { status: 'running' as const, messages: [] },
      todos: [{ id: 'todo-1', content: 'Wait for milk reminder', status: 'in_progress' as const }],
      followUpQueue: [{ message: 'Then buy eggs.' }],
      queuedCommands: [
        { type: 'prompt' as const, message: 'Use oat milk.', behavior: 'steer' as const },
      ],
      tasks: [
        {
          id: 't1' as const,
          kind: 'scheduled' as const,
          name: 'reminder',
          label: 'Wait one hour',
          ownerScopeId: 'turn-1' as const,
          status: 'scheduled' as const,
          startedAt: 1,
          wakeAt: 2,
        },
      ],
      taskOutputTails: { t1: ['scheduled'] },
      pendingLostTaskReminderTaskIds: ['t2' as const],
      nextTaskId: 3,
      wireGuardHorizon: { evictionHorizon: 4 },
    }

    expect(AgentTurnStateSchema.parse(state)).toEqual(state)
    expect(
      AgentTurnStateSchema.safeParse({ status: 'running', agent: { messages: [] } }).success,
    ).toBe(false)
  })

  test('validates task lifecycle, terminal state, and RPC-only acceptance separately', () => {
    const task = {
      id: 't7' as const,
      kind: 'subagent' as const,
      name: 'review',
      label: 'Review the patch',
      ownerScopeId: 'turn-1' as const,
      status: 'running' as const,
      startedAt: 10,
    }
    const events = [
      { type: 'task_started' as const, task },
      { type: 'task_output' as const, taskId: 't7' as const, chunk: 'Looks good.' },
      {
        type: 'task_settled' as const,
        settlement: { id: 't7' as const, status: 'completed' as const, settledAt: 11, result: {} },
      },
      { type: 'heartbeat' as const, timestamp: 12, activeTaskIds: ['t7' as const] },
    ]
    for (const event of events) expect(AgentTurnEventSchema.parse(event)).toEqual(event)

    const terminal = {
      type: 'complete' as const,
      status: 'completed' as const,
      result: 'done',
      state: {
        status: 'completed' as const,
        mode: 'agent' as const,
        agent: { status: 'completed' as const, messages: [] },
      },
    }
    expect(AgentTurnEventSchema.parse(terminal)).toEqual(terminal)
    expect(AgentSessionTimelineEventSchema.parse(terminal)).toEqual(terminal)
    expect(AgentTurnEventSchema.safeParse({ type: 'complete', status: 'completed' }).success).toBe(
      false,
    )

    const receipt = {
      type: 'command_accepted' as const,
      requestId: 'request-1',
      commandType: 'prompt' as const,
    }
    expect(AgentRpcCommandAcceptedEventSchema.parse(receipt)).toEqual(receipt)
    expect(AgentTurnEventSchema.safeParse(receipt).success).toBe(false)
    expect(AgentSessionTimelineEventSchema.safeParse(receipt).success).toBe(false)
  })

  test('identifies runner-deliverable input events', () => {
    expect(
      isRunnerDeliverableInputEvent({
        type: 'prompt_submitted',
        prompt: 'continue',
        inputKind: 'message',
        behavior: 'steer',
        sender: { kind: 'user', userId: 'user-1' },
      }),
    ).toBe(true)
    expect(
      isRunnerDeliverableInputEvent({
        type: 'note_submitted',
        note: 'Prefer the shorter patch.',
        sender: { kind: 'app', appId: 'app-1' },
      }),
    ).toBe(true)
    expect(
      isRunnerDeliverableInputEvent({
        type: 'answer_submitted',
        answer: 'Use option A.',
        sender: { kind: 'session', sessionId: 'session-parent-123' },
      }),
    ).toBe(true)
    expect(
      isRunnerDeliverableInputEvent({
        type: 'session_created',
        prompt: 'summarize demo:/reports',
        createdAt: '2026-07-07T00:00:00.000Z',
      }),
    ).toBe(false)
    expect(
      isRunnerDeliverableInputEvent({
        type: 'interrupt_requested',
        requestedAt: '2026-07-07T00:00:00.000Z',
      }),
    ).toBe(false)
  })

  test('pins shared session states and runner delivery attempts', () => {
    expect(AGENT_TERMINAL_STATES).toEqual(['complete', 'ask', 'interrupted', 'sleep'])
    expect(AGENT_SESSION_STATUSES).toEqual(['running', 'complete', 'ask', 'interrupted', 'sleep'])
    expect(RUNNER_DELIVERY_KINDS).toEqual(['initial_prompt', 'message', 'answer'])
    expect(AGENT_SESSION_EVENT_TYPES).toContain('task_started')
    expect(AGENT_SESSION_EVENT_TYPES).toContain('task_output')
    expect(AGENT_SESSION_EVENT_TYPES).toContain('task_settled')
    expect(AGENT_SESSION_EVENT_TYPES).toContain('heartbeat')
    expect(AGENT_SESSION_EVENT_TYPES).toContain('router_switch')
    expect(
      RunnerDeliveryAttemptSchema.parse({
        attemptId: 'attempt-1',
        throughSeq: 1,
        kind: 'message',
        createdAt: 123,
      }),
    ).toEqual({
      attemptId: 'attempt-1',
      throughSeq: 1,
      kind: 'message',
      createdAt: 123,
    })
  })

  test('validates input image wire caps and mime allowlist', () => {
    expect(
      AgentInputImageSchema.safeParse({
        data: 'aGVsbG8=',
        mimeType: 'image/png',
      }).success,
    ).toBe(true)
    expect(
      AgentInputImageSchema.safeParse({
        data: 'data:image/png;base64,aGVsbG8=',
        mimeType: 'image/png',
      }).success,
    ).toBe(false)
    expect(
      AgentInputImageSchema.safeParse({
        data: 'aGVsbG8=',
        mimeType: 'image/svg+xml',
      }).success,
    ).toBe(false)
    expect(
      AgentStartSessionRequestSchema.safeParse({
        prompt: 'look',
        images: Array.from({ length: AGENT_INPUT_IMAGE_MAX_COUNT + 1 }, () => ({
          data: 'aA==',
          mimeType: 'image/png',
        })),
      }).success,
    ).toBe(false)
    expect(
      AgentMessageRequestSchema.parse({
        prompt: 'look',
        images: [{ data: 'aA==', mimeType: 'image/png' }],
      }),
    ).toEqual({
      prompt: 'look',
      behavior: 'steer',
      images: [{ data: 'aA==', mimeType: 'image/png' }],
    })
    expect(
      AgentAnswerRequestSchema.parse({
        answer: 'the dashboard',
        images: [{ data: 'aA==', mimeType: 'image/png' }],
      }),
    ).toEqual({
      answer: 'the dashboard',
      images: [{ data: 'aA==', mimeType: 'image/png' }],
    })
    expect(
      AgentInputImageSchema.safeParse({
        data: Buffer.alloc(AGENT_INPUT_IMAGE_MAX_BYTES + 1).toString('base64'),
        mimeType: 'image/png',
      }).success,
    ).toBe(false)
  })

  test('cwd accepts drive-relative paths and rejects escapes and control characters', () => {
    for (const cwd of ['projects/demo', 'a/../b', '.', 'a/./b/', 'deep/nested/dir']) {
      expect(AgentCwdSchema.safeParse(cwd).success).toBe(true)
    }
    for (const cwd of ['/etc', '..', 'a/../../b', '', 'a\0b', 'a\nb', `x/${'y'.repeat(1024)}`]) {
      expect(AgentCwdSchema.safeParse(cwd).success).toBe(false)
    }
  })

  test('canonicalizes persistable agent cwd values', () => {
    expect(canonicalAgentCwd('projects/./demo')).toBe('projects/demo')
    expect(canonicalAgentCwd('projects//demo/')).toBe('projects/demo')
    expect(canonicalAgentCwd('projects/drafts/../demo')).toBe('projects/demo')
    expect(canonicalAgentCwd('.')).toBeUndefined()
  })

  test('collects runner images input-first then queued notes', () => {
    expect(
      collectRunnerImages({
        notes: [
          { images: [{ storageId: 'note-a', mimeType: 'image/png', bytes: 1 }] },
          { images: [{ storageId: 'note-b', mimeType: 'image/jpeg', bytes: 2 }] },
        ],
        input: { images: [{ storageId: 'prompt', mimeType: 'image/webp', bytes: 3 }] },
      }),
    ).toEqual([
      { storageId: 'prompt', mimeType: 'image/webp', bytes: 3 },
      { storageId: 'note-a', mimeType: 'image/png', bytes: 1 },
      { storageId: 'note-b', mimeType: 'image/jpeg', bytes: 2 },
    ])
  })

  test('caps combined runner delivery images without dropping current input images', () => {
    const images = collectRunnerImages({
      notes: [
        {
          images: Array.from({ length: AGENT_INPUT_IMAGE_MAX_COUNT }, (_, index) => ({
            storageId: `note-${index}`,
            mimeType: 'image/png' as const,
            bytes: 1,
          })),
        },
      ],
      input: { images: [{ storageId: 'prompt', mimeType: 'image/webp', bytes: 1 }] },
    })

    expect(images).toHaveLength(AGENT_INPUT_IMAGE_MAX_COUNT)
    expect(images.map(image => image.storageId)).toEqual([
      'prompt',
      ...Array.from({ length: AGENT_INPUT_IMAGE_MAX_COUNT - 1 }, (_, index) => `note-${index}`),
    ])
  })
})

describe('the runner protocol boundary', () => {
  // Duet renamed its own session columns — `status` became `turnStatus`,
  // `stateMachine` became `machineState`. These two field names are NOT Duet's
  // to rename: they are emitted by a deployed gateway bundle that reaches
  // workspace VMs on its own schedule, and the gateway folds them into on-disk
  // checkpoints it later reads back by spreading untyped record values. A
  // rename here fails at runtime inside a customer's VM, not at typecheck.
  //
  // "No backward compatibility" is a statement about our own surfaces. It is
  // not a statement about a protocol with a rollout lag and live state in
  // machines we do not control.
  test('the runner still says `stateMachine`, whatever Duet calls its own column', () => {
    const turnState = AgentTurnStateSchema.parse({
      status: 'completed',
      mode: 'agent',
      agent: { status: 'completed', messages: [] },
      stateMachine: {
        definition: { name: 'reminder', prompt: 'Wait.', states: [] },
        prompt: 'Get milk.',
        history: [],
        createdAt: 1,
        updatedAt: 2,
      },
    })
    expect(turnState.stateMachine).toBeDefined()

    const frame = AgentTurnEventSchema.parse({
      type: 'state_machine',
      stateMachine: {
        definition: { name: 'reminder', prompt: 'Wait.', states: [] },
        prompt: 'Get milk.',
        history: [],
        createdAt: 1,
        updatedAt: 2,
      },
    })
    expect(frame.type).toBe('state_machine')
    expect('stateMachine' in frame).toBe(true)
  })
})

function schemaTypeLiterals(schema: z.ZodType): string[] {
  return (schema as unknown as z.ZodDiscriminatedUnion).options.map(option =>
    schemaTypeLiteral(option),
  )
}

function schemaTypeLiteral(schema: unknown): string {
  return (schema as z.ZodObject<{ type: z.ZodLiteral<string> }>).shape.type.value
}

// Convex refuses a document over 1 MiB, and an event it refuses can never be
// relayed: it parks at the head of the journal and holds every event behind it
// there too, so the turn never terminates and the drain retries the same doomed
// payload forever. A budget above that ceiling mints exactly those events.
test('the event budget stays under the document limit that lets an event be stored', () => {
  expect(CONVEX_EVENT_BUDGET_BYTES).toBeLessThan(1024 * 1024)
})

/* The transcript is what a reader sees; the rest of the timeline is the
   runtime's structured-concurrency rail. One predicate decides the split so the
   row stamp the history index pages by and the projection's drop rule cannot
   drift apart. */
describe('transcript rows', () => {
  test('task lifecycle and child-backed steps are not transcript', () => {
    expect(
      isTranscriptEvent({
        type: 'task_started',
        task: {
          id: 't1',
          kind: 'tool',
          name: 'bash',
          label: 'ls',
          ownerScopeId: 'turn-1',
          status: 'running',
          startedAt: 1,
        },
      }),
    ).toBeFalse()
    expect(isTranscriptEvent({ type: 'task_output', taskId: 't1', chunk: 'x' })).toBeFalse()
    expect(
      isTranscriptEvent({
        type: 'task_settled',
        settlement: { id: 't1', status: 'completed', settledAt: 2, result: 'ok' },
      }),
    ).toBeFalse()
    expect(
      isTranscriptEvent({
        type: 'step',
        origin: { taskId: 't1' },
        step: { type: 'text', text: 'inside a subagent' },
      }),
    ).toBeFalse()
  })

  test('top-level steps, inputs, and terminals are transcript', () => {
    expect(isTranscriptEvent({ type: 'step', step: { type: 'text', text: 'hello' } })).toBeTrue()
    expect(
      isTranscriptEvent({
        type: 'prompt_submitted',
        prompt: 'hi',
        inputKind: 'initial',
        behavior: 'steer',
        sender: { kind: 'user', userId: 'u1' },
      }),
    ).toBeTrue()
    expect(isTranscriptEvent({ type: 'complete', status: 'completed' })).toBeTrue()
    expect(isTranscriptEvent({ type: 'turn_started' })).toBeTrue()
  })
})
