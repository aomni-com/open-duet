import { ConvexAuthNextjsServerProvider } from '@convex-dev/auth/nextjs/server'

export async function AuthProvider({ children }: { children: React.ReactNode }) {
  return <ConvexAuthNextjsServerProvider>{children}</ConvexAuthNextjsServerProvider>
}
