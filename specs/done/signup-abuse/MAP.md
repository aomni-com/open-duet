# Signup abuse unknowns map

Output of the pre-spec quadrant walk (2026-08-06). Duet replaces chat-app, and
chat-app takes a lot of real fraud — so **chat-app's implementation is the
baseline**, and every deviation below is deliberate and justified, not a
simplification of convenience.

The user's named vector: **one device registering many emails to farm the free
trial.** Everything here serves that first.

## Known knowns

- Duet auth is Convex Auth (`@convex-dev/auth`) with two providers, Email magic
  link and Google — not chat-app's WorkOS (`packages/backend/convex/auth.ts:31-46`).
- Google sign-in goes **browser → Convex directly** (`apps/web/app/sign-in/sign-in-client.tsx:73`).
  There is no Next.js route to hang a gate on, so chat-app's two-route gate
  (`/auth/magic-link/create` + `/auth/sso/google`) has no duet equivalent.
- `bootstrap` is the single post-auth choke point both providers pass through,
  and it runs before workspace, grant, and VM
  (`packages/backend/convex/domains/invitations/model.ts:55`).
- The trial is $5 (`DEFAULT_TRIAL_GRANT_MICRO_USD`, `packages/contract/src/ledger/index.ts:6`)
  over 7 days (`TRIAL_WINDOW_MS`), granted at workspace birth
  (`domains/workspaces/birth.ts:162`).
- The grant is already globally idempotent on canonical email:
  `signup_grant:canonical:${email}` with `idempotencyScope: 'global'`
  (`domains/credits/grants.ts:27,31`).
- `normalizeEmail` already folds `googlemail.com`, strips gmail dots, and strips
  `+tag` **for gmail only** (`domains/users/model.ts:106-117`). It runs at auth
  ingestion (`model.ts:35`), so `users.email` is stored canonical — gmail-dot
  farming is already closed today.
- Every signup mints a workspace **and** schedules a real exe.dev VM
  (`domains/invitations/model.ts:87`). Fraud costs compute, not just credits.
- Duet has no rate limiting on signup, no disposable-domain blocklist, and no
  `@fingerprintjs` dependency.
- The Fingerprint Pro account is shared with chat-app. `service.example.invalid` and
  `service.example.invalid` are both Active custom subdomains; chat-app uses
  `service.example.invalid` (`chat-app/apps/web/app/sign-in-page-client.tsx:126`).
- `servicingStatus: 'active' | 'paused' | 'banned'` already exists on workspaces
  (`schema.ts:267`), and `'use node'` actions are established
  (`domains/workspaces/vmAttach.ts:1`).

## Decisions

Every one closed in front of the user. None are open.

| # | Decision | Why | Closed by |
| --- | --- | --- | --- |
| P1 | Simplicity is a constraint | Prune anything that tunes a policy rather than enforces one | user |
| P2 | Fraud-user UX is a non-goal | No recourse flow, no appeal, no designed dead end | user |
| D1 | Gate at `bootstrap`, not the auth routes | One choke point for both providers, ahead of workspace + $5 + VM | user |
| D2 | Reuse `service.example.invalid` | Already Active, already on `service.example.invalid`, matches chat-app | user |
| D3 | `bootstrap` → `internalMutation` behind one public verifying action | It is public today; a caller-supplied verdict is forgeable from the browser console | territory + user |
| D4 | Duet counts distinct users per `visitorId`; Fingerprint only supplies the id | Simpler on every axis, unlimited lookback, and the only option that covers the Google path | user |
| D5 | `FINGERPRINT_API_KEY` → Convex; `NEXT_PUBLIC_FINGERPRINT_API_KEY` → Vercel `web` | Follows from D3 — verification runs in a Convex action | territory |
| D6 | ~~One mailbox = one account, `+tag` stripped in `normalizeEmail`~~ **REVERSED — see D21** | — | superseded |
| D21 | `normalizeEmail` is unchanged. A **separate** `canonicalEmail` strips `+tag` on all domains and is used only by the grant key and the device count | chat-app's two-function split turns out to be load-bearing: widening identity canonicalization collapses the entire staging harness onto one identity (F8) | user |
| D7 | Dot-stripping stays gmail/googlemail only | Other providers treat dots as significant; widening merges real strangers | user |
| D8 | Full blocklist port: address domains + MX backends + subdomain heuristic | chat-app is the baseline and these exist because of real fraud | user |
| D9 | Fingerprint blocks limited to `botd === 'bad'` and forgery mismatch | Both binary; no threshold to tune. chat-app's soft tier has never enforced | user |
| D10 | Farming → withhold grant. Everything else → deny | A confirmed bot should not cost a VM | user |
| D11 | The **3rd** account on a device gets no grant (1–2 keep theirs) | Personal + work is plausible; three is farming | user |
| D12 | All three D8 mechanisms collapse into one hard signup gate, in one `'use node'` action | They are all spam users; one gate is simpler than three | user |
| D13 | Slim `signupSignals` ledger: `visitorId`, `email`, `decision`, `reason`, `_creationTime` | Keep only if it stays this small — if it grows, cut it | user |
| D14 | The ledger write is its own mutation, **committed before enforcement** | Convex mutations are transactions: throwing rolls back the insert, erasing exactly the denied rows you want to see | territory |
| D15 | E2e emails allowlisted; the staging journey **proves the gate fires** | Headless Chrome + non-allowlisted email → denied + a ledger row. Allowlisted → clean signup | user |
| D16 | Fail-open on missing/failed identification is documented as a tunable lever | An adblocker that kills identification is the cheapest bypass; that is the accepted price of not punishing real users | user |
| D17 | `signupSignals` is a table only — Convex dashboard is the UI | No admin screen | user |
| D18 | Real Fingerprint key on staging **and** prod | Staging must exercise the real gate | user |
| D19 | Done = the D15 journey green against live staging | Per AGENTS.md | user |
| D20 | Accept that a withheld grant means a **paused, then archived** workspace | Same consequence as chat-app's `autoPauseForAbuse`, reached with zero new code | user |

### Dropped from the chat-app port, deliberately

- `linked-id.ts` / client-side sha256 — D4 removes the need for a `linkedId`.
- `VelocitySignals` and the three velocity thresholds — superseded by D4, which
  has unlimited lookback where velocity has a 24h ceiling.
- The soft tier (suspect score bands, VPN, incognito, VM, tampering, devtools)
  and `ENFORCE_FINGERPRINT_SMART_SIGNALS` — never enforced in chat-app, and
  every threshold in it was tuned against chat-app traffic, not duet's.
- chat-app's split consequences for the blocklists (hard 403 for domains,
  auto-pause for subdomain/MX) — D12 makes all three deny.

## Confirm before coding — CLOSED

All four are now settled in the slices: the allowlist is a new env-driven
`DUET_SIGNUP_TEST_IDENTITIES` (slice 01) and explicitly **not**
`DUET_TEST_AUTH_EMAIL`, which is a boolean local-dev switch absent from both env
files; the ledger records only `deny` and `no_grant` (slice 03); the blocklist
keeps chat-app's manual `curl` refresh comment with no refresh service (slice
05); and the count is over `users` (slice 04). Kept for the record.

- Exact allowlist mechanism for D15. chat-app uses `STORE_REVIEW_EMAILS`
  (`chat-app/.../magic-link/create/route.ts:100`); duet has `DUET_TEST_AUTH_EMAIL`.
  Pick one and make it env-driven, not a code branch.
- Whether `signupSignals` records allowed signups too, or only non-`allow`
  verdicts. Recording everything makes the table the signup log; recording only
  denials keeps it small. D13's size budget favours denials-plus-farming.
- Refresh story for the 5.5k-line disposable-domain list. chat-app documents a
  `curl` regeneration command at the top of
  `packages/services/src/lib/blocked-email-domains.ts`; decide whether duet
  inherits it as a manual chore or lets the data go stale.
- Whether the D11 count is over `users` rows carrying the `visitorId`, or over
  `signupSignals` rows. Users is the smaller, truer set (see F5).

## Unknown knowns surfaced by repository inspection

- Duet needs **one** identification, at bootstrap time, on whichever device
  completes signup. chat-app had to identify before sending the magic link and
  smuggle state through OAuth (`chat-app/.../sso/google/route.ts:25-32`) purely
  because `linkedId` had to exist at identification time. D4 removes that
  constraint entirely. A link requested on desktop and opened on a phone
  correctly counts the phone. Do not "fix" this back to chat-app's shape.
- The blocked-user UX is free. `completeBrowserSession` already catches a
  bootstrap throw and returns `bootstrap_failed`
  (`apps/web/src/auth/complete-browser-session.ts:20-29`), and the sign-in
  client already renders a generic error for it (`sign-in-client.tsx:52-56`).
- chat-app's `hasEmailSubdomain` is the weakest of the three blocklist signals —
  its own comment calls it "a strong spam-signup signal", and chat-app only ever
  *paused* on it. D12 promotes it to a hard deny. Known and accepted; it means
  `user@example.invalid` gets no account.
- The Fingerprint workspace is shared with chat-app, so staging signups appear
  in the same dashboard as live chat-app users. Harmless under D4 (separate
  Convex deployments count separately), but the dashboard is not per-product.

## Landmines

### F1 — "Withhold the grant" is really "born paused" — decided (D20)

`desiredServicingStatus` (`domains/credits/subscriptions.ts:53-65`) returns
`'active'` only for a live subscription or a future `billing.trialExpiresAt`,
and `trialExpiresAt` is written only when the grant applies (`grants.ts:35-37`).
Birth computes servicing through it (`birth.ts:174-179`), and paused workspaces
are swept to `archived` with the VM decommissioned
(`domains/workspaces/provisioningCore.ts:165-171`).

So D10 protects VM spend with **no new code**, and lands on chat-app's
`autoPauseForAbuse` behaviour by construction. The cost is that a false positive
(third colleague on a shared office laptop) loses the product, not just the $5.
Accepted.

### F8 — The staging harness signs up as `+tag` aliases of one shared inbox — reversed D6 (D21)

`taggedInboxAddress` (`packages/test-harness/src/staging-e2e-synthetic:86-87`)
mints every per-run identity as `inbox+<runId>@…` on a single shared AgentMail
inbox, and `workspace-browser` is the shared fixture behind most journeys
(`staging-e2e-synthetic:98-140`).
`staging-e2e-synthetic:266` asserts the stored user email equals
that raw tagged address.

Widening identity canonicalization (old D6) collapses every journey onto one
user and throws at `mintImpersonationKey` via F2. Hence D21.

**The consequence D21 does not by itself solve:** widening only the *grant key*
still collapses every staging run onto one reference
(`domains/credits/grants.ts:27`, `idempotencyScope: 'global'`). Runs after the
first get no grant → no `trialExpiresAt` → `desiredServicingStatus` returns
`'paused'` → workspace born paused → swept to `archived` with its VM (F1's
chain). Ephemeral users are **not** servicing-exempt; `servicingExempt` is used
only by the official hub (`internalAdmin/officialHub.ts:113`) and the admin
toggle (`internalAdmin/model.ts:404`).

So the D15 test allowlist is **one concept with one owner** — a "this is a test
identity" exemption that must cover all three of: fingerprint verification, the
device farming count, and the canonical grant dedupe. Owned by the spec's gate
seam, not sprinkled at three call sites.

### F9 — Most journeys never reach the gate — shrinks D15's blast radius

The `workspace-browser` fixture mints the user **and workspace**
programmatically via `/v1/admin/login-as` → `mintImpersonationKey` *before*
driving the browser sign-in (`staging-e2e-synthetic:114-140`). By
then membership exists and `bootstrap` returns early
(`domains/invitations/model.ts:76-78`). Only `campaign-conversions` performs a
genuine cold browser signup.

Corollary for the design: the gate should verify **only when bootstrap would
actually create a workspace**, mirroring chat-app, which never checks existing
users or validated invitees (`chat-app/.../magic-link/create/route.ts:53`).

### F2 — A latent bug in the API signup path — no longer amplified by D6

`mintImpersonationKey` looks users up with `args.email.trim().toLowerCase()`
(`domains/apiKeys/api.ts:155`), **not** `normalizeEmail`. It creates via
`createOrLinkUserForAuth` (which normalizes), then re-queries with the raw email
(`api.ts:166-169`) and throws `'Failed to create impersonation user'` on the
miss. It bites gmail dots and gmail `+tags` only. D21 keeps it at that blast
radius rather than widening it to every domain, so this is now an optional
one-line hardening, not a required ride-along.

### F3 — The web boundary checker rejects the Fingerprint client — sharp edge

`apps/web/scripts/check-boundaries.ts:6-11` forbids network imports across
`app/`, `components/`, `spa/`, `src/`, with a four-file allowlist at line 29-35.
The Fingerprint SDK calls `service.example.invalid`, so the new client file fails the local
gate until it is added explicitly. That allowlist is duet stating which files may
talk to the network — the addition is intentional, not a workaround.

### F4 — A second bootstrap entry exists — sharp edge

`domains/apiKeys/api.ts:183` calls `bootstrapUser` directly behind
`requireApiInternalKey`, creating users, workspaces, VMs and grants with no
fingerprint. D3 does not break it (it calls the model function, not the public
mutation), and it is correctly ungated as trusted server-to-server. It is the one
door where "all signups pass the gate" is knowingly false, and it must stay
internal-key-gated. It is also why probe scripts do not need the D15 allowlist.

### F5 — Denied signups leave orphan user rows — sharp edge

`createOrLinkUserForAuth` runs during authentication (`auth.ts:50`), before
bootstrap, so a denial leaves a `users` row with no workspace. Harmless — orphans
never receive a `visitorId` patch and so never inflate the D11 count — but the
`users` table and `signupSignals` will not reconcile row-for-row.

### F6 — `bootstrapTokens` is a closed validator — sharp edge

`domains/invitations/mutations.ts:8-11` is a closed `v.object`. Any additive wire
field must be added there or the call 500s at runtime while types stay green.
This is a repeat offender in duet.

### F7 — Fail-open is the cheapest bypass — decided (D16)

A user who blocks the identification script gets the full grant and is counted
toward no device. Failing closed would deny real users on a network hiccup, so
fail-open stands; `service.example.invalid` exists to make blocking it harder. Document it at
the code site as a lever, not an accident.

## Build plan — SUPERSEDED

**Do not implement from this section.** It is the pre-spec sketch, kept for the
record. The real ladder is [`README.md`](README.md) and `slices/00`–`slices/07`,
which reorders this work behind two kill gates and corrects three things this
sketch got wrong: the device count is over distinct canonical **mailboxes**, not
user rows; the withhold marker lives on the **user** so both grant call sites are
covered; and `generic-email-providers.ts` is not ported at all.

Sorted by likelihood of tweaking — judgment first, mechanical work last.

**Judgment calls, settle these while building**

1. The D11 counting query and its exact semantics (see *Confirm before coding*).
2. The verdict enum and its consequences: `deny` (throw) vs `no-grant` vs
   `allow`. One enum, three outcomes, computed in the action.
3. D15's allowlist mechanism and the journey's assertions.

**The spine**

4. Secrets: add `FINGERPRINT_API_KEY` (`convex: true`) and
   `NEXT_PUBLIC_FINGERPRINT_API_KEY` (`vercel: ['web']`) to
   `scripts/secret-topology.mjs`, copy both values from
   `chat-app/apps/web/.env.local` into duet's `.env.staging` and
   `.env.production`, then `bun run secrets:push`.
5. `bootstrap` → `internalMutation`; new public `'use node'` action in front of
   it that verifies, records, and then bootstraps or throws (D3, D12, D14).
6. Port `verifyFingerprintBot` from `chat-app/packages/services/src/fingerprint/`,
   keeping only the hard-block tier and the fail-open posture (D9, D16).
7. `visitorId` on `users` + index; the distinct-user count (D4, D11).
8. Client identification on the sign-in page, plus the `check-boundaries.ts`
   allowlist entry (F3).

**Mechanical**

9. Widen `normalizeEmail` to strip `+tag` on all domains, and fix
   `mintImpersonationKey` to use it (D6, F2).
10. Copy `blocked-email-domains.ts`, `generic-email-providers.ts`, `email-mx.ts`
    across; wire all three into the one gate (D8, D12).
11. `signupSignals` table + its own mutation (D13, D14).
12. The staging journey, registered in
    `packages/test-harness/src/staging-e2e-synthetic` (D15, D19).
