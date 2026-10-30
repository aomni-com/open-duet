import { describe, expect, test } from 'bun:test'

import { getFunctionName } from 'convex/server'

import {
  dispatchAndMarkRunnerInput,
  drainRunnerInputQueue,
  drainWorkspaceOnRegister,
  runnerInputRequest,
  retryRunnerDeliveryMark,
} from './agent-runner'

test('gateway request bodies carry the rendered attachment manifest unchanged', async () => {
  const envelope =
    '<user_message seq="2">Review it.\n  <attached_files note="Files attached.">\n    <file path="uploads/brief.pdf" bytes="42" mime_type="application/pdf"/>\n  </attached_files></user_message>'
  const gatewayBodies: unknown[] = []
  const prepared = {
    sessionId: 'session_attachments',
    status: 'running' as const,
    submittedThroughSeq: 2,
    dispatch: {
      attemptId: 'attempt_attachments',
      throughSeq: 2,
      inputKind: 'message' as const,
      message: envelope,
      behavior: 'steer' as const,
      resolvedModelId: 'balanced' as const,
    },
  }

  for (const kind of ['prompt', 'answer'] as const) {
    const result = await dispatchAndMarkRunnerInput(
      {
        get: () => ({ user: { id: 'user_1' } }),
        json: (body: unknown, status?: number) => Response.json(body, { status }),
      } as never,
      {
        convex: {
          mutation: async () => ({ status: 'running', lastDeliveredInputSeq: 2 }),
        },
        internalKey: 'internal',
        apiInternalKey: 'internal',
        now: () => 1,
      } as never,
      {
        callAgent: async (_c: unknown, _slug: string, request: { body?: string }) => {
          gatewayBodies.push(JSON.parse(request.body ?? ''))
          return { body: { acceptedThroughSeq: 2, disposition: 'live' } }
        },
      } as never,
      { id: 'workspace_1', slug: 'workspace', role: 'owner' },
      prepared,
      kind,
    )
    expect(result.delivery).toBe('accepted')
  }

  expect(gatewayBodies).toEqual([
    {
      attemptId: 'attempt_attachments',
      throughSeq: 2,
      input: { kind: 'prompt', message: envelope, behavior: 'steer' },
      launch: { tier: 'balanced' },
    },
    {
      attemptId: 'attempt_attachments',
      throughSeq: 2,
      input: { kind: 'answer', answer: envelope },
      launch: { tier: 'balanced' },
    },
  ])
})

test('runner input carries only the prepared-integrations marker', () => {
  expect(
    runnerInputRequest(
      {
        sessionId: 'session_1',
        status: 'running',
        submittedThroughSeq: 2,
        dispatch: {
          attemptId: 'attempt_1',
          throughSeq: 2,
          inputKind: 'message',
          message: 'Ship it',
          behavior: 'steer',
          resolvedModelId: 'balanced',
          integrations: true,
        },
      },
      { kind: 'prompt', message: 'Ship it', behavior: 'steer' },
    ).launch,
  ).toMatchObject({ integrations: true })
})

// Names only, and only the ones this turn's projection produced. The gateway
// turns each into a Duet proxy URL under its own bearer, so a URL or a
// third-party token appearing here would be the bug the split exists to prevent.
test('runner input carries the custom MCP server names, and nothing when there are none', () => {
  const prepared = (dispatch: Record<string, unknown>) => ({
    sessionId: 'session_1',
    status: 'running' as const,
    submittedThroughSeq: 2,
    dispatch: {
      attemptId: 'attempt_1',
      throughSeq: 2,
      inputKind: 'message' as const,
      message: 'Ship it',
      behavior: 'steer' as const,
      resolvedModelId: 'balanced' as const,
      ...dispatch,
    },
  })
  const input = { kind: 'prompt' as const, message: 'Ship it', behavior: 'steer' as const }

  expect(
    runnerInputRequest(prepared({ mcpServers: [{ name: 'notes' }, { name: 'tickets' }] }), input)
      .launch,
  ).toEqual({ tier: 'balanced', mcpServers: [{ name: 'notes' }, { name: 'tickets' }] })
  expect(runnerInputRequest(prepared({}), input).launch).toEqual({ tier: 'balanced' })
})

describe('runner delivery acknowledgement', () => {
  test('prepares integrations before dispatching a recovered queued input', async () => {
    const events: string[] = []
    let prepares = 0
    const convex = {
      mutation: async (_reference: unknown, args: Record<string, unknown>) => {
        if ('input' in args) {
          prepares += 1
          if (prepares > 1) return { queued: true, alreadyDelivered: true }
          return {
            sessionId: 'session_recovered',
            status: 'running',
            dispatch: {
              attemptId: 'attempt_recovered',
              throughSeq: 1,
              inputKind: 'message',
              message: 'Retry after Composio recovers',
              behavior: 'steer',
              resolvedModelId: 'recommended',
              integrations: true,
            },
          }
        }
        if ('throughSeq' in args) return { status: 'running', lastDeliveredInputSeq: 1 }
        throw new Error(`Unexpected mutation args: ${JSON.stringify(args)}`)
      },
      query: async () => [{ seq: 1, event: { type: 'prompt_submitted' } }],
    }

    const result = await drainRunnerInputQueue({
      convex: convex as never,
      internalKey: 'internal',
      workspaceId: 'workspace_1',
      sessionId: 'session_recovered',
      now: () => 1,
      beforeDispatch: async prepared => {
        events.push(`prepare:${prepared.sessionId}`)
        return true
      },
      dispatch: async prepared => {
        events.push(`dispatch:${prepared.sessionId}`)
        return { ok: true, receipt: { acceptedThroughSeq: 1, disposition: 'live' } }
      },
    })

    expect(result).toEqual({ delivered: 1, stopped: 'empty' })
    expect(events).toEqual(['prepare:session_recovered', 'dispatch:session_recovered'])
  })

  test('retries a transient durable mark failure after the gateway accepted input', async () => {
    let attempts = 0
    const pauses: number[] = []

    const marked = await retryRunnerDeliveryMark(
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error('transient Convex failure')
        return { lastDeliveredInputSeq: 2 }
      },
      async delay => {
        pauses.push(delay)
      },
    )

    expect(marked).toEqual({ lastDeliveredInputSeq: 2 })
    expect(attempts).toBe(2)
    expect(pauses).toHaveLength(1)
    expect(pauses[0]).toBeGreaterThan(0)
  })

  test('queue draining retries the durable mark instead of redelivering accepted input', async () => {
    let prepares = 0
    let markAttempts = 0
    let dispatches = 0
    const convex = {
      mutation: async (_reference: unknown, args: Record<string, unknown>) => {
        if ('input' in args) {
          prepares += 1
          if (prepares > 1) return { queued: true, alreadyDelivered: true }
          return {
            sessionId: 'session_1',
            status: 'running',
            dispatch: {
              attemptId: 'attempt_1',
              throughSeq: 2,
              inputKind: 'message',
              message: 'Ship once',
              resolvedModelId: 'model_1',
            },
          }
        }
        if ('throughSeq' in args) {
          markAttempts += 1
          if (markAttempts === 1) throw new Error('transient mark failure')
          return { status: 'running', lastDeliveredInputSeq: 2 }
        }
        throw new Error(`Unexpected mutation args: ${JSON.stringify(args)}`)
      },
      query: async () => [{ seq: 2, event: { type: 'prompt_submitted' } }],
    }

    const result = await drainRunnerInputQueue({
      convex: convex as never,
      internalKey: 'internal',
      workspaceId: 'workspace_1',
      sessionId: 'session_1',
      now: () => 1,
      dispatch: async () => {
        dispatches += 1
        return {
          ok: true,
          receipt: { acceptedThroughSeq: 2, disposition: 'live' },
        }
      },
    })

    expect(result).toEqual({ delivered: 1, stopped: 'empty' })
    expect(dispatches).toBe(1)
    expect(markAttempts).toBe(2)
  })

  test('an input interrupted after gateway acceptance settles on the duplicate receipt', async () => {
    let prepares = 0
    let abandons = 0
    let marks = 0
    let dispatches = 0
    let delivered = false
    const convex = {
      mutation: async (_reference: unknown, args: Record<string, unknown>) => {
        if ('input' in args) {
          prepares += 1
          if (delivered) return { queued: true, alreadyDelivered: true }
          return {
            sessionId: 'session_restarted',
            status: 'running',
            submittedThroughSeq: 2,
            dispatch: {
              attemptId: `restart-attempt-${prepares}`,
              throughSeq: 2,
              inputKind: 'message',
              message: 'Survive the reboot',
              behavior: 'steer',
              resolvedModelId: 'model_1',
            },
          }
        }
        if ('throughSeq' in args) {
          marks += 1
          delivered = true
          return { status: 'running', lastDeliveredInputSeq: 2 }
        }
        abandons += 1
        return { status: 'running', lastDeliveredInputSeq: 0 }
      },
      query: async () => [{ seq: 2, event: { type: 'prompt_submitted' } }],
    }
    const drain = () =>
      drainRunnerInputQueue({
        convex: convex as never,
        internalKey: 'internal',
        workspaceId: 'workspace_1',
        sessionId: 'session_restarted',
        now: () => 1,
        dispatch: async () => {
          dispatches += 1
          if (dispatches === 1) {
            return { response: Response.json({ error: 'gateway_restarted' }, { status: 503 }) }
          }
          return {
            ok: true,
            receipt: { acceptedThroughSeq: 2, disposition: 'duplicate' },
          }
        },
      })

    const interrupted = await drain()
    const recovered = await drain()

    expect(interrupted).toMatchObject({ delivered: 0, stopped: 'failed' })
    expect(recovered).toEqual({ delivered: 1, stopped: 'empty' })
    expect({ dispatches, abandons, marks }).toEqual({ dispatches: 2, abandons: 1, marks: 1 })
  })
})

describe('workspace runner input drain', () => {
  // A session whose dispatch FAILS (rather than throws) used to end the pass,
  // so every session queued behind it was never dispatched at all. The drain
  // re-selects the same ordered set on the next tick, so one wedged session
  // starved the rest permanently — they re-queued forever while the sync log
  // showed only "dispatch failed". A 90s turn_started timeout in the gateway
  // presents at this seam exactly that way: a 503 response, not an exception.
  test('a session whose dispatch fails does not starve the sessions behind it', async () => {
    const dispatched: string[] = []
    const prepared = new Set<string>()
    const convex = {
      query: async (_reference: unknown, args: Record<string, unknown>) => {
        // The events query carries a limit too; the candidate query is the one
        // scoped to a workspace rather than a session.
        if (!('sessionId' in args)) {
          return {
            workspaceSlug: 'ws',
            sessions: [
              { sessionId: 'wedged_session', actorId: 'user_1', afterSeq: 0 },
              { sessionId: 'healthy_session', actorId: 'user_1', afterSeq: 0 },
            ],
          }
        }
        return [{ seq: 1, event: { type: 'prompt_submitted' } }]
      },
      mutation: async (_reference: unknown, args: Record<string, unknown>) => {
        if ('input' in args) {
          const sessionId = String(args.sessionId)
          if (prepared.has(sessionId)) return { queued: true, alreadyDelivered: true }
          prepared.add(sessionId)
          return {
            sessionId,
            status: 'running',
            dispatch: {
              attemptId: `attempt_${sessionId}`,
              throughSeq: 1,
              message: 'go',
              resolvedModelId: 'recommended',
            },
          }
        }
        return { status: 'running', lastDeliveredInputSeq: 1 }
      },
    }
    const gatewayClient = {
      callAgent: async (_c: unknown, _slug: string, request: { path: string }) => {
        const sessionId = decodeURIComponent(request.path.split('/')[4] ?? '')
        dispatched.push(sessionId)
        return sessionId === 'wedged_session'
          ? { response: Response.json({ error: 'runner_unavailable' }, { status: 503 }) }
          : { body: { acceptedThroughSeq: 1, disposition: 'live' } }
      },
    }

    const result = await drainWorkspaceOnRegister({
      c: { json: (body: unknown, status?: number) => Response.json(body, { status }) } as never,
      runtime: { convex: convex as never, apiInternalKey: 'internal', now: () => 1 } as never,
      gatewayClient: gatewayClient as never,
      workspaceId: 'workspace_1',
    })

    expect(dispatched).toEqual(['wedged_session', 'healthy_session'])
    expect(result.delivered).toBe(1)
    expect(result.stopped).toBe('failed')
  })

  // A discarded session's envelope is gone for good — abandoning just the
  // lease (the ordinary failure path) leaves runnerInputPending set, so the
  // very next drain tick finds the same undeliverable input and tries again,
  // forever. This has to actually end the turn instead.
  test('a session the gateway reports as discarded is finalized, not just abandoned', async () => {
    const mutationsCalled: string[] = []
    const convex = {
      query: async (_reference: unknown, args: Record<string, unknown>) => {
        if (!('sessionId' in args)) {
          return {
            workspaceSlug: 'ws',
            sessions: [{ sessionId: 'gone_session', actorId: 'user_1', afterSeq: 0 }],
          }
        }
        return [{ seq: 1, event: { type: 'prompt_submitted' } }]
      },
      mutation: async (reference: unknown, args: Record<string, unknown>) => {
        mutationsCalled.push(getFunctionName(reference as never))
        if ('input' in args) {
          return {
            sessionId: String(args.sessionId),
            status: 'running',
            dispatch: {
              attemptId: 'attempt_gone_session',
              throughSeq: 1,
              message: 'go',
              resolvedModelId: 'recommended',
            },
          }
        }
        return { status: 'interrupted', lastEventSeq: 1 }
      },
    }
    const gatewayClient = {
      callAgent: async () => ({
        response: Response.json({ error: 'session_discarded' }, { status: 410 }),
      }),
    }

    const result = await drainWorkspaceOnRegister({
      c: { json: (body: unknown, status?: number) => Response.json(body, { status }) } as never,
      runtime: { convex: convex as never, apiInternalKey: 'internal', now: () => 1 } as never,
      gatewayClient: gatewayClient as never,
      workspaceId: 'workspace_1',
    })

    expect(result.delivered).toBe(0)
    expect(result.stopped).toBe('failed')
    expect(mutationsCalled).toContain('domains/agentSessions/model:finalizeDiscardedSession')
    expect(mutationsCalled).not.toContain('domains/agentSessions/model:abandonRunnerInputDelivery')
  })

  // A failure earlier in the pass must survive a LATER session hitting the
  // delivery cap in the same run — the cap is routine, the failure is not,
  // and losing the failure just because something else also filled the
  // budget would hide the exact thing this file's other new test exists to
  // surface.
  test('a failure caught earlier survives a later session hitting the drain limit', async () => {
    const dispatched: string[] = []
    let wedgedSessionAttempted = false
    let attemptNumber = 0
    const convex = {
      query: async (_reference: unknown, args: Record<string, unknown>) => {
        if (!('sessionId' in args)) {
          return {
            workspaceSlug: 'ws',
            sessions: [
              { sessionId: 'wedged_session', actorId: 'user_1', afterSeq: 0 },
              { sessionId: 'bottomless_session', actorId: 'user_1', afterSeq: 0 },
            ],
          }
        }
        return [{ seq: 1, event: { type: 'prompt_submitted' } }]
      },
      mutation: async (_reference: unknown, args: Record<string, unknown>) => {
        if ('input' in args) {
          const sessionId = String(args.sessionId)
          if (sessionId === 'wedged_session') {
            if (wedgedSessionAttempted) return { queued: true, alreadyDelivered: true }
            wedgedSessionAttempted = true
          }
          // bottomless_session never runs out, so its own drain loop always
          // has more to prepare — exactly what exhausts the shared budget.
          return {
            sessionId,
            status: 'running',
            dispatch: {
              attemptId: `attempt_${sessionId}_${++attemptNumber}`,
              throughSeq: 1,
              message: 'go',
              resolvedModelId: 'recommended',
            },
          }
        }
        return { status: 'running', lastDeliveredInputSeq: 1 }
      },
    }
    const gatewayClient = {
      callAgent: async (_c: unknown, _slug: string, request: { path: string }) => {
        const sessionId = decodeURIComponent(request.path.split('/')[4] ?? '')
        dispatched.push(sessionId)
        return sessionId === 'wedged_session'
          ? { response: Response.json({ error: 'runner_unavailable' }, { status: 503 }) }
          : { body: { acceptedThroughSeq: 1, disposition: 'live' } }
      },
    }

    const result = await drainWorkspaceOnRegister({
      c: { json: (body: unknown, status?: number) => Response.json(body, { status }) } as never,
      runtime: { convex: convex as never, apiInternalKey: 'internal', now: () => 1 } as never,
      gatewayClient: gatewayClient as never,
      workspaceId: 'workspace_1',
    })

    expect(dispatched[0]).toBe('wedged_session')
    expect(result.stopped).toBe('failed')
  })
})
