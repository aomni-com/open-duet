import { expect, test } from 'bun:test'

import { X_DUET_GATEWAY_HEADER } from '@repo/contract'

import { runCli } from '../src/cli.js'

function sink(): { chunks: string[]; write(chunk: string): boolean } {
  const chunks: string[] = []
  return { chunks, write: (chunk: string) => { chunks.push(chunk); return true } }
}

test('services call preserves vendor errors while mapping Duet gateway blocks', async () => {
  const vendorStdout = sink()
  const vendorStderr = sink()
  const vendor = await runCli(['services', 'call', 'elevenlabs', 'POST', '/v1/text-to-speech/voice'], {
    env: { DUET_API_KEY: 'key', DUET_API_URL: 'https://api.test', DUET_WORKSPACE: 'workspace' },
    io: { stdout: vendorStdout, stderr: vendorStderr },
    fetch: async (_input, init) => {
      expect(init?.method).toBe('POST')
      return Response.json({ error: 'vendor_bad_request', detail: 'invalid voice' }, { status: 422 })
    },
  })
  expect(vendor.exitCode).toBe(1)
  expect(vendorStdout.chunks.join('')).toContain('vendor_bad_request')
  expect(vendorStderr.chunks.join('')).toContain('HTTP 422')

  const gatewayStdout = sink()
  const gatewayStderr = sink()
  const gateway = await runCli(['services', 'call', 'elevenlabs', 'POST', '/v1/text-to-speech/voice'], {
    env: { DUET_API_KEY: 'key', DUET_API_URL: 'https://api.test', DUET_WORKSPACE: 'workspace' },
    io: { stdout: gatewayStdout, stderr: gatewayStderr },
    fetch: async () => new Response(JSON.stringify({ error: 'subscription_required' }), {
      status: 403,
      headers: { 'content-type': 'application/json', [X_DUET_GATEWAY_HEADER]: 'block' },
    }),
  })
  expect(gateway.exitCode).toBe(4)
  expect(gatewayStderr.chunks.join('')).toContain('Missing required scope')
})
