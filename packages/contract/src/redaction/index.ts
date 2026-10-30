export type RedactionRule = string | RegExp

export const REDACTION_MASK = '[REDACTED]'

const SECRET_KEYS: { prefix: string; body: string }[] = [
  { prefix: 'duet_vm_', body: '[a-f0-9]{64}' },
  { prefix: 'duet_sk_', body: '[a-f0-9]{64}' },
  { prefix: 'duet_gt_', body: '[a-f0-9]{64}' },
  { prefix: 'sk-svcacct-', body: '[a-zA-Z0-9_-]+' },
  { prefix: 'sk-proj-', body: '[a-zA-Z0-9_-]+' },
  { prefix: 'sk-ant-api03-', body: '[a-zA-Z0-9_-]+' },
  { prefix: 'ghp_', body: '[a-zA-Z0-9_]+' },
]

const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const URLSAFE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const BASE64_RUN = '[A-Za-z0-9+/_=-]*'
const MIN_FRAGMENT_LEN = 8

function encodeBase64Groups(bytes: number[], alphabet: string): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const triple = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += alphabet[(triple >> 18) & 63]
    out += alphabet[(triple >> 12) & 63]
    out += alphabet[(triple >> 6) & 63]
    out += alphabet[triple & 63]
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function base64PrefixFragments(prefix: string): string[] {
  const prefixBytes = Array.from(prefix, c => c.charCodeAt(0))
  const fragments = new Set<string>()
  for (const alphabet of [STD_ALPHABET, URLSAFE_ALPHABET]) {
    for (let pad = 0; pad < 3; pad += 1) {
      const usableBytes = Math.floor((pad + prefixBytes.length) / 3) * 3
      if (usableBytes === 0) continue
      const raw = [...Array<number>(pad).fill(0), ...prefixBytes].slice(0, usableBytes)
      const encoded = encodeBase64Groups(raw, alphabet)
      const fragment = pad === 0 ? encoded : encoded.slice(4)
      if (fragment.length >= MIN_FRAGMENT_LEN) fragments.add(fragment)
    }
  }
  return [...fragments]
}

const PLAINTEXT_PREFIXES = SECRET_KEYS.map(key => key.prefix)
const BASE64_FRAGMENTS = [...new Set(PLAINTEXT_PREFIXES.flatMap(base64PrefixFragments))]

export const REDACTION_RULES: RedactionRule[] = [
  ...SECRET_KEYS.map(({ prefix, body }) => new RegExp(escapeRegExp(prefix) + body, 'g')),
  ...BASE64_FRAGMENTS.map(fragment => new RegExp(escapeRegExp(fragment) + BASE64_RUN, 'g')),
]

const DEFAULT_ANCHOR_RE = new RegExp(
  [...PLAINTEXT_PREFIXES, ...BASE64_FRAGMENTS].map(escapeRegExp).join('|'),
)

export function redactText(text: string, rules: RedactionRule[] = REDACTION_RULES): string {
  if (text.length === 0) return text
  if (rules === REDACTION_RULES && !DEFAULT_ANCHOR_RE.test(text)) return text

  let redacted = text
  for (const rule of rules) {
    if (typeof rule === 'string') {
      if (rule.length === 0) continue
      redacted = redacted.split(rule).join(REDACTION_MASK)
    } else {
      rule.lastIndex = 0
      redacted = redacted.replace(rule, REDACTION_MASK)
    }
  }
  return redacted
}

interface RedactedText {
  text: string
  redacted: boolean
  redactionCount: number
}

const IMPORT_SECRET_RULES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Z0-9_]*(?:API|TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}["']?/gi,
]

const HIGH_ENTROPY_TOKEN_RE = /\b[A-Za-z0-9+/=_-]{32,}\b/g

export function redactImportMemoryText(text: string): RedactedText {
  const contractRedacted = redactText(text)
  let redactionCount =
    contractRedacted === text ? 0 : countMasks(contractRedacted) - countMasks(text)
  let redacted = contractRedacted

  for (const rule of IMPORT_SECRET_RULES) {
    rule.lastIndex = 0
    redacted = redacted.replace(rule, match => {
      redactionCount += 1
      if (/^Bearer\s/i.test(match)) return `Bearer ${REDACTION_MASK}`
      const separator = match.match(/^([^:=]+[:=]\s*)/u)
      return separator === null ? REDACTION_MASK : `${separator[1]}${REDACTION_MASK}`
    })
  }

  HIGH_ENTROPY_TOKEN_RE.lastIndex = 0
  redacted = redacted.replace(HIGH_ENTROPY_TOKEN_RE, match => {
    if (match === REDACTION_MASK || !looksLikeSecretToken(match)) return match
    redactionCount += 1
    return REDACTION_MASK
  })

  return { text: redacted, redacted: redacted !== text, redactionCount }
}

function redactUnknown(value: unknown, rules: RedactionRule[] = REDACTION_RULES): unknown {
  if (typeof value === 'string') return redactText(value, rules)
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map(item => {
      const redacted = redactUnknown(item, rules)
      if (redacted !== item) changed = true
      return redacted
    })
    return changed ? out : value
  }
  if (value && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, entryValue] of Object.entries(value)) {
      const redacted = redactUnknown(entryValue, rules)
      if (redacted !== entryValue) changed = true
      out[key] = redacted
    }
    return changed ? out : value
  }
  return value
}

export function redactLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactUnknown(fields) as Record<string, unknown>
}

function looksLikeSecretToken(value: string): boolean {
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false
  if (value.includes(REDACTION_MASK)) return false
  return shannonEntropy(value) >= 4.2
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

function countMasks(value: string): number {
  return value.split(REDACTION_MASK).length - 1
}

// Runtime errors can contain URLs and credentials; diagnostics retain only known codes.
export function safeTransportCode(error: unknown): string | undefined {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++) {
    if (error.name === 'AbortError') return undefined
    if (error.name === 'TimeoutError') return 'ETIMEDOUT'
    const code = 'code' in error ? error.code : undefined
    if (
      typeof code === 'string' &&
      /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(
        code,
      )
    )
      return code
    error = error.cause
  }
  return undefined
}
