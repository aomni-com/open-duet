import {
  REDACTION_MASK,
  REDACTION_RULES,
  redactLogFields as redactContractLogFields,
  redactText as redactContractText,
  type RedactionRule,
} from '@repo/contract'

export { REDACTION_MASK, REDACTION_RULES, type RedactionRule }

const runtimeSecrets = new Set<string>()

export function registerRedactionSecret(secret: string): void {
  if (secret.length === 0) return
  runtimeSecrets.add(secret)
}

export function redactText(text: string, rules: RedactionRule[] = REDACTION_RULES): string {
  const base = redactContractText(text, rules)
  if (runtimeSecrets.size === 0) return base
  let redacted = base
  for (const secret of runtimeSecrets) {
    redacted = redacted.split(secret).join(REDACTION_MASK)
  }
  return redacted
}

export function redactLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactRuntimeSecrets(redactContractLogFields(fields)) as Record<string, unknown>
}

function redactRuntimeSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactRuntimeSecrets)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, redactRuntimeSecrets(entryValue)]),
  )
}
