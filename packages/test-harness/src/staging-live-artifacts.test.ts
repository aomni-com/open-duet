import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import JSZip from 'jszip'

import {
  assertNoCredentialArtifacts,
  redactArtifactValue,
  safeRequestTarget,
  stagingProtectionHeaders,
  StagingArtifactCollector,
} from './staging-live-artifacts.ts'

describe('staging artifact secrecy', () => {
  test('registers a newly issued secret before writing diagnostics', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-transient-secret-'))
    try {
      const collector = new StagingArtifactCollector(directory, [])
      collector.registerSecret('fresh-runtime-authority')
      await collector.writeJson('receipt.json', { diagnostic: 'received fresh-runtime-authority' })
      expect(await Bun.file(path.join(directory, 'receipt.json')).json()).toEqual({
        diagnostic: 'received [REDACTED]',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  test('records only request origin and path, never bypass or auth query values', () => {
    expect(
      safeRequestTarget(
        'https://app-staging.duet.so/w/acme/sessions?x-vercel-protection-bypass=secret#token',
      ),
    ).toBe('https://app-staging.duet.so/w/acme/sessions')
  })

  test('redacts known secrets recursively without changing useful diagnostics', () => {
    const value = redactArtifactValue(
      {
        message: 'request failed with token duet_sk_super_secret',
        nested: ['safe', 'bypass-secret'],
        durationMs: 42,
      },
      ['duet_sk_super_secret', 'bypass-secret'],
    )

    expect(value).toEqual({
      message: 'request failed with token [REDACTED]',
      nested: ['safe', '[REDACTED]'],
      durationMs: 42,
    })
  })

  test('redacts unknown Duet keys and URL query credentials from diagnostics', () => {
    expect(
      redactArtifactValue(
        'failed https://auth.example.test/verify?token=magic#state with duet_sk_unknown_secret',
        [],
      ),
    ).toBe('failed https://auth.example.test/verify?[REDACTED_QUERY] with [REDACTED_DUET_KEY]')
  })

  test('rejects an unredacted Drive download grant in an artifact URL', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-drive-grant-artifacts-'))
    try {
      await Bun.write(
        path.join(directory, 'unsafe.txt'),
        `https://vm.example/v1/files/report.pdf?grant=${'g'.repeat(32)}`,
      )
      await expect(assertNoCredentialArtifacts(directory)).rejects.toThrow('query credential')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('redacts and rejects capability-bearing desktop entry paths', async () => {
    const entryUrl = `https://gateway.example/v1/desktop/grant-123.${'s'.repeat(32)}/?autoconnect=1`
    expect(redactArtifactValue(`viewer ${entryUrl}`, [])).toBe(
      'viewer https://gateway.example/v1/desktop/[REDACTED_DESKTOP_GRANT]/?[REDACTED_QUERY]',
    )
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-desktop-artifacts-'))
    try {
      await Bun.write(path.join(directory, 'unsafe.txt'), entryUrl)
      await expect(assertNoCredentialArtifacts(directory)).rejects.toThrow('unsafe.txt')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('redacts and rejects capability-bearing desktop debugger paths', async () => {
    const debuggerUrl = `ws://127.0.0.1/v1/desktop/browser/cdp/grant-123.${'d'.repeat(32)}`
    expect(redactArtifactValue(`debugger (${debuggerUrl})`, [])).toBe(
      'debugger (ws://127.0.0.1/v1/desktop/browser/cdp/[REDACTED_DESKTOP_GRANT])',
    )
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-desktop-debugger-artifacts-'))
    try {
      await Bun.write(path.join(directory, 'unsafe.txt'), debuggerUrl)
      await expect(assertNoCredentialArtifacts(directory)).rejects.toThrow('unsafe.txt')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects raw OAuth access, refresh, and authorization-code material in artifacts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-oauth-artifacts-'))
    try {
      await Bun.write(path.join(directory, 'safe.json'), '{"access_token":"[REDACTED_CREDENTIAL]"}')
      await assertNoCredentialArtifacts(directory)
      await Bun.write(path.join(directory, 'unsafe.txt'), `leaked duet_rt_${'r'.repeat(32)}`)
      await expect(assertNoCredentialArtifacts(directory)).rejects.toThrow('unsafe.txt')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  /**
   * RFC 7592's credential is the one that outlives a run: it deletes a client
   * registration at a third-party authorization server, and nothing else in
   * the artifact pipeline names it. The guard has to recognize BOTH shapes it
   * arrives in — the fake issuer's signed value, and the wire field any real
   * server answers a DCR POST with.
   */
  test('rejects registration-access-token material in artifacts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-registration-artifacts-'))
    try {
      await Bun.write(
        path.join(directory, 'safe.json'),
        '{"registration_access_token":"[REDACTED_CREDENTIAL]","token_type":"Bearer"}',
      )
      await assertNoCredentialArtifacts(directory)

      for (const [name, content] of [
        ['fixture.txt', `registered with fake-oauth-registration-${'r'.repeat(40)}`],
        ['snake.json', '{"registration_access_token":"Zm9vYmFyYmF6cXV4MTIzNDU2"}'],
        ['camel.json', '{"registrationAccessToken":"Zm9vYmFyYmF6cXV4MTIzNDU2"}'],
      ] as const) {
        const target = path.join(directory, name)
        await Bun.write(target, content)
        await expect(assertNoCredentialArtifacts(directory)).rejects.toThrow(name)
        await rm(target)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('adds the Vercel bypass only to exact staging origins', () => {
    const origins = new Set([
      'https://app-staging.duet.so',
      'https://lander-staging.duet.so',
      'https://docs-staging.duet.so',
    ])
    expect(
      stagingProtectionHeaders(
        'https://app-staging.duet.so/sign-in',
        origins,
        { accept: 'text/html' },
        'bypass-secret',
      ),
    ).toEqual({ accept: 'text/html', 'x-vercel-protection-bypass': 'bypass-secret' })
    expect(
      stagingProtectionHeaders(
        'https://accounts.google.com/o/oauth2/auth',
        origins,
        { accept: 'text/html' },
        'bypass-secret',
      ),
    ).toEqual({ accept: 'text/html' })
  })

  test('sanitizes trace text while preserving binary resources', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-trace-'))
    const target = path.join(directory, 'trace.zip')
    const binary = new Uint8Array([0, 255, 13, 37])
    const binaryWithSecret = new Uint8Array([
      0,
      255,
      ...Buffer.from('prefix-bypass-secret-suffix'),
      13,
    ])
    try {
      const archive = new JSZip()
      archive.file(
        'trace.network',
        [
          'bypass-secret https://auth.example/verify?token=magic duet_sk_unknown',
          '{"name":"cookie","value":"duet_session=ZXlKdGIyTnIifQ"}',
          '{"name":"duet_session","value":"ZXlKMGIydGxiaUk2SW1SMVpYUmZjMnRm"}',
          '{"value":"Bearer dynamic-jwt","name":"authorization"}',
          JSON.stringify({
            message: 'navigating to "https://auth.example/verify?token=magic", waiting',
          }),
          JSON.stringify({
            request: {
              url: 'https://app.example/sign-in?returnTo=%2F&code=one-time-code',
              queryString: [
                { name: 'returnTo', value: '/' },
                { name: 'code', value: 'one-time-code' },
              ],
              headers: [
                { name: 'accept', value: 'application/json' },
                { name: 'cookie', value: 'duet_session=opaque' },
                { name: ':path', value: '/sign-in?code=magic-link-code&intent=magic-link' },
              ],
              cookies: [{ name: 'ordinary-name', value: 'opaque-cookie' }],
              postData: {
                mimeType: 'application/json',
                text: JSON.stringify({
                  action: 'auth:signIn',
                  args: { params: { code: 'one-time-code' } },
                }),
              },
            },
          }),
        ].join('\n'),
      )
      archive.file(
        'resources/0123456789abcdef',
        '{"access_token":"opaque-value","vmProxyToken":"proxy-value","authorization":"Bearer dynamic-secret"}',
      )
      archive.file('resources/image.png', binary)
      archive.file('resources/opaque-binary', binaryWithSecret)
      await Bun.write(target, await archive.generateAsync({ type: 'uint8array' }))

      const output = path.join(directory, 'sanitized.zip')
      await new StagingArtifactCollector(directory, ['bypass-secret']).sanitizeTraceArchive(
        target,
        output,
      )

      const sanitized = await JSZip.loadAsync(await Bun.file(output).arrayBuffer())
      const networkLines = (await sanitized.file('trace.network')!.async('string')).split('\n')
      expect(networkLines.slice(0, 4).join('\n')).toBe(
        [
          '[REDACTED] https://auth.example/verify?[REDACTED_QUERY] [REDACTED_DUET_KEY]',
          '{"name":"cookie","value":"[REDACTED_CREDENTIAL]"}',
          '{"name":"duet_session","value":"[REDACTED_CREDENTIAL]"}',
          '{"value":"[REDACTED_CREDENTIAL]","name":"authorization"}',
        ].join('\n'),
      )
      expect(JSON.parse(networkLines[4]!)).toEqual({
        message: 'navigating to "https://auth.example/verify?[REDACTED_QUERY]", waiting',
      })
      expect(JSON.parse(networkLines[5]!)).toEqual({
        request: {
          url: 'https://app.example/sign-in?[REDACTED_QUERY]',
          queryString: [
            { name: 'returnTo', value: '[REDACTED_CREDENTIAL]' },
            { name: 'code', value: '[REDACTED_CREDENTIAL]' },
          ],
          headers: [
            { name: 'accept', value: 'application/json' },
            { name: 'cookie', value: '[REDACTED_CREDENTIAL]' },
            { name: ':path', value: '/sign-in?[REDACTED_QUERY]' },
          ],
          cookies: [{ name: 'ordinary-name', value: '[REDACTED_CREDENTIAL]' }],
          postData: {
            mimeType: 'application/json',
            text: JSON.stringify({
              action: 'auth:signIn',
              args: { params: { code: '[REDACTED_CREDENTIAL]' } },
            }),
          },
        },
      })
      expect(await sanitized.file('resources/0123456789abcdef')!.async('string')).toBe(
        '{"access_token":"[REDACTED_CREDENTIAL]","vmProxyToken":"[REDACTED_CREDENTIAL]","authorization":"[REDACTED_CREDENTIAL]"}',
      )
      expect(await sanitized.file('resources/image.png')!.async('uint8array')).toEqual(binary)
      expect(await sanitized.file('resources/opaque-binary')!.async('string')).toBe(
        '[REDACTED_BINARY_RESOURCE]',
      )
      expect((await stat(output)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects a sanitized archive when an entry name still carries a magic-link code', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-trace-assertion-'))
    const source = path.join(directory, 'trace.zip')
    const target = path.join(directory, 'sanitized.zip')
    try {
      const archive = new JSZip()
      archive.file('resources/verify?code=magic-link-code', 'safe')
      await Bun.write(source, await archive.generateAsync({ type: 'uint8array' }))

      await expect(
        new StagingArtifactCollector(directory, []).sanitizeTraceArchive(source, target),
      ).rejects.toThrow('retained a query credential in an entry name')
      expect(await Bun.file(target).exists()).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects JWT-like credentials but permits explicit credential placeholders', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'duet-trace-jwt-'))
    const unsafeSource = path.join(directory, 'unsafe.zip')
    const safeSource = path.join(directory, 'safe.zip')
    try {
      const unsafe = new JSZip()
      unsafe.file(
        'resources/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLWJ5dGVz',
        'safe',
      )
      await Bun.write(unsafeSource, await unsafe.generateAsync({ type: 'uint8array' }))
      await expect(
        new StagingArtifactCollector(directory, []).sanitizeTraceArchive(
          unsafeSource,
          path.join(directory, 'unsafe-sanitized.zip'),
        ),
      ).rejects.toThrow('retained a JWT-like credential in an entry name')

      const safe = new JSZip()
      safe.file(
        'resources/docs?code=example',
        '{"code":"ERR_ABORTED","session":"active"} The literal foo.bar.baz is not a JWT.',
      )
      await Bun.write(safeSource, await safe.generateAsync({ type: 'uint8array' }))
      await expect(
        new StagingArtifactCollector(directory, []).sanitizeTraceArchive(
          safeSource,
          path.join(directory, 'safe-sanitized.zip'),
        ),
      ).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test('private Blob signing credentials are rejected raw and removed from browser traces', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'duet-backup-grant-artifacts-'))
  try {
    const unsafe = path.join(directory, 'unsafe.json')
    await Bun.write(
      unsafe,
      JSON.stringify({
        url: 'https://store.private.blob.vercel-storage.com/backup.zip?vercel-blob-delegation=delegation-abc123456789&vercel-blob-signature=signature-abc123456789',
      }),
    )
    await expect(assertNoCredentialArtifacts(directory)).rejects.toThrow('query credential')
    await rm(unsafe)
    const raw = new JSZip().file(
      'trace.trace',
      JSON.stringify({
        queryString: [
          { name: 'vercel-blob-delegation', value: 'delegation-abc123456789' },
          { name: 'vercel-blob-signature', value: 'signature-abc123456789' },
        ],
      }),
    )
    const input = path.join(directory, 'input.zip')
    const output = path.join(directory, 'safe.zip')
    await Bun.write(input, await raw.generateAsync({ type: 'uint8array' }))
    await new StagingArtifactCollector(directory, []).sanitizeTraceArchive(input, output)
    const saved = await JSZip.loadAsync(await Bun.file(output).arrayBuffer())
    const trace = await saved.file('trace.trace')!.async('text')
    expect(trace).not.toContain('delegation-abc123456789')
    expect(trace).not.toContain('signature-abc123456789')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
