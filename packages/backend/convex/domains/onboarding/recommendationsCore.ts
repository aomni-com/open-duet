import { z } from 'zod'

import {
  MAX_ONBOARDING_RECOMMENDATION_REASON_LENGTH,
  type AgentTag,
  type MarketplaceListingSummary,
  type OnboardingRecommendation,
  type OnboardingRecommendationsResponse,
} from '@repo/contract'

export const RECOMMENDATIONS_MODEL = 'openai/gpt-6-luna'
export const RECOMMENDATIONS_TIMEOUT_MS = 10_000
// What the model is asked for, deliberately under the wire clamp: a reason
// that arrives a little long still fits rather than being cut mid-sentence.
const REASON_TARGET_LENGTH = 140

// The exact projection the marketplace UI renders — no second catalog shape.
export type RecommendationCatalogEntry = Pick<
  MarketplaceListingSummary,
  'agentName' | 'title' | 'summary' | 'tags'
>

export const RECOMMENDATIONS_SYSTEM_PROMPT = `You assemble the starting team of AI agents for a new workspace owner. They just told the product what they want to accomplish; below is the catalog of official agents they can hire, one per line as:

agentName | title | tags | summary

Pick exactly 4 distinct agents from the catalog that will help this person most, ordered most helpful first. For each pick, give one reason of at most ${REASON_TARGET_LENGTH} characters, in second person, echoing the user's own words where natural. Never invent an agent that is not in the catalog and never claim a capability beyond its summary. Write every reason in the exact language the user's message is written in — an English message gets English reasons, a Spanish message gets Spanish reasons. Never use any other language.`

// Wider than the wire on purpose: the model may over- or under-deliver, and
// sanitization — not schema failure — is what enforces the 4-or-0 rule.
export const RawRecommendationsSchema = z.object({
  recommendations: z
    .array(
      z.object({
        agentName: z.string().describe('An agentName copied exactly from the catalog.'),
        reason: z
          .string()
          .describe(
            `At most ${REASON_TARGET_LENGTH} characters, second person, echoing the user's own words, written in the same language as the user's message.`,
          ),
      }),
    )
    .min(1)
    .max(6),
})

export interface RecommendationGenerationRequest {
  schema: typeof RawRecommendationsSchema
  system: string
  prompt: string
}

export type GenerateRecommendations = (request: RecommendationGenerationRequest) => Promise<unknown>

export function buildRecommendationPrompt(
  purpose: string,
  tagHints: readonly AgentTag[],
  catalog: readonly RecommendationCatalogEntry[],
): { system: string; prompt: string } {
  const lines = catalog.map(
    listing =>
      `${listing.agentName} | ${oneLine(listing.title)} | ${listing.tags.join(', ')} | ${oneLine(listing.summary)}`,
  )
  return {
    system: `${RECOMMENDATIONS_SYSTEM_PROMPT}\n\n${lines.join('\n')}`,
    prompt: tagHints.length === 0 ? purpose : `${purpose}\n\nEmphasis: ${tagHints.join(', ')}`,
  }
}

export function sanitizeRecommendations(
  raw: readonly { agentName: string; reason: string }[],
  catalog: readonly RecommendationCatalogEntry[],
): OnboardingRecommendation[] {
  const known = new Set(catalog.map(listing => listing.agentName))
  const picked = new Set<string>()
  const survivors: OnboardingRecommendation[] = []
  for (const item of raw) {
    if (!known.has(item.agentName) || picked.has(item.agentName)) continue
    const reason = item.reason.trim().slice(0, MAX_ONBOARDING_RECOMMENDATION_REASON_LENGTH)
    if (reason.length === 0) continue
    picked.add(item.agentName)
    survivors.push({ agentName: item.agentName, reason })
    if (survivors.length === 4) break
  }
  return survivors.length === 4 ? survivors : []
}

export async function recommendAgents(options: {
  purpose: string
  tagHints?: readonly AgentTag[]
  catalog: readonly RecommendationCatalogEntry[]
  generate: GenerateRecommendations
}): Promise<OnboardingRecommendationsResponse> {
  if (options.catalog.length === 0) return { recommendations: [] }
  const { system, prompt } = buildRecommendationPrompt(
    options.purpose,
    options.tagHints ?? [],
    options.catalog,
  )
  try {
    const output = await options.generate({
      schema: RawRecommendationsSchema,
      system,
      prompt,
    })
    const raw = RawRecommendationsSchema.parse(output)
    return { recommendations: sanitizeRecommendations(raw.recommendations, options.catalog) }
  } catch {
    // Timeout, gateway failure, and malformed output all land here: the
    // contract is empty recommendations, never an error (settled decision 1).
    return { recommendations: [] }
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
