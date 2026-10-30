# device-auth — pick-at-approval device flow + MCP OAuth

Two authorization front doors that share one consent surface. A terminal
authenticates through the device flow; an MCP client authenticates through
OAuth 2.1. Both end at the same browser consent screen, where the user is
already signed in, picks the workspace, and grants a workspace-scoped
`duet_sk_` key.

Shipped and live on staging (both phases); production carries the same code.
Phase-2 OAuth was verified end-to-end against live staging with a real
browser (consent approved through the UI, token confirmed `oauth`-kind with
the exact MCP audience and materialized scopes, MCP accepted the
audience-bound token at root).

## What shipped

**Phase 1 — the device flow stopped naming a workspace.** `duet login` sends
capabilities, not a `ws:<slug>:…` scope; the browser approval page binds the
workspace at approval (auto-selecting when exactly one is grantable). This
also fixed a live breakage: the agent still requested `ws:<slug>:ai`,
unparseable since the capability-vocabulary cutover (`f5725d30`), so login
400'd.

**Phase 2 — `apps/mcp` became a spec-compliant OAuth 2.1 resource server**
at its root, backed by a new authorization server on `apps/api`, reusing the
phase-1 consent panel with an added client-identity block.

## Why it works this way

**One consent surface, two controllers.** The workspace picker, capability
chips, and eligibility states live in one presentational component
(`apps/web/components/auth/consent-panel.tsx#ConsentPanel`). The device page
and the OAuth page each wrap it with their own controller; OAuth adds the
client-identity/redirect-host block through the panel's optional `client`
slot. Neither forks the picker. This is why the device and OAuth screens read
as one design.

**Binding moves to approval, the mint path does not.** A capability-only
device code carries no workspace until the browser approves it; approval
materializes real `ws:<slug>:<cap>` scopes onto the `deviceCodes` row, which
then reaches the *unchanged* `pollDeviceCode` mint path as an ordinary
single-workspace row. `assertSingleWorkspaceScopes` still holds at mint — the
single-workspace invariant (SECURITY.md) is preserved, not weakened. The one
subtlety the plan under-specified: the response contract has explicit unresolved
and resolved variants. An *approved* capability row responds with materialized
scopes and no `capabilities` field; a pending, denied, or expired row responds
with capabilities instead.

**OAuth tokens are ordinary `apiKeys`, not a parallel credential.** The
`oauth` kind authenticates through the *existing* `apiKeys` path
(`domains/apiKeys/api.ts#authenticate`) — `assertSingleWorkspaceScopes` +
`authorizedApiKeyPayload`, plus a grant-liveness check and the generic
`expiresAt` check that already existed. OAuth is *not* the first expiring
credential (browser sessions, impersonation, app, and system-VM keys already
expire); it reuses that validator and adds an audience and a revocable grant
family. There is no second authentication path and no token-exchange rail.

**First-party audience, documented honestly.** MCP forwards the caller's
bearer to `ctl`/`gateway` within one trust domain. The MCP spec's
token-passthrough section would prefer a separate upstream token; SECURITY.md
states plainly that Duet diverges because `mcp`/`ctl`/`gateway` share a trust
boundary, and does not pretend the tension is absent.

**Refresh rotation uses grace re-rotation, not derived tokens.** Within a
short grace window the immediate predecessor refresh token re-rotates,
superseding the unclaimed successor (so a network-flake retry doesn't
self-nuke); deeper ancestors or post-grace reuse revoke the whole grant
family. Rejected alternative: HMAC-derived deterministic successors — same
attacker exposure, plus a new secret to manage.

**Redirect URIs are HTTPS or HTTP-loopback only.** A redirect URI is a
browser navigation target that reaches `window.location.assign` at consent
completion. `OAuthRedirectUriSchema`
(`packages/contract/src/oauth/index.ts`) rejects executable/opaque schemes
(`javascript:`, `data:`, `file:`), credentials, and fragments — one owner for
registration, CIMD, authorize, and token. Without it a registered
`javascript:` redirect would execute in the Duet page.

**The `/mcp` path was deleted, not aliased.** MCP serves at root; the
`/mcp`-suffix concept and the `DUET_MCP_URL`/`DUET_MCP_PUBLIC_URL` env split
were erased repo-wide (web + lander included) into one canonical origin owner.

## Invariants (what must stay true)

- Every non-`sync_device` credential is single-workspace; the capability
  device form and the `oauth` kind both satisfy it by materializing
  `ws:<slug>:<cap>` scopes before/at mint. Violating this reopens the
  open-proxy hole the whole auth model exists to close (SECURITY.md).
- One eligibility owner: `grantableWorkspacesForCapabilities`
  (`domains/apiKeys/model.ts`) — all-or-nothing (the role must grant *every*
  requested capability). The consent UI only renders its result; approval
  re-checks it server-side so a stale picker cannot widen access.
- The browser only ever receives an opaque authorization-request handle;
  completion redirects are built server-side from the persisted exact
  redirect URI. No redirect URI reaches the page before the exact-registered
  check.
- Codes, access tokens, and refresh tokens are hashed at rest. The CIMD
  fetcher (`apps/api/src/oauth/client-metadata.ts`) is the sole owner of
  client-metadata fetching, SSRF-guarded (HTTPS-only, DNS answers checked,
  private/loopback/link-local/mapped-IPv6 rejected, address pinned, redirects
  re-resolved, bounded time/size/type).
- The `oauth` kind's grant liveness is checked only on its own authenticate
  branch; the other credential kinds must never acquire a grant lookup.
- The API origin has one deployment key: `DUET_API_URL` is consumed by the API
  publisher, MCP resource server, and other API clients. The API publisher
  fails closed in deployed non-production environments when that origin is
  absent. (See dead ends: the outage this caused, and why fail-closed behavior
  was kept.)

## Pointers into the code

- Wire contract: `packages/contract/src/oauth/index.ts`,
  `packages/contract/src/api-keys/index.ts` (device request XOR and explicit
  approval-response variants), `packages/contract/src/scopes/index.ts#LOGIN_CAPABILITIES`.
- Device lifecycle: `packages/backend/convex/domains/apiKeys/`
  (`deviceApproval.ts`, `mutations.ts:createDeviceCode`, `api.ts:pollDeviceCode`).
- OAuth kernel: `packages/backend/convex/domains/oauth/` (`api.ts` grants/
  codes/refresh mutations, `refresh.ts` the rotation classifier). Tests:
  `packages/backend/src/oauth.test.ts` (concurrency, grace, family revocation).
- AS: `apps/api/src/routes/oauth.ts` (metadata, register, authorize, token,
  `/v1/oauth/authorization/*`), `apps/api/src/oauth/client-metadata.ts`.
- RS: `apps/mcp/src/http.ts` (root serve, PRM, one `WWW-Authenticate`
  builder, audience enforcement), `apps/mcp/src/config.ts`.
- Consent UI: `apps/web/components/auth/consent-panel.tsx`,
  `apps/web/app/oauth/authorize/controller.tsx`,
  `apps/web/app/device/page.tsx` (auto-inspect), settings grants card in
  `apps/web/spa/routes/user-settings.tsx`.
- Staging journeys: `packages/test-harness/src/staging-e2e-synthetic`,
  `.../staging-e2e-synthetic` (see dead ends for its foundation caveat).

## Dead ends and divergences

- **No Inspect button (diverged from the approved mock).** Mid-build the user
  cut the Inspect button; the device page auto-inspects a complete code. The
  mock in `assets/device-approval-mock.html` predates this and still shows the
  button — it is the visual standard for everything *else* on the card.
- **The full `e2e:staging` gate was replaced by targeted journeys** (user
  call): a device probe for phase 1, an MCP-OAuth journey for phase 2, run via
  `e2e:staging --journey <name>` rather than the ~30-min full suite.
- **Prod outage during rollout.** Promoting phase-2 to `main` deployed code
  that reads `DUET_MCP_PUBLIC_URL` before that secret was in prod's Vercel
  env; the fail-closed config threw at app construction and 500'd the entire
  API. Recovered by setting the var and redeploying. The fail-closed behavior
  was *kept* (not softened to a prod default) — a missing origin should fail
  loudly; the fix is to push env before promoting code that needs it, and to
  never double-push a branch (racing Vercel builds cancel each other).
- **The committed MCP-OAuth journey cannot currently pass.** It is built on
  `runWorkspaceBrowserJourney`, which injects a `duet_session` cookie — that
  satisfies the `/api/duet/*` proxy but not the consent page's Convex Auth
  guard (`apps/web/proxy.ts` gates protected pages on
  `convexAuth.isAuthenticated()`), so it redirects to `/sign-in`. The product
  is correct; the harness foundation is wrong. Phase-2 was verified with a
  magic-link probe instead. FOLLOW-UP: switch the journey's foundation to a
  magic-link AgentMail identity like `runDeviceApproval`.
- **CIMD not live-hosted.** The MCP-OAuth journey's Client-ID-Metadata-Document
  leg self-skips without a hosted fixture; DCR (the path real clients use) is
  the live-verified path. Same fixture-hosting deferral class as
  connected-providers 11b.
## Visual provenance

- `assets/device-approval-mock.html` — the approved consent-card mock (three
  eligibility states). Every card element except the deleted Inspect button
  was measured against it via `compare-screenshots` + unprimed
  `screenshot-critique`. Two critique-driven fixes shipped: long-workspace-name
  truncation on the approve button, and (OAuth) de-nudging the Approve button
  to an outline peer of Deny when the redirect is localhost.
- `assets/quadrant-map.html` — the pre-build quadrant walk that closed the
  product decisions; its build plan is superseded by this record.
- `assets/spike-report.md` — the phase-2 kill-gate spikes (SSRF pinning,
  refresh atomicity, MCP SDK conformance at root) that de-risked the design
  before any product code.

Decision record: `choices.md` (consolidated, grouped by confidence).
