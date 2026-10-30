import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference, type FunctionReference } from 'convex/server'

import { convexUrlsFromDeployment } from '@repo/contract'

interface PauseVmUpdatesInput {
  paused: boolean
  reason?: string
}

export async function setVmUpdatesPaused(input: PauseVmUpdatesInput): Promise<void> {
  const deployment = requiredEnvironment('CONVEX_DEPLOYMENT')
  const client = new ConvexHttpClient(convexUrlsFromDeployment(deployment).cloudUrl)
  await client.mutation(
    makeFunctionReference(
      'domains/workspaces/vmSync:setUpdatesPaused',
    ) as FunctionReference<'mutation'>,
    {
      internalKey: requiredEnvironment('DUET_API_INTERNAL_KEY'),
      paused: input.paused,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
  )
}

if (import.meta.main) {
  try {
    const input = parseCommandLine(process.argv.slice(2))
    await setVmUpdatesPaused(input)
    console.log(`VM updates are now ${input.paused ? 'paused' : 'enabled'}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

function parseCommandLine(args: string[]): PauseVmUpdatesInput {
  let paused: boolean | undefined
  let reason: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--paused') {
      const value = args[++index]
      if (value !== 'true' && value !== 'false') {
        throw new Error('--paused must be true or false')
      }
      paused = value === 'true'
    } else if (argument === '--reason') {
      reason = args[++index]
      if (reason === undefined || reason.trim().length === 0) {
        throw new Error('--reason requires a non-empty value')
      }
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  if (paused === undefined) {
    throw new Error('usage: --paused <true|false> [--reason <text>]')
  }
  return { paused, ...(reason === undefined ? {} : { reason }) }
}

function requiredEnvironment(name: 'CONVEX_DEPLOYMENT' | 'DUET_API_INTERNAL_KEY'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
