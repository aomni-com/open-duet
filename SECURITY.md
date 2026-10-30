# Security model

How identity, workspace access, and deployment-level protection are controlled
across the platform. This is the canonical home for the auth principles; the
mechanisms live in the packages pointed to at the end.

## Signup is open; identity and workspace access are authenticated

Identity enters the system in exactly one conceptual place — creating an account —
and there are three doors onto the _same_ implementation
(`createOrLinkUserForAuth`), so an account is identical however it was made:

- **Real signup/login** — Convex Auth (email magic-link + Google OAuth), browser
  straight to Convex. This is the only path a normal user takes; `duet-api` has no
  signup route. New addresses may create an account without an invitation or
  operator setup. Existing verified identities link to the same account through
  `createOrLinkUserForAuth`. Google proves identity through OAuth; email sign-in
  requires the emailed code before a session is issued. Account creation alone
  grants no access to another person's workspace. Trial eligibility belongs to
  `domains/signupAbuse`: blocked domains and excessive domain signup volume
  refuse workspace bootstrap; other suspicious signups have their trial withheld
  and their workspace paused until payment. The shared email provider suppresses
  blocked-domain verification mail before the paid delivery service, retaining
  the normal start-response shape regardless of account existence. Convex Auth
  creates its user and code before that callback, so delivery suppression does
  not prevent those auth rows.
  Fixtures replace real identity verification with `DUET_TEST_AUTH_EMAIL=1` or
  the test-Google credentials provider, `DUET_TEST_AUTH_GOOGLE=1`. Email fixtures
  pin the sign-in code to a constant *and* suppress every outbound email — on a
  real deployment that is an unauthenticated takeover of anyone whose address you
  know, with the warning eaten by the same flag. Nothing in the secrets rail pushes
  it. The test-provider guards in `convex/config.ts` refuse unless the
  deployment reports a loopback address, and fail closed when it cannot tell.
- **Programmatic** — `POST /v1/admin/login-as` on `duet-api`, gated by a dedicated
  secret (`DUET_PROGRAMMATIC_LOGIN_SECRET`) at the HTTP layer; the underlying Convex
  mint (`mintImpersonationKey`) is separately gated by the server-to-server internal
  key (`DUET_API_INTERNAL_KEY`), so holding _either_ the login secret (via the route)
  or the internal key (direct) can impersonate. Creates-or-reuses the account and
  mints a session — a controlled backdoor onto the real creation path, not a parallel
  one. Treat both secrets as impersonation-grade and rotate on exposure.

- **Internal operator creation** — the internal-admin user creation endpoint
  requires an operator browser session or impersonation credential at the API,
  then rechecks the operator's identity behind the internal key in Convex. It
  uses the shared account and default-workspace bootstrap, with its audit in
  the same transaction. It creates no credential, sends no email, and leaves
  email verification to ordinary sign-in. Existing canonical mailboxes are
  refused without changing their account or creating another workspace.

Workspace invitations can be accepted by their email-link token or by the
recipient's authenticated browser account. The in-app path follows the existing
browser-session account-management boundary: the API derives the actor from
the session, and the backend matches that user's canonical email to the stored
invitation. An invitation ID alone grants nothing, and the recipient inbox
never returns token hashes or link secrets. Both paths share the same expiry,
revocation, membership-admission, and audit transaction.

Every normal sign-in must prove identity before receiving a session. Programmatic
and operator account creation retain their credential checks; workspace access
always depends on membership or an explicitly issued capability.

## Human keys identify a person; workspace access follows membership

A first-party human key (`user`) identifies its user. It stores no capability
scopes or workspace bindings. CLI login, REST operations and sync use that same
identity; current workspace membership and role determine access on every request.
Joining a workspace makes it available to the existing key, leaving removes it,
and changing role changes allowed operations. Browser sessions and impersonated
visits share this authorization policy, with browser presentation added separately.

Device-code approval signs the CLI in as the approving person. It does not request
a workspace or a set of capabilities. Ordinary key management lists identity and
revocation metadata, and account operations accept authenticated human credentials.
Revocation and expiry are checked before the live membership projection.

Every authenticated route still checks its credential. VM registration and other
auth-bypass routes carry their own secret or token. Managed VM/app credentials and
third-party OAuth grants retain their workspace bindings and capability contracts.
A model request from a human must explicitly select its workspace; there is no
implicit first workspace for billing. The model gateway resolves current access
and payer policy before forwarding to the upstream provider.

The session-deletion disposal callback is another explicit auth-bypass route,
gated by `DUET_API_INTERNAL_KEY`. It is a narrow execution path over an opaque
backend-owned deletion-work ID: the API reloads the workspace, session, and
provider targets from Convex, so the caller cannot turn the callback into a
general gateway command or select a different workspace capability. Missing,
stale, and completed work all collapse to the same harmless no-op.

A second chain spends the **platform's own** gateway key from inside Convex,
never through the model gateway, and it is deliberately narrow: onboarding's
starting-team recommender. Its gate is not a credential tier but a *window* —
owner-only, and closed the moment `onboardedAt` is stamped — which is what
stops a call we pay for from becoming a general-purpose endpoint for anyone
with an account. Any further platform-paid call belongs behind a gate of that
shape, and named here. Dev fixtures do not get to open this window: the
onboarding playground reads the agent catalog live but keeps its
recommendations canned for exactly this reason.

Capability scopes are the effective authorization projection at the request
boundary. Human keys derive them from current roles; managed and delegated keys
remain bound to their explicit grants. Stored grants never narrow first-party
human identity.

The workspace capability vocabulary is `files:read`, `files:write`, `memory`,
`sessions`, `agents`, `services`, `integrations`, `apps`, `share`, `publish`,
`members`, and `admin`. `admin` is the same-workspace wildcard; `members` is
limited to invite creation, listing, and revocation, while metered service proxy
access requires `services`.

The `app` credential kind is a key bound to one durable app row and its workspace.
Managed keys are platform-delivered; explicitly exported keys are returned once
to an authorized external-host setup. Their scopes are re-derived from that row's `apiScopes`
declaration on mint and revalidated on every authentication; `admin` is not in
the declaration grammar, so no app key can represent it. App authentication is
membership-free like `system_vm`, but succeeds only while the exact app row still
exists, remains enabled, and declares the stored scope set. Deletion, disabling,
share-convergence removal, and official-app removal revoke the key in the same
durable mutation. Re-enabling an app never resurrects an old credential.

Current managed delivery mints and refreshes keys for non-empty declarations
through the workspace VM's pull-only credential rail, then injects them only
into the registered service process as `DUET_APP_API_KEY`; install commands
never receive it. A declaration
change rotates the key, and delivery of the replacement restarts only that app.
The gateway keeps the managed plaintext in its private state. The workspace VM
is one trust domain, so a user or agent may also persist an app key in a private
local runtime file when an app or test needs it. Keep it out of source control,
public assets, browser bundles, logs and shared/published files; external hosts
should use their server-side environment or secret store.

App-bound credential management belongs to ordinary workspace app management:
the `apps` capability and app-management authority, not a human-only or
browser-only gate. A workspace agent asked to build an externally hosted app
must be able to configure its Duet access as part of that work, without sending
the person through another key-minting, copying, or consent step. Export does
not widen the app declaration or change the app's workspace identity.

Explicit export is an intentional transfer to the external server's secret
manager. Keep returned plaintext out of conversation/tool transcripts, public
assets, browser bundles and logs. Private local persistence is allowed inside
the trusted workspace when needed for runtime or testing; pass the value to the
external host's server-side environment or secret store. Managed VM refresh
must not revoke external exports.
The independent export lifecycle is documented in
[`app-key-export`](specs/done/app-key-export/README.md). Human API-key, device and OAuth issuance retain
their existing consent boundaries.

## Inside a workspace VM there is one trust domain — don't over-engineer it

The workspace VM is the security boundary, not the processes inside it. The
agent, its tools, and everything it installs run as one user on one
filesystem, where the drive (including every synced `.env*`) and the
workspace's `DUET_API_KEY` are already readable. A security distinction drawn
*between* those processes is theater: anything on the VM that wants a
capability can already reach it through the agent, the filesystem, or the
gateway rail. Theater is worse than nothing — it accretes route-specific
credential checks, split scope sets, and special cases that make the product
harder to build on without stopping a single real attack.

The rule: when the question is "should this workspace-scoped credential be
allowed to do X in its own workspace?", the answer is yes whenever anything
already inside that workspace can cause X by other means — grant the
capability and use the uniform auth gate, never a per-route credential
carve-out. This holds for every workspace credential, not just the VM's own
key: app keys bind their workspace, human keys act through current membership,
and a workspace is one trust domain.

It follows that none of the following is a finding, in design or in review.
Do not raise them, and do not build them:

- **Capability splitting inside a workspace** — a second scope so that
  holders of the first can't reach some subset of what the workspace can
  already do.
- **Payload allowlists** — refusing shapes on a request body because
  executing them would run commands in the VM. Every workspace credential can
  already cause arbitrary execution there by prompting the agent.
- **Key-kind carve-outs** — accepting a field only from `system_vm`, only
  from an app key, only from a browser session.
- **"But a third-party app holds this key"** — the user granted an app a
  workspace capability; that grant is the decision, and it was made at
  install time, not at each route.

Worked examples: the session-cwd endpoint added `sessions` to `vmModelScopes`
instead of dual-accepting `system_vm` at one route (stale-scope keys rotate
themselves at next refresh); session creation accepts a whole state-machine
definition — `script` states and all — from any `sessions`-scoped caller,
with no state-kind allowlist and no key-kind check.

Non-security limits are still fine and are not what this section is about. A
numeric floor on a scheduling interval, a body-size cap, or a rate limit is a
cost or sanity guard that applies uniformly to every caller; it is not a trust
decision and needs no justification here.

Scope-splitting earns its complexity only where a credential *leaves* the
boundary: third-party OAuth grants and app keys —
the app rail exists because app folders sync, share, and publish beyond the
VM, not to protect the VM from itself.

## OAuth credentials: resource-bound, expiring grant families

The `oauth` credential kind is a workspace-scoped Duet key issued through the
authorization-code flow. Its access credential expires after roughly one hour
and carries the canonical MCP resource as its audience. This is not Duet's first
expiring credential: the shared API-key validator already enforces `expiresAt`
for browser sessions, impersonation, app, and system-VM credentials. OAuth uses
that same validator and adds a resource audience plus a revocable grant family.

An authorization-code exchange mints an access/refresh pair. Refresh rotates
both credentials. The immediately previous refresh credential may be retried
during the short grace window; that retry re-rotates at the same generation,
revokes the first caller's unclaimed access credential, and preserves the
original access/refresh deadlines. A deeper ancestor or a predecessor reused
after grace revokes the whole grant family. Revoking the Connected app in
Settings has the same family-wide effect: every access and refresh credential
from that grant dies.

Audience enforcement happens at the MCP resource boundary. MCP accepts an OAuth
key only when `whoami` reports the exact configured MCP audience; ordinary
first-party keys remain pasteable because they are not OAuth resource tokens.
After admission, MCP forwards that same bearer to `ctl` for REST-backed tools
and to the model gateway for gateway-backed tools.

That forwarding is a deliberate tension with the MCP authorization
specification's token-passthrough guidance, which prefers the MCP server to use a
separate upstream credential instead of relaying the client's resource token.
Duet does not pretend otherwise: `mcp`, `ctl`, and the gateway are first-party
components inside one trust boundary, so Duet treats the MCP audience as that
shared resource domain and accepts the larger bearer exposure. If any of those
services leaves that trust boundary, a separate upstream-token exchange becomes
mandatory before the split ships.

OAuth client identity uses dynamic client registration (DCR) only. The caller
submits public-client metadata, which `apps/api/src/oauth/client-metadata.ts`
validates and stores at registration — the server never fetches a URL to resolve
a client, so there is no client-metadata SSRF surface. The normalized client is
copied into an immutable authorization snapshot so consent and completion never
depend on later client state. (A URL-identified Client ID Metadata Document
(CIMD) mode, which required a server-side metadata fetch, was removed.)

## Sync machines are separate from login

A machine's Syncthing identity and display name describe the computer, not an
access grant. Sync uses the same human key as ordinary CLI commands and evaluates
current membership. Removing a machine stops that computer's mirroring without
revoking the person's login on their other computers.

## Why Vercel Deployment Protection is defense-in-depth, not the control

Every deployed service enforces its own key auth (above). Vercel's SSO/deployment
protection sits _in front of_ that as a coarse outer gate. The consequence:

- **Disabling SSO on a service makes it internet-reachable but grants no access** —
  the app-level key auth still gates every route. An unauthenticated caller gets a
  401, not a free ride.
- The one thing SSO was a genuine _second_ lock on: the secret-gated endpoints,
  above all `login-as` (which mints a session, and a session can spend credits).
  With SSO off, those secrets become the sole gate — so they must stay strong
  (32–64-char random) and be **rotated if ever exposed** (e.g. handled in a support
  session).
- Therefore: **staging may run with SSO disabled**, relying on app-level auth, _as
  long as identity verification and workspace authorization remain enforced_.
  **Production should keep SSO on** as an extra layer for deployment and operator access.

The load-bearing invariant: every session starts from verified identity or an
authorized operator credential, and every workspace request checks its current
membership or capability. Open signup does not grant access to existing workspaces.

## Where the mechanisms live

- **Convex Auth** (real signup/login providers + the shared `createOrLinkUserForAuth`
  account bootstrap) — `packages/backend/convex/auth.ts` and `domains/users`.
  Its session is the identity every browser credential is minted from, and it
  is bounded by inactivity alone: the rotating refresh token dies after
  `IDENTITY_SESSION_INACTIVE_MS` unused, and its cookie persists for the same
  span so quitting the browser is not a sign-out. The library also demands an
  absolute deadline fixed at sign-in; `IDENTITY_SESSION_TOTAL_MS` sets it past
  any person's use of the product (both in `packages/contract/src/api-keys`).
  Someone who keeps using the product is never signed out.
- **Session credentials** (Duet API keys: mint, hash-at-rest, validate, and the
  live human membership and managed grants) — `packages/backend/convex/domains/apiKeys`; the
  browser carries one as the `duet_session` cookie. Scope grammar lives in
  `packages/contract/src/scopes`.
  Browser credentials are long-lived so normal use does not depend on frequent
  renewal. Their lifetime lives in `packages/contract/src/api-keys`; logout
  revokes them directly, and each request checks current membership and roles.
- **App credentials** (the `app` kind: row-bound mint, scope revalidation,
  expiry, rotation, and lifecycle revocation) — same `domains/apiKeys`; app
  declarations and their non-admin ceiling live in `AppApiScopesSchema`.
- **OAuth credentials** (authorization snapshots, rotating refresh families,
  grant revocation, and expiring audience-bound access keys) —
  `packages/backend/convex/domains/oauth`; HTTP discovery, registration, and
  exchange live in `apps/api/src/routes/oauth.ts`; registration metadata
  validation lives in `apps/api/src/oauth/client-metadata.ts`.
- **MCP resource enforcement** (root transport, protected-resource metadata,
  bearer challenge, exact OAuth audience check, and first-party forwarding) —
  [`apps/mcp`](apps/mcp/README.md).
- **Programmatic login / impersonation** — `apps/api/src/routes/admin.ts`
  (secret-gated) calling the mint above.
- **Model-gateway key validation + AI-gateway forwarding** —
  [`apps/model-gateway`](apps/model-gateway/README.md).
- **Trust-root internal key** (server-to-server, e.g. api → Convex acting as a
  user) — `requireApiInternalKey` in `domains/apiKeys`.
