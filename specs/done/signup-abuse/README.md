# Signup abuse

One device registering many mailboxes to farm the trial is a proven fraud vector
on chat-app, which duet replaces. Duet gates cold signups on device identity and
email provenance. Blocked domains and excessive controlled-domain volume
refuse workspace bootstrap. Other objections withhold the trial: the workspace
is born paused behind the subscribe wall, and payment restores ordinary access.

Implementation lives in `packages/backend/convex/domains/signupAbuse/`. Start at
`actions.ts` — the only browser-authenticated entry to signup and bootstrap.
(`domains/workspaces/birth.ts:createWorkspace` also creates workspaces, but it is
internal-key gated behind `POST /v1/workspaces`, not reachable from a session.)

## Why it works this way

**Evidence determines the consequence.** Known blocked domains and domain
velocity refuse self-serve bootstrap to avoid accumulating spam workspaces.
Other objections withhold the trial so a false positive can pay and continue.
A paused workspace never provisions a VM, so withholding bounds the cost while
preserving that recovery path.

**The gate sits at `bootstrap`, not at the auth routes.** chat-app hangs its
checks on two Next.js route handlers, one per provider. Duet's Google sign-in
goes browser → Convex directly with no server route to hang anything on, but duet
has something chat-app lacks: a single post-auth choke point that both providers
pass through *before* the workspace, the grant and the VM exist. One gate, both
providers, no OAuth state plumbing.

**Paid email has an earlier gate.** Blocked domains are rejected before any
auth persistence: the API sign-in action returns its normal enumeration-safe
response without writing a request row, and the shared auth user callback rejects
browser and direct Convex email starts before Convex Auth inserts the user,
account, or verification code. The provider callback in
`packages/backend/convex/auth.ts` remains a defense-in-depth mail check for any
code that predates the block. The post-auth bootstrap refusal remains necessary
for other identity providers and codes issued before the domain was blocked.

**Nothing forgeable crosses the seam.** `bootstrap` was a public mutation, so a
signed-in browser could call it from the devtools console; any verdict passed in
as an argument would have been trivially faked. The verdict is therefore computed
on the action side and the mutation is unreachable from a client.

**Two email-normalizing functions, deliberately.** `normalizeEmail`
(`domains/users/model.ts`) owns *login identity* and was left untouched;
`canonicalEmail` (`domains/users/signupIdentity.ts`) owns the *abuse and grant
key* and is the only one that strips `+tag` beyond Gmail. Widening the identity
function instead — the original plan — collapses the entire staging harness onto
one user, because every live journey signs up as a `+tag` alias of one shared
inbox.

**Fail open is a lever, not an oversight.** Unresolvable device evidence allows
the signup. Denying real users over a network hiccup costs more than the trials a
farmer saves by blocking the identification script, and `service.example.invalid` — a
first-party endpoint — exists to make that blocking harder. The four distinct
"couldn't check" reasons are recorded separately so a missing key stays
distinguishable from a user with an ad blocker; collapse them to a boolean and
the gate can sit silently disabled.

## Invariants

Break any of these and the gate degrades quietly rather than loudly.

1. **One consequence, reached from two deciders.** `decideSignup` (`policy.ts`)
   is pure and owns the device-evidence and email verdicts, returning
   `allow | no_grant`. The device mailbox limit is decided separately, inside
   `claimDeviceForUser` (`model.ts`), because it must count and stamp in one
   transaction and therefore cannot be pure. Both converge on the single
   `withholdTrial` (`model.ts`) — that convergence, not a single decider, is what
   keeps "what happens when we object" from having two answers.
2. **The device count is over distinct canonical mailboxes, never user rows.**
   `+tag` aliases are separate users sharing one canonical form and one grant
   key, so counting rows would withhold on someone's third alias of a single
   inbox — not the vector. `signup-abuse-device.test.ts` pins exactly this false
   positive.
3. **Counting and withholding share one transaction** (`claimDeviceForUser` in
   `model.ts`). Split them and two simultaneous third signups both read "two" and
   both keep a trial.
4. **The withhold marker lives on the user**, and
   `grantTrialCreditsForAccount` (`domains/credits/grants.ts`) honours it. The
   trial is granted from **two** call sites — workspace birth and VM registration
   — so a guard on either caller alone leaks.
5. **The device binding is fixed at first signup and never migrates.** Re-binding
   on a later sign-in would let a farmer reset the count from a clean browser.
6. **One classification decides exemption.** `classifySignupIdentity` gates
   verification, the email rules *and* the count together. Per-rule exemptions
   drift apart.
7. **Only verified visitors are counted.** The count reads the visitor id
   Fingerprint resolved, never the one the client claimed, or a farmer picks a
   fresh id per signup and never collides.

## The exemption is load-bearing

Fingerprint classifies duet's own headless Playwright browser as
`botd === 'bad'` — measured by the live journey, not assumed.

A test identity must match a configured inbox in `DUET_SIGNUP_TEST_IDENTITIES`
**and** carry the `staging-e2e-synthetic` marker that every live run already puts in its
address (the same marker `convex/testing/stagingE2e.ts` uses). Narrow or remove
that exemption and every browser journey in `packages/test-harness` starts losing
its trial, being born paused, and never getting a VM.

Requiring both conditions is also what makes the feature testable at all: one
mailbox yields `inbox+staging-e2e-synthetic@` (waved through) and `inbox+abuse-x@`
(withheld). The AgentMail key is not permitted to create a second inbox, and
exempting the whole inbox would leave no deliverable address the gate is willing
to act on.

## Pointers

| Concern | Code |
| --- | --- |
| Browser signup entry, orchestration | `domains/signupAbuse/actions.ts` |
| The verdict | `domains/signupAbuse/policy.ts` |
| Outside facts, injected `fetch` | `domains/signupAbuse/evidence.ts` |
| Device claim, withhold, count | `domains/signupAbuse/model.ts` |
| Vendored blocklists + MX backends | `domains/signupAbuse/blockedEmailDomains.ts` |
| Identity, exemption, grant key | `domains/users/signupIdentity.ts` |
| Browser identification | `apps/web/app/sign-in/device-identification-provider.tsx` |
| Verdict + evidence tests | `packages/backend/src/signup-abuse-policy.test.ts` |
| Device, ledger, grant-site tests | `packages/backend/src/signup-abuse-device.test.ts` |
| Live journey | `packages/test-harness/src/staging-e2e-synthetic` |

Operational: `FINGERPRINT_API_KEY` (Convex), `NEXT_PUBLIC_FINGERPRINT_API_KEY`
(Vercel `web`), `DUET_SIGNUP_TEST_IDENTITIES` (Convex, staging).
`DUET_SIGNUP_MX_LOOKUP=off` disables the gate's only outbound DNS call;
`signupMxLookupEnabled` in `convex/config.ts` also switches it off in any
test-auth environment, because fixtures sign up as `@example.com`, which
publishes a Null MX and is correctly treated as a non-functional mail domain.

## Dead ends

**The Fingerprint server SDK.** `@fingerprintjs/fingerprintjs-pro-server-api`
top-level-imports `crypto`, `zlib`, `util` and `buffer`, forcing Convex's Node
runtime on its own, and stores the bare global `fetch` on a class field — the
shape that has already caused a production bug in this repo. A probe proved plain
`fetch` reaches both the Fingerprint REST API and DNS-over-HTTPS from the default
isolate, so the gate is a short typed fetch instead of a 726-line dependency, and
`node:dns` (chat-app's MX path) was replaced by DoH for the same reason.

**Widening `normalizeEmail`.** See above — collapses the staging harness onto one
user.

**A forged `requestId` as the journey's withhold trigger.** An invented request
id 404s at Fingerprint and *fails open*, so the refusal it produced never came
from the gate. Caught only because the journey asserted a ledger row and found
none; an assertion of "not 204" would have gone green on the wrong thing.

**A second AgentMail inbox.** The staging key returns `Forbidden` on inbox
creation. The marker-based exemption removed the need.

**Fingerprint's velocity product and its soft signal tier** (suspect-score bands,
VPN, incognito, virtual machine, tampering, devtools). Every one is a tuned
threshold, and chat-app's thresholds were tuned against chat-app's traffic — it
has never enforced them. Velocity is also capped at a 24-hour window, where
counting our own rows has unlimited lookback.

**`generic-email-providers.ts`** (4783 lines). chat-app uses it for lead-gen and
organization-domain logic only; it is absent from chat-app's own auth path.

**A shared browser context across journey legs.** After the first leg signs in,
the second never sees the sign-in form — the client notices the existing session
and posts straight to the session endpoint. A signup test needs a cold context
per identity.

## Decisions the user owns

Two live product calls, both confirmed:

- `outlook.com` and `hotmail.com` are in the ported `SPAM_EMAIL_DOMAINS`, so
  those users get a paused workspace rather than a trial. The entries carry their
  original chat-app annotations and dates.
- `hasEmailSubdomain` (e.g. `user@example.invalid`) withholds too, where chat-app
  only paused such orgs behind billing. Under the collapsed design these are the
  same outcome.

The full decision record — every choice made where the plan was silent, with its
scenario and verdict — is in [`choices.md`](choices.md). The pre-spec quadrant
walk that produced the plan is in [`MAP.md`](MAP.md); its build-plan and
confirm-before-coding sections are superseded by this document.
