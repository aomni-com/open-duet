import { describe, expect, test } from 'bun:test'

import { callService } from './call-service'
import { elevenlabs } from '@repo/service-catalog'

describe('callService', () => {
  test('matches catalog routes, injects vault auth, and returns vendor pricing', async () => {
    let seen: Request | undefined
    const result = await callService([elevenlabs], {
      now: () => 100,
      credentials: { get: async () => ({ secret: 'vendor-secret', fingerprint: 'fingerprint' }) },
      fetch: async (input, init) => {
        seen = new Request(input, init)
        return new Response('audio', { status: 200, headers: { 'character-cost': '28', 'content-type': 'audio/mpeg' } })
      },
    }, {
      serviceId: 'elevenlabs', method: 'POST', path: '/v1/text-to-speech/voice-1', search: '?q=a', headers: new Headers({ authorization: 'caller', 'x-duet-workspace': 'demo' }), body: JSON.stringify({ text: 'hi' }), workspaceId: 'workspace-demo',
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.charge).toEqual({ vendorCostMicroUsd: 2240, chargeMicroUsd: 2688, reference: undefined })
    expect(seen?.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice-1?q=a')
    expect(seen?.headers.get('xi-api-key')).toBe('vendor-secret')
    expect(seen?.headers.get('authorization')).toBeNull()
  })

  test('returns 404 before credential access for an unlisted route', async () => {
    let reads = 0
    const result = await callService([elevenlabs], { now: () => 0, credentials: { get: async () => { reads += 1; return null } }, fetch: async () => new Response() }, { serviceId: 'elevenlabs', method: 'GET', path: '/v1/history', search: '', headers: new Headers(), body: null, workspaceId: 'workspace-demo' })
    expect(result).toEqual({ kind: 'not_found' })
    expect(reads).toBe(0)
  })

  test('forwards vendor query parameters, including workspace values, unchanged', async () => {
    let seen = ''
    await callService([elevenlabs], {
      now: () => 0,
      credentials: { get: async () => ({ secret: 'vendor-secret', fingerprint: 'f' }) },
      fetch: async input => { seen = String(input); return new Response('ok', { status: 200 }) },
    }, { serviceId: 'elevenlabs', method: 'GET', path: '/v1/models', search: '?workspace=vendor-workspace&limit=1', headers: new Headers(), body: null, workspaceId: 'workspace-demo' })
    expect(seen).toBe('https://api.elevenlabs.io/v1/models?workspace=vendor-workspace&limit=1')
  })

  test('forwards arbitrary vendor query parameters unchanged', async () => {
    let seen = ''
    await callService([elevenlabs], {
      now: () => 0,
      credentials: { get: async () => ({ secret: 'vendor-secret', fingerprint: 'f' }) },
      fetch: async input => { seen = String(input); return new Response('ok', { status: 200 }) },
    }, {
      serviceId: 'elevenlabs', method: 'GET', path: '/v1/models', search: '?apiKey=vendor-param&workspace=vendor-workspace&limit=1',
      headers: new Headers(), body: null, workspaceId: 'workspace-demo',
    })
    expect(seen).toBe('https://api.elevenlabs.io/v1/models?apiKey=vendor-param&workspace=vendor-workspace&limit=1')
  })

  test('records a created shared-pool resource before returning it', async () => {
    let recorded: unknown
    const result = await callService([elevenlabs], {
      now: () => 1_000,
      credentials: { get: async () => ({ secret: 'vendor-secret', fingerprint: 'f' }) },
      fetch: async () => new Response(JSON.stringify({ voice_id: 'new-voice' }), { status: 200 }),
      recordPoolResource: async input => { recorded = input },
    }, {
      serviceId: 'elevenlabs', method: 'POST', path: '/v1/voices/add', search: '', headers: new Headers(), body: JSON.stringify({ name: 'temporary' }), workspaceId: 'workspace-demo',
    })
    expect(result.kind).toBe('ok')
    expect(recorded).toEqual({
      serviceId: 'elevenlabs',
      pool: 'voice',
      resourceId: 'new-voice',
      workspaceId: 'workspace-demo',
      expiresAt: 86_401_000,
      expiry: {
        baseUrl: 'https://api.elevenlabs.io',
        method: 'DELETE',
        path: '/v1/voices/:voiceId',
        authKind: 'header',
        authName: 'xi-api-key',
      },
    })
  })

  test('the proxy labels ElevenLabs voice creations with their design prompt', async () => {
    let seenBody = ''
    const result = await callService([elevenlabs], {
      now: () => 1_000,
      credentials: { get: async () => ({ secret: 'vendor-secret', fingerprint: 'f' }) },
      fetch: async (_input, init) => { seenBody = await new Response(init?.body as BodyInit).text(); return new Response(JSON.stringify({ voice_id: 'new-voice' }), { status: 200 }) },
      recordPoolResource: async () => {},
    }, {
      serviceId: 'elevenlabs', method: 'POST', path: '/v1/text-to-voice', search: '', headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ voice_name: 'Sassy mouse', voice_description: 'A sassy squeaky mouse', labels: { language: 'en', createdVia: 'caller' } }), workspaceId: 'workspace-demo',
    })
    expect(result.kind).toBe('ok')
    expect(JSON.parse(seenBody)).toEqual({ voice_name: 'Sassy mouse', voice_description: 'A sassy squeaky mouse', labels: { language: 'en', designPrompt: 'A sassy squeaky mouse', createdVia: 'duet' } })
  })

  test('the proxy labels multipart voice uploads when the vendor accepts labels', async () => {
    let labels = ''
    const form = new FormData()
    form.set('name', 'Uploaded mouse')
    form.set('description', 'A sassy squeaky mouse')
    form.set('labels', JSON.stringify({ language: 'en' }))
    form.set('files', new Blob(['audio']), 'sample.wav')
    const result = await callService([elevenlabs], {
      now: () => 1_000,
      credentials: { get: async () => ({ secret: 'vendor-secret', fingerprint: 'f' }) },
      fetch: async (_input, init) => { labels = String((await new Request('https://vendor.test', init).formData()).get('labels')); return new Response(JSON.stringify({ voice_id: 'new-voice' }), { status: 200 }) },
      recordPoolResource: async () => {},
    }, {
      serviceId: 'elevenlabs', method: 'POST', path: '/v1/voices/add', search: '', headers: new Headers({ 'content-type': 'multipart/form-data; boundary=unused' }), body: form, workspaceId: 'workspace-demo',
    })
    expect(result.kind).toBe('ok')
    expect(JSON.parse(labels)).toEqual({ language: 'en', designPrompt: 'A sassy squeaky mouse', createdVia: 'duet' })
  })

  test('rebuilds buffered multipart bodies with a matching boundary', async () => {
    let contentType = ''
    let isBlob = false
    const form = new FormData()
    form.set('file', new Blob(['audio']), 'sample.wav')
    const result = await callService([elevenlabs], {
      now: () => 1_000,
      credentials: { get: async () => ({ secret: 'vendor-secret', fingerprint: 'f' }) },
      fetch: async (_input, init) => {
        const forwarded = new Request('https://vendor.test', init)
        contentType = forwarded.headers.get('content-type') ?? ''
        isBlob = (await forwarded.formData()).get('file') instanceof Blob
        return new Response('audio', { status: 200 })
      },
    }, {
      serviceId: 'elevenlabs', method: 'POST', path: '/v1/speech-to-text', search: '', headers: new Headers({ 'content-type': 'multipart/form-data; boundary=old-boundary' }), body: form, workspaceId: 'workspace-demo',
    })
    expect(result.kind).toBe('ok')
    expect(contentType).toContain('boundary=')
    expect(contentType).not.toContain('old-boundary')
    expect(isBlob).toBe(true)
  })

  test('returns a marked failure and calls cleanup when pool tracking fails', async () => {
    let cleaned: unknown
    const result = await callService([elevenlabs], {
      now: () => 1_000,
      credentials: { get: async () => ({ secret: 'vendor-secret', fingerprint: 'f' }) },
      fetch: async () => new Response(JSON.stringify({ voice_id: 'orphan' }), { status: 200 }),
      recordPoolResource: async () => { throw new Error('convex unavailable') },
      cleanupPoolResource: async input => { cleaned = input },
    }, {
      serviceId: 'elevenlabs', method: 'POST', path: '/v1/voices/add', search: '', headers: new Headers(), body: JSON.stringify({ name: 'temporary' }), workspaceId: 'workspace-demo',
    })
    expect(result).toEqual({ kind: 'pool_record_failed', routeId: 'voice-create' })
    expect(cleaned).toEqual({ serviceId: 'elevenlabs', pool: 'voice', resourceId: 'orphan' })
  })
})
