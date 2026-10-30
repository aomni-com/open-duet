import {
  USER_SETTINGS,
  WORKSPACE_DESTINATIONS,
  WORKSPACE_SETTINGS,
} from '@/spa/routes/route-metadata'

export type DeployedProductRoute = {
  template: string
  destination: string
}

export const DEPLOYED_PRODUCT_ROUTES: DeployedProductRoute[] = [
  { template: '/', destination: 'root' },
  { template: '/w/:workspaceSlug', destination: 'workspace-root' },
  ...WORKSPACE_DESTINATIONS.map(([route, destination]) => ({
    template: `/w/:workspaceSlug/${route.replace(/\/\*$/, '')}`,
    destination,
  })),
  { template: '/w/:workspaceSlug/settings', destination: 'workspaceSettings' },
  ...WORKSPACE_SETTINGS.map(([surface]) => ({
    template: `/w/:workspaceSlug/settings/${surface}`,
    destination: 'workspaceSettings',
  })),
  { template: '/settings', destination: 'userSettings' },
  ...USER_SETTINGS.map(([surface]) => ({
    template: `/settings/${surface}`,
    destination: 'userSettings',
  })),
  { template: '/internal-admin', destination: 'internalAdmin' },
]
