# Choices ledger — device-auth (consolidated at close)

Decisions the build made where the spec was silent, re-audited against the
final shipped code. Grouped by confidence, least-certain first. Gate results
and per-pass narration have been dropped; this is choices only.

## Needs your eye

1. **First-party audience over the spec's token-passthrough guidance.** MCP
   forwards the caller's bearer to `ctl`/`gateway` instead of exchanging for a
   separate upstream token. Sound only while those three stay one trust
   domain — SECURITY.md documents the divergence explicitly. If a future MCP
   tool reaches a genuinely third-party service, this must become a token
   exchange.
2. **The distinct MCP resource origin remains fail-closed.** A deployed MCP
   service must be told its own canonical resource identity; unlike the shared
   API origin, that value cannot be inferred from another service URL. This
   caused a prod outage when phase 2 shipped before the secret, but weakening
   the identity check would make bearer [REDACTED] environment-dependent.
4. **Committed MCP-OAuth journey needs a foundation swap.** It injects a
   `duet_session` cookie, which the consent page's Convex Auth guard rejects,
   so it can't pass as-is. Phase-2 was verified live via a magic-link probe
   instead. The journey should be rebuilt on a magic-link AgentMail identity
   (like `runDeviceApproval`). Left as a named follow-up rather than a rushed
   mid-run rewrite.

## Sound, worth knowing

3. **The API origin and grant inventory now have bounded, single owners.**
   API, MCP, and other API clients consume `DUET_API_URL`, so protected resource
   metadata cannot advertise a different issuer from the API origin it calls.
   OAuth grant inventory crosses Convex in cursor pages; the API drains those
   pages behind the existing response shape, keeping database reads bounded
   without making the settings UI own pagination.
5. **Redirect-URI floor is one shared schema.** `OAuthRedirectUriSchema`
   (HTTPS or HTTP-loopback; no executable/opaque schemes, credentials, or
   fragments) gates registration, CIMD, authorize, and token — closing a
   `javascript:`-redirect XSS sink the review found. Matches OAuth 2.1 / MCP.
6. **Device approval has two explicit response variants.** Unresolved
   capability rows carry capabilities and eligible workspaces; resolved rows
   carry materialized `ws:` scopes and may name the bound workspace. An
   approved capability row therefore crosses the resolved branch without
   changing the mint path. The shared schema models these as a real union
   instead of optional fields plus an after-the-fact XOR check.
7. **`pollDeviceCode`'s return gained `workspace {slug,name}`; its mint/scope
   logic did not change.** "Mint path untouched" was read as logic, not return
   shape — it owns the approved-row read, so a route-side lookup would split
   ownership. Sync grants omit `workspace`.
8. **whoami emits `credential {kind, audience?}` for every kind, additively,
   through one projection owner** (`apps/api/src/whoami.ts`). MCP reads it to
   enforce OAuth audience; nothing MCP does reads Convex or validates hashes.
9. **Grace re-rotation, not derived successors.** Immediate-predecessor reuse
   within grace re-rotates (no self-nuke on flakes); ancestors / post-grace
   revoke the family. A discarded same-generation successor is invalid without
   harming the live family.
10. **Eligibility is all-or-nothing and single-owner.**
    `grantableWorkspacesForCapabilities` admits a workspace only if the actor's
    role grants *every* requested capability; approval revalidates it so a
    stale UI selection can't widen access. Ineligible workspaces are hidden,
    not disabled. Denied capability responses omit `workspaces` (an empty list
    would falsely read as "no eligible workspace").
11. **`workspaceSlug`-only-on-approve enforced solely in the domain**, mapped
    to 400 in the route's error table — no duplicate route-side check. Unknown
    vs ineligible slug both map to 403 (no workspace-existence oracle).
12. **No Inspect button; the device page auto-inspects** a complete code once
    per distinct value (ref-guarded effect; a failed lookup isn't retried until
    the code changes). User decision, supersedes the mock's button.
13. **Consent security-UX from critique triage:** long workspace names truncate
    on the approve button; a localhost redirect de-nudges Approve to an outline
    peer of Deny and strengthens the warning. Both from unprimed critiques.
14. **The grants card persists its authorized `redirectHost`** at exchange
    (from the authorization request's exact redirect), truthful for opaque DCR
    client ids; revoked rows are dimmed with a REVOKED pill. Captured as an
    element screenshot (the card sits in a nested-scroll surface a full-page
    shot clips).
15. **Reused existing owners rather than inventing parallels:**
    `APP_API_CAPABILITIES` for "enum minus admin"; `WorkspaceRoleSchema` for
    the role vocabulary; `AppApiScopesSchema` for capability dedup/sort; the
    pre-auth rate-limit rail shared between device and OAuth endpoints (distinct
    buckets); RFC 9728 `protected_resources` instead of a nonstandard boolean.
16. **Agent 0.3.3 released by tag; monorepo consumers share the root catalog
    pin.** API, gateway, contract, and test-harness no longer repeat independent
    dependency versions; the API rollout default reads the installed agent package's
    version, so rollout and runtime consumers cannot drift.
    Prod-first ship order was
    waived by the user ("no one is using duet-agent, we're still on staging");
    legacy dead-flag tests were dropped (no install base to protect). CLI
    capability list duplicated agent-side by design (cross-repo import for six
    strings rejected).
17. **Full `e2e:staging` replaced by targeted journeys** for both phases (user
    call); the committed capability + MCP-OAuth journeys run via
    `--journey <name>`.

## Environmental / process notes (not product decisions)

- The convexDev fixture self-tests and a couple of Convex-harness suites fail
  under a sandbox that can't bind `192.0.2.1`; a non-workspace Convex fixture
  needs a committed `node_modules` symlink to resolve `convex/server`.
- `bun`'s `toMatchObject` mutates the received object (asymmetric matchers
  overwrite matched fields) — capture values before asserting.
- After a subtractive UI change or an invalid Tailwind class (`opacity-55`
  isn't in the default scale), a green visual check can be a stale-build
  false-pass; force a clean rebuild and confirm the baseline PNG changed.
