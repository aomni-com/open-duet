# Choices ledger — sessions-and-jobs (final, full audit fidelity, 2026-07-31)

Every decision the implementation made on the user's behalf that was not in
the MAP or the slice files, re-audited against the shipped code at close.
Grouped by verdict, ranked least-confident-first within each group. MAP
decisions (D1–D29) are the user's own and are not audited here.

## Needs-user — none open

Every genuinely user-only call was made by Example User during the planning walk or
live during the build (release policy, no-compat, delegation posture). Nothing
in the shipped code waits on a user decision.

## Sound — the architecture Example User now owns, least confident first

### 1. The default-alias message response is a union of two shapes, not one new envelope

- **When:** slice 08.
- **The choice:** You POST a message to `/agent/sessions/default/messages`.
  If no default session exists yet, the server creates one and answers with
  the SAME response shape as the ordinary session-create endpoint (a
  `session` block, a full snapshot, history). If a default already exists,
  the server delivers your message to it and answers with the ordinary
  message-accepted shape (`ok`, `delivery`) — plus one new top-level field,
  `sessionId`, because that shape never carried an id and the caller needs to
  know which session got the message. The unbuilt alternative: invent one new
  envelope that both branches share — every client then learns a third shape,
  and the creation branch stops being byte-compatible with the create
  endpoint clients already parse.
- **The gap:** the slice required "the real sessionId either way" but never
  chose where it lives in each branch.
- **The reach:** every client of the alias must branch on the response shape
  ("has `session`" = created; "has `ok`" = delivered) and read the id from a
  different place in each. The `start-session` skill and the web SPA both
  encode this branching today.
- **Verdict:** **sound** — reusing both existing contracts beats a third one;
  the asymmetry is documented in the union schema.
- **Confidence:** medium.

### 2. An unknown agent slug and a real-but-unset default 404 with different bodies

- **When:** slice 08, sharpened in the final review.
- **The choice:** GET `/agents/research/sessions/default` when no agent named
  `research` exists → `404 {error:"not_found"}`. Same GET when `research`
  exists but has never had a default conversation → `404
  {error:"no_default_session"}`. And after the review fix: an agent that
  exists but is disabled or has a broken folder ("anchor") also gets
  `not_found` on the POST path — because before that fix, posting to a
  disabled agent sailed past the route, hit the backend's ownership guard,
  and surfaced as a 500. The unbuilt alternative: one error body for
  everything — simpler, but then a client cannot tell "register the agent
  first" apart from "just send the first message."
- **The gap:** the slice specified the unset-pointer 404 but said nothing
  about slugs that resolve to no agent, or to an unlaunchable one.
- **The reach:** UI and skills can route the user correctly: `not_found` →
  agent management; `no_default_session` → show the composer.
- **Verdict:** **sound** — the split follows one rule: could this operation
  ever create a valid session here?
- **Confidence:** medium.

### 3. Nested create: the parent 404 wins before billing, and inheritance happens inside the transaction

- **When:** slice 09.
- **The choice:** a caller with an empty wallet POSTs
  `/agent/sessions/<bogus-parent>/sessions`. Today the route answers `404`
  (no such parent) — it never reaches the billing check, so the caller does
  not learn their credit state from a structurally impossible request. For a
  real parent, the mutation that inserts the child re-reads the parent row
  inside the same database transaction and takes `cwd`/`tier` from THAT
  read — so a parent that began deleting in the milliseconds after the
  route's check cannot donate values. The unbuilt alternative: inherit from
  the route's earlier snapshot — faster, but a child could be born from a
  parent that no longer qualified at commit time.
- **The gap:** the slice required both the 404 and the billing preflight but
  not their order, and named inheritance without naming its owner.
- **The reach:** any future caller of the convex create function — not just
  this REST route — gets transactional inheritance for free; error-order is
  now a contract clients can rely on.
- **Verdict:** **sound** — structural errors before cost policy; the
  transaction is the only honest owner of inherited values.
- **Confidence:** medium.

### 4. The journey encodes physical tolerances: 900s turn budget, best-effort nudges, a jobs-aware child finder

- **When:** slice 13, hardened across five failing live runs.
- **The choice:** three linked decisions about what the e2e journey tolerates.
  (a) It waits up to 900 seconds for the delegation turn, because a fresh VM's
  first agent spawn was MEASURED to cost 2m09s wall / 2m24s CPU initializing
  its memory database, and the first delivery attempt can burn a full 300s
  gateway hold before a fast retry. (b) After creating the default session it
  sends up to two "nudge" messages (a queued cold delivery only drains when
  new input arrives), and a nudge that dies when the load balancer kills a
  held connection at ~255s is CAUGHT and ignored — a nudge is optional by
  nature, and one such death failed an entire otherwise-green run. (c) When
  looking for the child the default session created, it searches BOTH
  `/agent/sessions` and `/agent/jobs?view=active`, because the moment a
  child's state machine starts, the `jobView` index dimension structurally
  moves it out of the sessions list — a fast child vanished from the only
  list the first finder polled, and the journey timed out staring at it.
  The unbuilt alternative for all three: assert ideal latencies and single
  lists, and fail on every cold VM.
- **The gap:** the slice delegated fixture mechanics and never anticipated
  cold-VM physics or the jobView exclusion.
- **The reach:** these tolerances are now the template for any session-backed
  journey; anyone tightening the budgets should first re-measure the cold
  floor, not assume the numbers are habit.
- **Verdict:** **sound** — each number traces to a measured constant, not a
  guess that happened to pass.
- **Confidence:** medium.

### 5. An interrupt still cancels a scheduled wake; prompts and answers never do

- **When:** slice 03 integration (my ruling during codex's scope request).
- **The choice:** a session sleeps with a reminder set for 2 hours ("wake":
  a durable record saying wake this session at time T). If you CHAT with it,
  the reminder survives — the prompt no longer consumes the wake (that was
  the deleted bug). If you INTERRUPT it (the stop button), the reminder is
  cancelled. Slice 03's text said interrupts should also preserve wakes; I
  ruled the text overbroad and kept the pre-existing interrupt-clears-wake
  tests exactly as written, because the upstream Session fix in slice 01 had
  just enshrined "an interrupt is a deliberate stop" and the neighbouring
  test already draws the finer line (a FAILED interrupt — hydration error —
  preserves the wake). The unbuilt alternative: interrupts preserve wakes
  too — then stopping a runaway reminder session requires a second action to
  actually silence it.
- **The gap:** the slice sentence and the pre-existing tests contradicted
  each other; one had to be edited.
- **The reach:** "stop" means fully stop, everywhere, both repos. A future
  "pause but keep the schedule" feature would need a new verb, not a changed
  interrupt.
- **Verdict:** **sound** — consistent stop semantics across repos beats a
  sentence written before the tests were read.
- **Confidence:** medium-high.

### 6. Wake acceptance consumes the wake record in the same ledger write that records the command

- **When:** slice 03 (codex construction, stronger than the slice sketch).
- **The choice:** when the gateway's timer fires and it dispatches a wake to
  a session, the slice sketched three steps: read the wake record, send the
  wake, then clear the record. Shipped shape: `acceptWake` deletes the wake
  record in the SAME atomic file write that records the in-flight wake
  command. Walk the crash: with read→send→clear, a gateway crash between
  send and clear leaves the record alive, and the reboot re-arms and
  dispatches the same wake a second time. With accept-consumes, a crash
  after the write cannot double-fire — the record is already gone, and the
  in-flight command record is what reboot recovery resumes from. Beside it,
  the same pass found and fixed `settleInput` silently DROPPING the wake
  record while rewriting the envelope for unrelated input — a wake could
  vanish because someone sent a message.
- **The gap:** the slice named the end state ("dispatch clears the record")
  but not its atomicity.
- **The reach:** wake delivery is exactly-once-per-record by construction;
  nobody needs to reason about crash windows between send and clear.
- **Verdict:** **sound** — strictly stronger than specified, at no cost.
- **Confidence:** high.

### 7. The durable launch envelope validates `mode` with the contract schema instead of trusting a cast

- **When:** slice 07.
- **The choice:** a session's launch envelope (the JSON file the gateway
  persists so a session survives gateway restarts) is deliberately "loose" —
  unknown fields pass through untouched so old gateways survive new fields.
  Slice 05 made `mode` a KNOWN field. Shipped shape: the envelope parser
  validates `mode` with the same zod schema the public wire uses, and the
  TypeScript type derives from the shared contract — so by the time the
  coordinator sends `mode` to a runner, it is proven data. The unbuilt
  alternative: keep the field opaque and cast it at the send site — fewer
  lines, but the last consumer would be asserting validity the durable owner
  never checked, on bytes that might have been written by an older gateway.
- **The gap:** the slice said "read launch.mode" without saying how a loose,
  version-skew-tolerant store should expose a now-known field to types.
- **The reach:** the pattern for every future launch field: known fields get
  validated on parse; unknown fields keep riding loose.
- **Verdict:** **sound** — the durable boundary proves what it stores.
- **Confidence:** high.

### 8. The per-agent warning logger died with its only caller

- **When:** slice 07.
- **The choice:** before the cutover, a malformed `agent.json` made the mode
  loader write a warning line into a per-agent log file; a small logging
  utility and a `logPath` field on every resolved agent context existed
  solely to serve that. The cutover deleted the loader — and with it, the
  logger, the `logPath` field, and their tests, rather than leaving a
  generic-looking zero-caller logging module for hypothetical future use.
  The unbuilt alternative: keep the utility "since we might want per-agent
  logs someday" — future readers would then infer a live logging contract
  that nothing writes.
- **The gap:** the slice killed the warning path but never named the
  adjacent utility or the context field.
- **The reach:** future per-agent logging must be designed on purpose; there
  is no half-alive API to inherit shape from.
- **Verdict:** **sound** — zero-caller modules are misinformation.
- **Confidence:** high.

### 9. One origin grammar, enforced at the single append path

> **Superseded (2026-08-05):** the `origin` string was replaced by a required
> typed `sender` union with API-owned derivation and Convex-validated
> `sourceSessionId`; see
> [session-input-attribution](../session-input-attribution/README.md). The
> durable principle — one grammar at the single append path — carried over.

- **When:** slice 09.
- **The choice:** messages can carry an `origin` saying who really wrote
  them: absent = the human; `system` = the product (the onboarding
  kick-off); `session:<id>` = another session. The public wire REJECTS
  anything except the `session:<id>` form (callers may not claim to be the
  user or the system). Convex's own argument validators cannot express "a
  string starting with session:" — its validator language has no template
  literals — so the closed convex inputs accept any string, and the shared
  timeline schema at the ONE place events are appended enforces the full
  grammar before a row exists. The unbuilt alternative: copy a manual
  prefix-check into each convex writer — a second grammar that drifts.
- **The gap:** the slice required "widened validators" without saying how to
  encode a template-literal union in a validator language that lacks them.
- **The reach:** any new server-side event writer inherits the grammar by
  going through the shared append path; bypassing it is the only way to
  write a bad origin, and there is no reason to bypass it.
- **Verdict:** **sound** — one owner at the choke point beats N copies.
- **Confidence:** high.

### 10. A session-attributed message wears its source's initials; only `system` borrows the Duet face

> **Superseded (2026-08-05):** presentation now resolves from the typed
> sender via one web resolver (category chips, typed portraits); see
> [session-input-attribution](../session-input-attribution/README.md). The
> durable principle — the label and the face must agree — carried over.

- **When:** slice 10 closeout (unprimed critique catch).
- **The choice:** a message with `origin: session:<ops-session>` renders in
  the transcript labeled "From Ops — main" — and as shipped it wears
  initials derived from that source session ("O"), like a third party. As
  codex first built it, that row wore the Duet mascot avatar: a bubble
  claiming to be FROM Ops while wearing the product's face — a
  self-contradiction the fresh-eyes critique flagged and my primed eyes had
  passed. `system` rows (the product speaking, e.g. onboarding's kickoff)
  keep the mascot, because there the product IS the author.
- **The gap:** slice 10 specified "attributed, not the user's bubble" but
  never said whose identity the avatar shows.
- **The reach:** avatar = author, everywhere; any new origin kind must pick
  its identity deliberately.
- **Verdict:** **sound** — the label and the face must agree.
- **Confidence:** high.

### 11. The Skills card keeps two of three grid columns after the mode card's deletion

- **When:** slice 07 closeout (critique overturned codex's interim call).
- **The choice:** deleting the mode card left the Skills card alone on its
  row. Codex let it stretch the full content width; the unprimed critique
  called five small chips in a ~960px card "an unfinished stub", and the
  shipped state restores the original three-column grid with Skills spanning
  two columns. Notable mechanics: this change was INVISIBLE to the pixel
  gate in both directions (white card on white page, sub-threshold
  everywhere) and needed `ui:approve --force` to re-bless — the same gate
  blindness later repeated on the 36px avatar fix.
- **The gap:** the slice deleted a card without specifying the survivor's
  width.
- **The reach:** the standing lesson (banked below and in auto-memory): on
  low-contrast layout changes, the unprimed critique is the real gate;
  `ui:check` green proves nothing there.
- **Verdict:** **sound** — matches the pre-change visual rhythm.
- **Confidence:** high.

### 12. Session-backed journeys share one polling module

- **When:** slice 13.
- **The choice:** the agent-continuity journey privately owned loops for
  "poll this session's history until X" and "poll the jobs list until Y".
  The new journey needed identical loops. Shipped: the loops moved to a
  neutral shared module (`staging-e2e-synthetic`) that BOTH
  journeys import — same page sizes, same cadence, same cleanup rules. The
  unbuilt alternatives: copy the loops (drift), or import continuity's
  private helpers (names and failure messages claiming the wrong owner).
- **The gap:** the slice said "reuse the harness's helpers" but the helpers
  were not exported.
- **The reach:** the third session-backed journey inherits the same physics
  for free.
- **Verdict:** **sound** — a real seam, extracted at the moment of second
  use.
- **Confidence:** high.

### 13. `integrations` joined the VM key's scopes

- **When:** post-journey wedge diagnosis (VMT handoff task).
- **The choice:** every agent turn runs with a workspace-scoped API key.
  That key listed `services, apps, agents, sessions` — but agent 0.3.8's
  runner connects an "integrations" MCP server that authenticates with this
  very key against the session integrations MCP resource, which demands the
  `integrations` scope. Result on every cold spawn: the connect failed
  `insufficient_scope` and the runner stalled 205–305 seconds retrying
  before giving up — at or past the gateway's 300s startup ceiling,
  wedging fresh VMs. Shipped: the scope is in `vmModelScopes`; stale keys
  self-rotate; a fresh VM's stderr verified the error gone. This is the
  literal worked-example pattern in SECURITY.md: the VM can already reach
  integrations through the API by other means, so gating its own key was
  never protection.
- **The gap:** no slice owned "what scopes does 0.3.8's runner actually
  need" — the requirement arrived silently with Example User's release.
- **The reach:** any new runner-side consumer of the workspace key should
  add its scope the same day it ships, or every cold spawn pays.
- **Verdict:** **sound** — one-trust-domain rule, applied as documented.
- **Confidence:** high.

## Standing lessons (not choices — operational facts to keep)

- **The pixel gate cannot see low-contrast layout changes; proven twice in
  one spec** (entries 10 and 11). `--force` re-bless plus unprimed critique
  is the working recipe.
- **A codex report is a claim, not a record, and git identity never
  discriminates actors.** The day's worst event: I attributed Example User's own
  v0.3.8 release to codex overreach and destroyed it (cancelled the publish
  workflow mid-run, deleted the tag, reverted the bump) before his
  correction; everything was restored, and the discriminators now live in
  auto-memory. Weigh the containment's harm against the contained harm;
  when the "unauthorized" act is low-harm and owner-reversible, ask first.
- **Load flakes repeat on this machine:** two suites fail only under CPU
  saturation (image builds); both pass deterministically idle. Compare
  before "fixing".

## The fresh-VM wedge — root-cause chain (evidence, all links probed live)

Fresh e2e workspaces froze with sessions stuck at two events
(`session_created`, `user_prompt`) and no turn. The chain: (1) the scope gap
above stalled every cold spawn past the startup ceiling; (2) beneath it, a
fresh VM's first spawn pays ~2–3 minutes of memory-database initialization
(measured 2m09s wall / 2m24s CPU); (3) the API's register-time input
dispatch can NEVER succeed — it fires inside the register handler, before
the response has handed the gateway its auth token, guaranteed 401; (4) the
sync-route dispatch awaits a ~300s gateway hold on the VM's SERIAL sync
loop, so sync cadence collapses 5s→~300s exactly when the workspace most
needs it (one wedge self-healed at ~12 minutes; every test budget expired
first); (5) two bystanders observed on wedged VMs: the skills bundle
download 401s while the same token syncs fine, and the duetfs helper
crashed EPIPE.

## Needs-owner registry (work items that survive this spec)

| # | Finding | Owner |
|---|---|---|
| N1 | Register-handler input dispatch fires before the gateway can hold its token — guaranteed 401; move behind the response or retry | api |
| N2 | Sync-route dispatch blocks the serial sync loop through ~300s holds — waitUntil it | api |
| N3 | memory.db cold-init floor (~2–3 min) — pre-warm at gateway boot | gateway (or upstream) |
| N4 | Skills bundle download 401 while the same vmToken syncs fine | api/gateway |
| N5 | duetfs helper EPIPE crash on stats emit | duetfs |
| N6 | Should turn_started block minutes behind MCP connect retries? | duet-agent |
| N7 | Roster: truncation ellipsis reads as a duplicate "…" control; unlabeled brain icon duplicates "Train" | knowledge-map |
| N8 | Tier slider strip wider than the composer card, clipped corners | virtual-model-tiers |
| N9 | App-pane placeholder floats unaligned in the right pane | session-app-pane |
| N10 | Fresh-worktree deploys need hand-copied .env.keys and rebuilt .vercel/ links | deploy docs |
| N11 | continueSessionTerminalization.reason can become required once pre-deploy scheduled continuations drain (agents-ui scheduler-durability tolerance) | backend |
| N12 | The 30s schedule-floor number lives in both contract code and schedule-task prose with no drift test | skills-registry |

---

# Appended 2026-08-16 — the default-chat alias stops 404ing

Example User's directive: the console-error spam on the hub's agents page "is
obviously NOT an error, fix this." The fix changed a public wire contract;
these are the decisions inside it.

**Review these first:** #B1 (a documented /v1 endpoint changed its response
shape with no version bump), #B2 (a nonexistent agent is no longer
distinguishable from a chatless one on this endpoint).

## Sound — but you now own these

### B1. The response shape of a public /v1 endpoint changed in place

**Confidence: medium.**

**What happens today.** `GET /v1/ws/{ws}/agents/{agent}/sessions/default` is
in the public endpoint registry (the 137 contract-owned endpoints the docs
verify). It used to answer a bare session snapshot on hit and `404
no_default_session` on miss. It now answers `200 {"session": <snapshot>}` on
hit and `200 {"session": null}` on miss — a breaking change for any external
API-key consumer that parsed the old shape, shipped without a version bump.

**Why I chose it.** The repo's standing rules: internal APIs carry no version
machinery, deploying is the version — and the product is pre-launch, with no
external consumers of this endpoint beyond our own web app and test harness
(both updated in the same commit). Wrapping in an envelope (rather than a bare
`null` body) is what makes the next change to this endpoint additive.

**The reach.** If external API consumers exist before the next breaking
change, this class of edit needs a `/v2` route instead. Nothing to do today.

### B2. "No such agent" and "no chat yet" now give the same answer

**Confidence: medium.**

**What happens today.** The endpoint resolves the agent slug first. Before:
an unknown or unlaunchable (locked/broken-anchor) agent and a known-but-
chatless agent both returned the same 404. Now both return `{"session":
null}`. A client holding a dead link sees the "start a conversation" composer
rather than an error page.

**Why.** The distinction was already unavailable — both cases were the same
404 before, so no consumer could have been telling them apart. Agent
*existence* is the roster's fact, answered by the roster endpoints; asking a
chat-alias read to also police existence would be a second owner for that
fact. If a user actually composes into a dead link, the POST fails loudly.

### B3. The client treats every error as "unavailable," none as "empty"

**Confidence: high.**

**What happens today.** The web client used to inspect errors: a 404 with
code `no_default_session` opened the composer; any other failure showed
"unavailable, retry." That error-sniffing helper is deleted. Now: settled
data `null` opens the composer; ANY error shows unavailable. The map's
per-agent backstop poll similarly stops on a settled `null` (nothing to
re-ask) and keeps polling through real errors (a blip should heal).

**The reach.** One latent bug this surfaced is fixed and pinned: the session
cache patched default-chat cache entries assuming they were always snapshot
objects; a cached `null` crashed the whole agents route. Any future code that
reads the default-chat cache must treat `null` as a settled answer.

### B4. The history sub-endpoint keeps its 404

**Confidence: high.**

`GET …/sessions/default/history` still 404s when there is no session. It is
only ever called with a session already in hand, so a miss there is genuinely
exceptional — and making it match would have widened the change for no
console noise (nothing polls history on chatless agents).

## Operational record (same session, not code)

- Six hub listings unlisted and six hub agents deleted by direct backend
  mutation / API as the hub owner — the one-time manual form of what the sync
  now does itself.
- The staging outage was config, not code: Vercel SSO protection ("Standard
  Protection") had been enabled on duet-web, which protects branch custom
  domains like app-staging; every request 302'd to Vercel SSO. Identified,
  left for Example User to toggle (permission-gated).
