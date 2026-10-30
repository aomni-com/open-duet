/**
 * The one place an MCP tool result is shrunk before it reaches a model.
 *
 * Pure, no I/O: it takes a serialized JSON-RPC payload and gives one back.
 * Nothing here cuts bytes off the frame — a truncated frame is unparseable
 * JSON, which turns an oversized-but-useful result into a hard tool failure,
 * strictly worse than shipping the oversized one. The size the limit is
 * measured against is the serialized `result` (`content` and
 * `structuredContent` together), never the whole envelope.
 */
export interface CappedMcpPayload {
  body: string
  /** Serialized size of the original `result`, present only when it was cut. */
  cappedFrom?: number
}

export function capMcpPayload(
  body: string,
  contentType: string | null,
  limitBytes: number,
): CappedMcpPayload {
  const mediaType = (contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (mediaType === 'application/json') {
    const capped = capJsonRpcMessage(body, limitBytes)
    return capped.cappedFrom === undefined
      ? { body }
      : { body: capped.text, cappedFrom: capped.cappedFrom }
  }
  if (mediaType === 'text/event-stream') return capEventStream(body, limitBytes)
  return { body }
}

/**
 * Split an SSE body on frame boundaries, keeping each boundary's exact bytes.
 *
 * This is deliberately a local ~30 lines rather than `packages/test-harness`'s
 * `SseFrameParser`: `apps/api` cannot depend on that package in production —
 * the import typechecks locally and fails the Vercel build — and the cap needs
 * frame splitting, not a reader. Terminators are preserved verbatim so an
 * uncapped stream is forwarded byte for byte.
 */
export function splitSseFrames(body: string): { text: string; terminator: string }[] {
  const frames: { text: string; terminator: string }[] = []
  let rest = body
  while (rest.length > 0) {
    const boundary = nextFrameBoundary(rest)
    if (boundary === undefined) {
      frames.push({ text: rest, terminator: '' })
      break
    }
    frames.push({
      text: rest.slice(0, boundary.index),
      terminator: rest.slice(boundary.index, boundary.index + boundary.length),
    })
    rest = rest.slice(boundary.index + boundary.length)
  }
  return frames
}

function nextFrameBoundary(text: string): { index: number; length: number } | undefined {
  let best: { index: number; length: number } | undefined
  for (const terminator of ['\n\n', '\r\n\r\n', '\r\r']) {
    const index = text.indexOf(terminator)
    if (index === -1) continue
    // A shorter terminator can start at the same offset as a longer one only
    // for '\r\r' vs '\r\n\r\n', which cannot overlap; earliest wins otherwise.
    if (best === undefined || index < best.index) best = { index, length: terminator.length }
  }
  return best
}

function capEventStream(body: string, limitBytes: number): CappedMcpPayload {
  let cappedFrom = 0
  const rebuilt = splitSseFrames(body).map(frame => {
    const capped = capSseFrame(frame.text, limitBytes)
    if (capped.cappedFrom !== undefined) cappedFrom += capped.cappedFrom
    return `${capped.text}${frame.terminator}`
  })
  if (cappedFrom === 0) return { body }
  return { body: rebuilt.join(''), cappedFrom }
}

/** SSE joins a frame's `data:` lines with newlines; one JSON-RPC message. */
function capSseFrame(frame: string, limitBytes: number): { text: string; cappedFrom?: number } {
  const lines = frame.split('\n')
  const dataLines: number[] = []
  const values: string[] = []
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('data:')) continue
    dataLines.push(index)
    const value = line.slice('data:'.length).replace(/\r$/, '')
    values.push(value.startsWith(' ') ? value.slice(1) : value)
  }
  if (dataLines.length === 0) return { text: frame }

  const capped = capJsonRpcMessage(values.join('\n'), limitBytes)
  if (capped.cappedFrom === undefined) return { text: frame }

  const carriageReturn = lines[dataLines[0]!]!.endsWith('\r') ? '\r' : ''
  const replacement = capped.text.split('\n').map(value => `data: ${value}${carriageReturn}`)
  const rebuilt: string[] = []
  for (const [index, line] of lines.entries()) {
    if (index === dataLines[0]) rebuilt.push(...replacement)
    else if (!dataLines.includes(index)) rebuilt.push(line)
  }
  return { text: rebuilt.join('\n'), cappedFrom: capped.cappedFrom }
}

interface CappedMessage {
  text: string
  cappedFrom?: number
}

function capJsonRpcMessage(text: string, limitBytes: number): CappedMessage {
  let message: unknown
  try {
    message = JSON.parse(text)
  } catch {
    return { text }
  }
  const result = toolCallResult(message)
  if (result === undefined) return { text }

  const originalBytes = serializedBytes(result)
  if (originalBytes <= limitBytes) return { text }

  // The same half `storable-event.ts` discards first, and for the same reason:
  // `content` usually carries the identical information in prose. Measured on a
  // real server, `structuredContent` came back a near-exact copy of `content`
  // (688,299 against 688,313 bytes), so this halves an oversized result at zero
  // information cost.
  if (result.structuredContent !== undefined) {
    const droppedBytes = serializedBytes(result.structuredContent)
    delete result.structuredContent
    // Unless it was the whole answer. A server that sends structure and no
    // prose would otherwise hand the model an empty result and no reason for it.
    if (!Array.isArray(result.content) || result.content.length === 0) {
      result.content = [{ type: 'text', text: truncationMarker(0, droppedBytes).trimStart() }]
    }
    // A server sends `structuredContent` because it declared an `outputSchema`,
    // and the SDK client rejects a schema-bearing result that arrives without
    // one — `MCP error -32600`, a hard tool failure rather than the truncated
    // document the cap was trying to preserve. Its single exemption is a result
    // already flagged as an error, and truncating the structure instead only
    // moves the refusal to the schema validator. So the cap says what is true:
    // it could not deliver the half the tool promised. The prose it kept, and
    // the marker naming the original size, ride along on the error.
    result.isError = true
  }
  if (serializedBytes(result) > limitBytes) truncateTextParts(result, limitBytes)
  return { text: JSON.stringify(message), cappedFrom: originalBytes }
}

interface ToolCallResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
}

/**
 * Only a `tools/call` result is capped. A response carries no method, so the
 * shape is the discriminator: `tools/list` answers with `tools`, and capping
 * one would truncate a tool schema into a silently malformed tool.
 */
function toolCallResult(message: unknown): ToolCallResult | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined
  const result = (message as { result?: unknown }).result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined
  const candidate = result as ToolCallResult
  const carriesToolOutput =
    Array.isArray(candidate.content) || candidate.structuredContent !== undefined
  return carriesToolOutput ? candidate : undefined
}

interface TextPart {
  text: string
}

/**
 * Cut text parts largest-first, each at most once: a second cut would rewrite
 * the marker with the already-truncated size and report a 4 MB output as a
 * 128 KB one.
 */
function truncateTextParts(result: ToolCallResult, limitBytes: number): void {
  if (!Array.isArray(result.content)) return
  const parts = result.content
    .filter(
      (part): part is TextPart =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .sort((left, right) => byteLength(right.text) - byteLength(left.text))

  for (const part of parts) {
    const overflow = serializedBytes(result) - limitBytes
    if (overflow <= 0) return
    const originalBytes = byteLength(part.text)
    // The marker's own length depends on how much survives, and how much
    // survives depends on the marker's length. Budget against the widest the
    // marker can be — `kept` never has more digits than `originalBytes`.
    const reserve = byteLength(truncationMarker(originalBytes, originalBytes))
    const keep = originalBytes - overflow - reserve - JSON_ESCAPE_SLACK
    const kept = keep <= 0 ? '' : cutOnCharacterBoundary(part.text, keep)
    const marker = truncationMarker(byteLength(kept), originalBytes)
    part.text = kept === '' ? marker.trimStart() : `${kept}${marker}`
  }
}

function truncationMarker(keptBytes: number, originalBytes: number): string {
  return `\n[truncated — ${keptBytes} of ${originalBytes} bytes; narrow the query or request a smaller range]`
}

/** JSON escapes the marker's newline as two characters; buy the slack outright. */
const JSON_ESCAPE_SLACK = 16

function serializedBytes(value: unknown): number {
  return byteLength(JSON.stringify(value))
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Cut to at most `maxBytes`, never mid-character: a split code point relays a
 * replacement glyph and a split surrogate pair breaks JSON encoding outright.
 */
function cutOnCharacterBoundary(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.byteLength <= maxBytes) return text
  return new TextDecoder('utf8', { fatal: false })
    .decode(encoded.subarray(0, maxBytes))
    .replace(/�$/, '')
}
