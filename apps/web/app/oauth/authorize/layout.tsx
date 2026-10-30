import { AuthProvider } from '../../../src/auth/provider'

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}
