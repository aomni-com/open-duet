# mcp-oauth-green — live e2e coverage for the DCR MCP-OAuth journey

**Shipped 2026-07-26.** `bun run e2e:staging -- --journey mcp-oauth` passes all
six legs against live staging — `discovery`, `dcr-authorization`, `mcp-tools`,
`refresh-family`, `settings-revoke`, `audience-and-root` — with cleanup verified
and no orphaned resources. This is the first time that journey has run
end-to-end live; it validates the **MCP OAuth** feature (an external MCP client
connecting to a Duet workspace via OAuth consent, then calling Duet tools) on the
**DCR** path real clients use.

## Why this needed a spec at all

The journey existed but had **never executed past consent**. Two layers hid that:

1. **The browser never actually authenticated.** `runWorkspaceBrowserJourney`
   authenticated its Playwright browser by planting a `duet_session` cookie. But
   since device-auth, the web middleware (`apps/web/proxy.ts`) gates every
   protected product path — including `/oauth/authorize` — on
   `convexAuth.isAuthenticated()` (the `@convex-dev/auth` JWT), which a
   `duet_session` cookie does not satisfy. Every browser journey was silently
   307'd to `/sign-in` before its assertions ran. Fixed (separately, commit
   `2f9a4465`) by having the journey drive a real magic-link sign-in via a tagged
   AgentMail address so the browser holds a genuine convex-auth JWT.

2. **Every leg past consent was a first-time live assertion.** Because auth always
   failed first, the legs' UI-coupled and response-shape assumptions had never
   been checked against reality. The plan therefore treated the work as a
   sequential validation ladder — run, classify (test-brittleness vs real product
   bug), fix, re-run — rather than a known set of edits.

## What actually shipped (plan vs reality)

The ladder predicted a fix per leg and a possible product-bug rabbit hole. Reality
was lighter: **only two legs needed changes, and no product bugs surfaced** (commit
`cb47f91f`, harness-only).

- **`dcr-authorization` — approve-response race.** `authorizeClient` read the
  authorization `code` from the approve POST response body, but the consent
  controller navigates the browser to the redirect URL immediately after approve,
  evicting that body (`getResponseBody: No resource with given identifier found`).
  Now reads `code`/`state` from the post-approve **navigation URL**
  (`waitForURL` + `page.url()`), which is robust regardless of what the callback
  route returns. `OAuthConsentApproveResponseSchema` is no longer used here.
- **`settings-revoke` — wrong accessible name.** The revoke button's real i18n
  (`user.apiKeys.connectedAppRevoke` → `Revoke connected app {name}`) did not match
  the asserted `Revoke {name}`. Matched the shipped label. (The redirect-host
  consent assertion had the same class of bug and was fixed earlier: the host is
  rendered inside "Redirects to {host}", so it is matched as a substring.)
- **`mcp-tools`, `refresh-family`, `audience-and-root` — no changes.** They passed
  live unchanged: tool dispatch (`list_files`, `generate_media`) through the OAuth
  token, refresh rotation + reuse-detection revocation, wrong-audience rejection,
  the device-approval sub-flow, and the retired `/mcp` path returning 404.

## Invariants (what must keep holding)

- **The journey browser must carry a real convex-auth session**, not just a
  `duet_session` cookie — the middleware gate is on the convex-auth JWT. If a
  future change reverts `runWorkspaceBrowserJourney` to cookie-planting, every
  browser journey silently regresses to a `/sign-in` bounce.
- **Read the OAuth `code` from the navigation the browser lands on, never from the
  approve response body** — the post-approve navigation evicts that body. Any
  browser consent flow must follow this.
- **Browser assertions must match shipped i18n / DOM**, not an imagined UI. The two
  bugs here were both over-strict/wrong text (`exact:true` on interpolated or
  mislabeled strings). Prefer the real message key's rendered value.
- **One test oracle: the live journey.** Diagnosis probes (curl/API) are allowed to
  localize a failure; the verdict is always `--journey mcp-oauth`.
- **`mcp-oauth` is kept an opt-in focused journey** (registered in
  `staging-e2e-synthetic`, run via `--journey mcp-oauth`). We deliberately did
  not promote it into the full-suite gate — it provisions a VM + image-gen +
  browser flows (~5–7 min, real resources). Promote only after it proves stable
  across runs.

## Pointers into the code

- Journey + all legs: `packages/test-harness/src/staging-e2e-synthetic`
  (`MCP_OAUTH_STAGING_LEGS`, `runMcpOAuthAcceptance`, `authorizeClient`).
- Browser sign-in that unblocks it: `runWorkspaceBrowserJourney` in
  `packages/test-harness/src/staging-e2e-synthetic`.
- The gate that required it: `apps/web/proxy.ts` (`convexAuth.isAuthenticated()`)
  + `apps/web/src/routing/product-routes.ts` (`isProtectedProductPath`).
- Revoke UI + label: `apps/web/spa/routes/user-settings.tsx`
  (`connected-app-<id>` fixture) + `apps/web/messages/en/app.json`
  (`user.apiKeys.connectedAppRevoke`).
- Device-approval sub-flow: `runCapabilityDeviceApproval` in
  `packages/test-harness/src/staging-e2e-synthetic`.
- Green run: runId `staging-e2e-synthetic`.

## Dead ends (do not re-walk)

- **CIMD (Client ID Metadata Document) was removed, not fixed.** The
  `cimd-authorization` leg had always self-skipped, so the SSRF-guarded resolver's
  live-fetch path had never run; when finally exercised it rejected a valid served
  doc with `unauthorized_client`. CIMD is an emerging URL-identity variant with no
  known clients; DCR is unaffected. The deletion is split across two commits: the
  contract/convex/harness removal is `3796a562`, and the api-side files (the CIMD
  route + `resolveClientMetadata` resolver) were swept into the concurrently
  landing campaign commit `66d88149` mid-removal (a shared-working-tree race) —
  so `git log --oneline 66d88149` reads "campaigns" but its diff contains the api
  CIMD deletions. See memory `cimd-selfhosted-mcp-oauth`. Do not reintroduce it.
- **The `apps/api/src/index.test.ts` reuse-revocation 403/401 unit failure is not a
  product bug.** It asserts a *revoked* access token → browser-only
  `/v1/user/oauth-grants` returns `403`, but a revoked token correctly returns
  `401` (auth rejects it before the credential-kind gate). It is off the e2e
  `refresh-family` path (confirmed: that leg passed unchanged). If ever fixed, it's
  a one-line unit expectation, unrelated to this journey.
