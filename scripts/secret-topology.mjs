export const SECRETS = {
  // The deploy rail runs `convex deploy` inside the API build, authenticating
  // only from this key — so it must live on the API Vercel project.
  CONVEX_DEPLOY_KEY: { vercel: ['api'], convex: false, optional: true },
  // Local-only credentials for running the manual `secrets:push` fanout — a
  // Vercel API token and the dotenvx decryption keys. They ride in the encrypted
  // .env files (dotenvx injects VERCEL_TOKEN so the CLI auth is automatic) but
  // are never fanned to any project; the private keys cannot be, being what
  // decrypts those files.
  VERCEL_TOKEN: { vercel: [], convex: false, optional: true },
  // Domain registration runs in Convex, with its own runtime credential.
  DUET_VERCEL_DOMAINS_TOKEN: { vercel: [], convex: true, optional: true },
  DOTENV_PRIVATE_KEY_STAGING: {
    vercel: [],
    convex: false,
    environments: ['staging'],
    optional: true,
  },
  DOTENV_PRIVATE_KEY_PRODUCTION: {
    vercel: [],
    convex: false,
    environments: ['production'],
    optional: true,
  },
  AI_GATEWAY_API_KEY: { vercel: ['lander', 'model-gateway'], convex: true },
  DUET_API_INTERNAL_KEY: { vercel: ['api', 'lander', 'model-gateway'], convex: true },
  DUET_PROGRAMMATIC_LOGIN_SECRET: {
    vercel: ['api', 'web', 'mcp', 'edge', 'model-gateway'],
    convex: true,
  },
  // Per-env Convex deployment id. The function apps need it to resolve the
  // Convex cloud URL at runtime; the lander's campaign actions call Convex too.
  CONVEX_DEPLOYMENT: {
    vercel: ['api', 'edge', 'lander', 'model-gateway', 'mcp', 'web'],
    convex: false,
  },
  // API mints short-lived private-app launch grants and edge verifies them
  // before forwarding the authenticated viewer identity to Convex.
  DUET_EDGE_INTERNAL_KEY: { vercel: ['api', 'edge'], convex: true },
  EXE_TOKEN: { vercel: ['api'], convex: true },
  COMPOSIO_API_KEY: { vercel: ['api'], convex: false },
  // The API's train scraper and the lander still call Firecrawl directly. The
  // service proxy has its own vault copy for catalogued calls.
  FIRECRAWL_API_KEY: { vercel: ['api', 'lander'], convex: false },
  DUET_VM_TOKEN_DERIVE_SECRET: { vercel: [], convex: true },
  // Server-side advertising destinations stay disabled until their matching
  // account config and credentials are provisioned. Optional source keys let
  // the topology declare the intended Convex-only boundary without fake values.
  META_CONVERSIONS_ACCESS_TOKEN: { vercel: [], convex: true, optional: true },
  GOOGLE_DATA_MANAGER_CLIENT_ID: { vercel: [], convex: true, optional: true },
  GOOGLE_DATA_MANAGER_CLIENT_SECRET: { vercel: [], convex: true, optional: true },
  GOOGLE_DATA_MANAGER_REFRESH_TOKEN: { vercel: [], convex: true, optional: true },
  REDDIT_CONVERSIONS_ACCESS_TOKEN: { vercel: [], convex: true, optional: true },
  OPENAI_CONVERSIONS_API_KEY: { vercel: [], convex: true, optional: true },
  AUTH_GOOGLE_ID: { vercel: [], convex: true },
  AUTH_GOOGLE_SECRET: { vercel: [], convex: true },
  // Device identification for the signup abuse gate. The browser key is public
  // by design (it identifies, it does not authorize); the server key resolves
  // the identification event and therefore stays Convex-only, because the gate
  // runs inside Convex rather than in a Next route.
  FINGERPRINT_API_KEY: { vercel: [], convex: true },
  NEXT_PUBLIC_FINGERPRINT_API_KEY: { vercel: ['web'], convex: false },
  // Addresses whose canonical form is exempt from the signup gate: the live
  // acceptance inboxes. Staging-only, because prod has no synthetic identities.
  DUET_SIGNUP_TEST_IDENTITIES: { vercel: [], convex: true, environments: ['staging'] },
  RESEND_API_KEY: { vercel: [], convex: true },
  STRIPE_SECRET_KEY: { vercel: [], convex: true },
  STRIPE_WEBHOOK_SECRET: { vercel: [], convex: true },
  // Subscription objects minted by the provisioner
  // (packages/backend/scripts/provision-stripe-subscriptions.ts); read by
  // convex config.ts to map plans ↔ Stripe prices and pin the narrowed portal.
  STRIPE_STARTER_RECURRING_PRICE_ID: { vercel: [], convex: true },
  STRIPE_PRO_RECURRING_PRICE_ID: { vercel: [], convex: true },
  STRIPE_MAX_RECURRING_PRICE_ID: { vercel: [], convex: true },
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID: { vercel: [], convex: true },
  // Both sibling apps use one PostHog project so anonymous acquisition state
  // can continue into the authenticated product.
  NEXT_PUBLIC_POSTHOG_KEY: { vercel: ['lander', 'web'], convex: false },
  NEXT_PUBLIC_POSTHOG_HOST: { vercel: ['lander', 'web'], convex: false },
  // Convex uses server-only names for the retried analytics sink while sharing
  // the same PostHog project and ingest host as native browser telemetry.
  POSTHOG_API_KEY: {
    vercel: [],
    convex: true,
    valueFrom: 'NEXT_PUBLIC_POSTHOG_KEY',
  },
  POSTHOG_HOST: {
    vercel: [],
    convex: true,
    valueFrom: 'NEXT_PUBLIC_POSTHOG_HOST',
  },
  // Per-env origins (paths are owned by code). The app and lander origins are
  // explicit because sibling Vercel projects cannot infer one another.
  DUET_API_URL: { vercel: ['api', 'lander', 'mcp', 'web'], convex: true },
  // Per-env gateway origin. No config.ts default exists — the API drops model
  // credentials from VM sync when this is unset, so both environments must set
  // it explicitly (2026-08-12: staging-only scoping left prod unable to run
  // any agent turn).
  DUET_MODEL_GATEWAY_URL: { vercel: ['api', 'mcp'], convex: true },
  // Test-only OAuth issuer. Convex forwards it into newly provisioned staging
  // VMs; production has neither a source value nor a topology destination.
  DUET_CONNECT_FAKE_ISSUER_URL: { vercel: [], convex: true, environments: ['staging'] },
  // Mounts the fake issuer routes on the staging api (flag off = routes not
  // registered). Staging-only by construction; prod must never carry it.
  DUET_ENABLE_FAKE_OAUTH_ISSUER: { vercel: ['api'], convex: false, environments: ['staging'] },
  // One canonical OAuth resource identifier shared by API discovery and the
  // MCP resource server. Both deployments must set it explicitly.
  DUET_MCP_PUBLIC_URL: { vercel: ['api', 'lander', 'mcp', 'web'], convex: false },
  DUET_APP_URL: { vercel: ['api', 'web'], convex: true },
  // Edge host this environment's public app URLs live under (apps are
  // subdomains of it, publishes are paths on it). Read by the API's
  // canonicalAppUrl seam and by Convex, which derives marketplace listing
  // source URLs from it.
  // Both environments must set it explicitly: Convex's `edgeHost()` fails
  // closed precisely so a missing value cannot silently resolve to the
  // production edge and point staging VMs at production content.
  DUET_EDGE_HOST: { vercel: ['api'], convex: true },
  NEXT_PUBLIC_DUET_APP_URL: {
    vercel: ['lander'],
    convex: false,
    valueFrom: 'DUET_APP_URL',
  },
  DUET_LANDER_URL: { vercel: [], convex: false },
  NEXT_PUBLIC_DUET_LANDER_URL: {
    vercel: ['lander'],
    convex: false,
    valueFrom: 'DUET_LANDER_URL',
  },
  // Fixed @convex-dev/auth vendor key. It carries the same product origin but
  // is not read by Duet application code and is never sent to Vercel apps.
  SITE_URL: { vercel: [], convex: true, valueFrom: 'DUET_APP_URL' },
  // Immutable VM image reference consumed by API provisioning and Convex.
  DUET_VM_IMAGE_REF: { vercel: ['api'], convex: true },
}

export const KNOWN_TARGET_UNMANAGED = new Set([
  'VERCEL_OIDC_TOKEN',
  // Provisioned by the private Blob store's project connection, never fanned to VMs.
  'BLOB_READ_WRITE_TOKEN',
  'BLOB_STORE_ID',
  'BLOB_WEBHOOK_PUBLIC_KEY',
  'CONVEX_URL',
  'CONVEX_SITE_URL',
  // Generated and rotated by @convex-dev/auth rather than dotenvx fan-out.
  'JWKS',
  'JWT_PRIVATE_KEY',
  'NODE_ENV',
  'NEXT_PUBLIC_AXIOM_INGEST_ENDPOINT',
])

// Unmanaged above because each deployment generates its own, but a Convex
// deployment missing them is not merely unconfigured -- it cannot mint or
// verify a session token, so every provider's sign-in fails and the JWKS
// endpoint 500s. Nothing pushes these; `secrets:push` asserts they are there.
export const CONVEX_DEPLOYMENT_OWNED = new Set(['JWKS', 'JWT_PRIVATE_KEY'])

export const SOURCE_ONLY = new Map([
  // Catalog vendor credentials are copied from these encrypted source files
  // into the Convex service vault; they must not remain in Vercel API env.
  ['CRUSTDATA_API_KEY', new Set(['staging', 'production'])],
  ['FULLENRICH_API_KEY', new Set(['staging', 'production'])],
  ['DATAFORSEO_BASE64_PASSWORD', new Set(['staging', 'production'])],
  ['ELEVENLABS_API_KEY', new Set(['staging', 'production'])],
  ['SOCIALAPI_API_KEY', new Set(['staging', 'production'])],
  ['AGENTMAIL_API_KEY', new Set(['staging'])],
  ['DUET_E2E_AGENTMAIL_INBOX_ADDRESS', new Set(['staging'])],
  ['DUET_E2E_AGENTMAIL_INBOX2_ADDRESS', new Set(['staging'])],
  ['DUET_DOCS_URL', new Set(['production'])],
  ['DUET_RELEASE_PROBE_WORKSPACE_SLUG', new Set(['production'])],
  ['VERCEL_AUTOMATION_BYPASS_SECRET', new Set(['staging'])],
])
