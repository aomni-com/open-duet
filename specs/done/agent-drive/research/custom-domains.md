# Custom domains — integration note (live DNS/TLS deferred)

> Historical note: the table/backend described below are absent from the current
> code. The shipped [App domains rationale](../../app-domains/README.md) supersedes
> these implementation instructions.

Slice 14 ships the custom-domain **state machine** and its contract, with the real
Vercel DNS/TLS integration **stubbed behind an injectable `VercelDomainClient`**. The
live path needs a deployed edge and a Vercel project to verify against — wire it when
those exist (pairs with the slice-11 edge deploy + WS-limit checkpoint).

## What is built

- `attach → verifying → active → revoked` (plus `verification_failed` back to a
  retryable state). The transition function `transitionCustomDomain` is a pure,
  contract-owned reducer; `domains/customDomains/state.ts` wraps it around the
  injected client. Pinned by unit tests over both the reducer and the stubbed
  client.
- A `domains` table + attach/verify/serve/revoke mutations, audited.

## What the real integration must add (post-deploy)

Port the proven shape from v1 (`/Users/synthetic-user/dev/chat-app`
`customDomains/actions.ts` + `services/vercel.ts`), against the frozen
`VercelDomainClient` seam:

- `attachDomain(domain)` → Vercel add-domain API; returns the DNS verification
  record (TXT/CNAME) the user must set. Store the token.
- `checkVerification(domain)` → poll Vercel's verification endpoint; a
  **verification-poll cron** advances `verifying → active` when DNS + TLS
  provisioning complete, or records `verification_failed` with the reason.
- `removeDomain(domain)` → Vercel remove-domain on revoke.
- TLS is Vercel-managed once the domain verifies; the edge already routes by host,
  so an `active` custom domain resolves to the same app/publish origin descriptor.

## Invariants (hold in both stub and live)

- A domain only serves traffic in `active`. `verifying`/`failed`/`revoked` never
  route.
- Every state change is audited on the owning workspace.
- Custom domains attach to an app or a publish — they reuse that entity's
  origin/visibility resolution, not a parallel one.
