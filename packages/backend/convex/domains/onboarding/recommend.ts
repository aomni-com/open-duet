'use node'

import { gateway, generateText, Output } from 'ai'
import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { z } from 'zod'

import { MarketplaceListingSummarySchema, type AgentTag } from '@repo/contract'

import { action } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'
import {
  RECOMMENDATIONS_MODEL,
  RECOMMENDATIONS_TIMEOUT_MS,
  recommendAgents,
  type RecommendationGenerationRequest,
} from './recommendationsCore'

export const recommend = action({
  args: {
    internalKey: v.string(),
    purpose: v.string(),
    tagHints: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const catalog = z.object({ listings: z.array(MarketplaceListingSummarySchema) }).parse(
      await ctx.runQuery(fnQuery('domains/marketplace/listings:catalog'), {
        internalKey: args.internalKey,
      }),
    )
    return await recommendAgents({
      purpose: args.purpose,
      tagHints: args.tagHints as AgentTag[] | undefined,
      // Same rule as the onboarding team step: only verified publishers'
      // listings are recommendable.
      catalog: catalog.listings.filter(listing => listing.verifiedPublisher),
      generate: generateRecommendations,
    })
  },
})

async function generateRecommendations(request: RecommendationGenerationRequest) {
  const { output } = await generateText({
    model: gateway(RECOMMENDATIONS_MODEL),
    output: Output.object({ schema: request.schema }),
    system: request.system,
    prompt: request.prompt,
    // Keep the model's default reasoning; sampling overrides can conflict with it.
    abortSignal: AbortSignal.timeout(RECOMMENDATIONS_TIMEOUT_MS),
  })
  return output
}

function fnQuery(name: string): FunctionReference<'query'> {
  return makeFunctionReference(name) as FunctionReference<'query'>
}
