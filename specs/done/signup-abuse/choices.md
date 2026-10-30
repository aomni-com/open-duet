# Choices ledger — signup abuse

Every decision made where the spec was silent, re-audited against the **final
shipped code** rather than the pass it landed in. Grouped by verdict, ranked
least-confident first within each group.

Terms used throughout, defined once:

- **The gate** — `domains/signupAbuse/actions:signUp`, the one public entry that
  now stands in front of workspace creation.
- **Exempt / test identity** — an address the gate skips entirely, so our own
  automated tests don't get blocked by our own fraud checks.
- **Canonical email** — one mailbox's single true name. `user@example.invalid`
  and `user@example.invalid` are one mailbox, so they share one canonical email.
- **The trial** — the $5 of credits a new account gets, which is what a fraudster
  is farming.

---

## Needs user — decide

### 1. Outlook and Hotmail users can no longer create an account

- **When:** slice 05.
- **The choice.** Someone types `user@example.invalid` into the duet sign-in form and
  clicks the button. Today: the gate looks her address up in a 5,500-entry
  blocklist, finds `outlook.com`, refuses her, and shows a generic "we couldn't
  verify this device" message. She has no way in. That entry is in the list
  because you put it there on chat-app — the file carries the note "per Example User
  2026-04-23, high volume of spam sign-ups on Duet" — along with `hotmail.com`,
  `edu.pl`, `edu.rs`, `qwiklabs.net`, and `phuturemail.com`. The unbuilt
  alternative: port the ~5,490 disposable-provider entries (mailinator and
  friends) and leave the six hand-curated ones behind, so real Outlook users get
  in and you re-add entries only when duet itself sees the spam.
- **The gap.** You said chat-app's logic is the baseline and these exist because
  of real fraud. The spec never asked whether that included the curated
  human-added entries as opposed to the mechanical disposable list.
- **The reach.** This is the largest user-visible consequence of the entire
  feature, and it is invisible in the diff — it lives in one data file among
  5,500 lines. Outlook and Hotmail are among the most common consumer mail
  providers in existence.
- **Verdict:** needs-user. Provisional call: **kept as ported**, since you were
  explicit that chat-app is the baseline and these entries encode real observed
  fraud. Reversing is deleting two lines from `SPAM_EMAIL_DOMAINS` in
  `domains/signupAbuse/blockedEmailDomains.ts` — no other code changes.
- **Confidence:** low. You made this call for chat-app, but duet is a different
  funnel and you have not seen its spam yet.

### 2. Company sub-domain addresses are refused outright, where chat-app only paused them

- **When:** slice 05.
- **The choice.** An employee at Acme signs up as `user@example.invalid` — a real
  company that issues staff addresses on a sub-domain rather than on `acme.com`.
  Today the gate refuses her: no account, generic error. chat-app treats the same
  address differently — it *creates* the account and then marks the workspace
  paused, so the person hits a billing wall and can pay their way out of it. The
  unbuilt alternative here is chat-app's: let them in and withhold the free
  credits (`no_grant`) instead of the account.
- **The gap.** Your instruction was to "combine all 3 mechanisms into just a hard
  signup gate — all those are spam users." That collapsed chat-app's two
  different consequences into one. The spec recorded the tightening; nothing
  established that a real customer wouldn't be caught by it.
- **The reach.** This rule is the weakest evidence of the three email checks —
  chat-app's own comment calls it "a strong spam-signup signal", not proof. It
  is the rule most likely to refuse a paying customer, and refusals leave no
  trace the user can act on because the message is deliberately generic.
- **Verdict:** needs-user. Provisional call: **kept as a hard deny**, per your
  explicit instruction. Reversing is one line in
  `domains/signupAbuse/policy.ts` — return `no_grant` instead of `deny` for
  `email-subdomain`. The predicates deliberately don't own their consequences,
  precisely so this is a one-line change.
- **Confidence:** low. You chose "one hard gate" before I could show you that
  chat-app treats this signal more gently than the other two.

### 3. "Third account on a device" was implemented as "third distinct mailbox"

- **When:** slice 04.
- **The choice.** You said the third account on a device loses its trial. But
  "account" is ambiguous, and the two readings behave differently. Scenario: Jane
  signs up three times from one laptop as `user@example.invalid`,
  `user@example.invalid`, `user@example.invalid`. Those are three separate login
  accounts — duet keeps `+tag` in the stored address for non-Gmail domains — but
  one mailbox. Counting **accounts** would withhold her third trial. Counting
  **mailboxes** does not, because all three collapse to `user@example.invalid` and
  already share a single trial-grant key, so she never got more than one $5 grant
  anyway. Today the code counts mailboxes. The unbuilt alternative counts rows,
  which would fire on Jane while catching no extra fraud.
- **The gap.** The spec fixed the number at 3 (your call) but not the unit being
  counted.
- **The reach.** Anything later that reasons about "how many accounts on this
  device" reads `users.canonicalEmail`, a field this decision added. Changing the
  unit later means a data migration, not a constant tweak.
- **Verdict:** needs-user only because it reinterprets your words; the audit
  believes it is what you meant. Provisional call: **count mailboxes**. Reversing
  is a change to the `Set` in `domains/signupAbuse/model.ts` to key on user id.
- **Confidence:** medium. Counting rows would produce false positives with no
  compensating catch, which is a strong argument — but it is still my reading of
  your sentence, not your reading.

### 4. Six live staging runs were spent before checking a precondition

- **When:** slice 07.
- **The choice.** The journey's deny leg works by letting the sign-in page
  identify the browser normally and then tampering with the result — it keeps the
  real identification receipt and swaps the device id, which the gate refuses as
  a forgery. That only works if the deployed staging sign-in page actually sends
  an identification, which it only does if staging web was rebuilt with slice
  06's client. I never checked. Six runs followed, each launching a Docker
  browser, creating real staging users and workspaces, and consuming AgentMail
  messages. The unbuilt alternative: one `curl` against `service.example.invalid`
  before the first run.
- **The gap.** Nothing in the spec said who deploys staging web, or that the
  journey depends on it having been deployed.
- **The reach.** Anyone picking this up inherits the same trap. The handoff now
  names it as the first thing to check, and the leg asserts on it — but only
  after its response wait resolves, so the assertion is slow rather than
  immediate.
- **Verdict:** needs-user, because how much staging resource a closeout gate may
  burn is your call, not mine. Provisional call: **stop and hand over**, which is
  what I did. Reversing is simply running it again once the deploy is confirmed.
- **Confidence:** low. I do not know your tolerance here, and I spent it without
  asking.

---

## Sound — acknowledge; this is the architecture you now own

### 5. The MX lookup is silently disabled in any test-auth environment

- **When:** slice 05.
- **The choice.** One of the three email checks asks DNS "does this domain
  actually receive mail?" and refuses domains that don't. Every backend test
  signs up as `user@example.invalid`, and `example.com` publishes a *Null MX* —
  a DNS record that explicitly declares "this domain accepts no mail." So the
  gate correctly refused every test signup, and 35 test files broke at once.
  Today the lookup is skipped whenever `DUET_TEST_AUTH_EMAIL=1`, which this repo
  already uses to mean "this is not a real environment" (`config.ts`'s
  `useTestFakeStripe` guards on the same flag). There is also an explicit
  override, `DUET_SIGNUP_MX_LOOKUP=off`, for turning it off in production. The
  unbuilt alternative: set an env var in all 35 test files, or give every test a
  domain with real MX records.
- **The gap.** The spec never said tests must not depend on live DNS, nor what
  address fixtures should use.
- **The reach.** Two consequences. First, no test can exercise the MX rule
  end-to-end — it is covered only by unit tests with fixed inputs. Second, you
  now have a production kill-switch for the gate's only outbound DNS call.
- **Verdict:** sound. The general property is "a test environment makes no live
  network calls", not "make example.com pass" — and it reuses an existing repo
  convention rather than inventing a second one.
- **Confidence:** medium. Coupling the DNS decision to the auth-test flag is
  convenient and consistent, but they are two different concerns sharing one
  switch.

### 6. An address is exempt only if it is on a known inbox *and* carries a test marker

- **When:** slice 07.
- **The choice.** The journey needs two things from one mailbox: an address the
  gate lets through (to prove signup still works) and an address the gate
  refuses (to prove the gate works at all). We have exactly one AgentMail inbox,
  `user@example.invalid`, and the API key is not permitted to create another —
  it returns `Forbidden`. Originally the whole inbox was exempt, which left no
  refusable address anywhere. Today an address is exempt only if its canonical
  form matches a configured inbox **and** it contains the literal string
  `staging-e2e-synthetic`, which every automated run already puts in its address. So
  `user@example.invalid` is waved through and
  `user@example.invalid` is not — same mailbox, opposite treatment.
  The unbuilt alternative: a second inbox, which needs an AgentMail permission we
  don't have.
- **The gap.** The spec assumed a third inbox could be provisioned.
- **The reach.** The exemption is now tighter than planned — an address on the
  test inbox without the marker is *not* exempt. Any future test that signs up
  must put `staging-e2e-synthetic` in its address or it will be gated like a stranger. I
  verified every existing journey already does.
- **Verdict:** sound. It reuses a marker the repo already treats as "this is a
  synthetic identity" (`testing/stagingE2e.ts`), and it narrows rather than
  widens a security-relevant exemption.
- **Confidence:** medium-high. The mechanism is right; the risk is a future test
  author not knowing about the marker requirement.

### 7. The "no free credits" flag lives on the person, not on the signup

- **When:** slice 04.
- **The choice.** When someone is the third mailbox on a device, we withhold
  their $5. The obvious place to do that is where the workspace is created —
  pass a "skip the grant" flag into workspace birth. But the trial is granted
  from **two** places: workspace birth, and again when a VM registers
  (`workspaces/registration.ts`). A flag passed into birth would leave the second
  door open, and the person would get their $5 a few seconds later when their VM
  came up. Today a timestamp is written on the *user* record and
  `grantTrialCreditsForAccount` — the single function both doors call — refuses
  anyone carrying it. The unbuilt alternative leaks through the second door.
- **The gap.** The spec named the withhold but not where it is enforced.
- **The reach.** Any third place that ever grants a trial is covered
  automatically. There is now a permanent field on the user record recording that
  this person was refused credits.
- **Verdict:** sound. The property that guarantees it is "one function applies
  every trial", which holds regardless of how many callers appear later.
- **Confidence:** high.

### 8. Denials are written down in a separate step, before the refusal happens

- **When:** slice 07.
- **The choice.** When the gate refuses someone, we want a row in a table saying
  who and why, so you can look it up later. The natural implementation records
  the row and then throws the error in the same operation. That silently loses
  every row: Convex mutations are transactions, so throwing rolls back the write
  that just happened — and the only rows you would lose are the refusals, which
  are exactly the rows worth having. Today the row is written by its own
  operation that commits, and only then does the outer action throw. There is a
  test that signs up with a blocked address, asserts the signup fails, and then
  reads the row back.
- **The gap.** The spec flagged the risk; it did not specify the mechanism.
- **The reach.** Any future signal added to this table must follow the same
  ordering or it will vanish under exactly the conditions you care about.
- **Verdict:** sound.
- **Confidence:** high.

### 9. The Fingerprint SDK is hidden behind our own React context

- **When:** slice 06.
- **The choice.** The browser half of this feature uses Fingerprint's React
  library, whose `useVisitorData` hook throws an exception if it is called
  anywhere that isn't wrapped in Fingerprint's provider. My first version called
  it directly from the sign-in page component. In any environment without the
  Fingerprint key — a developer's laptop, a preview deploy without secrets — the
  provider isn't rendered, so the hook throws and the **sign-in page crashes**.
  That is the opposite of the intended behaviour, which is that a browser we
  can't identify just gets waved through. Today the SDK is confined to one file
  that exposes a plain function through React context; with no key, that function
  returns "couldn't identify" and the page renders normally.
- **The gap.** The spec said the provider wraps the sign-in surface. It did not
  say what happens with no key.
- **The reach.** Nothing outside that one file imports the Fingerprint SDK, so
  swapping vendors touches one file.
- **Verdict:** sound.
- **Confidence:** high.

### 10. The gate runs in Convex's fast runtime and does not use Fingerprint's server SDK

- **When:** slice 00.
- **The choice.** Convex code runs in one of two places: a fast lightweight
  sandbox, or a slower full Node.js environment you opt into with `'use node'`.
  chat-app's version needs Node, because it uses Fingerprint's official server
  library and Node's DNS module. I probed whether the fast runtime could reach
  both services with plain `fetch` — it can. So the gate makes one HTTP call to
  Fingerprint and resolves DNS over HTTPS instead. The library was rejected on
  evidence, not taste: it imports `crypto`, `zlib`, `util` and `buffer` at the
  top level, which forces Node on its own, and it stores the global `fetch` on a
  class field — a pattern that has already caused a production bug in this repo.
  The unbuilt alternative: 726 lines of dependency and the slow runtime.
- **The gap.** The spec named it as the thing to find out.
- **The reach.** Fifteen lines of our own code that we maintain, versus a vendor
  library that tracks their API changes for us. If Fingerprint changes its
  response shape, we edit `evidence.ts`.
- **Verdict:** sound.
- **Confidence:** high.

### 11. The login identity function was left untouched; a second one owns the fraud key

- **When:** slice 01.
- **The choice.** To stop one mailbox claiming many trials you need a single true
  name per mailbox. The tempting move is to change `normalizeEmail`, which
  decides what address a login *is*, so `user@example.invalid` and `user@example.invalid`
  become the same account. That would have broken every staging test at once:
  the whole test harness signs up as `+tag` variants of one shared inbox, so all
  of them would have collapsed into a single user. Today `normalizeEmail` is
  unchanged and a separate `canonicalEmail` is used only for the trial-grant key
  and the device count. So `jane+a@` and `jane+b@` remain two logins that share
  one $5 grant.
- **The gap.** The original plan (D6) *did* say to widen the identity function. I
  found the harness collision while implementing and you reversed the decision.
- **The reach.** Two functions now exist that both "normalize an email", for
  different purposes. Anyone adding a third normalization should use one of
  these, and the older third one in `grants.ts` was deleted as part of this.
- **Verdict:** sound.
- **Confidence:** high.

### 12. The bootstrap mutation was sealed and every caller moved

- **When:** slice 02.
- **The choice.** Before this, the function that creates a workspace, grants $5
  and provisions a VM was callable directly from a signed-in browser's developer
  console. Any fraud verdict passed *into* it as an argument would have been
  trivially forgeable — type your own "allowed" and press enter. Today it is
  internal, and the only way in is an action that runs the checks itself. Four
  callers moved, two of which referenced the function by a **string** the
  TypeScript compiler cannot check.
- **The gap.** The spec named the seam; the caller inventory was mine.
- **The reach.** The new public action is the single front door for account
  creation. The test asserts the old door is *gone*, not merely locked — an
  earlier draft asserted only that a call fails, which would have passed before
  the change too, since the old public mutation also rejected unauthenticated
  callers.
- **Verdict:** sound.
- **Confidence:** high.

### 13. Only cold signups are checked; existing members are never re-verified

- **When:** slice 03.
- **The choice.** The gate runs on every call to the session endpoint, including
  ordinary sign-ins by people who already have a workspace. If it checked them,
  a device that legitimately hosts three accounts — a shared office laptop, a
  family computer — would start failing its own users' logins forever. Today the
  gate first asks "does this person already have a workspace membership?" and
  skips everything if so.
- **The gap.** The spec said existing users skip the gate; it did not say how
  "existing" is determined.
- **The reach.** The membership check mirrors the early return already inside
  workspace bootstrap, so the two agree by construction.
- **Verdict:** sound.
- **Confidence:** high.

### 14. "We couldn't check" is recorded as four distinct reasons, not one flag

- **When:** slice 03.
- **The choice.** When device evidence is unavailable the signup is allowed —
  denying real users over a network hiccup costs more than the trials a fraudster
  saves by blocking a script. But "unavailable" has four causes: no device sent
  at all, no API key configured, the Fingerprint API errored, and the
  identification receipt wasn't found. All four allow, but each is recorded
  separately. The unbuilt alternative is a single boolean, under which a
  misconfigured key looks identical to a user with an ad blocker — and the gate
  could sit silently disabled for weeks.
- **The gap.** The spec said "fail open"; it did not say to keep the reasons
  apart.
- **The reach.** The distinction is what makes the failure mode detectable rather
  than invisible.
- **Verdict:** sound.
- **Confidence:** high.

### 15. The device a person is bound to is fixed at their first signup, forever

- **When:** slice 04.
- **The choice.** Each user record stores the device they signed up on. If we
  updated that on every later sign-in, a fraudster would sign in once from a
  clean browser and their old device would be forgotten, resetting the count for
  free. Today the field is written only if empty. There is a test asserting a
  second device does not overwrite the first.
- **The gap.** The spec said to record the device; it did not say what happens on
  a second one.
- **The reach.** The field is a permanent record of where an account was born,
  not where it is used.
- **Verdict:** sound.
- **Confidence:** high.

### 16. Exempt test accounts are never recorded against a device at all

- **When:** slice 04.
- **The choice.** Our automated tests run repeatedly on whatever machine CI uses.
  If those signups counted toward that machine's device limit, the third test run
  of the day would start failing. Today an exempt identity returns from the
  device claim before anything is written.
- **The gap.** The spec said test identities are exempt from the count; "never
  recorded" is stronger than "not counted" and is what actually holds.
- **The reach.** Device rows in the database describe real users only.
- **Verdict:** sound.
- **Confidence:** high.

### 17. Nothing was added to the web app's network allowlist

- **When:** slice 06.
- **The choice.** `apps/web` has a checker that forbids network calls from most
  files, with a hand-maintained list of four exceptions. Adding a network-calling
  SDK looked like it would need a fifth entry. I ran the checker instead of
  assuming: it looks for literal `fetch(`/`WebSocket(` in *our* source and does
  not list Fingerprint as forbidden, so the new files pass untouched. The unbuilt
  alternative — adding an entry "to be safe" — would have widened a
  security-relevant list for no reason.
- **The gap.** The spec predicted an allowlist edit would be needed.
- **The reach.** The list still means what it says.
- **Verdict:** sound.
- **Confidence:** high.

### 18. The signals table records refusals only, not every signup

- **When:** slice 07.
- **The choice.** The table could log every signup attempt, making it a complete
  signup log. Today it holds only `deny` and `no_grant` rows — four fields and no
  vendor payload. It is an exception log you read when something was taken away,
  which is the question you said you would be asking from the Convex dashboard.
- **The gap.** The spec set a size budget but not the population.
- **The reach.** You cannot use this table to count total signups.
- **Verdict:** sound.
- **Confidence:** high.

### 19. Each journey leg owns its own mail tag and its own cleanup ledger

- **When:** slice 07.
- **The choice.** One string was serving three masters: it discriminates which
  email in a shared mailbox belongs to this run, it signals exemption to the
  gate, and the cleanup ledger requires it to appear in every recorded label.
  Those pull apart — the exempt leg's tag must contain `staging-e2e-synthetic` and the
  refused leg's must not. Three consecutive journey failures came from that
  collision. Today each leg carries its own tag and its own ledger.
- **The gap.** The spec did not anticipate that the exemption signal and the mail
  discriminator are the same field.
- **The reach.** Any future leg added to this journey needs its own pair.
- **Verdict:** sound.
- **Confidence:** high.

### 20. Someone else's lint breakage was fixed in a separate commit

- **When:** during slice 05.
- **The choice.** `origin/staging` was already failing lint from an unrelated
  commit — an unused import and three unused variables left by a
  connected-providers refactor. It blocked my gate. I fixed it in its own
  clearly-labelled commit rather than folding it into feature work or waiting.
- **The gap.** Not in scope; a judgment call about someone else's code.
- **The reach.** Four lines, no behaviour change.
- **Verdict:** sound.
- **Confidence:** high.

### Trivial discretion, not itemised

Roughly a dozen internal naming and shaping calls: module filenames under
`domains/signupAbuse/`, a structural `FetchLike` type instead of `typeof fetch`
(Bun decorates the global and broke the typecheck), an `act()` helper added to
the test harness beside the existing `query()` and `mutate()`, splitting the
device-claim logic into `model.ts` with a thin mutation wrapper to match the
repo's existing layout, and removing two pieces of surface nothing produced (an
unreachable verdict reason and an export with no consumer).

---

## Open — not choices, but not finished either

**The live staging journey has never gone green.** Its exempt leg completes a
real cold browser signup through the deployed gate on every run, so the gate is
live and is not refusing legitimate users. Its deny leg is unproven end to end.
See the README handoff for exactly where it stops and what to check first.

**The botd measurement deferred from slice 00 was never taken.** It stopped
affecting correctness once every existing journey became exempt by construction,
so nothing depends on it — we simply still don't know whether Fingerprint
classifies our test browser as a bot.
