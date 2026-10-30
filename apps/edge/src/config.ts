// Typed per-environment defaults, per the repo config convention: config.ts
// owns the default, an env var overrides it per environment.

// The publish viewer's upstream is the apps/web origin. R4 forbids deriving it
// from the inbound Host, so the default keys off the deployment environment
// (Vercel stamps VERCEL_ENV); `DUET_WEB_ORIGIN` overrides when set. Staging is
// the single non-prod config, so preview/dev fall to the staging origin.
export function defaultViewerOrigin(env: Record<string, string | undefined> = process.env): string {
  return env.VERCEL_ENV === 'production' ? 'https://app.duet.so' : 'https://app-staging.duet.so'
}
