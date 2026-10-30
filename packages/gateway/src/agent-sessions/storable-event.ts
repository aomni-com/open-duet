import {
  type AgentTurnEvent,
  type AgentTurnState,
  CONVEX_EVENT_BUDGET_BYTES,
  relayedTurnState,
} from '@repo/contract'

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * The runner's working state stays on the VM: the checkpoint in this
 * session's envelope is written from the untrimmed event, and the wire carries
 * the slice the control plane reads (`relayedTurnState`).
 */
function projectedState(event: AgentTurnEvent): AgentTurnEvent {
  const state = (event as { state?: AgentTurnState }).state
  if (state === undefined) return event
  return { ...event, state: relayedTurnState(state) } as AgentTurnEvent
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

type ToolCallStep = Extract<
  Extract<AgentTurnEvent, { type: 'step' }>['step'],
  { type: 'tool_call' }
>

function toolCallStep(event: AgentTurnEvent): ToolCallStep | undefined {
  const step = (event as { step?: { type?: string } }).step
  return step?.type === 'tool_call' ? (step as ToolCallStep) : undefined
}

const PAYLOAD_PREVIEW_BYTES = 1024

function outputPreview(output: NonNullable<ToolCallStep['output']>): typeof output {
  if (jsonBytes(output) <= PAYLOAD_PREVIEW_BYTES) return output
  const text = output.map(part => (part.type === 'text' ? part.text : '')).join('\n')
  return [
    {
      type: 'text',
      text: textPreview(text, jsonBytes([{ type: 'text', text: '' }])),
    },
  ]
}

function textPreview(text: string, envelopeBytes = 2): string {
  const marker = `\n[truncated — ${humanBytes(Buffer.byteLength(text, 'utf8'))} total]`
  let remaining = PAYLOAD_PREVIEW_BYTES - envelopeBytes - (jsonBytes(marker) - 2)
  let head = ''
  // Count encoded characters: quotes, control characters and Unicode all cost
  // different numbers of bytes on the wire. The marker and array count too.
  for (const character of text) {
    const bytes = jsonBytes(character) - 2
    if (bytes > remaining) break
    head += character
    remaining -= bytes
  }
  return head + marker
}

function payloadSlots(event: AgentTurnEvent) {
  if (event.type === 'task_settled')
    return payloadFields(event.settlement, ['result', 'error', 'reason'])
  if (event.type === 'task_output') return payloadFields(event, ['chunk'])
  if (
    event.type === 'step' &&
    (event.step.type === 'tool_call' || event.step.type === 'tool_call_start')
  ) {
    return payloadFields(event.step, ['input', 'details'])
  }
  // Script results also appear in machine history, including on terminals.
  // Only diagnostics are previews: state identity, progress and definitions
  // remain intact for the control plane's lifecycle projection.
  const machine =
    event.type === 'state_machine'
      ? event.stateMachine
      : (event as { state?: AgentTurnState }).state?.stateMachine
  if (machine === undefined) return []
  const slots = payloadFields(machine, ['currentInput'])
  for (const entry of machine.history) {
    slots.push(...payloadFields(entry, ['input', 'output', 'error', 'reason']))
    if ('terminal' in entry) slots.push(...payloadFields(entry.terminal, ['reason']))
    if ('priorTerminal' in entry) slots.push(...payloadFields(entry.priorTerminal, ['reason']))
  }
  if (machine.terminal !== undefined) slots.push(...payloadFields(machine.terminal, ['reason']))
  return slots
}

function payloadFields(value: object, keys: string[]) {
  const record = value as Record<string, unknown>
  return keys
    .filter(key => record[key] !== undefined)
    .map(key => ({
      key,
      read: () => record[key],
      write: (value: unknown) => {
        record[key] = value
      },
    }))
}

function dataPreview(value: unknown, label: string): unknown {
  if (typeof value === 'string') return textPreview(value)
  const originalBytes = jsonBytes(value)
  const slots: ProseSlot[] = []
  collectProse(value, slots)
  truncateSlots(slots, originalBytes, PAYLOAD_PREVIEW_BYTES)
  if (jsonBytes(value) <= PAYLOAD_PREVIEW_BYTES) return value
  return { omitted: `[${label} omitted — ${humanBytes(originalBytes)} total]` }
}

/**
 * An event the control plane can store, and a timeline that says what it lost.
 *
 * Image data always goes: it is the bulk of an oversized event, nothing in the
 * control plane reads it, and a file the user should see belongs in the drive
 * where markdown can render it. Tool output is a bounded human preview even
 * when the event is below the storage ceiling. The same preview budget bounds
 * input, debug details and task diagnostics; local recovery data stays whole.
 */
export function storableEvent(event: AgentTurnEvent): AgentTurnEvent {
  const wire = projectedState(event)
  const step = toolCallStep(wire)
  const carriesImage = step?.output?.some(part => part.type === 'image') === true
  const oversizedOutput =
    step?.output !== undefined && jsonBytes(step.output) > PAYLOAD_PREVIEW_BYTES
  const oversizedPayload = payloadSlots(wire).some(
    slot => jsonBytes(slot.read()) > PAYLOAD_PREVIEW_BYTES,
  )
  if (
    !carriesImage &&
    !oversizedOutput &&
    !oversizedPayload &&
    jsonBytes(wire) <= CONVEX_EVENT_BUDGET_BYTES
  ) {
    return wire
  }

  const trimmed = structuredClone(wire)
  for (const slot of payloadSlots(trimmed)) {
    if (jsonBytes(slot.read()) > PAYLOAD_PREVIEW_BYTES)
      slot.write(dataPreview(slot.read(), slot.key))
  }
  const trimmedStep = toolCallStep(trimmed)
  if (trimmedStep?.output !== undefined) {
    trimmedStep.output = trimmedStep.output.map(part =>
      part.type === 'image'
        ? {
            type: 'text' as const,
            text: `[image omitted — ${humanBytes(Buffer.byteLength(part.data, 'utf8'))} ${part.mimeType}]`,
          }
        : part,
    )
    trimmedStep.output = outputPreview(trimmedStep.output)
  }
  if (jsonBytes(trimmed) <= CONVEX_EVENT_BUDGET_BYTES) return trimmed

  truncateProse(trimmed)
  return trimmed
}

/**
 * Cut the longest strings until the event fits, largest first, so one runaway
 * output is trimmed before a short one beside it is touched at all. Each slot
 * is cut at most once: a second cut would rewrite the marker with the size of
 * the already-truncated text and report a 4 MB output as a 300 KB one.
 */
function truncateProse(event: AgentTurnEvent): void {
  truncateSlots(proseSlots(event), jsonBytes(event), CONVEX_EVENT_BUDGET_BYTES)
}

function truncateSlots(prose: ProseSlot[], bytes: number, budget: number): void {
  const slots = prose
    .map(slot => ({ slot, bytes: Buffer.byteLength(slot.read(), 'utf8') }))
    .sort((a, b) => b.bytes - a.bytes)
  for (const { slot, bytes: originalBytes } of slots) {
    const overflow = bytes - budget
    if (overflow <= 0) return
    const original = slot.read()
    const marker = `\n[truncated — ${humanBytes(originalBytes)} total]`
    // JSON encodes the marker's newline as two characters, and a cut that
    // lands one byte over costs a whole second pass, so buy slack outright.
    const keep = originalBytes - overflow - Buffer.byteLength(marker, 'utf8') - JSON_ESCAPE_SLACK
    const replacement =
      keep <= 0 ? marker.trimStart() : `${cutOnCharacterBoundary(original, keep)}${marker}`
    const reduction =
      Buffer.byteLength(JSON.stringify(original)) - Buffer.byteLength(JSON.stringify(replacement))
    if (reduction <= 0) continue
    slot.write(replacement)
    // Only this JSON string changed; account for escaping without serializing
    // the entire nested event again for each leaf.
    bytes -= reduction
  }
}

const JSON_ESCAPE_SLACK = 16

interface ProseSlot {
  read: () => string
  write: (text: string) => void
}

/** Prose eligible for trimming at the whole-event safety ceiling. */
function proseSlots(event: AgentTurnEvent): ProseSlot[] {
  const slots: ProseSlot[] = []
  const step = (event as { step?: Record<string, unknown> }).step
  if (step !== undefined) {
    for (const key of ['text', 'message'] as const) {
      if (typeof step[key] === 'string') {
        slots.push({ read: () => step[key] as string, write: text => void (step[key] = text) })
      }
    }
    const output = (step as ToolCallStep).output
    if (Array.isArray(output)) {
      for (const part of output) {
        if (part.type !== 'text') continue
        slots.push({ read: () => part.text, write: text => void (part.text = text) })
      }
    }
    // Tool arguments can nest whole files or state definitions inside objects
    // and arrays. These are display copies; the executed arguments stay intact.
    const input = (step as { input?: Record<string, unknown> }).input
    if (input !== undefined) collectProse(input, slots)
  }
  const terminal = event as { result?: unknown; error?: unknown }
  for (const key of ['result', 'error'] as const) {
    if (typeof terminal[key] === 'string') {
      slots.push({
        read: () => terminal[key] as string,
        write: text => void (terminal[key] = text),
      })
    }
  }
  return slots
}

function collectProse(value: unknown, slots: ProseSlot[]): void {
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const record = value as Record<string, unknown>
    if (typeof child === 'string') {
      slots.push({ read: () => record[key] as string, write: text => void (record[key] = text) })
    } else {
      collectProse(child, slots)
    }
  }
}

/**
 * Cut to at most `maxBytes`, never mid-character: a split code point would
 * relay a replacement glyph, and a split surrogate pair breaks JSON encoding
 * outright.
 */
function cutOnCharacterBoundary(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text)
  if (encoded.byteLength <= maxBytes) return text
  // Non-fatal by default: a cut that lands mid-code-point yields U+FFFD, which
  // the caller strips, rather than throwing.
  return new TextDecoder().decode(encoded.subarray(0, maxBytes)).replace(/�$/, '')
}
