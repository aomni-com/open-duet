export function normalizeTrainSourceUrl(value: string): string {
  const trimmed = value.trim()
  const hasHttpScheme = /^https?:\/\//i.test(trimmed)
  const hasSchemePrefix = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
  const isBareHostWithPort = /^[^/?#\s:]+:\d+(?:[/?#]|$)/.test(trimmed)
  if (!hasHttpScheme && hasSchemePrefix && !isBareHostWithPort) {
    throw new Error('A Train source must be an HTTP or HTTPS URL')
  }
  const candidate = hasHttpScheme ? trimmed : `https://${trimmed}`
  const parsed = new URL(candidate)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.length === 0) {
    throw new Error('A Train source must be an HTTP or HTTPS URL')
  }
  return parsed.toString()
}
