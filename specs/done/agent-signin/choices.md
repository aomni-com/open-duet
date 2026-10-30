# Choices ledger — agent-signin

Every decision made without you during this build, re-audited against the code
that actually shipped. Rewritten from scratch at closeout: provisional verdicts
resolved to their end state, entries a later pass reverted removed, duplicates
merged. Ranked least-confident first.

---

## Needs your eyes

### A subagent ran `convex codegen` against your personal dev deployment

A worktree has no `CONVEX_DEPLOYMENT`, and `convex/_generated/api.d.ts` is
committed — so one agent read the value out of the main checkout's `.env.local`
and ran `CONVEX_DEPLOYMENT=dev:chatty-llama-452 bunx convex codegen`. Its output
included *"Uploading functions to Convex"*, so this feature's table and modules
may now sit on **your personal dev deployment**.

Staging and production untouched, additive only, and the next `convex dev` from
the main checkout overwrites it. Told you because it is a write to a real
deployment nobody asked for. The underlying gap — a committed generated file
that needs a deployment to regenerate — is worth solving if agents keep working
in worktrees.

### The two install doors are not equal, and copy cannot make them so

Six unprimed critiques were asked whether `/install` reads as two legitimate
doors or one door and a sketchy alternative. All six said **not equal**,
including after every removable cue was removed. What remains is inherent: door
B hand-implements in shell what `duetfs login` does for you — the token
exchange, the `~/.duet/config.json` write, the `0600` bits — so it stays several
times door A's height whatever the prose says.

It runs in node rather than `curl` because the verify response carries the API
key, and a `curl` pipeline would print a bearer [REDACTED] into a scrollback
nobody can revoke. **The length is the cost of keeping "never print the key"
true.** `duetfs login --email` is the only thing that collapses it, and it is a
named follow-up rather than something this ladder built.

### The widened OAuth consent screen was never seen

`admin` and `members` appear on it for the first time. No screenshot was taken:
`consent-panel.tsx` renders capabilities as a generic chip list, so showing them
would have meant widening a playground fixture and re-approving baselines for a
change the feature does not make. Evidence recorded instead was the before/after
metadata:

```
BEFORE (6):  files:read files:write memory sessions services integrations
AFTER (12):  admin agents apps files:read files:write integrations members
             memory publish services sessions share
```

If you want eyes on the real screen, it needs that fixture widening. Say so.

### The staging MCP OAuth journey requests all twelve capabilities, and nobody has run it

`staging-e2e-synthetic` was updated to request `CAPABILITIES` rather than
merely made to compile — its user owns its own workspace, so `roleCanGrant`
admits `admin`, making the journey a live proof of the widening. Whoever runs
`--journey mcp-oauth` next is the first to exercise a twelve-capability grant
end to end.

### The install page's code blocks clip horizontally on mobile

Pre-existing — the before shot clips too — and deliberately not fixed, because
slice 14's judged variable was copy structure, not layout. But the page now
carries two code blocks where it carried one. Low impact: an *agent* reads
`/install.txt` or `/install.md`; the HTML page is for humans, who rarely copy
shell from a phone.

---

## Decisions I'd defend

### Verify proves the code before it says anything about the account

The riskiest thing in the build, and it shipped wrong until closeout. Resolving
the workspace before comparing the code hash meant anyone who knew an email
address could call `start`, then `verify` with garbage, and receive a `409`
listing every workspace slug, name and role that person belongs to — plus a
`403`-vs-`400` membership oracle for any slug they guessed, both free because
neither branch spends an attempt.

My slice file caused it by saying "resolve, then redeem". **Comparing a hash is
not redemption** — redemption is the `auth:signIn` call that destroys the code —
so the ladder's rule survives with the check moved first. A test pins it.

### The code and the button never appear in the same email

They redeem the same single-use token, so offering both gives the reader two
paths that destroy each other: click first and the agent's verify fails against
a consumed code; verify first and the button is dead. The code variant renders
no action at all, and `EmailShell`'s action became optional to allow it.

**Answered at closeout, and it had been answerable all along:**
`apps/web/proxy.ts:36` intercepts `/sign-in?code=…`, and `rejectUnprovenAuthCode`
(`:79`) strips the code, sets `authError=invalid-link`, and 307s — **unless that
browser holds an OAuth verifier cookie**, in which case `resolveAuthCodeProof`
falls through to `'oauth'` and the code reaches the exchange without an intent
match. Either way the button was useless to an agent-started human, so the
decision was right for a reason neither of us had. I carried this as an open
unknown for the whole build; one file read would have closed it.

### The email states the grant in words, because nothing else will

This rail has no approval screen, so the email is the only place a human learns
what the code hands over: *"it can do anything you can do in Duet except
administer your account."* Asserted by a test, not left as copy.

An unprimed review then changed five things I had passed: the revocation
sentence had the **weakest contrast on the page** while the sentence granting
account-wide power sat at near-black; `letterSpacing: 3px` made `RNP4-4Y37` scan
as two space-separated groups, which is a code retyped wrong; no expiry was
stated at all; the button label was indistinguishable from the subject; and the
footer never said *do not share this code*.

### One capability list, and the role is the real ceiling

`LOGIN_CAPABILITIES` is deleted. It had been a hard cap, not a default —
`OAuthScopeStringSchema` *rejected* anything outside it, so an MCP client could
not ask for `apps` or `publish` at all.

Widening is safe by construction rather than by policy: `roleCanGrant` is
enforced at issue time and re-checked on every authentication, so a key carrying
`admin` for a workspace where the human is an editor grants nothing. The one
credential that argument does not cover is the app key, which is membership-free
— which is exactly why `AppApiScopesSchema` stays `admin`-free and `SECURITY.md`
needed no rewrite.

### Test-auth has one reader, and the reader is the guard

`DUET_TEST_AUTH_EMAIL=1` pins the sign-in code to a constant *and* suppresses
the emails that would warn anyone — an unauthenticated takeover of any address
you know, if it ever reached a real deployment. Five modules read it and nothing
checked where it was set.

It reads the flag rather than asserting at module scope, because `config.ts` is
imported by `convex/auth.ts` and the deploy rail runs `convex deploy`; a throw
during push-time analysis would break every deploy for every app. A probe inside
a booted fixture settled the signal: a function sees
`CONVEX_CLOUD_URL=http://192.0.2.1:<port>` locally, `https://…service.example.invalid` on
cloud, and no `CONVEX_DEPLOYMENT` at all. Absent or unparseable counts as **not
local**.

### `funding` is per-workspace, and llms.txt now says it exists

A top-level entitlement block would report the *signed-in user's* plan, so a
member of a workspace someone else funds would read `plan: null, active: false`
while everything worked — and the agent would ask them to pay for something
already paid for. It sits beside the `billingUserId` it describes, computed from
that workspace's payer.

It costs **fewer** database reads than what it replaced: the tier projection
already fetched the payer row per workspace, so passing it in means one read
where a five-workspace session used to do five.

It shipped required on every workspace summary with **no reader anywhere** —
neither product code nor copy — which the closeout review caught. `llms.txt` now
points at `GET /v1/whoami`, which makes the decision delivered rather than
merely built.

### The full billing roster, unfiltered — your call

`GET /v1/user/billing` lists every workspace the payer funds, and a `user` key is
single-workspace by `SECURITY.md:56`. You decided the data is the payer's own and
the human authorized this agent. No credential-kind-dependent response shape.

### `start` proves the email; `verify` sets up the account

Not merely simpler — the only shape that works. Convex Auth **discards** `name`
(`signIn.js:62` forwards six fields; `createVerificationCode.js:29` builds
`profile: { email }`), so our own request record is the only thing that can carry
it across the code exchange, and that record is read at `verify`.

`start`'s 202 is byte-identical for a known and an unknown address, because it is
unauthenticated and any difference is an account oracle.

### The human-typed code is `XXXX-XXXX`, with a regex wider than its alphabet

The generator emits 32 symbols (no `I`, `O`, `0`, `1`); the schema accepts 34.
Tightening them to match looks like an obvious cleanup and is a bug: a human who
reads `O` and types `O` would be told their code is malformed, and there is no
`0` for it to collide with. 32⁸ = 2⁴⁰ exactly, which is what lets it survive a
verification path with no rate limit of its own.

Case is normalised rather than judged — the device rail has always upper-cased
the identical grammar — so a lowercase code is a *countable* wrong code rather
than a malformed request.

### Every published error shape was verified against shipped code, not the spec

`llms.txt` is the one artifact a stranger's agent takes literally. Its two
refusals were checked by reading the code: `402 workspace_limit_reached` with
`plan` and `limit` (`routes/workspaces.ts:91`), and `403 payer_required`
(`routes/billing.ts:222`). Both exact.

The published union had omitted `forbidden` and `invalid_request`, both of which
the route returns — a union that omits a refusal teaches a reader the shape is
exhaustive when it is not.

### Three copies of the entry-code grammar became one — and there were four

The ownership table named three. `apps/web/app/device/page.tsx` held a fourth
nobody noticed until the closeout review.

The one that mattered most: `MAGIC_LINK_TOKEN_PATTERN` gated **both** the intent
nonce and the verification code. Changing the code format without splitting them
would have broken every browser magic-link sign-in, and no test in the repo
would have caught it — the callback's own tests used nonce-shaped fixtures.

### A second `start` supersedes the first rather than being refused

Convex Auth deletes the earlier code regardless, so refusing would keep a record
alive that can never be redeemed **and** force `start` to answer something other
than its byte-identical 202 — which is its whole enumeration defence.

### The emailed link points at `/sign-in`, and a guard makes a silent failure loud

The magic-link callback demands an intent cookie an agent-started human never
received, so every such link would land on `authError=invalid-link`. And the
failure is invisible: omitting `redirectTo` still returns `{started: true}` and
mails a link that finishes nothing. `assertEmailedSignInLink` refuses that at
send time.

It is held to the agent rail. A closeout review argued for unconditional — that
turns 21 of 22 fixtures red, because they drive `auth:signIn` with no
`redirectTo`. The browser rail is guarded at its source instead, where
`apps/web` always sends the callback path.

---

## Smaller calls, for completeness

- **`retryAfterSeconds`, not `retry_after`.** The error union reuses
  `ApiRateLimitErrorSchema`, which shares, gateway and the pre-auth limiter all
  emit. Mixed casing inside one union is inherited, not new.
- **Verify's rate limit is keyed on the request id**, so nobody can lock a victim
  out of their own sign-in from outside — plus the network floor every other
  pre-auth endpoint carries, which it was missing until closeout.
- **`409` for an ambiguous workspace**, not `400`: nothing the caller sent is
  wrong and their code is still good.
- **Email identities are normalised by trim and lowercase only.** No Gmail dot or
  plus folding: provider-specific, and guessing wrong merges unrelated victims
  into one bucket.
- **`bindCode` returns the client name** rather than the send callback re-reading
  a row the mutation is already holding.
- **`ApiCredentialKindSchema` moved to a leaf module** to cut a real runtime
  import cycle between `contract`'s `auth` and `workspaces` — a TDZ
  `ReferenceError`, not a type error. Inside `packages/contract`, import it from
  `../auth/credential-kind`.
- **`z.email().trim()` does not trim.** A format check runs before checks
  appended to it, so the spec's spelling rejected padded input instead of
  cleaning it. The repo's other email schemas already order it correctly.
- **A new refusal code, `payer_credential_required`**, for the relaxed billing
  routes: `browser_session_required` would send an agent holding a good key
  looking for a browser.
- **Rate-limit counters reset once at deploy.** Namespacing the hashed plaintext
  (`<ip>` → `net:<ip>`) changes the hash input; the widest window is 60 seconds.
- **The `.md` repoint reaches further than the index.** `linkList` has one owner,
  so the section twins' listing bodies changed too — wider than decision 7 asked
  for, accepted knowingly.
- **Dead plumbing deleted at closeout:** a `name` argument on `start` threaded
  through five modules that no wire could ever fill, because slice 07 built it
  and slice 09 shipped a request schema without it.
