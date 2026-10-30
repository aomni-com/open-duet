import { PRODUCT_DESTINATIONS } from './product-destinations'

export const WORKSPACE_DESTINATIONS = PRODUCT_DESTINATIONS.flatMap(destination =>
  destination.pathPatterns.map(path => [path, destination.id] as const),
)

export const WORKSPACE_SETTINGS = [
  ['general', 'general'],
  ['members', 'members'],
  ['shares', 'shares'],
  ['backups', 'backups'],
  ['app-domains', 'appDomains'],
  ['connected-providers', 'connectedProviders'],
  ['publishes', 'publishes'],
  ['usage', 'usage'],
  ['audit', 'audit'],
  ['billing-user', 'billingUser'],
] as const

export const USER_SETTINGS = [
  ['profile', 'profile'],
  ['billing', 'billing'],
  ['api-keys', 'apiKeys'],
  ['preferences', 'preferences'],
] as const

export function isWorkspaceSettingSurface(surface: string | undefined): boolean {
  return surface === undefined || WORKSPACE_SETTINGS.some(([route]) => route === surface)
}

export function isUserSettingSurface(surface: string | undefined): boolean {
  return surface === undefined || USER_SETTINGS.some(([route]) => route === surface)
}
