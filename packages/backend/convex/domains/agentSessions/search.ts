/** Locale-independent normalization shared by corpus writers and readers. */
export function normalizeSessionSearch(value: string): string {
  return value.trim().toLowerCase()
}

export function sessionSearchCorpus(title: string, initialPrompt: string): string {
  return normalizeSessionSearch(`${title}\n${initialPrompt}`)
}
