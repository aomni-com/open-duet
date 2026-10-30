import { expect, test } from 'bun:test'

import { encodeSignedDescriptor } from '../signed-descriptor'
import {
  checkAuthorizationResponseIssuer,
  encodeMcpConnectState,
  verifyMcpConnectState,
  type McpConnectStateDescriptor,
} from './oauth'

const EXPECTED = 'https://issuer.test/v1/test-only/oauth-issuer'
const SECRET = 'api-internal-key'
const NOW = 1_000

function descriptor(overrides: Partial<McpConnectStateDescriptor> = {}): McpConnectStateDescriptor {
  return {
    version: 1,
    kind: 'mcp-connect',
    workspaceSlug: 'acme',
    serverId: 'server_1',
    attempt: 'attempt-1',
    destination: 'https://app.duet.so/w/acme/integrations',
    expiresAt: NOW + 600_000,
    ...overrides,
  }
}

/**
 * D23's table, which the SDK does not implement anywhere: `client/auth.js` has
 * no `iss` handling at all, so a client that leans on it performs none of RFC
 * 9207's mixed-up-authorization-server defence.
 */
test('the four iss rows: advertised support decides only whether absence is fatal', () => {
  const advertised = { authorization_response_iss_parameter_supported: true }
  const silent = {}

  expect(
    checkAuthorizationResponseIssuer({
      metadata: advertised,
      iss: EXPECTED,
      expectedIssuer: EXPECTED,
    }),
  ).toBe('ok')
  expect(
    checkAuthorizationResponseIssuer({ metadata: advertised, iss: null, expectedIssuer: EXPECTED }),
  ).toBe('missing')
  // Absent support plus a present `iss` still compares: a server may emit the
  // parameter before it updates its metadata, and that response is exactly the
  // one an attacker would have to forge.
  expect(
    checkAuthorizationResponseIssuer({
      metadata: silent,
      iss: 'https://evil.test',
      expectedIssuer: EXPECTED,
    }),
  ).toBe('mismatch')
  expect(
    checkAuthorizationResponseIssuer({ metadata: silent, iss: null, expectedIssuer: EXPECTED }),
  ).toBe('ok')
})

test('a state descriptor round trips, and expires on its own ten-minute clock', async () => {
  const state = await encodeMcpConnectState(descriptor(), SECRET)

  expect(await verifyMcpConnectState(state, SECRET, NOW)).toEqual(descriptor())
  // The row in Convex expires too, but the state has to refuse on its own: a
  // callback that never reaches the row must not be readable a day later.
  expect(await verifyMcpConnectState(state, SECRET, NOW + 600_001)).toBeNull()
})

test('anything that is not exactly this descriptor is not a descriptor', async () => {
  const state = await encodeMcpConnectState(descriptor(), SECRET)

  const refusals = {
    tampered: `${state}x`,
    otherSecret: await encodeMcpConnectState(descriptor(), 'someone-elses-key'),
    unsigned: `${state.split('.')[0]}.`,
    absent: undefined,
    // The whole point of the exact-keys check: a version-skewed or bolted-on
    // field would otherwise parse partially and take a branch nobody wrote.
    extraField: await encodeSignedDescriptor({ ...descriptor(), scope: 'admin' }, SECRET),
    missingField: await encodeSignedDescriptor(
      { version: 1, kind: 'mcp-connect', workspaceSlug: 'acme', expiresAt: NOW + 1 },
      SECRET,
    ),
    // A descriptor Duet signs for a DIFFERENT callback. Same secret, same
    // shape family, and it must still not be usable here.
    otherKind: await encodeSignedDescriptor(
      {
        version: 1,
        kind: 'user-connect',
        workspaceSlug: 'acme',
        destination: '/',
        expiresAt: NOW + 1,
      },
      SECRET,
    ),
    futureVersion: await encodeSignedDescriptor({ ...descriptor(), version: 2 }, SECRET),
  }

  for (const [name, value] of Object.entries(refusals)) {
    expect(await verifyMcpConnectState(value, SECRET, NOW), name).toBeNull()
  }
})

test('comparison is byte-for-byte: no case folding, port elision, or slash normalization', () => {
  const metadata = { authorization_response_iss_parameter_supported: true }
  const near = [
    `${EXPECTED}/`,
    EXPECTED.replace('issuer.test', 'Issuer.Test'),
    EXPECTED.replace('https://issuer.test', 'https://issuer.test:443'),
    EXPECTED.replace('oauth-issuer', 'oauth%2Dissuer'),
  ]

  for (const iss of near) {
    expect(checkAuthorizationResponseIssuer({ metadata, iss, expectedIssuer: EXPECTED }), iss).toBe(
      'mismatch',
    )
  }
})
