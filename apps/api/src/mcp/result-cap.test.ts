import { describe, expect, test } from 'bun:test'

import { capMcpPayload } from './result-cap'

describe('capMcpPayload', () => {
  test('leaves a tool result inside the limit byte-identical', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'small answer' }] },
    })

    expect(capMcpPayload(body, 'application/json', 1024)).toEqual({ body })
  })

  test('drops structuredContent first and keeps the prose intact', () => {
    const prose = 'x'.repeat(400)
    const result = {
      content: [{ type: 'text', text: prose }],
      structuredContent: { rows: Array.from({ length: 200 }, (_, index) => ({ index })) },
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result })

    const capped = capMcpPayload(body, 'application/json', 600)

    expect(capped.cappedFrom).toBe(Buffer.byteLength(JSON.stringify(result), 'utf8'))
    expect(JSON.parse(capped.body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      // Flagged because the structured half is gone, not because the tool
      // failed — see the schema-bearing case below.
      result: { content: [{ type: 'text', text: prose }], isError: true },
    })
  })

  test('says so when structured output was the whole answer', () => {
    const structuredContent = { rows: 'r'.repeat(4000) }
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [], structuredContent },
    })

    const capped = capMcpPayload(body, 'application/json', 512)

    const parsed = JSON.parse(capped.body) as { result: { content: { text: string }[] } }
    expect(parsed.result).not.toHaveProperty('structuredContent')
    expect(parsed.result.content[0]!.text).toContain(
      `of ${Buffer.byteLength(JSON.stringify(structuredContent), 'utf8')} bytes`,
    )
    expect(parsed.result.content[0]!.text).toContain('narrow the query')
  })

  test('leaves a result capped by prose alone a success', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'h'.repeat(4000) }] },
    })

    const parsed = JSON.parse(capMcpPayload(body, 'application/json', 512).body) as {
      result: { isError?: boolean }
    }

    expect(parsed.result.isError).toBeUndefined()
  })

  test('truncates the largest text part first and leaves the small one whole', () => {
    const huge = 'h'.repeat(4000)
    const small = 'the short but load-bearing answer'
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        content: [
          { type: 'text', text: small },
          { type: 'text', text: huge },
        ],
      },
    })

    const capped = capMcpPayload(body, 'application/json', 512)

    const parsed = JSON.parse(capped.body) as {
      result: { content: { type: string; text: string }[] }
    }
    expect(Buffer.byteLength(JSON.stringify(parsed.result), 'utf8')).toBeLessThanOrEqual(512)
    expect(parsed.result.content[0]!.text).toBe(small)
    expect(parsed.result.content[1]!.text.startsWith('hhhh')).toBe(true)
    expect(parsed.result.content[1]!.text).toContain('of 4000 bytes')
    expect(parsed.result.content[1]!.text).toContain('narrow the query')
  })

  test('caps an SSE-framed tool result, the framing real servers actually use', () => {
    const huge = 'h'.repeat(4000)
    const frame = `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: huge }] },
    })}\n\n`

    const capped = capMcpPayload(frame, 'text/event-stream; charset=utf-8', 512)

    expect(capped.cappedFrom).toBeGreaterThan(4000)
    const lines = capped.body.split('\n')
    expect(lines[0]).toBe('event: message')
    expect(capped.body.endsWith('\n\n')).toBe(true)
    const parsed = JSON.parse(lines[1]!.slice('data: '.length)) as {
      result: { content: { text: string }[] }
    }
    expect(parsed.result.content[0]!.text).toContain('of 4000 bytes')
  })

  test('forwards an SSE stream the cap does not touch byte for byte', () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}]}}\n\n' +
      ': keepalive\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n'

    expect(capMcpPayload(body, 'text/event-stream', 1024)).toEqual({ body })
  })

  test('leaves a result of exactly the limit alone and cuts one byte over it', () => {
    const envelope = (text: string) =>
      JSON.stringify({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text }] } })
    const atLimit = envelope('a'.repeat(300))
    const limit = Buffer.byteLength(
      JSON.stringify((JSON.parse(atLimit) as { result: unknown }).result),
      'utf8',
    )

    expect(capMcpPayload(atLimit, 'application/json', limit)).toEqual({ body: atLimit })
    expect(capMcpPayload(envelope('a'.repeat(301)), 'application/json', limit).cappedFrom).toBe(
      limit + 1,
    )
  })

  test('never truncates a tools/list result, however large', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      result: {
        tools: Array.from({ length: 60 }, (_, index) => ({
          name: `tool_${index}`,
          description: 'd'.repeat(200),
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    })

    expect(capMcpPayload(body, 'application/json', 512)).toEqual({ body })
  })

  test('halves a server-duplicated result at zero information cost', () => {
    // Shape measured on mcp.deepwiki.com: `read_wiki_contents` answered with
    // 688,313 bytes of `content` and a 688,299-byte near-identical copy in
    // `structuredContent`. Scaled down here, the ratio is what matters.
    const article = 'a'.repeat(100 * 1024)
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 6,
      result: {
        content: [{ type: 'text', text: article }],
        structuredContent: { markdown: article },
      },
    })

    const capped = capMcpPayload(body, 'application/json', 128 * 1024)

    expect(capped.cappedFrom).toBeGreaterThan(200 * 1024)
    expect(JSON.parse(capped.body)).toEqual({
      jsonrpc: '2.0',
      id: 6,
      result: { content: [{ type: 'text', text: article }], isError: true },
    })
  })
})
