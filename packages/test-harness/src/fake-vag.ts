export type FakeVagFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface FakeVagRequest {
  method: string
  url: URL
  headers: Headers
  body: string
}

export interface FakeVagScenario {
  method?: string
  path: string | RegExp | ((url: URL) => boolean)
  status?: number
  headers?: HeadersInit
  body?: BodyInit | null
  json?: unknown | ((generationId: string) => unknown)
  sseChunks?: string[] | ((generationId: string) => string[])
  sseChunkDelayMs?: number
  readyAfterPolls?: number
  totalCost?: number
  inputTokens?: number
  outputTokens?: number
}

export interface FakeVagCompletion {
  text: string
  inputTokens: number
  outputTokens: number
  totalCost: number
}

export interface FakeVag {
  fetch: FakeVagFetch
  requests: FakeVagRequest[]
  generationPolls: Map<string, number>
  generationIds: string[]
  assertNoPendingScenarios(): void
}

interface PendingScenario {
  scenario: FakeVagScenario
  used: boolean
}

export function createFakeVag(
  options: {
    aiGatewayApiKey?: string
    catalogModelId?: string
    completion?: FakeVagCompletion
    readyAfterPolls?: number
    scenarios?: FakeVagScenario[]
  } = {},
): FakeVag {
  const aiGatewayApiKey = options.aiGatewayApiKey ?? 'test-platform-key'
  const requests: FakeVagRequest[] = []
  const generationPolls = new Map<string, number>()
  const generationReadyAfterPolls = new Map<string, number>()
  const generationUsage = new Map<
    string,
    { totalCost: number; inputTokens: number; outputTokens: number }
  >()
  const generationIds: string[] = []
  const scenarios = (options.scenarios ?? []).map(scenario => ({ scenario, used: false }))
  let generationSequence = 0

  const fake: FakeVag = {
    requests,
    generationPolls,
    generationIds,
    assertNoPendingScenarios() {
      const unused = scenarios
        .filter(entry => !entry.used)
        .map(entry => printablePath(entry.scenario))
      if (unused.length > 0) {
        throw new Error(`Unused fake VAG scenarios: ${unused.join(', ')}`)
      }
    },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const body = await request.text()
      const captured = {
        method: request.method,
        url,
        headers: new Headers(request.headers),
        body,
      }
      requests.push(captured)

      assertGatewayHeaders(captured, aiGatewayApiKey)

      if (url.pathname === '/v1/generation') {
        return generationResponse(url, generationPolls, generationReadyAfterPolls, generationUsage)
      }

      const scenario = takeScenario(scenarios, request.method, url)
      const mintsGeneration = shouldMintGeneration(request.method, url)
      const generationId = mintsGeneration ? `gen_fake_${++generationSequence}` : 'gen_fake_catalog'
      if (mintsGeneration) {
        generationIds.push(generationId)
        generationReadyAfterPolls.set(
          generationId,
          scenario?.readyAfterPolls ?? options.readyAfterPolls ?? 0,
        )
        generationUsage.set(generationId, {
          totalCost: scenario?.totalCost ?? options.completion?.totalCost ?? 1234,
          inputTokens: scenario?.inputTokens ?? options.completion?.inputTokens ?? 0,
          outputTokens: scenario?.outputTokens ?? options.completion?.outputTokens ?? 0,
        })
      }

      if (scenario) return scenarioResponse(scenario, generationId)
      return defaultResponse(
        request.method,
        url,
        generationId,
        body,
        options.catalogModelId,
        options.completion,
      )
    },
  }

  return fake
}

function assertGatewayHeaders(request: FakeVagRequest, aiGatewayApiKey: string): void {
  const authorization = request.headers.get('authorization')
  if (authorization !== `Bearer ${aiGatewayApiKey}`) {
    throw new Error(`Expected platform bearer, received ${authorization ?? '<missing>'}`)
  }
  const loopbackHttp = request.url.protocol === 'http:' && request.url.hostname === '127.0.0.1'
  if (request.headers.has('x-api-key')) throw new Error('Caller x-api-key reached upstream')
  if (!loopbackHttp && request.headers.get('connection')) {
    throw new Error('Caller connection header reached upstream')
  }
  if (!loopbackHttp && request.headers.get('host'))
    throw new Error('Caller host header reached upstream')
  if (request.headers.get('transfer-encoding')) {
    throw new Error('Caller transfer-encoding header reached upstream')
  }
}

function generationResponse(
  url: URL,
  polls: Map<string, number>,
  readyAfterPolls: Map<string, number>,
  usageByGeneration: Map<string, { totalCost: number; inputTokens: number; outputTokens: number }>,
): Response {
  const id = url.searchParams.get('id')
  if (!id || !readyAfterPolls.has(id)) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const nextPoll = (polls.get(id) ?? 0) + 1
  polls.set(id, nextPoll)
  if (nextPoll <= (readyAfterPolls.get(id) ?? 0)) {
    return Response.json({ error: 'not_ready' }, { status: 404 })
  }
  const usage = usageByGeneration.get(id)
  return Response.json({
    data: {
      total_cost: usage?.totalCost ?? 0,
      tokens_prompt: usage?.inputTokens ?? 0,
      tokens_completion: usage?.outputTokens ?? 0,
      native_tokens_prompt: usage?.inputTokens ?? 0,
      native_tokens_completion: usage?.outputTokens ?? 0,
    },
  })
}

function takeScenario(
  scenarios: PendingScenario[],
  method: string,
  url: URL,
): FakeVagScenario | null {
  const entry = scenarios.find(candidate => {
    if (candidate.used) return false
    const scenarioMethod = candidate.scenario.method
    if (scenarioMethod && scenarioMethod.toUpperCase() !== method.toUpperCase()) return false
    return pathMatches(candidate.scenario.path, url)
  })
  if (!entry) return null
  entry.used = true
  return entry.scenario
}

function pathMatches(path: FakeVagScenario['path'], url: URL): boolean {
  if (typeof path === 'string') return url.pathname === path
  if (path instanceof RegExp) return path.test(url.pathname)
  return path(url)
}

function scenarioResponse(scenario: FakeVagScenario, generationId: string): Response {
  const status = scenario.status ?? 200
  if (scenario.sseChunks) {
    const chunks =
      typeof scenario.sseChunks === 'function'
        ? scenario.sseChunks(generationId)
        : scenario.sseChunks
    return new Response(streamChunks(chunks, scenario.sseChunkDelayMs), {
      status,
      headers: { 'content-type': 'text/event-stream', ...headersRecord(scenario.headers) },
    })
  }
  if (scenario.json !== undefined) {
    const json = typeof scenario.json === 'function' ? scenario.json(generationId) : scenario.json
    return Response.json(json, { status, headers: scenario.headers })
  }
  if (scenario.body !== undefined)
    return new Response(scenario.body, { status, headers: scenario.headers })
  return jsonGeneration(generationId, status, scenario.headers)
}

function shouldMintGeneration(method: string, url: URL): boolean {
  if (method === 'POST' && url.pathname === '/v1/embeddings') return false
  return !(method === 'GET' && url.pathname === '/v1/models')
}

function defaultResponse(
  method: string,
  url: URL,
  generationId: string,
  body: string,
  catalogModelId = 'openai/gpt-5-mini',
  completion?: FakeVagCompletion,
): Response {
  if (method === 'GET' && url.pathname === '/v1/models') {
    return Response.json({
      object: 'list',
      // `type` is part of the upstream entry, and it is what the gateway lists
      // a language model by — an entry without it is one no caller can run.
      data: [{ id: catalogModelId, type: 'language', object: 'model' }],
    })
  }

  if (completion !== undefined && url.pathname === '/v1/responses') {
    return responsesCompletion(generationId, parseJsonObject(body), completion)
  }

  if (completion !== undefined && url.pathname === '/v1/messages') {
    return messagesCompletion(generationId, parseJsonObject(body), completion)
  }
  if (completion !== undefined && url.pathname === '/v1/chat/completions') {
    return chatCompletion(generationId, parseJsonObject(body), completion)
  }

  if (url.pathname === '/v1/messages') {
    return new Response(
      streamChunks([
        'event: message_start\n',
        `data: ${JSON.stringify({ type: 'message_start', message: { id: generationId } })}\n\n`,
      ]),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }

  if (url.pathname === '/v1/responses') return jsonGeneration(generationId)
  if (url.pathname === '/v1/chat/completions') return jsonGeneration(generationId)
  if (method === 'POST' && url.pathname === '/v1/embeddings') return embeddingsResponse(body)
  if (url.pathname.startsWith('/v4/ai/')) {
    return new Response(
      streamChunks([`data: ${JSON.stringify({ generationId, type: 'result' })}\n\n`]),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }

  return Response.json({ error: 'not_found' }, { status: 404 })
}

function responsesCompletion(
  id: string,
  request: Record<string, unknown>,
  completion: FakeVagCompletion,
): Response {
  const response = {
    id,
    object: 'response',
    status: 'completed',
    model: request.model,
    output: [
      {
        id: `msg_${id}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: completion.text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: completion.inputTokens,
      output_tokens: completion.outputTokens,
      total_tokens: completion.inputTokens + completion.outputTokens,
    },
  }
  if (request.stream !== true) return Response.json(response)
  return new Response(
    streamChunks([
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id, status: 'in_progress' } })}\n\n`,
      `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...response.output[0], content: [] } })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: response.output[0]!.id, delta: completion.text })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: response.output[0] })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
    ]),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function messagesCompletion(
  id: string,
  request: Record<string, unknown>,
  completion: FakeVagCompletion,
): Response {
  const message = {
    id,
    type: 'message',
    role: 'assistant',
    model: request.model,
    content: [{ type: 'text', text: completion.text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: completion.inputTokens, output_tokens: completion.outputTokens },
  }
  if (request.stream !== true) return Response.json(message)
  const events = [
    {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { input_tokens: completion.inputTokens, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: completion.text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: completion.outputTokens },
    },
    { type: 'message_stop' },
  ]
  return new Response(
    streamChunks(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function chatCompletion(
  id: string,
  request: Record<string, unknown>,
  completion: FakeVagCompletion,
): Response {
  const usage = {
    prompt_tokens: completion.inputTokens,
    completion_tokens: completion.outputTokens,
    total_tokens: completion.inputTokens + completion.outputTokens,
  }
  const envelope = { id, model: request.model, created: 0 }
  if (request.stream !== true)
    return Response.json({
      ...envelope,
      object: 'chat.completion',
      usage,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: completion.text },
          finish_reason: 'stop',
        },
      ],
    })
  const chunks = [
    {
      ...envelope,
      object: 'chat.completion.chunk',
      choices: [
        { index: 0, delta: { role: 'assistant', content: completion.text }, finish_reason: null },
      ],
    },
    {
      ...envelope,
      object: 'chat.completion.chunk',
      usage,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]
  return new Response(
    streamChunks([
      ...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`),
      'data: [DONE]\n\n',
    ]),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function embeddingsResponse(body: string): Response {
  const parsed = parseJsonObject(body)
  const model = typeof parsed.model === 'string' ? parsed.model : 'unknown'
  const input = Array.isArray(parsed.input) ? parsed.input : []
  return Response.json({
    data: input.map((_, index) => ({
      embedding: [index + 0.1, index + 0.2, index + 0.3],
    })),
    model,
  })
}

function parseJsonObject(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function jsonGeneration(generationId: string, status = 200, headers?: HeadersInit): Response {
  return Response.json({ generationId, id: generationId }, { status, headers })
}

function streamChunks(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      if (delayMs <= 0) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
        return
      }
      enqueueDelayedChunks(controller, encoder, chunks, delayMs).catch(error =>
        controller.error(error),
      )
    },
  })
}

async function enqueueDelayedChunks(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  chunks: string[],
  delayMs: number,
): Promise<void> {
  for (const chunk of chunks) {
    await sleep(delayMs)
    controller.enqueue(encoder.encode(chunk))
  }
  controller.close()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(new Headers(headers).entries())
}

function printablePath(scenario: FakeVagScenario): string {
  if (typeof scenario.path === 'string') return scenario.path
  if (scenario.path instanceof RegExp) return String(scenario.path)
  return '<predicate>'
}

/**
 * Serve a fake VAG over real HTTP for consumers that run in a separate
 * process (the Convex reconcile action polls /v1/generation and cannot use
 * an injected fetch). Ephemeral port by default; stop() when done.
 */
export function serveFakeVag(fake: FakeVag, port?: number): { url: string; stop: () => void } {
  const server = startFakeVagServer(fake, port)
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

function startFakeVagServer(fake: FakeVag, port: number | undefined): ReturnType<typeof Bun.serve> {
  if (port !== undefined) {
    return Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: request => fake.fetch(request),
    })
  }

  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return Bun.serve({
        hostname: '127.0.0.1',
        port: randomTestPort(),
        fetch: request => fake.fetch(request),
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to start fake VAG')
}

function randomTestPort(): number {
  return 20_000 + Math.floor(Math.random() * 30_000)
}
