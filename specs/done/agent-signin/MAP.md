# Agent sign-in and subscribe — quadrant map

Completed quadrant walk, 2026-08-17. **Nothing is OPEN.** Every decision below is
stated so a spec can carry it verbatim as a given.

> **This file is the decision provenance.** It records how each decision was
> reached and by whom, during the quadrant walk that preceded the build.
> [README.md](README.md) is the durable record of what shipped and what must
> stay true; [choices.md](choices.md) holds the decisions made during
> implementation, where this map was silent.

Rendered version (same content, with the build plan and a pre-drafted
implementation prompt): <https://claude.ai/code/artifact/9d6d7118-bcf3-4093-aac2-43fe82b2428e>

The literal bytes that ship — llms.txt sections, wire transcript, the email —
are in the sample sheet: <https://claude.ai/code/artifact/245b4e98-6ada-471a-bd45-575dee32f419>

## The ask

Two agent-first rails, both discoverable from `service.example.invalid/llms.txt` without a
browser: sign a human in (registering them if needed), and ask them to
subscribe. Plus: llms.txt must point at pricing.

---

## Quadrant 1 — known knowns

### The flow does not exist today

- `service.example.invalid/llms.txt` is 185 lines of marketing, generated from six page kinds in
  `apps/lander/lib/llms/index-text.ts:26`. Zero auth or API content.
- Exactly three endpoints are `scope: 'public'`: `/v1/feedback`,
  `/v1/device/code`, `/v1/device/token`. No sign-in, no registration.
- Device approval dead-ends in a browser: `service.example.invalid/device` →
  `307 /sign-in?returnTo=%2Fdevice` (probed live).
- The web magic-link route is Origin-locked (`magic-link-intent.ts:22`, probed
  live: 403) and bound to an HttpOnly cookie. The email carries a link, not a
  code (`packages/email/src/prepare.tsx:32`).

### But the mechanism already runs in production, undocumented

Every function in this chain is public on the prod Convex deployment;
`auth:signIn` answered an unauthenticated probe.

```
auth:signIn {provider:"email", params:{email}}   sends the email
auth:signIn {params:{code}}                      → {tokens:{token: JWT}}
signupAbuse/actions:signUp {}                    bootstraps user + workspace
apiKeys/mutations:mintBrowserSession {}          plain mutation, requireCurrentUserId
POST /v1/user/api-keys                           → a real scoped key
```

This is not "build an auth system" — it is "put a supported public face on a
rail that already runs".

### The subscribe half is further along than expected

- The 402 rail exists and already carries a URL: `apps/api/src/shared.ts:286-323`
  (`subscription_required`, `insufficient_credits`, `monthly_cap`,
  `subscription_inactive`, `payment_required`). API keys hit it too.
- Stripe checkout exists: `POST /v1/user/billing/subscription/checkout` →
  `{url}` (`routes/billing.ts:117`), payer- and workspace-bound.
- Every billing endpoint is `browser_session` by a **named invariant** at
  `shared.ts:115-120` — a stance, not an oversight.
- `service.example.invalid/pricing.md` already returns 200; llms.txt already lists `/pricing`.

### The payer model

- `birth.ts:152` sets `billingUserId = ownerUserId` — the creator pays.
- Reassignable only to a current live owner: `PUT /v1/ws/{slug}/billing-user`
  (`ws:admin`).
- Creation checks the creator's current memberships against their own plan;
  joining and payer changes remain unrestricted by plan capacity. See the
  [backend policy](../../../packages/backend/README.md).

### The role is the real ceiling

`roleCanGrant` (`apiKeys/model.ts:742`) is enforced at issue time (`:141`) *and*
re-checked on every authentication (`:188`, `:286`). Comment at `:445`: "the
use-time capability ceiling. Nothing a stored scope could say widens this."
Only an owner ever exercises `members` or `admin`.

`WorkspaceSummarySchema` (`workspaces/index.ts:78-93`) already carries
`servicingStatus`, `servicingStatusChangedAt`, `role`, `billingUserId`.

---

## Quadrant 2 — decision ledger

| # | Question | Decision | Closed by |
|---|---|---|---|
| 1 | Authority an emailed code buys | Full device-flow parity. `SECURITY.md:14` already makes email possession account authority. | user |
| 2 | What the subscription link is | A real Stripe Checkout Session from the existing `createSubscriptionCheckout` — payer- and workspace-bound, webhooks already attribute. | user |
| 3 | How a keyed agent reaches billing | Relax the subscription endpoints to `user`-kind keys. The `shared.ts:115` comment is **rewritten** in the same change, naming exactly what is program-reachable. | user |
| 3a | What the relaxed `GET /v1/user/billing` returns | **The full roster, unfiltered.** `UserBillingOverviewSchema.workspaces` lists every workspace the payer funds, and a `user` key is single-workspace by `SECURITY.md:56` — so this hands a scoped credential a cross-workspace view. Accepted: every workspace listed is one the human pays for, and the human authorized this agent. No credential-kind-dependent response shape. | user, 2026-08-17 |
| 4 | Whether 402 carries the checkout URL | No — 402 unchanged; the agent mints on demand. No Stripe call on a refusal path, no expiring URLs in error bodies, no two-schema widening. | user |
| 5 | What an API-registered account gets | The full 7-day trial, same as a browser signup. Abuse is met with rate limits on `start`, not a withheld trial. | user |
| 6 | How the agent reads entitlement | **Revised by F2.** Per-workspace `funding: {plan, active, trialEndsAt?}` on `WorkspaceSummary`, beside the `billingUserId` it describes — plus `GET /v1/user/billing` relaxed to `user` keys. | user + territory |
| 7 | Where agent-facing instruction lives | Inline in llms.txt; the link list repointed at the `.md` twins robots.txt allows. | user |
| 8 | What the human types back | `[A-Z2-9]{4}-[A-Z2-9]{4}` — byte-identical to `DeviceUserCodeSchema`. 34⁸ ≈ 40 bits, which survives the unrated verification path. | user |
| 9 | Naming the workspace | Optional `workspace_name`, threaded to `createWorkspaceRow`, which already accepts it. Absent means today's derivation; browser signups untouched. | user |
| 10 | The `start` / `verify` split | `start` proves the email and nothing else. `verify` owns the account and the workspace: `name`, `workspace_name`, `workspace_slug`. | user |
| 11 | Whether `name` can ride Convex Auth | No. `signIn.js:62` forwards only `{provider, accountId, email, phone, code, expirationTime}`; `createVerificationCode.js:29` builds `profile:{email}`. Our request record must carry it — which incidentally fixes a live defect: **every** magic-link signup today has no name. | territory |
| 12 | Create-another-workspace on `verify` | Not needed. `POST /v1/workspaces` is `scope: 'api_key'`. | territory |
| 13 | Scope parameter on `start` | None. On a rail with no scope picker, self-limitation by the holder is decoration, not a boundary. | user |
| 14 | Which capability list applies | `LOGIN_CAPABILITIES` **deleted**; `CAPABILITIES` is the one list for membership-backed credentials. `AppApiScopesSchema` stays `admin`-free as the app *declaration grammar* — app keys are membership-free (`SECURITY.md:77`) so `roleCanGrant` never caps them. The doc needs no rewrite. | user + territory |
| 15 | Which workspace the key binds to | `409 workspace_ambiguous` with the list; the code is **not consumed**. Agent asks, then calls `verify` again with `workspace_slug`. | user |
| 16 | Whether copy explains the payer split | Yes, in both llms.txt sections — a plan belongs to a person, not a workspace. `workspace_limit_reached` named as a second subscribe trigger. | user |
| 17 | Containing the test-auth switch (F1) | Boot assertion in `convex/config.ts` — the file that already gates `DUET_TEST_FAKE_STRIPE` — throwing if test-auth is set on a non-local deployment. | user |
| 18 | Revoking an agent's key (F4) | Web only, and llms.txt says so plainly. | user |

### API seams

```
POST /v1/auth/email/start                 scope: public
{ "email": "user@example.invalid",
  "client_name": "Claude Code"? }
→ 202 { "request_id": "req_…", "expires_in": 600 }
  Byte-identical whether or not the email has an account — it is
  unauthenticated, so any difference is an enumeration oracle.

POST /v1/auth/email/verify                scope: public
{ "request_id", "code",
  "name"?,            // new account only
  "workspace_name"?,  // new account only
  "workspace_slug"? } // returning user disambiguating
→ 200 { access_token, token_type, prefix, scopes, workspace, created }
→ 400 { "error": "invalid_code", "attempts_remaining": 4 }
→ 409 { "error": "workspace_ambiguous", "workspaces": [...] }   code preserved
→ 410 { "error": "expired" }
→ 429 { "error": "rate_limited", "retry_after": 60 }

Workspace resolution, in order:
  workspace_slug given → bind it (403 if not a member)
  no account yet       → create, named by workspace_name or derived
  exactly one          → bind it
  more than one        → 409

Relaxed to accept `user`-kind keys:
  GET  /v1/user/billing
  POST /v1/user/billing/subscription/checkout
  POST /v1/user/billing/subscription/plan

Still browser_session only (and the comment must say why):
  PUT  /v1/user/billing                 top-up config, spend caps
  POST /v1/user/billing/checkout        card setup, credit top-ups
  POST /v1/user/billing/portal          Stripe customer portal
       /v1/user/api-keys  *             key management
       /v1/device/{inspect,approve,deny}
```

### Four facts to confirm before coding

1. Whether Convex's environment exposes a reliable local-vs-cloud signal for the
   F1 boot assertion. `config.ts` has no such helper today.
2. Whether the `409 workspace_ambiguous` "code not consumed" state is
   expressible without a second Convex round trip.
3. Whether `PUBLIC_SUBSCRIPTION_PLANS` in `apps/lander/lib/public-site-config.ts`
   can expose `WORKSPACE_LIMIT_BY_PLAN` — already in `@repo/contract`.
4. Whether `apps/mcp/src/tools/` needs apps / publish / share / members tools
   before "MCP does everything the UI does" is true. Six modules exist today
   (agent, files, integrations, media, memory, train); none cover those.

---

## Quadrant 3 — unknown knowns

**Context probes.**

- *First consumer: a stranger's coding agent that found llms.txt.* llms.txt must
  stand alone with security framing spelled out — confirming inline-over-linking
  and ruling out "just point at service.example.invalid".
- *Key custody: the agent's choice; document only "never print it".* This is what
  made revocation load-bearing enough to surface as F4.
- *Done: unit and route tests plus one manual live probe.* A deliberate deviation
  from AGENTS.md's staging-journey rule — recorded as a choice, not an oversight.

**Taste extracted mid-walk.**

- "llms.txt shouldn't even mention capabilities" killed a parameter, then a whole
  constant (decisions 13, then 14).
- "Wouldn't it be moot if they aren't admin?" surfaced `roleCanGrant` as the true
  ceiling, shrinking a proposed `SECURITY.md` rewrite to nothing.
- "start handles login, verify handles the workspace" turned out to be the only
  shape that works, because Convex Auth discards `name` (decision 11).
- The payer/workspace split is a differentiator worth explaining to a stranger,
  not an implementation detail to hide.

---

## Quadrant 4 — landmines

Sweep covered the ~20 files this task touches across `apps/lander`, `apps/api`,
`apps/mcp`, `packages/contract`, `packages/backend/convex`, `packages/email`.

### F1 — `DUET_TEST_AUTH_EMAIL=1` becomes a two-call account takeover — DECIDED

`convex/auth.ts:40` makes the verification token a fixed constant;
`convex/services/email.ts:73` suppresses all outbound mail in the same mode.
`config.ts:164` only makes `DUET_TEST_FAKE_STRIPE` *require* test-auth — nothing
forbids test-auth on a real deployment.

Today, exploiting the fixed code means driving the browser flow with an intent
cookie you do not have. After this change it is two unauthenticated POSTs with a
known constant, against any account, and the victim is never emailed because the
same flag suppresses delivery. The task does not create the switch; it removes
every obstacle to using it.

**Decided:** boot assertion in `convex/config.ts`, throwing on a non-local
deployment. Protects the existing browser flow too.

### F2 — a top-level entitlement block would nag the wrong person — DECIDED

`WorkspaceSummarySchema` already carries `servicingStatus`, `role`,
`billingUserId`; whoami returns `workspaces: WorkspaceSummary[]`.

A top-level block reports the *signed-in user's* plan. A member of a workspace
someone else funds has none, so it reads `plan: null, active: false` while
everything works — and the agent asks for a subscription nobody needs. Also
ambiguous for a `browser_session` key spanning several workspaces.

**Decided:** revises decision 6 — per-workspace `funding`, beside
`billingUserId`. Only `plan` and `trialEndsAt` are new.

### F3 — the pre-auth rate limiter cannot express a per-email limit — SHARP EDGE

`routes/pre-auth-rate-limit.ts:42` keys on IP alone, falling back to the literal
`'global'` when proxy headers are untrusted and `'unknown'` when no IP header is
present. `start` sends mail; IP keying does not stop bombing one victim from many
IPs, and both fallbacks are wrong here. Decision 5 leaned on these limits
explicitly when granting the unconditional trial.

**Fix:** an explicit-identity variant so a second per-email bucket rides the same
Convex mutation. New enum members: `auth_email_start`, `auth_email_verify`.

### F4 — revocation is browser-only — DECIDED

`DELETE /v1/user/api-keys/{keyId}` is `scope: 'browser_session'`. The agent keeps
the key wherever it likes and the human's only way to cut it off is a web page.

**Decided:** web only. llms.txt states it plainly rather than implying the whole
product is browserless.

### F5 — Convex's code lives six times longer than ours — SHARP EDGE

The Email provider sets `maxAge: 60 * 60`; our request record expires in 600s.
After ours dies the Convex token stays valid another 50 minutes, and
`auth:signIn({params:{code}})` is publicly callable with the rate limiter
skipped — `verifyCodeAndSignIn.js:22` keys on `params.email ?? params.phone`,
both absent on a code-only call.

**Fix:** align `maxAge` to the same TTL.

### F6 — repointing at `.md` is the design, not a workaround — CLOSED BY TERRITORY

`apps/lander/app/robots.ts:29-35`: the `.md` twins are the deliberate crawler
surface for the whole corpus, "because... a twin carries no navigation, no CTA,
and no ad-campaign lander." Bare marketing pages are intentionally closed to AI
crawlers. Decision 7 is the design working as designed.

---

## Post-walk additions

Everything below was settled after the walk closed — during the `/write-spec`
interview and the three-draft synthesis. It belongs to the decision record, not
the ladder.

### Interview decisions (2026-08-17)

| # | Question | Decision |
|---|---|---|
| 19 | Parallel drafting | Three blind drafters with orthogonal biases — fewest-slices, risk-first, seam-quality — then synthesize rather than anoint one. All three ran on Opus; the skill's cross-vendor mix (a Codex draft) was skipped because Codex only runs when explicitly asked for. |
| 20 | MCP tool parity | **Out of scope.** The capability merge ships; the four missing tool modules (`apps`, `publish`, `share`, `members`) are their own feature. "MCP does everything the UI does" becomes true in two steps, not one. |
| 21 | Backward compatibility / migrations | **Neither. Hard cutover.** `funding` is additive; deleting `LOGIN_CAPABILITIES` widens rather than narrows, so existing OAuth grants stay valid; the billing relaxation only accepts a credential kind that was previously refused. |

### Rejected alternatives, and why they lost

Kept because a future reader will otherwise re-propose them.

- **Static Stripe Payment Links** instead of a Checkout Session. Nothing binds a
  static link to a workspace or user, so the webhook could only match on the
  email Stripe collects — a new and fragile attribution path, where
  `createSubscriptionCheckout` already binds payer and workspace correctly.
- **A `browser_session` token** returned alongside the API key, so the agent
  could reach the user rail without relaxing anything. It puts two credentials
  in one response and makes subscription access depend on a separate
  credential's expiry.
- **Capping code-issued keys at `LOGIN_CAPABILITIES`.** That set is the
  *third-party OAuth* grant, missing `agents`, `apps`, `publish`, `share`, and
  `members` — an agent capped at it cannot create an agent or publish an app,
  which is most of what "use the product fully without the UI" means. Following
  that thread is what produced decision 14.
- **A separate `email-otp` Convex Auth provider**, to keep the browser link at
  128 bits while the agent gets a short code. Unnecessary once the code matched
  `DeviceUserCodeSchema`'s ~40 bits, which the product already accepts for
  device codes.
- **A 6-digit numeric OTP.** 10⁶ against a verification path with no rate limit
  (`verifyCodeAndSignIn.js:22` keys on an absent `params.email`) is
  account takeover. Fixing the vendor's limiter would mean a vendored patch
  every upgrade could silently undo.
- **Filtering `GET /v1/user/billing` by the key's workspace** (see 3a). Rejected
  on the grounds that the data is the payer's own.
- **Allowing `/pricing` and `/install` to AI crawlers** rather than repointing
  llms.txt at `.md` twins. Closed by the territory: `robots.ts:29-35` makes the
  twins the deliberate crawler surface *because* they carry no navigation, CTA,
  or campaign lander.

### Live defects this feature inherits and fixes

Neither is caused by this work; both must be fixed for it to function.

1. **Every magic-link signup has no name.** Convex Auth discards the `name`
   param (`signIn.js:62`, `createVerificationCode.js:29`), so every workspace is
   `<localpart>'s Workspace`. Slice 08.
2. **Code verification is unrate-limited by construction.**
   `verifyCodeAndSignIn.js:22` keys its limiter on `params.email ?? params.phone`,
   both absent on a code-only call. Harmless at 128 bits; the reason decision 8
   chose 40 bits rather than six digits. Slices 00, 02, 10.

### Landmines the drafters found that this walk missed

Filed here so the map stays the honest record of what was known when.

| Finding | Owner |
|---|---|
| **`MAGIC_LINK_TOKEN_PATTERN` gates both the intent nonce and the verification code.** Changing the code format without splitting them breaks every browser magic-link sign-in, and no test catches it. The single most important finding of the exercise. | slice 00 |
| `install.md` does not exist. The artifact is `install-copy.ts` + `install.txt/route.ts` + `install/page.tsx`, and the page has committed visual baselines — so a "mechanical prose edit" pulls in the Docker visual gate. | slice 14 |
| A module-top-level throw in `convex/config.ts` could brick the deploy rail for every app, since `config.ts` is imported by `auth.ts` and the Vercel build runs `convex deploy`. | slice 01 |
| `auth:signIn({params:{code}})` is single-use, so the 409 decision must happen *before* redemption — which forces the request record to carry the email. | slices 06, 07, 10 |
| `normalizeCapabilities` clamps via `AppApiScopesSchema`, which strips `admin` but **not** `members`, so a naive deletion silently widens OAuth. | slice 12 |
| `runtime.convex` is a process-wide shared client; `setAuth` on it would bleed identity across concurrent requests on one Vercel instance. | slice 10 |
| The `WorkspaceSummary` projection is duplicated four times, all on the per-request auth path. | slice 03 |
| The test-auth fixture code is hard-coded in **45** files and does not match the new grammar. | slice 00 |
| `start` must pass an app-origin `redirectTo`, or the emailed link is one the web app cannot handle; a non-app origin throws. | slice 07 |
| A second `start` for one email deletes the first code, leaving two pending records and one live code. | slice 07 |
| `DEVELOPER_API_ENDPOINTS` filters on `.includes('browser_session')`, so an array scope containing it is still excluded. | slice 05 |
| `index-text.test.ts:17-25` goes red **by design** under the `.md` repoint; it encodes decision 7 and must be rewritten, not deleted. | slice 13 |
| `bootstrapUser` returns an existing membership without creating, so `workspace_name` is silently ignored for an account that already has a workspace. | slices 08, 13 |

### Where the three drafts agreed, and where they split

Agreement (firm ground): the `install.md` correction; the duplicated projection;
`endpoint-metadata.test.ts` forcing registry and route into one slice; no
`z.transform` in registered schemas; the `normalizeCapabilities` ambiguity
needing escalation; the `.md` link test breaking by design.

The split was slice count — 6, 16, and 16. The fewest-slices draft argued
correctly that a slice which cannot fail independently is not a slice, and its
merges of the email work and the llms.txt/install pair were adopted. The other
two won on the sign-in core: a pure resolution rule testable in milliseconds
pins the 409-before-redemption ordering by *where it is called*, which a merged
slice cannot do. The final ladder is 16, with five slices that change no
user-visible behavior — each one guarding a failure that is otherwise invisible
until production.
