# Agent sign-in and subscribe

An agent with no browser signs a human into Duet — registering them if they are
new — and receives an API key scoped to one of their workspaces. Two public
endpoints and one code the human reads out of their email. `service.example.invalid/llms.txt`
teaches a stranger's agent to drive it without fetching anything else.

```
POST /v1/auth/email/start   { email }                    → 202 { request_id, expires_in }
POST /v1/auth/email/verify  { request_id, code, … }      → 200 { access_token, token_type, prefix, scopes, workspace, created }
```

Entry points: `apps/api/src/routes/auth.ts` (HTTP shape only),
`packages/backend/convex/domains/authRequests/` (every decision),
`packages/contract/src/auth/index.ts` (the wire and the workspace rule),
`apps/lander/lib/llms/index-text.ts` (what an agent is told).

---

## Why it works this way

**The product was already API-first everywhere except getting in.** Exactly
three endpoints were public — feedback and the two halves of the device flow —
and device approval ends at `service.example.invalid/device`, which redirects to a sign-in
page. An agent could do everything except start.

**The mechanism already existed; it was just unsupported.** `auth:signIn`,
`signupAbuse:signUp`, and `mintBrowserSession` are public functions on the
production Convex deployment, and the test harness has always driven them
headlessly. This feature is a supported public face over a rail that ran, not a
new authentication system — which is why it is mostly seams and copy.

**An emailed code is not weaker than device approval; it is the same authority
by a different gesture.** `SECURITY.md` already names email magic-link a
first-class login, so possession of the mailbox has always been account
authority here. What device approval adds is a screen that *names the scopes*.
This rail has no such screen, which is why the email states the grant in words
and why `install-copy.ts` no longer forbids the flow.

**Scope narrowing was removed rather than added.** An early design let the agent
request a subset of capabilities. On a rail where the requester picks its own
limit and the human never sees a list, self-limitation is decoration: the same
agent can re-run `start` and ask for everything. Narrowing only means something
where a human reads the list before approving — the device screen and the OAuth
consent screen — so the parameter is gone and a code-issued key carries the
same ceiling a device grant does.

**Billing opened by exactly three endpoints.** `apps/api/src/shared.ts` states an
invariant: the user rail answers to a person in a product tab, not a program.
An agent that hits `402 subscription_required` must be able to hand its human a
real checkout link, so `requireBillingActor` admits `user` keys to reading
entitlement and starting or changing a subscription. Everything that takes a
payment instrument or hands out a credential stays tab-only, and the comment
there says which and why.

---

## Invariants

Break one of these and the failure is quiet.

1. **`start` answers byte-identically for a known and an unknown address.** It is
   unauthenticated, so any difference — body, status, or latency — is an account
   oracle. `expires_in` is the published constant, never a remainder computed
   from a stored row; the request id is minted unconditionally; no user is
   looked up. Pinned in `apps/api/src/routes/auth.test.ts`.

2. **`verify` proves the code before it says anything about the account.**
   Resolving the workspace first hands anyone who knows an address a `409`
   listing every workspace that person belongs to, and a `403`-vs-`400`
   membership oracle — both free, because neither branch spends an attempt. The
   ladder's rule is that ambiguity is settled before *redemption*, and it still
   is: redemption is the `auth:signIn` call that destroys the code. Comparing a
   hash destroys nothing. Pinned by *"a wrong code learns nothing about the
   account it names"* in `packages/backend/src/auth-requests.test.ts`.

3. **The code and the sign-in button never appear in the same email.** They
   redeem the same single-use token — `verifyCodeAndSignIn` deletes a correct
   code on success — so offering both gives the reader two paths that destroy
   each other. `EmailShell`'s action is optional for exactly this reason.

4. **The magic-link intent nonce and the verification code have separate
   grammars.** They were one `/^[a-f0-9]{32}$/`. Fusing them again breaks every
   browser magic-link sign-in, and no test catches it unless the callback's
   fixtures use a code-shaped code. Three tests in
   `apps/web/src/auth/magic-link-callback.test.ts` hold the split.

5. **`DUET_TEST_AUTH_EMAIL` has one reader and the reader is its guard.** The
   flag pins the sign-in code to a constant *and* suppresses the emails that
   would warn anyone. `testAuthEmailEnabled` in `packages/backend/convex/config.ts`
   refuses unless the deployment reports a loopback address, and fails closed
   when it cannot tell. It reads the flag rather than asserting at module scope,
   because `config.ts` is imported by `convex/auth.ts` and the deploy rail runs
   `convex deploy`.

6. **`funding` describes the workspace's payer, never the reader.** A member of a
   workspace someone else funds must see `active: true`; reporting the
   signed-in user's own plan would have agents asking people to pay for
   something already paid for. One derivation, `fundingOf` in
   `packages/backend/convex/domains/credits/subscriptions.ts`.

7. **`AppApiScopesSchema` stays `admin`-free.** `LOGIN_CAPABILITIES` — the
   rival *vocabulary*, which capped what an OAuth or MCP client could even ask
   for — collapsed into `CAPABILITIES`, and that is safe because `roleCanGrant`
   is re-checked on every authentication. App keys are membership-free, so that
   check never runs on them, which is why their declaration grammar keeps its
   own ceiling. (`VIEWER_CAPABILITIES`, `EDITOR_CAPABILITIES`,
   `SYNC_DEVICE_CAPABILITIES` and `ELEVATED_APP_CAPABILITIES` are untouched:
   they answer *which role or credential may hold what*, not *what vocabulary
   exists*.)

8. **The lander states no number of its own.** Prices, workspace limits, and the
   code TTL all reach copy through `@repo/contract`. The email states its
   duration from a prop for the same reason: `packages/email` imports no TTL.

---

## Dead ends

- **A static Stripe Payment Link** instead of a Checkout Session. Nothing binds
  it to a workspace or payer, so the webhook could only match on the email
  Stripe collects.
- **A `browser_session` token** returned beside the API key, so the agent could
  reach the user rail without relaxing anything. It puts two credentials in
  one response and makes subscription access depend on a separate credential's
  expiry.
- **Capping code-issued keys at `LOGIN_CAPABILITIES`.** That set is the
  third-party OAuth grant; it cannot create an agent or publish an app, which is
  most of what "use the product without the UI" means. Following that thread is
  what deleted the constant entirely.
- **A separate OTP provider**, to keep the browser link at 128 bits while the
  agent got a short code. Unnecessary once the code matched the device flow's
  existing ~40 bits.
- **A 6-digit code.** `verifyCodeAndSignIn` skips its own rate limiter on a
  code-only call (it keys on `params.email`, which such a call does not send),
  so 10⁶ against an unlimited guesser is account takeover.
- **Making `assertEmailedSignInLink` unconditional.** A closeout review argued
  it guards the one rail whose email has no link — true — but the shared fixture
  helper (`packages/test-harness/src/convex-testing.ts`) drives `auth:signIn`
  with no `redirectTo`, so the library falls back to a bare `SITE_URL` the guard
  rejects. Making it unconditional was tried, and observed to redden 21 of the
  22 tests in `packages/backend/src/auth-workspaces.test.ts` — not all for the
  same reason; several cascade off a failed shared sign-in rather than tripping
  the guard themselves. The browser
  rail is guarded at its source instead, where `createMagicLinkIntent`
  unconditionally builds the callback path — there is no branch that omits it.
- **Filtering the billing roster** by the calling key's workspace. Considered
  because a `user` key is single-workspace; rejected because every workspace
  listed is one the human pays for.

---

## Divergences from the plan

- **The verify work split in two** during the build — the Convex choreography
  and the HTTP route. As one unit it carried the redemption ordering, a new
  Convex hop, a rate-limit extension and the wire surface: four verdicts on the
  riskiest piece of the feature.
- **`codeHash` cannot be required**, as the plan's DDL had it. The code does not
  exist when the row is written; Convex Auth mints it inside `auth:signIn` and
  reveals it once, to the send callback. A `bindCode` mutation fills it.
- **`name` cannot ride on `start`.** Convex Auth discards it, which is also why
  every magic-link signup before this feature had no name at all.
- **A second `start` supersedes the first** rather than being refused: the
  library deletes the earlier code regardless, so refusing would strand a record
  *and* break `start`'s byte-identical answer.
- **`z.email().trim()` does not trim.** A format check runs before checks
  appended to it. The plan specified that spelling.

---

## Visual provenance

Two committed baselines are the standard this was held to, both regenerated in
this work and both reviewed by an unprimed critic before acceptance:

- `apps/web/tests/visual/__screenshots__/{desktop,mobile}/playground.spec.ts/email-auth-magic-link.png`
  — the sign-in email. The critique moved five things: the revocation sentence
  had the weakest contrast on the page while the sentence granting account-wide
  power sat at near-black; 3px letter-spacing made the hyphen in `RNP4-4Y37`
  read as a space; no expiry was stated; the button label was
  indistinguishable from the subject; and the footer never said *do not share
  this code*.
- `apps/lander/tests/visual/__screenshots__/{desktop,mobile}/public-pages.spec.ts/public-install.png`
  — the install page's two doors. Six critique rounds all answered *not equal*;
  what remains is inherent, and `duetfs login --email` is the only thing that
  collapses it.

Design artifacts from planning, kept because they carry the wire as designed:

- Sample sheet (the literal bytes, per-block approved):
  <https://claude.ai/code/artifact/245b4e98-6ada-471a-bd45-575dee32f419>
- The four-quadrant map the plan came from:
  <https://claude.ai/code/artifact/9d6d7118-bcf3-4093-aac2-43fe82b2428e>

---

## What is not done

- **The happy-path live probe.** Reading a code out of a real inbox is the one
  step nobody can automate — by design, and the same property that makes the
  rail safe. There is no registered journey in
  `packages/test-harness/src/staging-e2e-synthetic`; that was a recorded
  choice, not an oversight.

  What *was* probed by hand against `service.example.invalid` on 2026-08-17, with
  no email sent:

  | Probe | Result |
  |---|---|
  | `POST /v1/auth/email/nonexistent` | `401` — the middleware still gates everything off the bypass list |
  | `POST /v1/auth/email/start`, malformed body | `400` — route deployed, bypass wired, schema rejects |
  | `POST /v1/auth/email/verify`, unknown request id | `410 {"error":"expired"}` |

  The third is the whole chain: HTTP → rate limit → parse → the Convex action →
  a domain outcome → the status mapping. It is a transcript, not an artifact —
  nothing in the repo re-runs it.
- **`duetfs login --email`.** Until it exists, the email door is several times
  the height of the device door on `/install`.
- **MCP tool modules** for `apps`, `publish`, `share`, `members`. Those
  capabilities are now *reachable* through an OAuth grant; MCP still cannot
  exercise them.
- ~~Whether `/sign-in?code=…` completes for a human without the intent
  cookie.~~ **Answered by reading the code, not by this work.**
  `apps/web/proxy.ts:36` intercepts that URL, and `rejectUnprovenAuthCode`
  (`:79`) strips `code` and `intent`, sets `authError=invalid-link`, and 307s.

  **Bounced unless that browser holds an OAuth verifier cookie.**
  `resolveAuthCodeProof` (`apps/web/src/auth/auth-code-proof.ts:26-28`) tries the
  intent match first and falls through to `'oauth'` whenever a verifier cookie
  exists — so a human who began a Google sign-in in the same browser reaches the
  exchange without an intent match, and nothing on that path checks the code
  against the intent grammar. Worth knowing before anyone leans on that bounce
  as a boundary.

  Either way the emailed button was useless to an agent-started human, so
  dropping it was right for a reason nobody had at the time. This was carried as
  an open unknown through the whole build and was settled in one file the whole
  time.

## Where the rest lives

- [choices.md](choices.md) — every decision made without the user, re-audited
  against shipped code. Opens with the ones still worth a second opinion.
- [MAP.md](MAP.md) — decision provenance: the quadrant walk that preceded the
  build, what each decision cost, and the alternatives weighed at the time.
