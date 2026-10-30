export interface VaultPutArgs {
  serviceId: string
  name: string
  environment: 'staging' | 'production'
}

export function parseVaultPutArgs(args: readonly string[]): VaultPutArgs {
  if (args[0] !== 'put') throw new Error('usage: service:vault put <serviceId> <name> --env staging|production')
  const serviceId = args[1]?.trim()
  const name = args[2]?.trim()
  const envFlag = args[3]
  const environment = args[4]
  if (!serviceId || !name || envFlag !== '--env' || (environment !== 'staging' && environment !== 'production')) {
    throw new Error('usage: service:vault put <serviceId> <name> --env staging|production')
  }
  return { serviceId, name, environment }
}

export async function putServiceCredential(args: VaultPutArgs, value: string): Promise<{ generation: number; fingerprint: string }> {
  const internalKey = required('DUET_API_INTERNAL_KEY')
  required('CONVEX_DEPLOY_KEY')
  const child = Bun.spawn(
    [
      'bunx', 'convex', 'run', 'domains/serviceVault/model:putServiceCredential',
      JSON.stringify({ internalKey, serviceId: args.serviceId, name: args.name, value }),
      '--typecheck', 'disable',
    ],
    { stdout: 'pipe', stderr: 'pipe', env: process.env },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `convex run exited with ${exitCode}`)
  return JSON.parse(stdout) as { generation: number; fingerprint: string }
}

if (import.meta.main) {
  try {
    const args = parseVaultPutArgs(process.argv.slice(2))
    const value = (await new Response(Bun.stdin.stream()).text()).trimEnd()
    if (!value) throw new Error('credential value must be provided on stdin')
    const result = await putServiceCredential(args, value)
    console.log(JSON.stringify({ environment: args.environment, serviceId: args.serviceId, name: args.name, ...result }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
