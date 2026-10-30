# Choices ledger — agent-onboarding

Every decision made without Example User, re-audited against the **final shipped
code** rather than the pass each landed in. Provisional verdicts that a later
pass or a ruling resolved are collapsed to their end state; entries a later pass
reverted are gone. This file, not the diff, is the review surface.

Ranked least-confident first within each group.

---

## Decide (needs-user)

### N1 · The "Onboard agent" button fails WCAG AA contrast

**Confidence: medium** — this is your palette, not a code call.

The locked card's one call to action is white text on the product's brand blue.
Measured contrast is **3.74:1**; AA wants 4.5:1 for text this size (14px
semibold counts as normal text, not large). Legible, but washed out for
low-vision users.

This feature did not invent it: `bg-brand` + `text-brand-foreground` is the
pairing already used by the official-agents badges, the Jobs list selected
state, and the auth cards. Fixing it here makes this one button a snowflake;
fixing it properly means changing `--brand` or `--brand-foreground` in
`packages/tailwind-config/globals.css`, which restyles the product.

**In effect now:** the system pairing. **Reversal:** a one-line token change
fixes this and every other brand surface at once.

---

## Acknowledge (the architecture you now own)

### A1 · No schema rejects an unknown field — with two exceptions that are about meaning, not versions

**Confidence: medium.** Settled by your ruling, then materially refined by
running the suites.

Zod offers three behaviors for an undeclared field: *reject*, *strip* (accept,
drop), *pass through* (accept, keep). The repo was rejecting in 183 places,
which made adding one optional field a fleet-wide, deploy-ordered migration.

All 183 now strip. Seven stay pass-through, each with a reason in the code:
`agent.json`'s grammar and the gateway's launch/ledger envelopes, where a field
written by a newer writer must survive a read-and-rewrite by an older one.

Running the suites — which the delegated pass could not, its sandbox blocks
port binds — showed strictness had been doing **three** jobs, only the first of
which you were targeting:

1. **Version tolerance.** Converted to strip, as ruled.
2. **Union discrimination.** `Share = Incoming | Outgoing` has no discriminant
   field; Zod was picking the branch by which one *rejected* the other. Under
   strip the first branch accepted everything and silently dropped
   `tokenPrefix`. Those two stay strict. Merging them into one both-optional
   object would be worse — it would let a recipient-facing projection carry a
   token prefix it must never see.
3. **Deny-lists.** The hosted MCP `train_start` refused byte-bearing fields so
   file bytes cannot enter through the tool surface. Stripping meant a caller
   sending `content` got a train run over material that never arrived. Now an
   explicit deny-list (`files`/`content`/`encoding` declared
   `z.never().optional()`): unknown future fields pass, forbidden ones fail
   loudly — which is what strictness had been approximating.

**The reach.** Every future schema inherits this, and the two exceptions are
the question to ask: is this strictness about *versions*, or about *meaning*?

---

### A2 · Reinstalling an already-installed official agent returns 201, not 409

**Confidence: medium** — it changes a user-facing response clients may branch
on. You reviewed and accepted the collision behavior.

Installing an official agent puts it at a standard folder. Asking for one you
already have used to return 409. Campaign auto-install runs during signup and a
lost response must not wedge a new user behind an install they already have, so
the same agent at its canonical path with a live subscription is now **adopted**
(201).

The refusal still fires for the case it exists for — something *unrelated* owns
`agents/<name>` — pinned by a test that seeds a foreign occupant and asserts the
full typed payload, which is what the replaced test was really protecting. You
noted auto-install collisions are a non-issue in practice since campaign signups
get fresh VMs.

---

### A3 · Onboarding is a real session that no list will show

**Confidence: high.**

The conversation had to be resumable — press the button twice, land in the same
chat — yet absent from every list, job view, and search. It is hidden as a
*structural index dimension*, the same way the database filters by agent, not by
fetching rows and discarding them, which would hand users short or empty pages.

Two consequences the plan did not name, both deliberate: lifecycle sweeps do
**not** inherit the hiding (deleting an agent must still kill its live onboarding
runner, so the sweep reads both slices), and onboarding turns emit no analytics
and generate no title — the `grow` classifier counts messages, so a scripted
setup exchange would score every campaign signup as engaged before the user did
anything.

---

### A4 · Onboarding identity is immutable; the session's other launch fields keep tracking

**Confidence: high.**

A running session stores a small record on the VM: the facts needed to restart
after a crash, reboot, or scheduled wake — its folder, its model, and now
whether it is an onboarding session.

Making the new flag survive restarts initially froze the whole record, which
froze the model too: switch models mid-conversation and the session came back on
the old one after a wake, silently. Split into the rule that should hold —
**identity is immutable, parameters keep tracking.**

Fixing that surfaced a **pre-existing** bug of the same shape on the live-runner
path, which persisted the record it already had rather than the one the request
carried. That failure existed on `origin/staging` before this feature. Fixed
here, with the test watched failing first.

**The reach.** For anything added to that record later: ask whether it is
identity or parameter. Getting it wrong is invisible until a wake.

---

### A5 · The onboarding system prompt is layered, and ONBOARDING.md is optional

**Confidence: high.** Corrected after Example User rejected the first shape.

**The scenario.** An onboarding conversation needs two things in its system
prompt: the author's interview, and the product's guarantee that the agent will
mark itself onboarded when done. The first version got this wrong twice — it
put the completion instruction in the opening *user* turn, and it made
`ONBOARDING.md` **mandatory**, failing the launch when the file was absent. The
second was a workaround for the first: if the instruction lives in the author's
file, the file has to exist.

Now the gateway passes prompt layers in order — `ONBOARDING.md` if present, then
a generated completion block. The runner already renders one
`<system_prompt_file>` block per layer and skips files that do not exist, so
optionality costs nothing and the ordering is exactly "interview first, contract
second".

The completion block is written per agent into the gateway's state directory,
outside the drive: it never syncs, never publishes, and the agent it instructs
cannot edit it.

**The one thing that did not change:** onboarding still never falls back to
`AGENTS.md`. A missing or drive-escaping `ONBOARDING.md` yields no authored
layer, not the agent's ordinary persona — the user believes they are being
onboarded, and silently running a different agent is worse than running a sparse
one.

**The reach.** Anything the product must guarantee about how a session behaves
belongs in a prompt layer it owns, not in a user turn and not in a file the
author might not write.

---

### A6 · A campaign naming an unknown official agent is skipped silently, and registration continues

**Confidence: high.** Corrected after Example User rejected the first shape.

**The scenario.** A campaign (a marketing landing page with its own signup
link) can name official agents to auto-install into the new workspace —
`starterAgents: ['ad-image-generator']` in
`packages/backend/convex/domains/campaigns/config.ts`. Someone renames or
deletes that agent in the hub VM. Now every person who signs up through that
landing page asks for an agent that no longer exists.

The first version validated those names at module load and threw. Two things
were wrong with it. It read the **seed** as if it were the catalog — it is
not; the seed bootstraps the hub once and the hub VM owns official agents
thereafter (see the seed invariant in the README), so a campaign naming a
legitimately VM-authored agent would have failed the Convex deploy for an agent
that genuinely exists. And even correct validation was aimed at the wrong
failure: a name can go stale *after* deploy, when nothing in this repo changes.

Today `defineCampaigns` validates nothing. At signup the install of that one
agent fails, the API tags the result `campaign: true` and writes a
`console.warn`, and everything else proceeds: the account is created, the
workspace is provisioned, the other agents install. The user sees no error —
the web client's "some agents failed to install" warning skips any result
carrying the campaign tag. The alternative Example User rejected was showing that
warning: a stale name in one campaign config would then greet every single
person signing up through it with an error about something they never asked
for and cannot fix.

**The reach.** Campaign-carried agents are best-effort by contract. Anything
that must be guaranteed present in a new workspace cannot ride this rail. And
the general rule the first version broke: never validate against the seed —
the seed is a bootstrap, and the runtime catalog is what the hub VM currently
publishes.

---

### A7 · Completion is per workspace and never crosses a share

**Confidence: high.**

Each recipient onboards their own copy; replication never copies, clears, or
propagates the timestamp, and detach preserves it. The consequence worth
knowing: adding onboarding to an agent already installed elsewhere **re-locks
it** for every workspace that has not completed it. That is the intended lever
for "everyone must go through the new setup", and it is documented for authors
as such.

---

### A8 · The onboarding app is addressed by path, never by slug

**Confidence: high.**

A shared copy's app slug can be collision-suffixed while its path under the
mount is preserved, so matching by slug would silently resolve the wrong app —
or the recipient's own unrelated one. Resolution compares the app's anchor path
under the agent root. A dot-folder keeps the app out of the way while staying
reachable.

---

### A9 · The lock is a hint, and every surface fails open

**Confidence: high.**

`agent.json` is read from the workspace VM, so a paused or booting VM cannot
answer. Unreadable config means unlocked, trainable, all apps visible —
everywhere, from one projection. No product logic treats "locked" as fact; the
chain in particular waits on the install subscription, because an agent's row
goes active the moment it is registered while its folder bytes are still
landing.

---

### A10 · One owner each for config, lock, and app visibility

**Confidence: high.**

`resolveAgentConfig` is the only thing that turns `agent.json` bytes into
meaning — gateway and web each read the file, both delegate what it *means*.
Lock derivation and app visibility are single pure functions; all three app
surfaces filter through the same one, because a filter applied to two of three
is a half-hidden app.

---

### A11 · The campaign rails ship carrying no product data

**Confidence: high.** Your call to leave the mapping unset.

`starterAgents` exists on the campaign type, the server derives it from the
user's immutable signup attribution, the team step is skipped when it is
non-empty, and installs are idempotent — but **no campaign names any agent and
no official agent declares onboarding.** Nothing changes for existing users
until that data is added: naming agents in `domains/campaigns/config.ts`, and
authoring the `onboarding` block on those agents **in the hub VM** (not in this
repo — the seed is a one-time bootstrap, not the catalog).

The derivation trusts the user's attribution pointer without a back-check; it is
written once at signup and never rewritten, so the pointer *is* the claim, and
the removed check could only have fired on hand-corrupted rows.

---

### A12 · A visual baseline that pictured a failure was deleted, not approved

**Confidence: high.**

A fixture meant to show a hidden-but-reachable app had been approved with a
baseline that was a screenshot of Chrome's raw JSON viewer reading
`{"error":"unauthorized"}` — that surface mounts a live iframe, so it can never
be hermetic in the playground. Deleted, its behavior left pinned by component
tests. Every automated check was green with that PNG committed; the unprimed
screenshot critique is what caught it.

**The reach.** A fixture whose surface embeds an iframe or a live fetch cannot
be a static visual baseline.

---

### A13 · Small calls, not itemized

Naming throughout; the discriminated-union encoding of `onboarding`; audit event
names; confetti density and timing; the fixed hidden-session title; the M2
subline; disabled-state copy; which query key the config read reuses. Internal
and reversible.

---

### A14 · The e2e's unlock check was rewritten after it passed vacuously

**Confidence: high.** Found by an unbiased audit of the closed record, not by
any gate.

The journey proved the card unlocked by waiting for the "Onboard agent" button
to be **detached** from the page. A page that has not yet painted its roster has
no such button either, so the assertion passed on a loading skeleton — and the
screenshot archived as "the agent after completion" was grey placeholders. The
unlock was only ever proven at the API level.

Now the check waits for the agent's own card to render *first*, then asserts no
onboarding action exists, and the archived shot is from the re-run that proved
it.

**The reach.** Any negative assertion about a rendered page needs a positive one
before it. "The bad thing is absent" is satisfied by a page where *everything*
is absent.

---

### A15 · The hub re-sync rail was deleted rather than kept for onboarding content

**Confidence: high.** Follows directly from your ruling that the seed is not the
catalog.

**The scenario.** This feature briefly added an admin route,
`POST /v1/internal-admin/official-hub/sync`, that pushed this repo's seed
content into the already-live hub workspace — the idea being that adding an
`onboarding` block to a shipped official agent would need a way to get it out
there. Under the corrected model that route is actively harmful: official agents
are authored in the hub VM, so a re-sync would overwrite an operator's live edits
with repo fixtures and resurrect agents they had deliberately deleted.

The route and its two mutations are gone. `beginSeed` remains and is genuinely
once-only — it returns `state: 'existing'` on any later call and the route exits
before writing, now pinned by a test that snapshots the hub, re-seeds, and
asserts the snapshot is byte-identical.

Checked before deleting: this rail is not the one users share agents over. User
sharing runs through `shares` / `sourceShareId` and
`domains/agents/replication.ts`; it is a separate path from
`officialAgentSubscriptions` and shares only three helpers with it, so nothing
about user-to-user sharing changed.

**The reach.** There is no in-repo mechanism to update a live official agent —
that is done in the hub VM, deliberately.

---

## Fixed in passing (pre-existing, not introduced here)

- **The live-runner stale-launch bug** (A4) — on `origin/staging` before this
  feature; a mid-session model switch reverted on the next wake.
- **The API-access section** read `API access · No API access` for an app with
  no scopes. It now renders nothing: the section exists to surface authority an
  app *does* hold.
- **A broken docs link** from the shipped agents record to `train-files`, found
  while tracing the link chain.

## Superseded records corrected

`specs/done/agents/README.md` asserted "the launch wire stays `.strict()`" as a
shipped invariant. This feature deliberately overturned it, so that record now
marks it superseded with a pointer and the reason, keeping the part that still
holds (no `agentId` on the wire). Its forced-mode invariant gained the
onboarding exception.

## Environment notes (not choices, but they cost hours)

A fresh git worktree has no `node_modules` and no local Convex/dotenv config,
and **both fail silently rather than loudly**: cross-package imports resolve up
to the main checkout, so you test the wrong code; Convex suites fail with
`ConnectionRefused`. It also has no `.vercel` project links, so a secret push
from a worktree half-fails. Run `bun install`, copy `.env.local`, `.env.keys`,
`packages/backend/.env.local`, `packages/backend/.convex`, and run secret pushes
from the main checkout. Convex suites also fail en masse on their first cold run
and pass on the second.

Delegated agents run sandboxed and cannot bind ports, so their "full suite
green" is not evidence. Every defect in A4, A12, and the union/deny-list halves
of A1 was found only by re-running the gates unsandboxed on the merged tree.

---

# Addendum — chasing the onboarding stall (2026-07-29/30)

This spec was already closed above when a live run of its own e2e journey
found Leg B intermittently stalling. Everything below is new work from that
chase: root-causing the stall, hardening the gateway, raising the workspace VM
floor, building a self-healing resize cron, and delegating a real cold-start
fix to Codex in `duet-agent`. Ranked least-confident first within each group;
review B1–B4 first regardless of group — they're the ones with a real
consequence for someone other than this codebase.

## Decide (needs-user)

### B1 · The VM-size cron restarts every undersized VM in one tick, with no throttle

**Confidence: low** — this is a blast-radius call about live user sessions,
not a code call.

The scenario: `WORKSPACE_VM_CAPS` just got raised from 1 vCPU/2GB to 2/8GB.
About 18 of the ~20 workspaces in the fleet are still running the old size.
The new cron (`packages/backend/convex/domains/workspaces/vmSize.ts`) wakes up
every 3 hours and does this, in order:

```
candidates = active workspaces with a vmName, oldest-heartbeat-first, up to 500
for each candidate:              # no delay, no per-tick cap, no stagger
  if vm.cpu/mem < floor:
    resize(vm)                   # provider applies the new allocation now
    restart(vm)                  # kills whatever that VM was doing, right now
```

There is no "only touch N per tick" cap and no delay between iterations. The
very first time this cron runs after a floor raise, it restarts **every**
still-undersized VM back to back in one pass — which means every live agent
turn or session running on any of those 18 VMs at that moment gets killed,
all at once, with no warning. The mechanism itself (never shrinks, retries a
failed restart, reports what it couldn't fix) is sound; the question that
was never asked is whether "fix everyone right away" or "trickle a few per
tick to spread the disruption" is the right default.

**The reach.** This fires again every time the floor changes, which you said
you plan to do. Whoever raises it next inherits a cron that restarts the
whole lagging fleet at once, silently, three hours later.

**Provisional call in effect:** none — the cron ships as "fix everyone
immediately." Reversible by adding a per-tick cap (e.g. resize/restart at
most K candidates per run) if the disruption turns out to matter in
practice.

### B2 · The onboarding journey's failure-path diagnostic mints an admin user it never deletes — FIXED

**Confidence: medium** — a real leak, but low real-world cost so far (a handful
of rows on a private staging account, not a security exposure).

The scenario: when Leg B's gate never opens, `captureVmLogs`
(`packages/test-harness/src/staging-e2e-synthetic`) needs an
internal-admin identity to call the new operator log endpoint. It does this:

```
adminEmail = "duet-so+onboarding-diagnostics-<now>@service.example.invalid"
POST /v1/admin/login-as { email: adminEmail, create: true }
```

Every other identity the journey creates is registered with
`ledger.record({ kind: 'user', ..., cleanup: ... })` so the harness's own
`cleanupAll()` deletes it at the end of the run. This one is not — it was
added fast, mid-chase, specifically for the failure path, and that
registration was simply never written. The result: every failed run —
and there were several tonight before the fixes landed — left a permanent,
admin-capable user account in staging that nothing will ever delete.

**The reach.** This only fires on failure, so it's invisible on the happy
path and will keep quietly accumulating rows every time this journey (or any
future one that copies this pattern) fails.

**Fixed after the audit, on request:** the diagnostic identity is now
registered with the ledger exactly like every other one this journey
creates (`cleanupPriority: -100`, cleanup + verify by email), so a failed
run tears down its admin user the same way a successful run tears down
everything else.

### B3 · The turn-started ceiling — raise attempted, then REVERTED once the real cause was found

**Confidence: high** (the revert), and the entry is kept precisely because the
first two answers here were wrong.

I raised this to 600s on measurement, and that was the wrong move. A second
reviewer pushed back with the argument I should have made myself: parallel
startup is bounded by `max(phase)`, not `sum(phase)`, so if one phase is the
cost then the concurrency fix in Example User/duet-agent#88 changes nothing — and
duet-agent has run in this product since the beginning without turn_start
problems, so "the agent is slow" was never a credible story. Reverted to
300s.

**What the ceiling was actually hiding**, found by finally measuring the
agent directly instead of inferring from the gateway:

| where | `turn_started` |
| --- | --- |
| local Mac, `bun src/cli.ts` | **1210ms** |
| same, with the Composio MCP config attached | 1076ms |
| inside the exact staging VM image (emulated amd64, 2 cores) | ~4.4s |
| same image, 4 CPU burners for contention | 15.1s |
| same image, with model-gateway credentials | ~5.0s |
| **real native exe.dev VM, same image, idle box** | **229202ms / 118805ms / >400s** |

The last row is the finding. That is `duet rpc` alone on a freshly created,
completely idle VM — no gateway, no syncthing, no apps, no MCP, no model
credentials, no skills, no drive, fresh database each run. The same binary
that starts in 1.2s on a laptop and ~4.4s under *emulation* in the very same
image takes two to four minutes on exe.dev's real hardware.

So every explanation this session chased is eliminated by construction, not
by argument: not the gateway (not running), not CPU contention (idle), not
PGlite (fresh db each run, and run 2 was still 119s), not MCP or model
credentials or skills or the drive (none present), and not #88 (the phases it
overlaps sum to about a second).

**The reach.** The bound is back at 300s and should stay there. The layer was
isolated: exe.dev VMs run at **63.4% average hypervisor steal** (measured on
five VMs, including two live production workspaces at 71% and 66%), so a noop
`bun -e "0"` costs ~19s. CPU-bound work and disk are fine; only being
*scheduled* is broken. Full evidence:
[`assets/e2e/vm-cpu-starvation.md`](assets/e2e/vm-cpu-starvation.md).

An A/B on one VM — same host, same steal, agent version the only variable —
settled the remaining question: **0.3.5 = 230790ms, 0.3.7 = 257604ms.** The
concurrency fix does not help. Both the reviewer's `max(phase)` argument and
my later "scheduling latency is per-await-hop" refinement predicted a win
there; neither survived contact with the measurement. No code change reaches
a 15s budget when a noop process spawn costs 19s.

**What I got wrong, twice:** first that a bigger number was a fix, then that
the measurement justifying it was sound. Both were symptom management. The
number only looked defensible because every observation of it had been
truncated by the very constant being tuned.

### B4 · The VM-size sweep's 3-hour cadence is an unexamined pick

**Confidence: low** — genuinely arbitrary, no signal either way.

No requirement was ever stated for how quickly a newly-undersized workspace
should be caught. 3 hours was chosen because it's what the interval crons
already registered in this file use for slower-moving sweeps, not because
anything about this problem calls for that number specifically. Given B1,
the cadence and the blast-radius question are coupled: a longer interval with
no per-tick cap is worse (more candidates pile up before the one big
restart-everything pass), a shorter interval with a per-tick cap is better
(steady trickle instead of a periodic bulk hit).

**The reach.** Whichever way B1 gets resolved, this number should be chosen
together with it, not independently.

**Provisional call in effect:** 3 hours, uncapped per tick. Reversible: it's
one literal in `crons.ts`.

## Redo (unsound)

### B5 · Only the route already in front of me got checked for the Bun idle-timeout risk

**Confidence: medium.** Real gap, not yet known to matter in practice.

The corrected decision: Bun's `idleTimeout` (255s, the provider's hard cap)
kills ANY handler on this server that holds a connection open past it without
writing bytes — that's a property of the whole `Bun.serve` instance in
`packages/gateway/src/runtime/http.ts`, not of the `/input` route specifically.
The fix only reached `/input`, because that's the route the stall chase was
already inside of. No sweep was done of the gateway's other routes — train job
polling, publish serving, anything else that could plausibly hold a request
open for minutes — to check whether any of them share the same shape and are
equally exposed. `/input` happens to be incidentally protected today because
it reads its body first (see B-note below); nothing says every other slow
route on this server does the same.

**The reach.** Any other route added later that legitimately runs long
inherits this exact risk unless someone remembers this specific incident.

**Redo from:** an inventory of every route on this gateway server for "can
this legitimately take longer than `idleTimeout`," not a fix scoped to
whichever one was already being debugged.

### B6 · The VM-size sweep has no backpressure against exe.dev's own API, only against user disruption

**Confidence: low-medium.** Not exercised yet — the fleet is far too small to
trigger it — but the gap is real and distinct from B1.

B1 is about how many live sessions get killed at once. This is a different
risk: if the fleet ever grows past a few dozen undersized VMs at the same
time, the sweep fires `resize` + `restart` against exe.dev's control plane
for each one, back to back, in a single cron invocation, with no concurrency
cap or rate limit against the provider itself. Nothing in this session
established what exe.dev's own tolerance for a burst of control-plane calls
is copying the pattern; it was simply never asked.

**Redo from:** whichever throttle B1 adds (a per-tick cap, a stagger delay)
should also bound how fast this hits exe.dev, not just how many user
sessions it disrupts — the same knob likely serves both, but it should be
sized against both, not one.

## Acknowledge (the architecture you now own)

### B7 · The internal-admin log endpoint enumerates sources; it never takes a path

**Confidence: high.**

Because these responses are deliberately unredacted (your call), the only
thing standing between an operator and the model/app credential stores
sitting in the same state directory is that the endpoint can name `gateway`
or `agent[/anchorId]` and nothing else — there is no path parameter to widen.
Proven, not just asserted: the anchor-id containment check was deleted and
the traversal test caught it immediately.

### B8 · `GatewayRuntime` grew a setter (`setRequestTimeoutExtender`) purely to bridge a construction-order gap

**Confidence: high.**

The route options are built before the real `Bun.serve` server exists —
`createGatewayRuntime` runs first, `Bun.serve` runs later in a different
function. There was no existing seam to reach the not-yet-created server, so
one was added: a mutable closure captured at construction time, filled in
once the server actually starts. It's the only place in this codebase that
needs this pattern today, but any future "the route needs something only the
running server has" problem should reuse this shape rather than inventing a
second one.

### B9 · The VM-size sweep re-derives "current size" from the lobby every run; nothing is cached on the workspace row

**Confidence: high.**

Deliberate, and explicitly reasoned from the incident that started this
whole chase: a cached size is exactly the kind of stale fact that let the
fleet run undersized for five days unnoticed. The sweep always asks the
lobby what's actually allocated, every time, rather than trusting a stored
number.

### B10 · A drain pass surfaces only its first failure to the caller; later ones in the same pass are logged, not returned

**Confidence: high.**

`drainWorkspaceOnRegister` (`apps/api/src/agent-runner.ts`) fixed the bug
where one failed session blocked every session behind it — but the fix
still only threads the *first* caught failure through to the return value
(now correctly surviving a later `stopped: 'limit'` too, per the review
fix). A second, third, or fourth failed session in the same pass is
`console.error`'d and otherwise dropped. Every session still gets attempted;
nothing is starved. But an operator watching only the return value's
`stopped`/`response` fields sees one wedged session per pass, never "these
three sessions all failed."

### B11 · `duet-agent`'s cold-start fix was delegated whole, verified by reading the diff, not re-audited by a second reviewer

**Confidence: medium.**

Every fix produced in *this* repo tonight got an independent second-agent
review pass (the six findings in the addendum's own history). The
`duet-agent` perf fix — five startup phases now concurrent, plus a real
race closed in `SkillContext.reload()` — got one thing: this session reading
the actual diff and reasoning about it directly. No separate adversarial
pass challenged codex's own claim that the five phases are genuinely
independent. The claim held up under direct inspection (each phase's own
code was read to confirm disjoint state), and the real Docker suite passed
(1,279 tests), but the asymmetry versus every other change tonight is real:
this is the one fix in the whole session that hasn't had a second opinion
beyond the one that wrote it.

**The reach.** It sits on its own branch, unreleased. Whoever reviews it
before publishing inherits exactly this gap — a second look at the
concurrency claim, not just the test result, would close it.

### Small calls, not itemized

Internal naming and reversible cosmetic picks: `INPUT_ROUTE_TIMEOUT_HEADROOM_MS`
(30s); `RESTART_RETRY_ATTEMPTS` (2); the log endpoint returning `available[]`
on every call so an operator never has to guess an `anchorId`; the anchor-id
containment regex; reusing `INTERNAL_ADMIN_MAX_FILE_BYTES` for log reads
instead of a new cap; the floor-guard test asserting `>=` rather than exact
equality (deliberately permits a future raise without breaking the test);
repurposing an already-duplicated test into the new log-route admin-gate
test instead of adding a fresh one; each VM-log source read reporting its own
status independently rather than failing the whole capture fast.

---

# Addendum — the 15-second goal and the completion that never came (2026-07-30)

The goal: e2e green with a fresh VM reaching turn_started and first tokens
within 15 seconds. Getting there produced four features nobody specced —
memory-database seeding, provider-side VM tagging, a session-scoped completion
endpoint, and a prompt-layer exclusion — plus two process calls. Every entry
below is a decision made without you. Review C1 and C2 first: both are calls
where your goal statement and my judgment pulled in different directions.

## Decide (needs-user)

### C1 · The e2e journey does NOT assert the 15-second bar

**Confidence: low** — your goal named a number; I chose not to enforce it.

The goal says a fresh VM should reach turn_started and first tokens within
15 seconds. The journey proves the *behavior* (both legs green, agent
completes itself) but never measures the 15s — and I left it that way
deliberately. The same code measured 13.9s at a 13-VM fleet and 113s at 14
VMs an hour later: turn-start time is dominated by how many VMs share the
account's CPU at that minute, which nothing in this repo controls. A hard
`expect(turnStarted < 15_000)` would make the required staging gate fail on
fleet load — a red that blocks unrelated merges and teaches everyone to
ignore it.

**In effect now:** timing is observable (`runner_turn_started` with
`startedInMs`, `agent_memory_db` with `seedOutcome` in every VM's gateway
log) but not asserted. **The unbuilt alternative:** the journey records
turn-start walls into its evidence JSON every run, and optionally asserts a
generous ceiling (say 120s) as a regression tripwire rather than the 15s
target. **Reversal:** either is an additive harness change; say the word.

### C2 · Sweeping tagged VMs stays a manual command, not an automation

**Confidence: low-medium** — you said "delete those after every e2e journey";
I made that a process rule plus a one-liner, not a machine.

Ephemeral VMs (workspaces born from the secret-gated programmatic-login path
— e2e journeys, diagnostic probes) now self-identify with a `duet-ephemeral`
provider tag. The sweep is `bun packages/exe/scripts/sweep-ephemeral-vms.ts`:
dry-run by default, `--delete` to act, documented in the harness README as an
after-every-journey step, and I ran it after this stretch's journeys (it
caught and deleted one leftover from a failed run). What I did NOT build: a
cron or a harness-teardown hook that deletes automatically. Deleting a VM
destroys its disk, the account is shared with prod, and the tag rail was
hours old — I wanted a human between "tagged" and "gone" until the tag has
some mileage.

**In effect now:** manual sweep, README rule, ledger cleanup still the
first line. **The unbuilt alternative:** a 3-hourly cron (like the resize
sweep) calling the same tag-scoped deletion — never touches an untagged VM
by construction. **Reversal:** additive; the deletion primitive already
exists and is tag-scoped.

### C3 · Staging has all of this; prod has none of it

**Confidence: high that deferring was right** — pushing prod is your call by
standing practice, so this is a reminder, not a question.

Everything in this addendum — memory seeding, tagging, the resize cron, the
session-scoped completion — is live on staging only. Two consequences sit
waiting: the two 1-cpu VMs on the account are **prod** workspaces (the
staging resize cron proved it can't see them), so they stay under-floor until
prod deploys; and prod agents still get the old slug-derivation completion
prompt if any prod agent ever declares onboarding.

## Acknowledge (the architecture you now own)

### C4 · Onboarding interviews no longer know the workspace has apps

**Confidence: medium** — I narrowed another feature's surface on one live
observation.

The session-app-pane work (merged in parallel) added a "your apps" prompt
layer to every agent session: it lists the workspace's apps and teaches the
session to move its own working directory into an app's folder to work on
it. In the live journey, the onboarding agent's *very first act* was obeying
that teaching — it relocated to the seeded `welcome/hello-app`, looked for
`ONBOARDING.md` there, and burned its opening turn finding its way back.
Onboarding launches now exclude that layer entirely; the agent learns its
apps in every session after onboarding.

The unbuilt alternative was keeping the layer but forbidding the move. I
chose exclusion because the interview has exactly one job and the layer adds
only distraction to it — but this is a product-behavior narrowing of someone
else's feature, decided on evidence from one run. If an author someday wants
an onboarding interview that references the workspace's apps, this is the
line to revisit.

### C5 · A second unlock endpoint exists, addressed by conversation instead of by name

**Confidence: medium-high** — verified 4/4 locally and once live, but it is
new public API surface you now own.

The completion contract failed twice live: the prompt told the model to
derive the workspace slug (`whoami`), then its own agent slug (list + filter),
then POST — and the model finished its interview, said "Onboarding
complete.", and never ran any of it. The fix adds
`POST /v1/ws/{slug}/agent/sessions/{sessionId}/onboarded`: the runner already
holds `$DUET_SESSION_ID` in its environment, the session row already knows
which agent it onboards (attributed from its working directory at creation),
so the generated prompt is now one copy-pasteable call with zero derivation.
The old `POST …/agents/{slug}/onboarded` is unchanged — it is the card's
human toggle, the redo path, and the fallback the prompt still teaches when a
gateway doesn't know its workspace slug yet.

Guardrails you should know exist: an ordinary conversation calling the
session route gets `409 not_onboarding_session` (the completion prompt only
ever exists inside onboarding sessions, and a second undocumented unlock
path would be a gift to prompt injection); a malformed or unknown session id
is a 404; and the audit event for a self-completion carries the `sessionId`
in its provenance, so "the agent unlocked itself" and "a human pressed the
toggle" are distinguishable forever after.

### C6 · Every new agent's memory starts as a copy of one boot-built template

**Confidence: medium-high** — measured thoroughly, but it's a new moving part
in every VM's boot.

An agent's first turn used to pay ~5.9s of CPU creating its PGlite memory
database from scratch (measured: 31.0s turn-start cold vs 7.8s against an
existing database, on the same VM). Now the gateway builds ONE empty database
at boot — by running a throwaway start of the *same pinned agent binary* that
will later read it, so the template can never be a version the reader must
migrate — and copies it into place whenever a new agent's state directory is
created. The boot build costs ~49s of CPU but lands during provisioning,
before any user exists; it makes no model call (it stops at turn_started).

Properties that hold by construction: the root agent's own database is never
the template (it accumulates root memories that must not appear inside a
per-agent store — the template is always built empty at a scratch path);
both build and copy write to a temp path and rename, so a crash cannot leave
a half-written database an agent would open as real; and every seam is
best-effort — no template means the agent creates its own exactly as before,
so the mechanism can only ever help. Each copy logs a named outcome
(`seeded` / `already-exists` / `no-template` / `copy-failed`), so whether
the optimization fired is a fact in the gateway log, not an inference from a
fast turn. One thing deliberately not built: the template is never rebuilt
when the agent binary updates — agents already open databases created by
older versions as their normal fast path, so a stale-version template is the
same benign case.

### C7 · Ephemeral workspaces are marked at the only gate that can know — OVERTURNED by ruling, replaced with an explicit option

**Original call, overturned same day:** the first version *inferred*
disposability — any user minted by `login-as { create: true }` got their
workspace marked ephemeral, on the reasoning that the secret-gated
programmatic-login path only ever creates test identities. Example User's ruling:
that bakes in an assumption that dies the moment login-as programmatically
creates a real customer, and an explicit option can also carry explicit
behavior.

**In effect now:** `ephemeral` is a login-as request option, never inferred.
`ephemeral: true` buys a 6-hour default lifetime; an epoch-ms timestamp
names the deletion moment; nothing outlives 24 hours from mint (the cap
clamps, enforced in the mutation so no caller can mint around it). The mark
sets `users.ephemeralExpiresAt`, and workspace BIRTH derives
`workspaces.ephemeral` from the owner's expiry (Example User's follow-up ruling in
the quadrant walk) — so the bootstrap workspace AND every workspace the
user creates during its lifetime are born marked, their VMs tagged
`duet-ephemeral`, keeping the sweep-visible set identical to the set the
expiry deletes. A 3-hourly cron erases expired identities: every workspace
they OWN through the real deletion path (the VM-teardown rail reclaims the
VM), then the identity itself via the same retire core the e2e ledger uses. A user created WITHOUT the option is
marked nothing — the removed assumption. Re-impersonating an existing
non-ephemeral user with `ephemeral` set is a 409 (deletion is not a
retrofit a second caller can bolt on); re-login against an
already-ephemeral user keeps the ORIGINAL expiry, because extension would
let a chain of re-logins outlive the cap. Unchanged from the original
entry: tags are fixed at VM creation, so the 13 pre-rail VMs stay
indistinguishable; the tag constants live in `@repo/contract` because
writer (convex) and sweeper (exe scripts) cannot import each other.

Sub-choices made inside the ruling, not specified by it: the deletion is a
**cron sweep, not a per-mint scheduled function** (a failed deletion
retries every 15 minutes instead of dying with its one job; 15min lag is
nothing against 6–24h lifetimes); an over-cap timestamp **clamps** to 24h
rather than erroring (the ruling's own phrasing — "delete timeout max 24
hrs"); a timestamp already in the past is **refused** (400) rather than
treated as delete-immediately; and the sweep deletes only workspaces the
user **owns** — an ephemeral user invited into someone else's live
workspace defers to a later tick rather than ever deleting a workspace
they merely joined. Every harness journey now passes `ephemeral: true`
explicitly; the run ledger remains the first cleanup line, the expiry the
backstop for killed runs.

### C8 · An onboarding session can still be cwd-moved; the spawn just refuses to follow

**Confidence: medium** — I considered locking the door and chose the
existing guardrail instead.

The cwd-move endpoint (`POST …/agent/sessions/{id}/cwd`, from
session-app-pane) will happily move an onboarding session's working
directory out of its agent's folder — the live derailment did exactly that.
What contains it: the session is *bound* to its agent's anchor at creation,
and the spawn-time resolver clamps any cwd outside the anchor back to the
anchor folder (`outside_agent_anchor` fallback), so the next turn still runs
in the right place with the right prompt layers. I did not add a
409-for-onboarding-sessions guard to the cwd route: with the apps layer gone
nothing teaches the interview to move, the clamp already makes a move
harmless, and the route belongs to another feature's contract. If a future
layer re-teaches movement, that guard is the next line of defense.

## Small calls, not itemized

**Sound, high confidence, one line each:** the session route requires the
`agents` capability (same as the slug route — it mutates agent state); the
route lives in `routes/agents.ts` beside its twin rather than the session
file; malformed session ids map to 404 rather than 400 (an unparseable id
IS a nonexistent session to the caller); the session lookup precedes the
actor check inside the mutation, matching the slug route's existing order
(every path still auths before any write); the completion prompt keeps its
two hard rules verbatim (never first turn, never delegate the call to the
user); the memory-template build model id derives from
`DEFAULT_CHAT_MODEL_ROLE` instead of a pinned literal; the failed-run
diagnostic identity follows the harness's `<runId>-…@service.example.invalid` convention;
`5d749dc6` carries formatter quote-churn on `skills-registry/generated.ts`
swept in by `git add -A` (content identical, self-consistent since).

---

# Second audit — the app-onboarding cutover (2026-08-16)

Commits `ea02c25d5`, `9edd20a81`, `7694ba736`, `fee360cb5`, `cab68b3da`. Four
official agents moved off app onboarding, two moved onto it, and apps gained
model access. Decisions Example User made himself in the thread (the credential-keyed
route over an env var; repurposing the connect-* apps rather than deleting them;
the app writing the kit; dropping the `services` gate on the gateway address)
are settled and not re-listed.

**Review these first:** U1 (the apps write to a folder they assume rather than
learn), N1 (a model id pinned inside app source), N2 (a security contract I
re-specced rather than restored).

---

## Redo (unsound)

### U1 · Both setup apps write to a hardcoded agent folder

**Confidence: low** — I do not think you would have chosen this, and I made the
identical mistake earlier in the same session and fixed it there.

**The scenario.** A user installs the Brand Designer from the marketplace. The
install dialog asks what to call it and they type "Branding" — so the agent's
folder on the drive is `agents/branding`. They open its setup page, type their
website, press **Use this brand**. The app writes the kit to
`agents/brand-designer/brand/brand-kit.md` — a folder belonging to nothing they
installed — and then marks the agent onboarded. The card unlocks. The agent
looks for its kit in its own folder, finds nothing, and refuses the first
request. The exact failure the write-before-unlock ordering exists to prevent,
reached by a different door.

Both apps do this. `server.ts` in each carries a module constant:

```ts
const AGENT_FOLDER = 'agents/brand-designer'   // setup-brand
const AGENT_FOLDER = 'agents/editor'           // setup-voice
```

Every write is built from it — the kit, the logo, the voice profile, the
samples. It is correct for exactly one workspace: the official hub, where the
seed registers agents at those canonical paths. For every user install it is a
guess, and `createSubscription` makes clear it is often wrong: the install path
is `agents/<the name the installer typed>`, falling back to the listing slug,
and on a collision the user picks a different path entirely.

**What the unbuilt alternative does.** The app learns its own agent's folder
instead of assuming it. It already proves which agent it belongs to every time
it finishes — `POST /v1/ws/:slug/app/onboarded` resolves the owning agent from
the app's credential alone. The same resolution, exposed as a *read*, is all
that is missing.

**The gap.** Nobody specified where an onboarding app writes. I reached for the
seed's canonical path because that is what the manifest says, and the manifest
describes the hub, not an install.

**The reach.** Every future onboarding app that writes anything will copy
whichever of these two it opens first — the scaffolding is deliberately copied
(see the note now in `AUTHORING.md`), so this constant propagates by design.
Fixing it after three more apps exist means fixing it in five places.

**The corrected decision to redo from:** *an app never assumes its own drive
location; it asks.* Concretely, add the credential-keyed read that mirrors the
route already added — `GET /v1/ws/:slug/app` returning the calling app and its
owning agent, including `anchorPath` — and have both apps resolve `AGENT_FOLDER`
at startup from that. The narrower alternative, writing through the filesystem
relative to the app's own working directory (`../..` is always the agent
folder), also holds in general and drops the `files:write` scope, at the cost of
losing API-level file attribution.

---

## Decide (needs-user)

### N1 · A model id is pinned inside app source

**Confidence: low** — this is a cost and catalog-policy call, not a code one.

**The scenario.** A user with no subscription presses **Use this brand**. The
app sends a completion to the workspace's model gateway naming a specific
model:

```ts
const TIER = 'economy'
const MODEL = 'openai/gpt-5.6-luna'
```

Both constants are copied into both apps. The gateway checks the tier the
workspace may spend in and forwards the call. `economy` is the only tier a
workspace without an active subscription can use — onboarding runs before anyone
has paid, so a higher tier would turn setup into a paywall — and
`openai/gpt-5.6-luna` is one of the two models `MODEL_TIERS.economy` currently
discloses.

**What the unbuilt alternative does.** The app asks the gateway what it may call
(`GET $DUET_GATEWAY_BASE_URL/v1/models` is an ungated read) and picks from the
answer, so a catalog edit reaches the app without touching its source.

**The gap.** Nothing said which model an app should use, or whether an app may
name one at all.

**The reach.** The seed apps ship into user drives as files. When the catalog
drops `gpt-5.6-luna`, every already-installed copy keeps asking for it and every
setup silently loses its derived sections — the apps treat an unreachable model
as "write the kit with those parts marked open", so the failure is quiet by
design. The tier pin is the load-bearing half and I am confident in it; the
model pin is the fragile half.

**Provisional call in effect:** the pinned pair above. **Reversal:** replace the
`MODEL` constant with a catalog read in each app's `duet.ts` — two files, no
contract change.

### N2 · A VM ingest test now asserts refusal where it asserted tolerance

**Confidence: low** — I changed what a security-adjacent contract claims, on a
test I did not own, to make a red branch green.

**The scenario.** The VM gateway posts a batch of file events to
`POST /v1/vm/file-events`. The batch is authenticated by the VM's own token, and
the workspace those events land in is derived from that token — never from the
body. A test asserted this by posting a batch with an extra `workspaceId` field
naming a *different* workspace and expecting `200`, with a comment: *"a smuggled
workspaceId is ignored and events land under the authenticated VM's workspace."*

That test had been failing since commit `a528e60fe` (three days before this
work), because the batch schema became `strictObject` — which rejects unknown
fields outright. So the shipped behavior is `400`, not an ignored field.

I re-specced the test to assert `400`, on the reasoning that refusing is
strictly safer than accepting-and-ignoring and that the property the test really
protects — the payload cannot choose its workspace — still holds, and is proven
directly by the rows the test then reads back.

**What the unbuilt alternative does.** Treat the strict schema as the drift and
loosen it back to a tolerant object, restoring accept-and-ignore. That is the
direction your own ruling in [[strict-schemas-antipattern]] points — schemas
tolerate unknown fields — and `d1c87ff9e` is literally titled *"schemas accept
unknown fields by default; loose only where justified"*.

**The gap.** Nobody said which side of that cutover was intended for this
endpoint. The commit that made it strict did not update the test, so the two
have disagreed since.

**The reach.** This is a wire between two independently deployed components. A
strict ingest schema means a VM gateway that adds a field to its batch gets the
whole batch rejected until the API catches up — the lockstep-release hazard your
tolerance rule exists to avoid. Whichever way it resolves should probably match
every other VM→API ingest route.

**Provisional call in effect:** the test now documents refusal, matching shipped
code. **Reversal:** change `FileEventBatchSchema` from `strictObject` to
`object` in `packages/contract/src/file-attribution/index.ts` and flip the
assertion back; the security property is unaffected either way.

### N3 · The Editor's floor, dial, and vocabulary are mine

**Confidence: medium** — ordinary product taste, but taste in your product.

**The scenario.** An author drops one blog post into the Voice Setup page. The
app counts words, finds 140, and refuses: *"That is about 140 words. Add a bit
more — two or three finished pieces read best."* At 150 it accepts. Then it
offers exactly three ways to say how far an edit may go — **Light**
("Copyedit only. No restructuring"), **Balanced** ("Structure, then line. Hands
back a rewrite"), **Firm** ("Restructure freely when the argument needs it") —
and writes the chosen one into the profile as a rule the agent acts on.

Every number and word there is mine: the 150-word floor, the cap of five
samples, the three-way split, their names, and their one-line rules. The
Balanced rule is the only one with a source — it restates the agent's own
"more than about a third rewritten, hand back the diagnosis instead".

**The gap.** Your instruction was "some settings about the writing style". One
setting, three values, and a floor is my reading of "some".

**The reach.** These strings become the vocabulary the agent and the user share
about editing, and the profile file records the licence by name — so renaming a
tier later means migrating profiles already written.

**Provisional call in effect:** as above. **Reversal:** all four values live in
`LICENCES` and `LICENCE_RULE` in one file; the floor is `MIN_WORDS`.

---

## Acknowledge (sound)

### S1 · The write happens before the unlock, in both apps

Confirming does three things in a fixed order: write the artifact, mark the
agent onboarded, then record local state. If the file write fails the app
returns `502` and the agent stays locked — there is a test for it in each app.
The alternative ordering unlocks a seat whose material does not exist, which is
the original defect this whole thread started from. **Load-bearing: every future
onboarding app must copy this order.**

### S2 · One owner for "which agent owns this path"

`setAppAgentOnboarded` needs to turn an app into its agent. I first wrote a
string-prefix walk in Convex, then found `resolveNearestAgent` in the contract
already owned that decision — path normalization, nearest-by-depth, launch
eligibility — and that `resolveSessionAgent` already used it to attribute a
session from its working directory. Extracted `resolveAgentForPath` so both come
through one answer, and moved the `toAgent` projection down beside
`agentDisplayName` to break the import cycle that created. My original walk
differed in three ways that would have drifted apart.

One consequence to know: that owner filters to *launchable* agents, so an app
belonging to a disabled agent, or one whose folder anchor is not active, gets
`409 not_agent_app` rather than onboarding it. Deliberate, and the route comment
says so.

### S3 · `subscriber` is required in the delivery validator, not optional

The field reached the launch payload but not the mutation's returns validator,
so every runner delivery threw at runtime while typechecking clean — which is
what took out forty api tests by killing their deployment mid-file. The commit
that added it called the field optional, but that optionality belongs to the
wire toward the gateway; this validator describes what *this mutation* returns,
and its single construction always sets it. Required is the honest shape, and
hoisting `runnerDispatchValidator` gave it one owner instead of three.

### S4 · Sync credentials are accepted before desired state

Accepting desired state is what spawns apps, and an app's environment now
carries the model gateway address. Accepting credentials afterwards left every
app in the first payload — the whole fleet on a cold VM — without it until
something restarted them.

### S5 · Slugs kept, titles rewritten

The four repurposed apps keep their `connect-*` slugs, because renaming leaves
residue in the official hub, which never deletes. Their titles and headings were
rewritten to name what the page now controls, and `connect-repos` was corrected
from "Connect your helpdesk" — a copy-paste that predates this work.

### S6 · The onboarding chat returns the user to their workspace

Where a chat hands over an authorize link, `redirectTo` is `/w/$WORKSPACE_SLUG`
— the workspace home, not the agent's own page. Any Duet path fixes the stray
tab; the workspace home needs no slug the interview would have to derive.

### S7 · Two steps, one input

Both apps read first and write on a second press, rather than acting on the
first. The user sees what was read before anything is committed, which is what
makes a mis-typed domain or a mis-attached file recoverable.

### S8 · The logo is proxied, not hotlinked

The brand page loads the logo from the app's own `/api/logo` rather than the
brand's CDN. A screenshot caught the broken-image glyph; the same refusal would
hit real users whose CDN blocks cross-origin requests from the app frame.

### S9 · Sample text is held in memory, and a restart now refuses

Uploaded writing is not persisted until the author confirms. That choice created
a hole — a restart in between left the app confirming with an empty prompt and
recording invented prose as "what to preserve" — which is now a `409` that
clears the profile and asks again.

### S10 · Trivial discretion, not itemized

App slugs (`setup-brand`, `setup-voice`) and display names; the four visual scene
ids per app; `parseSections` duplicated across the two pages rather than shared;
the two app icons generated programmatically as flat shapes rather than through
the media-creation skill; `expectOneAudit` gaining a named `alsoRecords`
parameter rather than loosening its count; the neutral `.pill.off` chip added to
the scope pages.

---

## Resolved after the audit (2026-08-16)

**U1 — redone.** Both apps now read `$DUET_AGENT_DIR`, injected by the gateway
and resolved through `resolveNearestAgent`, the same contract owner the
app-onboarded route uses. Absence is "not ready": the app reports not-ready and
refuses to write, because a write to a guessed folder succeeds and the failure
is therefore silent. Their tests use a folder that is deliberately not the
manifest's, so hardcoding goes red. An audit of every app found no other
hardcoded drive path. Landed in `a5ed11c6c`.

**N1 — withdrawn, not a needs-user.** Example User ruled the model pin is correct: a
prebuilt app choosing its model is the point, and choosing well is the author's
job. The tier pin stands on evidence rather than caution — `billedCostForGeneration`
prices a tiered generation at its TIER's rates and only falls back to upstream
cost when no tier is claimed, so `frontier` would bill 6.7x economy on output for
identical tokens. The header is also mandatory: a non-internal model with no
`x-duet-tier` is `403 tier_not_allowed`.

**N2 — resolved, and the drift was real.** `d1c87ff9e` made the file-attribution
schemas loose by policy; `a528e60fe` silently made them strict again while
cutting over the activity contract, with no justification and without updating
the test. The envelope is loose again — an unknown key there changes nothing,
because the workspace comes from the VM's token — and the events inside stay
strict for a reason now written down: they refuse a caller-supplied `userId`,
which is resolved server-side at read time. That is the "loose only where
justified" carve-out doing its job.

**Where app data lives — settled by Example User, no change.** An app's data stays in
the app and is edited through its API, so the app validates the write and the
open page keeps one owner; an agent editing the file directly could put it in a
state neither survives. The agent's own material — a brand kit, a voice profile,
anything a skill defines the shape of — is drive content in the agent's folder.
The rule is now in AUTHORING.md with its test: whoever owns the schema owns the
file.

---

# Third audit — the services tier and the greetings (2026-08-16)

Commits `fcc788a93`, `4bb3a3257`. Example User set the direction on all three headline
calls — an `app`-then-`services` tier billing at model cost, apps told where they
live rather than assuming, app data staying behind the app's API — so those are
settled. What follows is what I decided inside them.

**Review first:** N4, then S11.

---

## Decide (needs-user)

### N4 · The services tier sits outside the tier enum, so nothing user-facing can see it · confidence: medium

**The scenario.** You asked for a tier that bills every model at its own rate.
The obvious build adds a fourth member to `MODEL_TIER_IDS`, the list that
already holds `frontier`, `balanced`, `economy`. I did not, and the reason is
what that list feeds: `PUBLIC_TIER_PRICING` on the marketing site derives from
`Object.values(MODEL_TIERS)`, and the agent's own system prompt renders a plan
ladder from `MODEL_TIER_IDS.map(...)`. A fourth member would have published
"Services" as a plan people can buy and told every agent it was a rung on the
ladder.

So the concept split in two:

- `MODEL_TIER_IDS` — the three a **person** picks. Unchanged, so the pricing
  page and the plan prompt are untouched.
- `ATTRIBUTION_TIER_IDS` — what a **generation** records. Four.

Columns follow the split: `gatewayGenerations.tier` and the credit ledger's
metadata widened; `agentSessions.tier` and the session snapshot stayed at three.

**The gap.** "Make an app tier" does not say whether it is a tier in the product
sense or only in the billing sense.

**The reach.** Anyone adding a tier later has to know which list to add it to,
and the answer depends on whether a human can choose it. Get it wrong toward
`MODEL_TIER_IDS` and it appears on the pricing page; wrong toward the other and
nobody can select it.

**Verdict:** needs-user, because it is a product-surface call rather than a code
one — but I am fairly confident: publishing "Services" as a purchasable plan is
clearly not what you asked for. **In effect now:** the split above. **Reversal:**
one line moves `SERVICES_ATTRIBUTION_TIER` into `MODEL_TIER_IDS`; the lander and
the plan prompt then pick it up automatically, which is exactly why it is out.

---

## Acknowledge (sound)

### S11 · A tier claim and permission to spend are two different gates

Writing the tests corrected something the code comments had implied. `services`
asks for **no subscription** — that is the tier's own requirement, and it is what
lets an onboarding app work. But whether the workspace may spend *at all* is a
separate, earlier gate in `isSpendEntitledAt`: an active subscription, **or** a
trial still inside its window with credit above the hard floor. A lapsed
non-subscriber cannot spend under any tier, `services` included.

That matters for the product, not just the prose: an app's model call works
during the trial window — which is exactly when onboarding runs — and stops when
the trial lapses without a subscription. Both apps already treat an unreachable
model as "write the artifact with those sections marked open", so the failure
degrades rather than breaks. The comments and the skill now say the gates
separately.

### S12 · The services tier carries no closure

The three user tiers list the models their router routes to, hand-synced with
duet-agent's table. `tierContainsModel` returns true for `services` on any model,
because the caller named the model itself and whether it may run is the
catalog's decision — `evaluateModelAccess` still refuses a paid-only model to a
non-subscriber, so this opens no door. A closure here would have been a second
copy of the catalog, drifting.

### S13 · Both flakes were test defects, and the fix pinned the variable rather than widening the assertion

The servicing-decommission test scoped its "elsewhere" query to
`listMine()[0]`; the fixture workspace belongs to the same owner, so under some
orderings that resolved to the fixture itself and the assertion contradicted
itself. It now creates its own second workspace. The folder-move projection test
hardcoded the rename at seq 101; it now reads back the seq the rename actually
got. Neither loosened what was asserted — the exact-cost assertion in particular
is deliberately tight and stayed tight.

### S14 · Greetings were rewritten against what each seat now knows

Six of seven asked for what onboarding had just collected. Each now opens on the
first piece of work. Two kept their question because setup deliberately leaves
that thing open: the Sales Development Rep connects an email and not a target,
and the Editor reads the author's voice and not the draft. The rule and its
exception are in AUTHORING.md, so the next author does not have to notice.

### S15 · Trivial discretion, not itemized

`tierBillsAtFlatRate` as the predicate name and its placement in the contract
beside the tier table; `attributionTierIdValidator` mirroring the existing
`modelTierIdValidator` naming; the trial fixture chosen for the preflight test
over hand-patching billing rows; the wording of the six greetings within the
300-character cap.
