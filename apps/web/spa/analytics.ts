import type { WhoamiResponse } from '@repo/contract'

export interface ProductAnalytics {
  identify(id: string, properties: { email: string; name?: string }): void
}

export function identifyProductUserOnce(
  analytics: ProductAnalytics,
  identity: WhoamiResponse,
  identifiedUserId?: string,
): string {
  if (identifiedUserId === identity.user.id) return identifiedUserId
  analytics.identify(identity.user.id, {
    email: identity.user.email,
    ...(identity.user.name === undefined ? {} : { name: identity.user.name }),
  })
  return identity.user.id
}
