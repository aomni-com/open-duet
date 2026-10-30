import { type CampaignLeadRequest } from '@repo/contract'

type EmailLeadInput = {
  email: string
  source?: string
  pageSlug?: string
  company?: { name?: string; url?: string }
  sourceUrl: string
  referrer?: string
}

export function buildEmailLeadRequest(input: EmailLeadInput): CampaignLeadRequest {
  return {
    data: {
      email: input.email,
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.pageSlug === undefined ? {} : { pageSlug: input.pageSlug }),
      ...(input.company === undefined ? {} : { company: input.company }),
    },
  }
}
