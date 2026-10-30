export function buildAppSpawnEnv(options: {
  base: Record<string, string | undefined>
  port: number
  extras?: Record<string, string>
}): Record<string, string> {
  const env: Record<string, string> = {}

  for (const name of ['PATH', 'HOME'] as const) {
    const value = options.base[name]
    if (value !== undefined) env[name] = value
  }

  return { ...env, ...options.extras, PORT: String(options.port) }
}
