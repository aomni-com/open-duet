# Suggested First Message — choices ledger

Decisions the build made that the map (D1–D11) did not settle. Audited
2026-08-13 after the review pass, on branch tip `ac7cef71`. Map decisions are
givens and are not re-listed.

## Review these first

The two least-confident calls in the whole ledger: **the root-page picker
carries the selected agent's greeting into the root default chat** (needs-user
#1) and **a corrupted known event now disappears silently instead of failing
loudly** (sound #1). Read those two even if you skim the rest.

---

## Needs-user (decide; each has a reversible provisional call)

### 1. ~~Picker selection greets the root chat~~ — RESOLVED by Example User 2026-08-13: the picker was legacy; deleted

- **The original choice:** my build let the compose surface's agent picker
  carry the selected agent's greeting into whatever chat it minted —
  including the workspace's one root conversation.
- **The resolution:** the picker turned out to be residue of the deleted
  new-session page: the map preselects one owner on every surface it mounts,
  so the multi-agent select was reachable from nowhere. Example User's call: delete
  the surface, not gate it. The compose bar's agent-select capability
  (`ComposeBar`'s `agent` picker prop and payload `agentId`) and the web's
  picker machinery (`selectedAgentId` state, option lists, `?agent`
  multi-resolution) are gone; each session surface now resolves ONE owner
  from its host (`resolveSessionOwner`, `session-owner.ts`) — the drive root
  or one agent — and only an agent owner can greet. Root structurally never
  greets.
- **The reach:** any future "talk to an agent from the root page" feature
  reintroduces selection deliberately, at the map, not in the composer.

### 2. The 23 authored messages are mine, in your approved voice

- **When:** seed pass (`fc45a75e`).
- **The choice:** You approved the warm-intro voice from one sample
  (account-researcher). I wrote the other 22 to the same shape: first person,
  one line of what the seat does for you, ending in the first concrete
  hand-over. They live in each agent's `agent.json` under
  `packages/official-agents-seed/content/agents/`.
- **The gap:** The map said "expect copy edits from Example User" — the actual words
  were never reviewed.
- **The reach:** These are the first words every new user hears from every
  official agent. They reach staging only when the hub is re-synced, so
  nothing is user-visible yet.
- **Verdict:** needs-user. **Provisional call (shipped):** my copy stands
  until you edit. **To reverse:** edit any `agent.json`, run
  `bun run codegen`, commit, re-sync the hub — per message, any time.
- **Confidence:** medium (voice was approved; the words weren't).

---

## Sound (acknowledge — architecture you now own)

### 1. A corrupted known event now vanishes from the transcript instead of erroring

- **When:** tolerant-read rework (`b858bba2`).
- **The choice:** The wire's event list is a union that ends in a catch-all
  ("any object with a `type` string"). The union is tried in order, so an
  event that *claims* a known type but is missing required fields — say a
  `step` event with no `step` payload, which before this change would have
  failed the entire history request loudly — now falls through to the
  catch-all, parses "successfully" as an unknown event, and the UI renders
  nothing for it. The unbuilt alternative: only genuinely *unknown* type
  strings get the catch-all, and a malformed known-type event still fails
  the request (or at least logs).
- **The gap:** D10 chose tolerance for unknown *types*; it said nothing about
  malformed *known* types.
- **The reach:** Any future serialization bug on a known event will show up
  as silently missing transcript rows, not as a visible error. Debugging that
  starts from "a row is missing", which is quieter than "the page errored".
- **Verdict:** sound — one corrupt row should not take down a whole
  transcript, and the write side (`appendEvent`) still validates strictly, so
  our own writer cannot produce such rows; only a genuine cross-version skew
  or data corruption can. The corrected decision, if you disagree: make the
  catch-all's schema exclude known type strings, so malformed known events
  fail loudly again.
- **Confidence:** medium.

### 2. The greeting reaches the model through the first delivery's event tail, not a stored flag

- **When:** backend pass (`eb672667`).
- **The choice:** When the runner gets its first turn, Convex reads every
  event after the last-delivered cursor (which starts at 0 for a new
  session), finds the `agent_message` row in that tail, and renders it into
  the envelope as `<agent_first_message>…</agent_first_message>` ahead of the
  user's message. Nothing is stored saying "this delivery includes the
  greeting" — the *only* reason it appears exactly once is that the cursor
  never rewinds, so no later delivery's tail can contain that row. The
  unbuilt alternative: thread the greeting text explicitly through the
  create call into the first dispatch.
- **The gap:** D1 said "rendered into the first envelope"; the mechanism was
  unspecified.
- **The reach:** Anything that ever replays deliveries from an earlier cursor
  (a redelivery feature, a cursor reset in surgery) would re-quote the
  greeting to the model. Harmless today; a constraint to know about.
- **Verdict:** sound — it derives "first envelope" from the same cursor that
  defines delivery order instead of duplicating that fact in a second flag.
- **Confidence:** high.

### 3. The envelope tag is bare — no seq, no timestamp

- **When:** backend pass (`eb672667`).
- **The choice:** User messages render to the model as
  `<user_message seq="3" timestamp="…" user_email="…">`. The greeting renders
  as plain `<agent_first_message>text</agent_first_message>` — no attributes —
  because it is the agent's *own* prior words, not attributed input from
  someone; the model needs the text, not provenance.
- **The gap:** Envelope shape unspecified.
- **The reach:** Prompt-shaped contract: the duet-agent runner and any prompt
  tooling will see this exact tag. Renaming later is a model-visible change.
- **Verdict:** sound. **Confidence:** high.

### 4. Over-long authored text truncates; blank text disappears — neither ever errors

- **When:** review pass (`ac7cef71`).
- **The choice:** One shared normalizer (`normalizeAgentFirstMessage` in the
  contract) trims whitespace, drops blank-only text, and hard-truncates at
  2,000 characters, at the config read *and* at the Convex write. Walk the
  failure it prevents: an author puts a 2,500-character greeting in
  `agent.json`; without the read-side clamp, the browser would render all
  2,500 and then the wire schema (max 2,000) would reject the request — the
  *user's first message* would fail with a 400 because of the *agent's*
  config. With the clamp, the bubble shows the truncated text and that same
  text is what sends and stores. The unbuilt alternatives: reject over-long
  config outright (drop the greeting entirely), or let the wire 400.
- **The gap:** The map set the authored gate (~300, official agents only);
  it never said what happens when a non-official agent's config exceeds the
  wire cap.
- **The reach:** 2,000 is now the hard ceiling for any client; mid-sentence
  truncation is the failure mode for oversized text rather than absence or
  error.
- **Verdict:** sound — a degraded bubble beats a failed first send.
  **Confidence:** medium-high.

### 5. Names: `agent_message`, `agentFirstMessage`, `suggestedFirstMessage`

- **When:** contract pass (`0bcb56ef`), map plan #1 (explicitly delegated,
  most-likely-tweaked).
- **The choice:** The durable event type is the *general* name
  `agent_message` (a message authored by the agent outside any turn), even
  though today's only writer is session creation; the wire field and envelope
  tag say `first`; the config field says `suggested`. Three names because they
  are three different things: a suggestion (may never be sent), a carried
  first message (this create), a stored agent message (general).
- **The gap:** Delegated, but rename cost changes at prod: the event type is
  in durable rows once real data exists (staging is wipeable today).
- **The reach:** Future "agent posts a message outside a turn" features can
  reuse `agent_message` without a new type.
- **Verdict:** sound. **Confidence:** medium — rename window closes at prod
  promotion.

### 6. ~~Congrats + greeting stacked layout~~ — OVERTAKEN by Example User 2026-08-13: the congrats block is deleted

- **What happened:** the audit's re-shot of the registry-static congrats
  scene (which had never run under the scoped gates) revealed the celebration
  text was already failing to render — the router-state-driven celebration
  was racy before this feature (at the pre-feature commit it showed on
  desktop but not mobile) and lost consistently after it. Example User's call:
  delete the 🎉 "agent is ready" block outright; the just-onboarded agent's
  empty chat now opens on its suggested first message like any other first
  visit. The confetti burst survives and is sturdier: it latches for six
  seconds from the moment the completion navigation is consumed
  (`confettiFor` in `SessionsProduct`), instead of riding the clearable
  state that was losing the race. The congrats copy, its playground
  scenarios, and the celebration submit plumbing are all deleted.

### 7. The pending timeline now knows the agent's face before the session exists

- **When:** web pass (`60dfc8a1`).
- **The choice:** While the create request is in flight there is no session
  snapshot, so the timeline used to have no agent identity — an agent bubble
  there would have worn the generic Duet mark. I made the pending view
  resolve the agent by matching the pending working directory against the
  agent list, so the greeting bubble (and anything else agent-voiced) wears
  the right avatar during the handoff. Side effect: this improved identity
  applies to the pending state generally, not just greetings.
- **The gap:** The map never mentioned the handoff window's identity.
- **Verdict:** sound. **Confidence:** high.

### 8. The seed gate checks presence and length through the resolver — not voice

- **When:** seed pass (`fc45a75e`).
- **The choice:** `seed.test.ts` fails an official agent whose `agent.json`
  lacks a resolvable suggestion or exceeds 300 chars; it does not enforce
  "ends with a question" or any tone rule. Voice lives in AUTHORING.md for a
  human reviewer, mirroring how the refusal-quality rule already works there.
- **Verdict:** sound. **Confidence:** high.

### Trivial discretion (one line each)

Event lands after the tier-clamp notice (both precede the prompt; order
invisible to users) · blank wire values dropped silently rather than 400ing ·
playground fixture gives the `research` agent a greeting, which reshot several
mobile baselines that embed that pane · docs sentence added to
`apps/docs/app/agents/page.mdx` · timestamp asymmetry already recorded in the
map's post-build notes.
