import type { ForwardRequest, HookContext, PriceRule } from '../../src/index'

export const elevenCredits: PriceRule = {
  kind: 'first',
  rules: [
    { kind: 'responseHeader', header: 'character-cost' },
    {
      kind: 'requestJson',
      paths: ['music_length_ms', 'composition_plan.sections[].duration_ms'],
      rate: 0.03,
    },
  ],
}

const elevenlabsVoiceCreateRoutes = new Set(['voice-create', 'voice-create-design'])

export function withElevenlabsVoiceLabels(request: ForwardRequest, context: HookContext): ForwardRequest {
  if (!elevenlabsVoiceCreateRoutes.has(context.route.id)) return request

  const labelsFor = (existing: unknown, prompt: string | undefined): Record<string, string> => {
    const labels: Record<string, string> = {}
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      for (const [key, value] of Object.entries(existing))
        if (typeof value === 'string') labels[key] = value
    } else if (typeof existing === 'string') {
      try {
        const parsed = JSON.parse(existing) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed))
            if (typeof value === 'string') labels[key] = value
        }
      } catch {
        // The vendor accepts a string form for multipart labels; replace an
        // invalid caller value with the proxy-owned metadata below.
      }
    }
    if (prompt !== undefined && prompt.length > 0) labels.designPrompt = prompt
    labels.createdVia = 'duet'
    return labels
  }

  if (request.body instanceof FormData) {
    const prompt = request.body.get('description')
    const labels = labelsFor(
      request.body.get('labels'),
      typeof prompt === 'string' ? prompt : undefined,
    )
    const body = new FormData()
    for (const [name, value] of request.body.entries()) body.append(name, value)
    body.set('labels', JSON.stringify(labels))
    const headers = new Headers(request.headers)
    headers.delete('content-type')
    return { ...request, headers, body }
  }

  if (typeof request.body !== 'string') return request
  let parsed: unknown
  try {
    parsed = JSON.parse(request.body)
  } catch {
    return request
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return request
  const input = parsed as Record<string, unknown>
  const prompt =
    typeof input.voice_description === 'string'
      ? input.voice_description
      : typeof input.description === 'string'
        ? input.description
        : undefined
  return { ...request, body: JSON.stringify({ ...input, labels: labelsFor(input.labels, prompt) }) }
}

