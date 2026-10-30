import { campaignHandoffResponse } from '../../../../src/auth/campaign-handoff'

export const dynamic = 'force-dynamic'

export function GET(request: Request): Response {
  return campaignHandoffResponse(request)
}
