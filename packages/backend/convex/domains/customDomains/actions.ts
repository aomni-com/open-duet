'use node'

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import type { DomainTarget } from '@repo/contract'

import { internalAction } from '../../_generated/server'
import {
  addDomain,
  readDomain,
  removeDomain,
  verifyDomain,
  VercelDomainError,
} from '../../services/vercelDomains'
import { domainOperationValidator } from './validators'
import type { DomainWorkResult } from './work'

const beginRef = makeFunctionReference<'mutation'>('domains/customDomains/work:beginAttempt')
const finishedRef = makeFunctionReference<'mutation'>(
  'domains/customDomains/work:markEffectFinished',
)
const aliasWriteRef = makeFunctionReference<'mutation'>(
  'domains/customDomains/work:markAliasWriteStarted',
)
const errorRef = makeFunctionReference<'mutation'>('domains/customDomains/work:recordCleanupError')
export const perform = internalAction({
  args: {
    domainId: v.id('customDomains'),
    revision: v.number(),
    operation: domainOperationValidator,
  },
  handler: async (ctx, args): Promise<DomainWorkResult> => {
    const plan = (await ctx.runMutation(beginRef, args)) as {
      hostname: string
      target: DomainTarget
      providerAssigned: boolean
    } | null
    if (plan === null) return { kind: 'stopped' }
    const deadline = Date.now() + 30_000
    let uncertainWrite = false
    const transport = fetch
    const effectFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const aliasWrite =
          init?.method === 'DELETE' ||
          (init?.method === 'POST' && !new URL(String(input)).pathname.endsWith('/verify'))
        if (!aliasWrite) return transport(input, init)
        if (init?.signal?.aborted)
          throw new VercelDomainError('timeout', 'Vercel domain operation timed out', true)
        if (!(await ctx.runMutation(aliasWriteRef, args)))
          throw new VercelDomainError('transport_error', 'Domain provider work stopped')
        if (init?.signal?.aborted)
          throw new VercelDomainError('timeout', 'Vercel domain operation timed out', true)
        uncertainWrite = true
        const response = await transport(input, init)
        // A server error can follow a committed write. Receipt of a normal
        // response establishes completion; local abort/rejection cannot.
        if (response.status < 500) uncertainWrite = false
        return response
      },
      { preconnect: transport.preconnect },
    )
    const options = () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0)
        throw new VercelDomainError('timeout', 'Vercel domain operation timed out', true)
      return { deadlineMs: remaining, fetch: effectFetch }
    }
    try {
      if (args.operation === 'remove') {
        await removeDomain(plan.hostname, plan.target, options())
        return { kind: 'removed' }
      }
      let observation =
        args.operation === 'add'
          ? await addDomain(plan.hostname, plan.target, options())
          : await readDomain(plan.hostname, plan.target, options())
      if (observation === null && !plan.providerAssigned)
        observation = await addDomain(plan.hostname, plan.target, options())
      if (observation === null)
        return {
          kind: 'failed',
          retryable: false,
          missing: true,
          error: 'Vercel domain assignment is missing',
        }
      if (!observation.ownershipVerified)
        observation = await verifyDomain(plan.hostname, plan.target, options())
      return { kind: 'observed', observation }
    } catch (error) {
      const failure = {
        kind: 'failed' as const,
        error:
          error instanceof VercelDomainError
            ? error.message.slice(0, 2_000)
            : 'Domain provider work failed',
        retryable: error instanceof VercelDomainError && error.retryable,
        definitive:
          error instanceof VercelDomainError &&
          ['not_found', 'target_mismatch'].includes(error.code),
      }
      if (args.operation === 'remove') {
        await ctx.runMutation(errorRef, {
          domainId: args.domainId,
          revision: args.revision,
          error: failure.error,
        })
        if (
          !uncertainWrite &&
          (failure.retryable ||
            (error instanceof VercelDomainError && error.code === 'not_configured'))
        )
          throw new Error(failure.error)
      }
      return failure
    } finally {
      await ctx.runMutation(finishedRef, { ...args, uncertain: uncertainWrite })
    }
  },
})

export const notifyWorkspaceApps = internalAction({
  args: { workspaceId: v.id('workspaces') },
  handler: async (_ctx, args) => {
    const key = process.env.DUET_API_INTERNAL_KEY
    const apiOrigin = process.env.DUET_API_URL
    if (!key || !apiOrigin) return
    try {
      const response = await fetch(new URL('/v1/internal/apps/reconcile', apiOrigin), {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10_000),
      })
      void response.body?.cancel().catch(() => {})
      if (!response.ok)
        console.error('App domain link refresh deferred to workspace sync', args.workspaceId)
    } catch {
      console.error('App domain link refresh deferred to workspace sync', args.workspaceId)
    }
  },
})
