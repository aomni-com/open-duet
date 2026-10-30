import { handleCampaignAction } from '@/src/campaigns/actions'

export const maxDuration = 180

export async function GET(
  request: Request,
  context: { params: Promise<{ campaignSlug: string; action: string }> },
) {
  return handleCampaignAction(request, await context.params)
}

export async function POST(
  request: Request,
  context: { params: Promise<{ campaignSlug: string; action: string }> },
) {
  return handleCampaignAction(request, await context.params)
}
