import { primaryAppUrl, type GatewayAppConfig } from '@repo/contract'

export function withPublicAppUrls(
  configs: readonly GatewayAppConfig[],
  options: { workspaceSlug: string; edgeHost: string },
): GatewayAppConfig[] {
  return configs.map(config => {
    if (config.visibility === 'public') {
      return {
        ...config,
        canonicalUrl: primaryAppUrl(options.workspaceSlug, config.slug, options.edgeHost, config.customDomain),
      }
    }
    const privateConfig = { ...config }
    delete privateConfig.canonicalUrl
    return privateConfig
  })
}
