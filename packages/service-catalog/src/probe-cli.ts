import { probeService, type ProbeResult } from './probe'
import { SERVICE_DEFINITIONS } from './index'

export interface ProbeArgs {
  serviceId: string | null
  environment: 'staging' | 'production'
}

export function parseProbeArgs(args: readonly string[]): ProbeArgs {
  const envIndex = args.indexOf('--env')
  const environment = envIndex >= 0 ? args[envIndex + 1] : undefined
  const positional = args.filter((value, index) => !value.startsWith('--') && index !== envIndex + 1)
  const all = args.includes('--all')
  if ((!all && positional.length !== 1) || (all && positional.length !== 0) || (all && args.some(value => value !== '--all' && value !== '--env' && value !== environment))) {
    throw new Error('usage: service:probe <serviceId>|--all --env staging|production')
  }
  if (environment !== 'staging' && environment !== 'production') {
    throw new Error('usage: service:probe <serviceId>|--all --env staging|production')
  }
  return { serviceId: all ? null : positional[0]!, environment }
}

const secretEnvByService: Record<string, string> = {
  firecrawl: 'FIRECRAWL_API_KEY',
  crustdata: 'CRUSTDATA_API_KEY',
  fullenrich: 'FULLENRICH_API_KEY',
  dataforseo: 'DATAFORSEO_BASE64_PASSWORD',
  elevenlabs: 'ELEVENLABS_API_KEY',
  socialapi: 'SOCIALAPI_API_KEY',
}

export async function runProbe(args: ProbeArgs, fetchImpl: typeof fetch = fetch): Promise<ProbeResult[]> {
  const definitions = args.serviceId === null
    ? SERVICE_DEFINITIONS
    : SERVICE_DEFINITIONS.filter(definition => definition.id === args.serviceId)
  if (definitions.length === 0) throw new Error(`unknown service: ${args.serviceId}`)
  const results: ProbeResult[] = []
  for (const definition of definitions) {
    results.push(...await probeService(definition, {
      fetch: fetchImpl,
      secret: async serviceId => process.env[secretEnvByService[serviceId] ?? ''] ?? null,
    }))
  }
  return results
}

if (import.meta.main) {
  try {
    const args = parseProbeArgs(process.argv.slice(2))
    const results = await runProbe(args)
    for (const result of results) console.log(JSON.stringify(result))
    if (results.some(result => result.verdict === 'drift' || result.verdict === 'error' || result.verdict === 'unpriced')) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
