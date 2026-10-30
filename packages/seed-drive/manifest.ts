import type { AppDeclaration } from '@repo/contract'

export const seedAppRegistrations = [
  // Omit the port so a base-image service can never collide with the reserved allocator.
  {
    path: 'welcome/hello-app',
    slug: 'hello',
    name: 'Hello',
    apiScopes: [],
    icon: 'icon.png',
    command: 'bun run server.ts',
  },
] as const satisfies readonly AppDeclaration[]
