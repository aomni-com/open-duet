import { createMagicLinkIntent } from '../../../../src/auth/magic-link-intent'
import { sendMagicLink } from '../../../../src/auth/send-magic-link'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return await createMagicLinkIntent(request, sendMagicLink)
}
