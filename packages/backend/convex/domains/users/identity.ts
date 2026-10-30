export const MAX_DISPLAY_NAME_LENGTH = 200
export const MAX_EMAIL_LENGTH = 320

export function normalizeEmail(email: string | undefined): string {
  const normalized = email?.trim().toLowerCase()
  if (!normalized) throw new Error('Auth profile is missing an email address')
  const at = normalized.lastIndexOf('@')
  let canonical = normalized
  if (at > 0 && at < normalized.length - 1) {
    const originalLocal = normalized.slice(0, at)
    const originalDomain = normalized.slice(at + 1)
    const domain = originalDomain === 'googlemail.com' ? 'gmail.com' : originalDomain
    const local =
      domain === 'gmail.com'
        ? (originalLocal.split('+')[0] ?? '').replaceAll('.', '')
        : originalLocal
    canonical = local ? `${local}@${domain}` : normalized
  }
  if (canonical.length > MAX_EMAIL_LENGTH) {
    throw new Error(`Email must be at most ${MAX_EMAIL_LENGTH} characters`)
  }
  return canonical
}

export function cleanDisplayName(value: string | undefined): string | undefined {
  const cleaned = cleanOptionalString(value)
  if (cleaned !== undefined && cleaned.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(`Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`)
  }
  return cleaned
}

export function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
