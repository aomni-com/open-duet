import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import JSZip from 'jszip'

export interface ApiTiming {
  method: string
  target: string
  status?: number
  durationMs: number
  error?: string
}

export interface BrowserDiagnostic {
  kind: 'console' | 'navigation-canceled' | 'page' | 'request' | 'response'
  message: string
}

export class StagingArtifactCollector {
  readonly apiTimings: ApiTiming[] = []
  readonly browserErrors: BrowserDiagnostic[] = []

  constructor(
    readonly directory: string,
    private readonly secrets: string[],
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
  }

  registerSecret(secret: string): void {
    this.secrets.push(secret)
  }

  async reservePrivateFile(target: string): Promise<void> {
    await this.initialize()
    await writeFile(target, new Uint8Array(), { mode: 0o600 })
    await chmod(target, 0o600)
  }

  recordApiTiming(timing: ApiTiming): void {
    this.apiTimings.push(redactArtifactValue(timing, this.secrets) as ApiTiming)
  }

  recordBrowserError(error: BrowserDiagnostic): void {
    this.browserErrors.push(redactArtifactValue(error, this.secrets) as BrowserDiagnostic)
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.initialize()
    await writeFile(
      path.join(this.directory, name),
      `${JSON.stringify(redactArtifactValue(value, this.secrets), null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  }

  async flushDiagnostics(): Promise<void> {
    await Promise.all([
      this.writeJson('api-timing.json', this.apiTimings),
      this.writeJson('browser-errors.json', this.browserErrors),
    ])
  }

  async sanitizeTraceArchive(source: string, target: string): Promise<void> {
    const archive = await JSZip.loadAsync(await Bun.file(source).arrayBuffer())
    await Promise.all(
      Object.values(archive.files).map(async entry => {
        if (entry.dir) return
        const bytes = await entry.async('uint8array')
        const content = decodeUtf8Text(bytes)
        if (content !== undefined && (isTraceTextEntry(entry.name) || looksLikeText(content))) {
          archive.file(entry.name, sanitizeTraceText(content, this.secrets), entry.options)
          return
        }
        if (findUnsafeCredential(Buffer.from(bytes).toString('latin1'), this.secrets)) {
          archive.file(entry.name, '[REDACTED_BINARY_RESOURCE]', entry.options)
        }
      }),
    )
    const temporaryTarget = `${target}.sanitized-${process.pid}-${Date.now()}`
    try {
      const bytes = await archive.generateAsync({ type: 'uint8array' })
      await assertSanitizedTraceArchive(await JSZip.loadAsync(bytes), this.secrets)
      await writeFile(temporaryTarget, bytes, {
        mode: 0o600,
      })
      await chmod(temporaryTarget, 0o600)
      await rename(temporaryTarget, target)
    } finally {
      await rm(temporaryTarget, { force: true })
    }
  }
}

function isTraceTextEntry(name: string): boolean {
  return /(?:\.trace|\.network|\.stacks|\.(?:html?|css|js|json|txt|svg|xml))$/i.test(name)
}

function decodeUtf8Text(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function looksLikeText(text: string): boolean {
  if (text.includes('\0')) return false
  const controls = [...text].filter(character => {
    const code = character.charCodeAt(0)
    return code < 32 && character !== '\n' && character !== '\r' && character !== '\t'
  }).length
  return controls <= Math.max(1, Math.floor(text.length / 100))
}

function sanitizeTraceText(value: string, secrets: string[]): string {
  return value
    .split('\n')
    .map(line => sanitizeTraceLine(line, secrets))
    .join('\n')
}

function sanitizeTraceLine(value: string, secrets: string[]): string {
  try {
    return JSON.stringify(sanitizeTraceJson(JSON.parse(value), secrets))
  } catch {
    return sanitizeTraceString(value, secrets)
  }
}

function sanitizeTraceJson(value: unknown, secrets: string[], parentKey?: string): unknown {
  if (typeof value === 'string') {
    const sanitized = sanitizeTraceString(value, secrets)
    if (parentKey !== 'text') return sanitized
    try {
      return JSON.stringify(sanitizeTraceJson(JSON.parse(sanitized), secrets))
    } catch {
      return sanitized
    }
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeTraceJson(item, secrets, parentKey))
  }
  if (value === null || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  const pairName = typeof record.name === 'string' ? record.name : undefined
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (key === 'value' && pairName === ':path' && typeof item === 'string') {
        return [key, sanitizeTraceRequestPath(item, secrets)]
      }
      if (key === ':path' && typeof item === 'string') {
        return [key, sanitizeTraceRequestPath(item, secrets)]
      }
      if (
        key === 'value' &&
        (parentKey === 'queryString' || parentKey === 'cookies' || isSensitiveTraceName(pairName))
      ) {
        return [key, '[REDACTED_CREDENTIAL]']
      }
      if (isSensitiveTraceName(key)) return [key, '[REDACTED_CREDENTIAL]']
      return [key, sanitizeTraceJson(item, secrets, key)]
    }),
  )
}

function sanitizeTraceRequestPath(value: string, secrets: string[]): string {
  const sanitized = sanitizeTraceString(value, secrets)
  if (!sanitized.startsWith('/')) return sanitized
  const query = sanitized.search(/[?#]/)
  return query === -1 ? sanitized : `${sanitized.slice(0, query)}?[REDACTED_QUERY]`
}

function isSensitiveTraceName(value: string | undefined): boolean {
  return (
    value !== undefined &&
    /^(?:vercel-blob-(?:delegation|signature)|authorization|cookie|set-cookie|code|csrf|verifier|signature|api_?key|x-vercel-protection-bypass|x-duet-edge-secret|x-exedev-authorization|[A-Za-z0-9_.-]*(?:session|auth|token|secret|password)[A-Za-z0-9_.-]*)$/i.test(
      value,
    )
  )
}

function sanitizeTraceString(value: string, secrets: string[]): string {
  const sanitized = redactArtifactValue(value, secrets) as string
  return sanitized
    .replace(
      /("name"\s*:\s*"(?:vercel-blob-(?:delegation|signature)|authorization|cookie|set-cookie|x-vercel-protection-bypass|x-duet-edge-secret|x-exedev-authorization|[A-Za-z0-9_.-]*(?:session|auth|token|secret)[A-Za-z0-9_.-]*)"\s*,\s*"value"\s*:\s*")[^"]*(")/gi,
      '$1[REDACTED_CREDENTIAL]$2',
    )
    .replace(
      /("value"\s*:\s*")[^"]*("\s*,\s*"name"\s*:\s*"(?:vercel-blob-(?:delegation|signature)|authorization|cookie|set-cookie|x-vercel-protection-bypass|x-duet-edge-secret|x-exedev-authorization|[A-Za-z0-9_.-]*(?:session|auth|token|secret)[A-Za-z0-9_.-]*)")/gi,
      '$1[REDACTED_CREDENTIAL]$2',
    )
    .replace(
      /("(?:vercel-blob-(?:delegation|signature)|authorization|cookie|set-cookie|api_?key|[A-Za-z0-9_]*(?:token|secret|password))"\s*:\s*")[^"]*(")/gi,
      '$1[REDACTED_CREDENTIAL]$2',
    )
    .replace(/(duet_session=)[^;\s"]+/gi, '$1[REDACTED_CREDENTIAL]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_CREDENTIAL]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
}

export function safeRequestTarget(input: string): string {
  const url = new URL(input)
  return `${url.origin}${url.pathname}`
}

export function stagingProtectionHeaders(
  requestUrl: string,
  stagingOrigins: ReadonlySet<string>,
  current: Record<string, string>,
  bypassSecret: string,
): Record<string, string> {
  if (!stagingOrigins.has(new URL(requestUrl).origin)) return current
  return { ...current, 'x-vercel-protection-bypass': bypassSecret }
}

export function redactArtifactValue(value: unknown, secrets: string[]): unknown {
  const usableSecrets = [...new Set(secrets.filter(secret => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  )
  return redact(value, usableSecrets, new WeakSet<object>())
}

function redact(value: unknown, secrets: string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    const knownRedacted = secrets.reduce(
      (result, secret) => result.replaceAll(secret, '[REDACTED]'),
      value,
    )
    return sanitizeUnknownCredentials(knownRedacted)
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets, seen))
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  const result = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redact(item, secrets, seen)]),
  )
  seen.delete(value)
  return result
}

function sanitizeUnknownCredentials(value: string): string {
  return value
    .replace(/duet_sk_[A-Za-z0-9_-]+/g, '[REDACTED_DUET_KEY]')
    .replace(/duet_(?:rt|ac)_[A-Za-z0-9_-]+/g, '[REDACTED_DUET_CREDENTIAL]')
    .replace(
      /\/v1\/desktop\/browser\/cdp\/[^/\s.]+\.[A-Za-z0-9_-]{16,}/g,
      '/v1/desktop/browser/cdp/[REDACTED_DESKTOP_GRANT]',
    )
    .replace(
      /\/v1\/desktop\/[^/\s.]+\.[A-Za-z0-9_-]{16,}\//g,
      '/v1/desktop/[REDACTED_DESKTOP_GRANT]/',
    )
    .replace(/https?:\/\/[^\s\\"'<>]+/g, candidate => {
      try {
        const url = new URL(candidate)
        return url.search.length > 0 || url.hash.length > 0
          ? `${url.origin}${url.pathname}?[REDACTED_QUERY]`
          : candidate
      } catch {
        return candidate
      }
    })
}

async function assertSanitizedTraceArchive(archive: JSZip, secrets: string[]): Promise<void> {
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue
    const unsafeName = findUnsafeCredential(`/${entry.name}`, secrets)
    if (unsafeName !== undefined) {
      throw new Error(`Sanitized trace archive retained ${unsafeName} in an entry name`)
    }
    const bytes = await entry.async('uint8array')
    const unsafePayload = findUnsafeCredential(Buffer.from(bytes).toString('latin1'), secrets)
    if (unsafePayload !== undefined) {
      throw new Error(`Sanitized trace archive retained ${unsafePayload} in ${entry.name}`)
    }
  }
}

/**
 * The names a structured credential hides behind.
 *
 * The token branch carries a LEADING wildcard only — a field must END in
 * `token` to be one. That is what lets `registration_access_token` and
 * `registrationAccessToken` be caught while `token_type: "Bearer"` stays a
 * description rather than a finding. `secret` and `password` keep their
 * trailing wildcard, which is how `secret_key` was already caught.
 */
const CREDENTIAL_NAME_TAIL =
  'vercel-blob-(?:delegation|signature)|authorization|cookie|set-cookie|api_?key|signature|verifier|' +
  '[A-Za-z0-9_.-]*(?:secret|password)[A-Za-z0-9_.-]*|[A-Za-z0-9_.-]*token'

/**
 * A `{name, value}` pair names a header or a query parameter, where a bare
 * `code` is an authorization code. As a plain object field, `code` is far more
 * often an error code, so it is deliberately absent from the field list below.
 */
const HEADER_CREDENTIAL_NAMES = `(?:code|${CREDENTIAL_NAME_TAIL})`
const FIELD_CREDENTIAL_NAMES = `(?:${CREDENTIAL_NAME_TAIL})`

function findUnsafeCredential(value: string, secrets: string[]): string | undefined {
  if (secrets.some(secret => secret.length > 0 && value.includes(secret))) return 'a known secret'
  if (/duet_(?:sk|rt|ac)_[A-Za-z0-9_-]{6,}/.test(value)) return 'a Duet OAuth credential'
  if (/\/v1\/desktop\/browser\/cdp\/[^/\s.]+\.[A-Za-z0-9_-]{16,}/.test(value)) {
    return 'a desktop debugger credential'
  }
  if (/\/v1\/desktop\/[^/\s.]+\.[A-Za-z0-9_-]{16,}\//.test(value)) {
    return 'a desktop grant credential'
  }
  // `registration` is the RFC 7592 credential the fake issuer signs, and it is
  // the one fixture value that can act on a third party after the run ends.
  // `fake-oauth-client-` is deliberately absent: a client id is public by
  // construction — it rides the authorize URL — so flagging it would fail runs
  // over a value that is not a secret.
  if (
    /fake-oauth-(?:access|refresh|registration)-|fixture-(?:rotated-)?(?:access|refresh)-token/i.test(
      value,
    )
  ) {
    return 'an OAuth fixture credential'
  }
  if (/\bBearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/-]{6,}=*/i.test(value)) {
    return 'a bearer credential'
  }
  if (/duet_session=(?!\[REDACTED)[^;\s"]{6,}/i.test(value)) return 'a session cookie'
  if (/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/.test(value)) {
    return 'a JWT-like credential'
  }

  const requestUrls = value.match(
    /(?:https?:\/\/[^\s"'<>]+|(?:^|[\s"'(])\/[^\s"'<>?#]*\?[^\s"'<>#]*)/gm,
  )
  for (const requestUrl of requestUrls ?? []) {
    const credential =
      /[?&](?:vercel-blob-(?:delegation|signature)|code|grant|token|access_token|refresh_token|api_?key|signature|verifier|x-vercel-protection-bypass)=([A-Za-z0-9._~+/%-]{6,})/i.exec(
        requestUrl,
      )?.[1]
    if (credential !== undefined && !isCredentialPlaceholder(credential)) {
      return 'a query credential'
    }
  }

  for (const pattern of [
    new RegExp(
      `"name"\\s*:\\s*"${HEADER_CREDENTIAL_NAMES}"\\s*,\\s*"value"\\s*:\\s*"([^"]{6,})"`,
      'gi',
    ),
    new RegExp(
      `"value"\\s*:\\s*"([^"]{6,})"\\s*,\\s*"name"\\s*:\\s*"${HEADER_CREDENTIAL_NAMES}"`,
      'gi',
    ),
    new RegExp(`"${FIELD_CREDENTIAL_NAMES}"\\s*:\\s*"([^"]{6,})"`, 'gi'),
  ]) {
    for (const match of value.matchAll(pattern)) {
      if (!isCredentialPlaceholder(match[1]!)) return 'a structured credential'
    }
  }
  return undefined
}

export async function assertNoCredentialArtifacts(
  directory: string,
  secrets: readonly string[] = [],
): Promise<void> {
  for (const file of await filesUnder(directory)) {
    const unsafe = findUnsafeCredential((await readFile(file)).toString('latin1'), [...secrets])
    if (unsafe !== undefined) {
      throw new Error(`Staging artifact retained ${unsafe}: ${path.relative(directory, file)}`)
    }
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await filesUnder(target)))
    else if (entry.isFile()) files.push(target)
  }
  return files
}

function isCredentialPlaceholder(value: string): boolean {
  return /^(?:\[REDACTED(?:_[A-Z]+)?\]|redacted|placeholder|example|sample|dummy|opaque|test)(?:[-_].*)?$/i.test(
    value,
  )
}
