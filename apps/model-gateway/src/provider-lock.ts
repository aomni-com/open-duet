export function applyProviderLock(
  jsonBody: Record<string, unknown>,
  providerLock: readonly string[],
): Record<string, unknown> {
  const providerOptions = objectRecord(jsonBody.providerOptions)
  const gateway = objectRecord(providerOptions.gateway)

  return {
    ...jsonBody,
    providerOptions: {
      ...providerOptions,
      gateway: {
        ...gateway,
        only: [...providerLock],
      },
    },
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
