# Voice mode choices ledger

## Accepted

| Choice | Why |
| --- | --- |
| One platform Python worker | LiveKit's first-class MCP integration is Python-only; one worker avoids per-agent deployment/state. |
| Voice is not an agent record | The selected agent is the real identity and Main memory owner; a hidden agent would imply files, training, and roster ownership. |
| Separate Voice and Main sessions | The call needs a clean retained transcript/audio record while Main needs its existing long-lived reasoning history. |
| New `voiceCalls` row denotes channel | Existing text-session rows remain canonical without a data migration or optional compatibility reader. |
| Dedicated `agentSessionAudio` owner | Audio has binary, quota, playout, and deletion semantics distinct from prompt images; no image-table rename or migration. |
| Three bound MCP tools | `main_send`, `main_read`, and an identifier-free `main_cancel` cover request, answer, polling, and explicit cancellation. Barge-in and End never cancel. |
| Agent query is a first-class MCP feature | `/?agent=root` or `/?agent=<slug>` selects a normalized default-session view; the Voice credential additionally enforces the same binding. |
| One-time dispatch ticket | Browser receives only the LiveKit participant token; the external worker gets no reusable workspace credential. |
| LiveKit Inference + Fish | It avoids a separate Fish key, supplies ZDR, and offers the newly launched S2.1 Pro Free model for the prototype. |
| Duet owns retention | LiveKit observability is disabled; transcript/audio lifetime follows the retained session and its deletion cascade. |
| Default-to-Main policy | Small talk is the narrow exception. Ambiguous or substantive content always uses the memory/tool-owning agent. |
| Non-blocking screenshot checkpoint | Playground screenshots remain available for feedback, but their approval does not stall implementation. |

## Rejected

| Alternative | Reason |
| --- | --- |
| Hidden, official, installed, or workspace Voice agent | Creates a false user-facing identity and parallel agent lifecycle. |
| ComposeBar mode or dedicated call route | Voice is an independent overlay launched from the card and must not navigate. |
| Existing MCP `run_agent` | Creates a fresh root session and loses selected-agent default-session continuity. |
| Voice gets the full MCP registry | It could answer or act without Main and exposes unrelated tools/arguments. |
| Workspace/agent arguments in LLM tool schemas | The server already knows the call binding; exposing selectors invites cross-target mistakes. |
| Browser session or API key in LiveKit Cloud | Exports a reusable workspace credential across the external boundary. |
| Per-agent workspace capability | `SECURITY.md` treats the workspace VM as one trust domain; binding is for the external call credential, not internal isolation theater. |
| Reuse OAuth/app/impersonation credentials | Wrong issuer, lifetime, revocation, and semantic owner for one call. |
| Browser carries worker ticket | Unnecessarily exposes a Duet bearer and creates a participant/worker join race. |
| Direct Fish key from the worker | Adds another provider credential and may lose LiveKit Inference ZDR. |
| Node worker | Gives up the first-class LiveKit MCP integration for no product benefit. |
| LiveKit observability/recording as retained record | Duplicates Duet ownership and has a separate retention policy. |
| Save full synthesized TTS on interruption | Stores words the user never heard. |
| Cancel Main on barge-in | Confuses playback interruption with reasoning work. |
| Put Main tool/reasoning events in Voice session | Makes the call record noisy and couples two intentionally separate sessions. |
| Base64 audio or image upload reuse | Wrong wire, caps, media semantics, and deletion owner. |
| Rename/generalize the image table | Requires a migration for unrelated existing data. |
| Auto-resume/pair registry in v1 | Adds state without helping the simplest complete call architecture. |
| Compatibility layer, dual writer, or legacy worker | Explicitly rejected by the user; every new seam lands once in its canonical form. |

## Evidence-conditioned choices

These are not delegated to an implementer's taste. Slice 03 records one
selection and its evidence before downstream work:

- STT model and language/endpointing configuration.
- Fast Voice LLM and policy-prompt configuration.
- Fish model and stock voice ID.
- Ogg/Opus segmentation and the exact owner of played-prefix capture.
- Warm/cold latency budget and LiveKit plan/concurrency requirement.

If the report cannot select a compliant option, the feature stops at the
spike. It does not grow a fallback architecture.

## Implementation ledger

### Sound

#### Slice 05 — keep the aggregate retention budget on the call row

- **When** — Slice 05 retained Voice session and audio pass.
- **The choice** — Each saved audio part owns its own size in
  `agentSessionAudio`, while `voiceCalls.retainedAudioBytes` keeps the running
  total used to admit the next part. For example, after a call has retained 63
  MiB, a 2 MiB utterance is refused in the same database transaction instead
  of loading and summing every earlier utterance. The unbuilt alternative was
  to rescan the entire call on every message, which gets slower without a
  finite database-read guarantee as the conversation grows.
- **The gap** — The plan froze the 64 MiB ceiling and per-part owner but did
  not say how to enforce an aggregate limit with bounded reads.
- **The reach** — Every future audio writer must update this counter in the
  same transaction as its one canonical audio row; retries and rejected parts
  must leave it unchanged.
- **Verdict** — sound. It preserves one owner for each part while giving the
  call a bounded, atomic admission ledger.
- **Confidence** — high.

#### Slice 05 — use the utterance id as the retained media id

- **When** — Slice 05 retained Voice session and audio pass.
- **The choice** — The worker already gives each spoken turn a stable
  `utteranceId`; the retained event uses that same value as `audioMediaId`. A
  retry of “utterance-7” therefore finds the same event and same playable audio
  without minting another identifier. The unbuilt alternative was a second
  random media id that the first commit would have to return and every retry
  would have to rediscover.
- **The gap** — The event contract required both names but did not specify how
  the media id is generated.
- **The reach** — Replay URLs and the future retained Voice UI can address an
  audio part directly from its canonical event, and duplicate uploads converge
  on that address.
- **Verdict** — sound. One stable identity is simpler and does not merge two
  independently meaningful objects: one utterance has exactly one retained
  audio prefix.
- **Confidence** — medium.

#### Slice 05 — first terminal boundary wins

- **When** — Slice 05 retained Voice session and audio pass.
- **The choice** — Ending a running call appends one terminal event and changes
  the session status. If a disconnect callback arrives after the user already
  pressed End, the callback receives the existing terminal result and does not
  rewrite `user` into `disconnect`. The unbuilt alternative was allowing late
  infrastructure callbacks to change the durable explanation of how the call
  ended.
- **The gap** — The plan required idempotent end behavior but did not state how
  two different end reasons race.
- **The reach** — Analytics, the ended UI, and credential revocation can trust
  one stable boundary even when browser and worker cleanup happen together.
- **Verdict** — sound. The first observed terminal transition is the only one
  that can describe the session consistently.
- **Confidence** — high.

#### Slice 05 — do not publish a worker upload route before bound auth exists

- **When** — Slice 05 retained Voice session and audio pass.
- **The choice** — Slice 05 lands the tested binary storage and idempotent
  commit core, but the public multipart endpoint opens only in Slice 06 after a
  worker holds a credential bound to this exact call. The unbuilt alternative
  was a temporary endpoint authenticated like a general workspace caller and
  removed or tightened one slice later.
- **The gap** — Slice 05 described the multipart route while Slice 06 owns the
  only credential that is allowed to call it.
- **The reach** — MIME/signature parsing and mid-upload route cleanup remain a
  Slice 06 gate, and no compatibility route or deploy-order bridge can become
  accidental product surface.
- **Verdict** — sound. It keeps the hard-cut security seam single and avoids
  shipping a knowingly over-broad intermediate contract.
- **Confidence** — high.

#### Slice 05 review — a storage blob has one retained audio owner globally

- **When** — Independent review follow-up after the Slice 05 commit.
- **The choice** — Before attaching uploaded bytes to a Voice message, the
  backend checks whether that Convex storage ID already belongs to any retained
  audio row. If call B presents call A's storage ID, B gets a content-free
  conflict and A's audio remains untouched. The unbuilt alternative treated
  “same storage ID” as a retry local to B, which could delete A's canonical
  blob as loser cleanup or let both calls point at bytes that either deletion
  could erase.
- **The gap** — The plan required one audio metadata owner and duplicate loser
  cleanup but did not state whether storage identity was unique only inside a
  call or across the whole storage table.
- **The reach** — Every future upload/commit path must check the global storage
  owner before insertion or cleanup; only an unowned fresh upload may be
  discarded as a loser.
- **Verdict** — sound. Blob lifetime cannot be correct if two independently
  deletable sessions own the same underlying bytes.
- **Confidence** — high.

#### Slice 05 review — a deleting activation is a conflict, not a resumable retry

- **When** — Independent review follow-up after the Slice 05 commit.
- **The choice** — An activation retry normally returns the call that first
  claimed its request ID, but once that call's retained session is marked
  deleting it rejects the retry. The unbuilt alternative returned the hidden
  call during the bounded deletion cascade, giving the browser identifiers it
  could no longer read or use.
- **The gap** — The plan required both activation and deletion idempotency but
  did not define their overlap window.
- **The reach** — Slice 06 maps this internal conflict at the activation route;
  clients mint a new request ID only for a genuinely new call rather than
  reviving a deleted one.
- **Verdict** — sound. Deletion is a terminal product decision and must win
  over retry recovery.
- **Confidence** — high.
## Slice 03 evidence pass — 2026-08-01

This pass stopped RED, so none of the evidence-conditioned production choices
above became accepted. The entries here describe only decisions embedded in
the disposable probe.

### Needs-user

#### Omit a partly spoken word from the candidate retained transcript

- **When:** Slice 03 local heard-prefix falsification pass.
- **The choice:** Suppose playback stops halfway through the word “three.” The
  probe keeps the audio bytes up to the browser's last acknowledged playback
  frame, but its text record ends at “One two” because “three” did not reach its
  known end time. The unbuilt alternative would save the partial word as text,
  which better reflects what the listener may have inferred but requires a
  defined way to represent incomplete speech.
- **The gap:** The spec requires the transcript to exclude the unplayed tail and
  explicitly tests a mid-word interruption, but it does not say whether a
  partially heard word belongs in the retained text.
- **The reach:** Slice 08 must choose transcript semantics when real TTS word
  timing is available. Search, session display, and future model context will
  inherit that choice even though the saved audio itself remains exact.
- **Verdict:** **needs-user.** The reversible provisional call is to omit the
  incomplete word: it cannot accidentally claim unheard text, and the RED
  report prevents this probe policy from becoming production behavior. Reverse
  it by defining an explicit partial-word representation after the integrated
  LiveKit interruption evidence exists.
- **Confidence:** medium.

### Sound

#### Keep the browser remote-track ledger as a falsification candidate, not a selection

- **When:** Slice 03 local falsification and Cloud-readiness passes.
- **The choice:** The probe first proved that desktop Chrome could acknowledge
  and trim a local Ogg/Opus fixture. Its same-path candidate now has the browser
  capture PCM (raw audio samples) from the decoded LiveKit remote track while
  the same audio graph sends those samples to the output device. The mechanism
  and tests stay checked in while the decision report explicitly forbids
  downstream code from treating them as authoritative before the Cloud/mobile
  run. The alternative would either discard all local learning or, more
  dangerously, call an unrun remote-track design proof of what a listener heard.
- **The gap:** The spec says to stop when the same-path proof is unavailable but
  does not say whether a reusable partial harness should remain in the RED
  evidence pass.
- **The reach:** A later Slice 03 run can wire and falsify the candidate through
  a real room instead of rebuilding it. Slices 05 and 08 remain unconstrained
  because the dated report selects no capture owner, signal, or codec mechanism.
- **Verdict:** **sound.** Preserving a clearly quarantined experiment reduces
  repeat work without weakening the stop/go boundary.
- **Confidence:** high.

#### Pin the disposable probe to exact Python and browser package releases

- **When:** Slice 03 locked runtime-probe setup.
- **The choice:** A fresh checkout asks `uv` for Python 3.12 and installs the
  exact LiveKit, MCP, media, test, type-check, and lint versions in the Python
  lockfile. The nested browser probe separately pins its LiveKit client and
  TypeScript toolchain in a Bun lockfile. The unbuilt alternative would allow a
  newer runtime or dependency to resolve on each run, which could silently
  change model constructors, codec output, WebRTC behavior, or MCP transport
  behavior between evidence samples.
- **The gap:** The spec mandates Python, `uv`, and a locked dependency set but
  does not choose the Python minor release or the exact tool releases.
- **The reach:** Reproduction of this dated evidence is stable. This does not
  choose the Python version for the future production worker; Slice 08 must
  reassess supported releases before graduating any code.
- **Verdict:** **sound.** Exact pins fit a disposable measurement artifact and
  remain isolated from product dependency policy.
- **Confidence:** high.

#### Prove worker metadata receipt with a content-free SHA-256 room attribute

- **When:** Slice 03 explicit-dispatch probe setup.
- **The choice:** The dispatcher sends candidate configuration plus a random
  nonce in opaque job metadata. After the worker starts its session, it hashes
  that metadata and publishes only the 64-character digest as a participant
  attribute; the browser-side probe waits for the matching digest before it
  records a sample. The unbuilt alternative would echo the metadata itself,
  which is easier to inspect but creates a pattern that could expose a future
  one-time ticket or other bearer value.
- **The gap:** The spec requires proof that the named worker read opaque job
  metadata, but does not define the acknowledgement channel or safe evidence
  shape.
- **The reach:** Cloud measurements can correlate one dispatch without writing
  credentials or user content. The attribute is a disposable probe contract,
  not a production call API; Slice 08 must not inherit it automatically.
- **Verdict:** **sound.** A one-way digest proves equality for the probe while
  keeping the checked evidence content-free.
- **Confidence:** high.

#### Make the generated Ogg evidence byte-stable

- **When:** Slice 03 closeout reproduction gate.
- **The choice:** Two runs can encode the same speech yet get different Ogg
  bytes because the media container normally chooses a random stream serial
  number. The probe enables FFmpeg's bit-exact mode, so the same checked source
  now produces the same audio bytes and SHA-256 hashes on repeated runs. The
  unbuilt alternative would compare only decoded duration and accept changing
  container bytes, leaving every documented reproduction with a dirty evidence
  diff and uncomparable hashes.
- **The gap:** The spec asks for a deterministic spoken fixture and reproducible
  codec evidence but does not state whether determinism stops at decoded sound
  or includes the generated container bytes.
- **The reach:** Reviewers can distinguish a real fixture change from an Ogg
  serial-number accident. This constrains only evidence generation; production
  media segmentation still requires the unavailable same-path Cloud/mobile
  proof.
- **Verdict:** **sound.** Stable bytes make the checked hashes useful without
  changing the decoded audio or making a production codec selection.
- **Confidence:** high.
## Slice 04 audited choices

All audited choices are sound. They are ordered from the decisions most worth
reviewing to the ones most strongly implied by existing behavior.

### Sound — terminal detail is preserved without inventing prose

**When:** Slice 04 Main-result normalization.

**The choice:** A successful `complete` event uses its result text; if Main
instead supplies an error on that terminal, the error becomes the required
text; and a terminal with neither becomes an empty string. An `interrupted`
event keeps its error as optional text, while `sleep` has no invented message.
For example, an interruption tagged `agent_deleted` remains that exact detail
for a later Voice policy to phrase safely. The unbuilt alternative was for the
low-level normalizer to author friendly sentences, which would mix transport
mapping with the worker's speaking policy and could misstate the failure.

**The gap:** The result union fixed which terminal states have required or
optional text, but it did not say how optional fields on existing Main events
populate them.

**The reach:** Slice 08 owns user-facing phrasing; Slice 07 must pass these
details through without treating them as ready-to-speak copy.

**Verdict:** Sound — the reducer remains factual and deterministic, and the
speaking layer retains control of wording.

**Confidence:** Medium.

### Sound — one text result represents every question in one ask event

**When:** Slice 04 Main-result normalization.

**The choice:** Main can pause and return an `ask` event containing more than
one question, while the Voice product contract has room for one `text` string.
The normalizer keeps every question in order and separates them with newline
characters. For example, “Which account?” and “For what date?” become one
two-line prompt, so Voice can speak both. The unbuilt alternatives were to
return only the first question, which would silently lose information, or to
change the already-frozen Voice result shape to expose an array.

**The gap:** The slice froze a single question result string but did not say
how an existing multi-question Main event should fit inside it.

**The reach:** Slice 07's `main_read` output and Slice 08's spoken-question
behavior inherit this lossless, ordered reduction.

**Verdict:** Sound — it preserves all Main-authored content without widening
the frozen tool contract.

**Confidence:** Medium.

### Sound — transport failures become four stable product reasons

**When:** Slice 04 Main-result normalization.

**The choice:** A blocked payment response becomes `billing_blocked`; failing
to launch the selected agent becomes `unlaunchable`; reading a default session
that was removed becomes `deleted`; and every other route or network failure
becomes `unavailable`. This means the future Voice worker sees a small product
vocabulary rather than HTTP status codes and backend error-body wording. The
unbuilt alternative was to pass those transport details through, which would
make Voice prompts and retry behavior depend on API implementation copy.

**The gap:** The slice listed the outcomes that must be distinguishable but did
not freeze the exact `reason` strings or the catch-all grouping.

**The reach:** Slices 07–08 will use these values for retry policy and spoken
recovery wording, so renaming one later is a tool-contract change.

**Verdict:** Sound — the four names preserve every product-relevant distinction
the slice requested and keep internal transport details out of MCP.

**Confidence:** Medium.

### Sound — one runner completion may settle several request IDs

**When:** Slice 04 durable terminal correlation.

**The choice:** If request A starts Main and request B reaches that same live
runner before it finishes, the runner emits one terminal event for the combined
turn. That terminal records both A and B as owners, so polling either receipt
can deterministically see the result. If B is merely queued in backend storage
and has not reached the runner, it is delivered after A finishes and is not
attached to A's terminal. The unbuilt alternative was to choose one “primary”
request ID, which would leave the other accepted request working forever even
though its runner turn had ended.

```text
runner accepts A
runner accepts B before terminal -> terminal owns [A, B]
runner terminalizes
backend later dispatches queued C -> next terminal owns [C]
```

**The gap:** The slice required one request to find its own result but did not
say how ownership works when the existing gateway accepts multiple commands
into one live turn.

**The reach:** The gateway's durable relay record, backend history rows, and
Slice 07 polling all inherit this many-requests-to-one-terminal rule.

**Verdict:** Sound — it follows the runner's real turn boundary and prevents an
accepted request from becoming permanently unresolvable.

**Confidence:** High.
## Slice implementation audit

### Wait for a settled onboarding lock before exposing Call

- **ELI5 scenario:** a custom agent card can appear before its `agent.json`
  finishes loading. Treating that moment as unlocked would make Call flash on
  a card that may immediately become onboarding-locked.
- **Plan gap:** the product rule defined locked and unlocked cards, but did not
  say what to do during the existing unresolved loading state.
- **Choice:** keep the roster's lock value unresolved until both agent and
  config data exist, and require the settled `false` value for Call. Do not add
  a Voice-specific eligibility flag.
- **Reach:** future controls that require an onboarded agent can reuse the same
  settled state; the choice does not change the final eligibility matrix.
- **Verdict:** sound, high confidence. It preserves the frozen lock rule across
  cold loads instead of creating a transient exception.

### Keep the callback optional until the overlay slice owns it

- **ELI5 scenario:** Slice 01 puts the phone on the real card, while Slice 02
  supplies the overlay that opens when it is pressed.
- **Plan gap:** the callback payload was frozen, but the incremental contract
  did not require an interim production owner before the overlay exists.
- **Choice:** thread one optional `onStartVoiceCall(card)` callback through the
  existing roster. The deterministic playground supplies it now; Slice 02 will
  supply the production owner rather than adding a no-op owner or second state
  projection in Slice 01.
- **Reach:** the card seam remains stable when the overlay lands, although the
  affordance is intentionally inert in production for this single completed
  slice.
- **Verdict:** sound, medium confidence. It honors the slice's explicit
  no-overlay boundary and avoids temporary architecture, but the brief inert
  interval depends on the planned immediate Slice 02 follow-up.

### Restore focus from the workspace that owns the overlay

- **When:** Slice 02 controlled Voice overlay.
- **The choice:** `AgentsWorkspace` records the focused Call control before it
  opens the single overlay and restores that element after Close. On mobile the
  card lives inside a rail that closes under the call, so the stable return
  target is the roster trigger. The card itself still emits only the selected
  `AgentRosterCard` and never owns modal state.
- **The gap:** The slice required restored focus but did not assign that work
  across the card callback, mobile rail, and overlay owner.
- **Reach:** Slice 09 can replace the controlled callbacks with transport and
  navigation without moving focus or duplicating an overlay per viewport.
- **Verdict:** sound, high confidence. The owner that creates and removes the
  dialog is the only layer with both the old and new focus targets.

### Retry the failed boundary instead of restarting every call

- **When:** Slice 02 unavailable-state reducer.
- **The choice:** A microphone denial retries at `requesting_permission`; an
  agent or connection failure retries at `connecting`. Permission failures use
  microphone-specific copy and every other failure honestly names the Main
  dependency. The unbuilt alternative restarted permission for failures that
  happen only after it was already granted.
- **The gap:** The state list required appropriate retry actions but did not
  define which boundary each reason resumes.
- **Reach:** Slice 09's transport controller must dispatch the matching action
  and may not add a parallel retry state machine.
- **Verdict:** sound, high confidence. Each retry repeats only the operation
  that can recover the recorded failure.

### Fix one two-line caption viewport across active phases

- **When:** Slice 02 visual state checkpoint.
- **The choice:** The overlay reserves one two-line rolling-caption area even
  when a phase has no caption. New runtime text replaces the old caption; it
  never grows into a timeline. The unbuilt alternative let the identity and
  controls jump vertically whenever listening, waiting, and speaking carried
  different amounts of text.
- **The gap:** The spec froze one rolling caption and stable geometry but did
  not choose the bounded density.
- **Reach:** Slice 09 may stream incremental captions into this same viewport;
  longer text remains available to assistive technology while the visual call
  surface stays calm.
- **Verdict:** sound, medium confidence. Two lines preserve a useful spoken
  fragment without letting captions take over the call.

### Project the correlation cursor, not Main session identity, to Voice

- **When:** Wave 1 maintenance checkpoint after integrating Slice 04.
- **The choice:** The MCP server consumes the full `MainSendReceipt` internally
  for routing, but the Voice model receives only `created`, `delivery`, and
  `startCursor`. Its first `main_read` passes that cursor and later polls pass
  the preceding result cursor. The unbuilt alternative exposed
  `mainSessionId`, contradicting the bound-tool rule and asking the model to
  carry an identifier it is forbidden to select.
- **The gap:** The root seam exposed a Main session ID while Slice 07 explicitly
  forbade session identifiers, and Slice 07 omitted the cursor that Slice 04
  proved necessary for correct turn ownership.
- **The reach:** Slice 07 must use the permanent correlation normalizers without
  leaking their internal routing identity; the worker ledger owns only request
  IDs and cursors.
- **Verdict:** sound, high confidence. It preserves the durable race proof and
  narrows the LLM-visible surface at the same time.

### Construct the bound registry at authentication time

- **When:** Slices 06 and 07 external credential review.
- **The choice:** The MCP transport validates the credential audience and
  `agent` query together, resolves one owner, then constructs only the bound
  Main registry. It never creates the ordinary registry and hides tools later.
- **The gap:** Ticket exchange returned an agent-shaped URL, but a URL query is
  not an authorization boundary by itself.
- **Reach:** Ordinary no-query callers retain the existing registry; bound
  callers cannot enumerate or invoke unrelated tools even if they alter their
  MCP request after exchange.
- **Verdict:** sound, high confidence. Authorization and visible capability
  construction now share one owner.

### Give bound Main operations identifier-free default aliases

- **When:** Slice 07 Main tool implementation.
- **The choice:** Answer and interrupt join message/history as root/custom
  default-session aliases. MCP derives those paths from its binding rather than
  discovering a session ID and forwarding a caller-selectable target.
- **The gap:** Ordinary session answer/interrupt routes required a concrete
  session ID, which would either leak it to Voice or widen API admission.
- **Reach:** Future bound callers can reuse the same narrow projection without
  learning Main session identity; the ordinary concrete-session API remains
  unchanged.
- **Verdict:** sound, high confidence. The alias is the resource-binding seam,
  not a compatibility wrapper.

### Canonicalize retained audio MIME after byte-level codec proof

- **When:** Slice 06 independent review.
- **The choice:** Upload admission accepts the Ogg media type form runtimes
  preserve, then the parser proves an Opus stream from bytes. Retained metadata
  records the provisional `audio/ogg;codecs=opus` candidate value pending Slice
  03's Cloud/mobile codec decision.
- **The gap:** Multipart runtimes may normalize away the codec parameter even
  when the producer supplied it, while an exact bare-MIME comparison rejected
  the current Slice 03 candidate artifact.
- **Reach:** Codec identity comes from content, not browser MIME serialization;
  there is still one storage MIME and no alternate legacy format.
- **Verdict:** provisional. The byte-level validation is sound, while the
  canonical production value remains contingent on Slice 03 evidence.
- **Confidence:** medium until the real browser floor closes.

### Make activation redispatch recoverable without ticket plaintext

- **When:** Slice 06 independent review of the create/dispatch crash window.
- **The choice:** Derive the 256-bit worker ticket with HMAC from the activation
  identity, retain only its digest, and record dispatch confirmation on the
  call. Confirmed retries skip dispatch; unconfirmed retries redispatch the
  same ticket.
- **The gap:** Call creation is transactional but LiveKit dispatch is external;
  treating an existing call as dispatched could strand a call if the request
  died between those operations.
- **Reach:** Duplicate external jobs may race only inside the unconfirmed crash
  window, while atomic ticket exchange permits at most one functional worker.
- **Verdict:** sound, high confidence. Recovery uses one durable bit and the
  existing one-time exchange instead of adding a second orchestration system.

### Reserve `root` for the MCP owner selector

- **When:** Slice 07 independent review of `?agent=root|<slug>`.
- **The choice:** `root` is not a valid custom-agent slug. It names only the
  workspace-root Main owner at activation and MCP parsing boundaries.
- **The gap:** A shared string grammar otherwise made a custom agent named
  `root` indistinguishable from the root-owner sentinel.
- **Reach:** Agent registration, marketplace listing/install derivation, and
  agent row parsing use the agent-specific slug schema; app and publish slugs
  retain their existing grammar.
- **Verdict:** sound, high confidence. The query stays minimal and has one
  unambiguous interpretation, with no compatibility branch.

## Slice 03 Cloud-readiness audit — 2026-08-02

### Sound

#### Anchor the retained candidate to the first audible remote frame

- **When** — Slice 03 browser remote-track evidence pass.
- **The choice** — The browser AudioWorklet reports the absolute frame where
  the first non-silent remote sample appears. Once the output-device clock says
  1.2 seconds beyond that frame have played, the probe freezes exactly that
  frame range. For example, 20 ms of connection silence before “One” is not
  allowed to replace the last 20 ms of heard speech. The unbuilt alternative
  counted from the beginning of capture, which looked correct for a fixture
  without silence but shortened the retained spoken prefix on a real track.
- **The gap** — The slice fixed a 1.2-second acknowledged boundary but did not
  define whether that boundary starts at track subscription, the first audio
  frame, or the first audible sample.
- **The reach** — This coordinate system determines the candidate bytes and
  transcript boundary in the Cloud/mobile falsification. It does not select a
  production capture owner; Slice 03 remains RED until that run passes.
- **Verdict** — sound. Actually-heard retention should measure audible output,
  and absolute frame coordinates prevent scheduler delay or leading silence
  from changing the interval.
- **Confidence** — medium.

#### Publish telemetry through one ordered content-free rail

- **When** — Slice 03 worker telemetry evidence pass.
- **The choice** — A worker milestone captures its sequence and monotonic time
  immediately, then one queue publishes milestones in that same order. If STT
  final and audio start occur almost together, a slow first network send cannot
  let the second packet arrive first. The unbuilt alternative launched an
  independent asynchronous publish for every callback; sequence numbers were
  correct at creation time but could arrive reversed and invalidate an honest
  sample.
- **The gap** — The slice required raw redacted measurements but did not assign
  ownership of ordering when LiveKit callbacks overlap.
- **The reach** — Clock calibration and latency subtraction can reject a real
  missing packet without confusing normal coroutine scheduling for data loss.
  The rail carries event names and numeric timings only, never transcript or
  audio content.
- **Verdict** — sound. One publisher makes evidence order a property of the
  harness rather than a timing coincidence.
- **Confidence** — high.

#### Treat dispatch acknowledgement as readiness, not runtime evidence

- **When** — Slice 03 dispatch evidence correction.
- **The choice** — When the named worker joins and proves it received the exact
  opaque metadata, the sample is labeled `dispatch_verified_only`. Its privacy
  record also says provider-side absence is unverified until the LiveKit
  dashboard/API is checked. The unbuilt alternative labeled that handshake
  “measured,” even though no microphone audio, model turn, remote playback,
  interruption, or provider dashboard had participated.
- **The gap** — The slice named all required evidence but did not define a
  machine-readable status for a run that stops after dispatch.
- **The reach** — Summary tooling and future agents cannot accidentally count
  a successful worker join toward model latency, heard-prefix, or privacy gates.
- **Verdict** — sound. Evidence status now states exactly what happened and
  keeps every unobserved claim false.
- **Confidence** — high.

#### Bound one remote-audio attempt without turning cold start into a hang

- **When** — Slice 03 independent-review follow-up.
- **The choice** — A browser waits at most 45 seconds in total for the remote
  audio track and its audible 1.2-second prefix. If a model never publishes a
  track or returns only silence, the attempt fails and the runner can disconnect
  the room. The caller may supply a different bound for an explicit experiment.
  The unbuilt alternative waited forever, so one provider failure could prevent
  the remaining candidates and cleanup from running at all.
- **The gap** — The slice requires real cold-start and provider-failure samples
  but did not define when an individual browser attempt stops waiting.
- **The reach** — The future Cloud runner must record the timeout as a failed
  sample rather than silently retrying or converting it into latency evidence.
  The bound is probe policy, not a production call timeout.
- **Verdict** — sound. Forty-five seconds leaves room for the documented cold
  activation hypothesis while keeping every evidence attempt and room cleanup
  finite.
- **Confidence** — medium.

## Slice 03 browser/Cloud integration audit — 2026-08-02

### Sound

#### Make the real browser the only LiveKit media participant

- **When** — Slice 03 `cloud-sample` integration pass.
- **The choice** — Python creates dispatches and controls a Playwright page,
  but it no longer joins the room as a second SDK participant. The visible
  Chrome page publishes the synthetic microphone, subscribes to the worker,
  and renders/captures its audio. For example, a successful Python-side room
  join cannot make a sample pass while Chrome failed to publish or hear
  anything. The unbuilt alternative kept Python in the room and used browser
  audio only for a later check, leaving two paths that could disagree about
  readiness and participant identity.
- **The gap** — The slice required the same LiveKit/browser path intended for
  production but did not assign the control-plane versus media-plane split in
  the disposable harness.
- **The reach** — Every future latency, interruption, and retained-prefix
  measurement starts only after the browser microphone publication succeeds.
  Python remains the evidence controller and LiveKit Server API client, not a
  competing media owner.
- **Verdict** — sound. One media participant makes a passing sample evidence
  about the path under test rather than a parallel SDK path.
- **Confidence** — high.

#### Bind every browser observation to the worker that proved the dispatch

- **When** — Slice 03 `cloud-sample` integration pass.
- **The choice** — After a remote participant publishes the exact SHA-256
  digest of this sample's opaque metadata, the browser keeps that participant's
  identity in memory and uses it for clock RPC, telemetry filtering, and audio
  capture. If an unrelated bot publishes audio first, that track gets its own
  capture slot and cannot satisfy the proved worker's wait. The unbuilt
  alternative used the first remote participant or first audio track, which
  could combine one worker's metadata with another participant's sound.
- **The gap** — The existing probe had separate metadata, telemetry, RPC, and
  audio primitives but did not say how one remote participant owns all four.
- **The reach** — A redacted sample can omit participant identity while still
  proving internally that every measurement came from one dispatched worker.
- **Verdict** — sound. Identity binding closes the cross-participant evidence
  mix-up without persisting a new identifier.
- **Confidence** — high.

#### Let raw heard audio cross only the in-memory controller boundary

- **When** — Slice 03 `cloud-sample` integration pass.
- **The choice** — Chrome serializes exactly the output-confirmed 1.2-second
  PCM prefix into the Playwright response. Python decodes those bytes in memory
  only long enough to validate their duration and compute a byte count and
  SHA-256 digest. JSONL evidence retains those numeric facts plus timing, uses
  scenario `fixed_interruption`, and labels whether the measured mute met the
  hypothesis; it contains no PCM, transcript, room token, or worker identity.
  The unbuilt alternative wrote the base64 prefix to
  evidence, which would turn a privacy probe into an audio store, or wrote no
  digest, which would make repeated evidence impossible to compare.
- **The gap** — The slice required redacted raw measurements and heard-prefix
  proof but did not define the process boundary or machine-readable status for
  a run that has heard remote audio without yet proving interruption/privacy.
- **The reach** — The Cloud matrix can compare output bytes without retaining
  speech. Downstream work still cannot interpret this partial status as proof
  of barge-in, provider-side absence, or a production capture choice.
- **Verdict** — sound. The smallest useful artifact is a digest and metadata,
  while the explicit partial status keeps unrun gates false.
- **Confidence** — high.

#### Use a visible secure-context Chrome page for desktop heard-audio evidence

- **When** — Slice 03 Playwright runner setup.
- **The choice** — The desktop probe launches the installed Chrome executable
  headed and unmuted, removes Playwright's default audio-muting argument, and
  injects the checked bundle into an intercepted HTTPS origin. The autoplay
  override lets the deterministic harness resume its AudioContext without a
  human click. The unbuilt alternatives were headless/muted playback, which
  cannot support an actually-heard claim, or a file URL, where secure-context
  and module/CORS behavior differs and AudioWorklet loading failed.
- **The gap** — The slice required real desktop playback but did not choose how
  the disposable bundle gets a secure origin or how unattended samples satisfy
  autoplay policy.
- **The reach** — Desktop samples exercise a visible render graph and output
  clock. This choice does not establish mobile Safari behavior or the eventual
  product page's user-gesture flow; those remain separate required evidence.
- **Verdict** — sound. It gives the desktop harness the browser capabilities it
  measures while keeping its automation concessions explicit and quarantined.
- **Confidence** — medium.

#### Mark the deterministic spoken response so silence means stopped

- **When** — Slice 03 fixed-interruption worker pass.
- **The choice** — The probe worker plays the checked four-second spoken
  fixture through `AgentSession.say`, bypassing configured LLM and TTS for this
  falsification, and mixes a low-level continuous carrier into its PCM. The
  browser triggers it with only the input fixture's first uninterrupted 450 ms
  utterance, so a natural pause cannot consume the one-shot response early. The
  evidence names only the STT model exercised before that response. The
  unbuilt alternative inferred mute from ordinary low-amplitude frames, but
  the spoken fixture contains natural pauses longer than the target mute
  budget and could therefore pass before any interruption reached the worker.
- **The gap** — The slice fixed the spoken content and duration but did not
  define a signal that distinguishes a real cut from punctuation and breathing
  gaps on the remote track.
- **The reach** — The browser can measure the last marked output frame after
  barge-in without treating a configured-but-unused Fish/LLM ID as latency
  evidence. This carrier is probe-only and is not a production audio feature.
- **Verdict** — sound. A continuous measurement marker turns playout stop into
  an observable boundary while preserving the spoken retained-prefix case.
- **Confidence** — high.

#### Schedule barge-in and playout stop on one browser clock

- **When** — Slice 03 integrated interruption pass.
- **The choice** — Once the worker's first audible frame is known, Chrome maps
  the 1.2-second output frame onto `performance.now()`, schedules the synthetic
  microphone for that wall-clock instant, and maps the last carrier-marked
  output frame back through `AudioContext.getOutputTimestamp()`. It requires a
  further 250 ms of output-clock silence before accepting that last frame. The
  unbuilt alternative waited until polling observed 1.2 seconds and only then
  started input, which added scheduler delay, while a worker-only stop event did
  not prove when the listener's device became silent.
- **The gap** — Input scheduling and speaker acknowledgement use different
  AudioContext timelines unless they are explicitly joined through the browser
  performance clock.
- **The reach** — `barge_in_mute` is the listener-path interval from scheduled
  microphone onset to the last audible marked frame. A value above 200 ms is
  retained as `fixed_interruption_budget_failed`; local checks cannot turn it
  into a passing Cloud sample.
- **Verdict** — sound. One clock and an explicit silence proof make the latency
  falsifiable without treating worker intent as heard audio.
- **Confidence** — medium until real desktop/mobile output clocks run it.

#### Encode the heard prefix only inside the evidence controller

- **When** — Slice 03 retained-artifact integration pass.
- **The choice** — After Chrome returns the exact PCM samples that reached its
  output graph, the Python controller encodes those samples in memory to the
  candidate Ogg/Opus artifact, decodes the duration, correlates its normalized
  waveform with the beginning of the full marked response, and trims the fixed
  transcript cue ledger at the measured last audible frame. The capture runs
  through mute completion, not merely to the earlier 1.2-second barge-in
  boundary; the Ogg end granule trims its final packet to the exact stop sample.
  Only byte counts, capture/artifact durations, sample rates, a digest,
  similarity, and content-free tail facts enter JSONL. The unbuilt alternative
  wrote temporary audio to disk or kept calling raw PCM a retained artifact
  without proving the selected container could represent the heard prefix.
- **The gap** — The slice required a persisted candidate artifact but also
  forbade the redacted Cloud evidence from retaining media; it did not name the
  safe process boundary between those requirements. Its original `1.2s ± 100ms`
  wording also conflicted with the invariant that every audible mute-latency
  frame must be retained.
- **The reach** — Desktop and mobile captures at different sample rates can be
  compared as canonical 48 kHz artifacts without turning the probe directory
  into a recording store. Production retention still waits for Cloud/mobile
  evidence and keeps no compatibility format.
- **Verdict** — sound. In-memory encoding proves the artifact contract while
  preserving the probe's content-free evidence boundary; measured playout stop
  is the single retention owner.
- **Confidence** — high.

#### Keep one browser participant identity for the retained call

- **When** — Slice 06 retry-correction pass.
- **The choice** — Every activation response mints a fresh short-lived token
  for the same `voice-participant-${callId}` identity. The room and participant
  identity therefore remain call-bound while token material can rotate across
  retries. The unbuilt alternative generated a new random participant identity
  per response, which could admit simultaneous browser participants after an
  ambiguous retry.
- **The gap** — Activation idempotency fixed the call and room but did not state
  whether retrying token issuance also had to preserve participant identity.
- **The reach** — A retried browser can reconnect to the same retained call
  without widening its grants or creating another call owner. Automatic resume
  of an ended call remains out of scope.
- **Verdict** — sound. Call identity is the existing durable idempotency owner,
  so deriving the browser identity from it removes an otherwise independent
  source of multiplicity.
- **Confidence** — high.

#### Prove audio cleanup beyond the transaction happy path

- **When** — Slice 05 closeout pass.
- **The choice** — The owning backend harness races two independent clients on
  one utterance and fills more than one deletion batch before checking final
  convergence. The implementation remains unchanged; the tests prove that the
  transaction winner is the only canonical message and that the bounded
  cascade schedules itself until every media row and blob is gone.
- **The gap** — Sequential duplicate calls and a single deletion batch could
  pass without exercising the production races and continuation boundary the
  slice claims to own.
- **The reach** — Session retention and deletion now have executable evidence
  for both concurrency and bounded cleanup without introducing a second media
  owner or an unbounded transaction.
- **Verdict** — sound. The proof targets user-visible storage invariants rather
  than implementation details.
- **Confidence** — high.

#### Split provider latency from deterministic interruption by job scenario

- **When** — Slice 03 real-candidate integration pass.
- **The choice** — Opaque dispatch metadata carries exactly one of
  `candidate_response` or `fixed_interruption`. The former runs the configured
  STT, LLM, Fish model, and stock voice through browser-acknowledged first
  output; the latter runs the same STT input but replaces the response with the
  marked fixture needed to falsify cutoff behavior. Each evidence row names
  only the identifiers its scenario actually exercises.
- **The gap** — One response path cannot simultaneously measure provider
  latency and guarantee the deterministic carrier needed for an actually-heard
  interruption proof.
- **The reach** — The matrix can compare real provider candidates without
  weakening the fixed cutoff case or mislabeling configured-but-unused models.
  This remains one probe worker and one browser harness, not two runtime
  topologies.
- **Verdict** — sound. The explicit scenario is the smallest seam that keeps
  both claims falsifiable.
- **Confidence** — high for the local contract, pending Cloud execution.

#### Let one manifest own the evidence matrix and make cold starts falsifiable

- **When** — Slice 03 matrix-closure pass.
- **The choice** — One checked manifest owns candidates, stock-voice sources,
  scenarios, activation states, and sample counts. The runner writes exactly
  one content-free row per attempt and produces a no-go closure report for any
  missing, duplicate, rebound, failed, privacy-pending, or over-budget row. A
  deployment-lifetime fingerprint must be new relative to every warm process and
  unique across the five planned cold activations of one named benchmark
  shape. Status text alone is insufficient: each row must carry the model,
  voice, or interrupted-codec proof appropriate to its scenario.
- **The gap** — Parallel CLI flags could drift from dispatched job metadata,
  exception exits erased attempted samples, and a caller-provided `cold` label
  did not prove a fresh worker process.
- **The reach** — Candidate identity now crosses the controller/worker boundary
  once in strict opaque job metadata. The external activation script remains
  replaceable, while a no-op cannot satisfy closure. The deployment launcher
  creates the fingerprint before LiveKit spawns job processes, so every job in
  one warm deployment inherits the same value.
- **Verdict** — sound. This is the smallest contract that makes matrix,
  failure, and activation claims independently falsifiable.
- **Confidence** — high for the local contract, pending Cloud execution.

#### Separate audible acknowledgement from the measured Main response

- **When** — Slice 03 strict latency-milestone pass.
- **The choice** — Candidate-response jobs suppress the ordinary LLM turn and
  speak one fixed Fish-synthesized “Okay.” After the browser proves its first
  audible frame and 250 ms of output-clock silence, it invokes one
  sample-bound, single-use worker RPC. The worker waits for idle, captures
  content-free Main-result and runtime-event anchors, then asks the configured
  LLM and Fish voice to paraphrase a fixed simulated Main result. The browser
  measures the next audible epoch strictly after the silence anchor and records
  caption paint only after two animation frames from the metadata-proven
  worker. Cross-clock intervals include calibration uncertainty. The rejected
  alternative treated one first-audio timestamp as proof of both acknowledgement
  and the later Main response, which cannot establish two distinct milestones.
- **The gap** — The slice named both response budgets but did not define how one
  candidate turn could expose two independently audible boundaries without
  importing the unbuilt production Main/MCP topology into the disposable probe.
- **The reach** — Cloud samples can falsify the three response budgets and the
  configured provider mechanics. They do not claim production MCP/Main latency;
  that stays owned by the later staging journey. No obsolete single-onset
  reader or telemetry vocabulary remains.
- **Verdict** — sound. Two audible epochs make both latency claims observable
  while keeping the probe isolated and explicit about its synthetic seam.
- **Confidence** — high for the local contract, pending Cloud execution.

#### Provisionally cold-test the first benchmark shape

- **When** — Slice 03 checked-manifest pass.
- **The choice** — The checked manifest currently sends its five forced cold
  activations to the Deepgram/Gemma/free-Fish/default-voice combination. This
  decides which process shape pays the cold-start cost; it does not select that
  combination for production. The alternative is to wait for warm results,
  edit `cold_candidate_id` to the leading shape, and only then run cold probes.
- **The gap** — The spec requires cold evidence for the selected deployment
  shape, but no warm Cloud evidence exists yet from which to select it.
- **The reach** — Running the manifest unchanged spends five cold activations
  on a provisional shape. Reversing the choice is one manifest-field edit and
  a fresh evidence file; no product code or schema changes.
- **Verdict** — needs-user. The provisional first shape keeps an unsupervised
  run possible, but the operator should point `cold_candidate_id` at the warm
  winner before spending the cold runs.
- **Confidence** — low; this is intentionally a placeholder until warm data
  exists.

#### Reuse one authenticated browser probe across the mobile matrix

- **When** — Slice 03 mobile-controller pass.
- **The choice** — One loopback HTTP/WebSocket controller is exposed only
  through an operator-supplied Cloudflare quick tunnel. A 256-bit secret lives
  in the URL fragment, is removed before connection, and authenticates one
  Safari controller. The browser accepts only the seven fixed probe operations;
  Python keeps the existing result decoders and permits one command in flight.
  The authenticated handshake rejects desktop and alternate iOS browsers before
  any row can carry the `ios-safari` floor. One user gesture arms an
  `AudioContext` that remains alive across attempts.
  The rejected shape duplicated the probe protocol in a mobile-specific app or
  added a general remote-evaluation surface.
- **The gap** — Playwright-owned desktop Chrome could not execute the required
  physical iOS Safari floor, and reconnecting every attempt would lose Safari's
  user-gesture audio grant.
- **The reach** — One `cloud-matrix` invocation owns both browser floors.
  `browser_floor` is mandatory in the manifest, attempt ID, evidence row,
  closure binding, and percentile population, so desktop results cannot satisfy
  iOS gates. The tunnel and controller are disposable probe infrastructure, not
  production topology.
- **Verdict** — sound. It is the smallest external boundary that preserves the
  existing evidence contract without exposing arbitrary browser execution.
- **Confidence** — high for the local seam; physical Safari and Cloud execution
  remain pending evidence.

#### Bind the iOS evidence label to Safari admission, while leaving physical-device proof external

- **When** — Slice 03 mobile-controller closeout.
- **The choice** — When the operator opens the one-time controller URL, the
  browser sends its user-agent string, platform, and touch-point count inside
  the authenticated WebSocket handshake. Python admits only iPhone/iPad-style
  touch platforms carrying WebKit, Version, Mobile, and Safari markers, and it
  rejects known alternate iOS browser markers before any matrix command can
  run. This stops an operator from accidentally opening desktop Chrome and
  producing rows labeled `ios-safari`. It does not pretend that browser strings
  cryptographically prove a physical phone: the operator still supplies and
  records the real-device run. The unbuilt alternative trusted the manifest's
  label regardless of which browser opened the URL.
- **The gap** — The slice required a physical Safari floor but did not define
  how the remote browser would be admitted or how much of “physical” a local
  web harness could honestly establish.
- **The reach** — Every future mobile timing row depends on this admission gate.
  A stronger device-lab attestation can replace the handshake later, but it
  must preserve the rule that a planned floor cannot label an unverified
  executor.
- **Verdict** — sound. It closes accidental browser substitution with the
  smallest local check and keeps the remaining physical-device claim explicit
  rather than overclaiming it.
- **Confidence** — medium; the boundary is technically honest and reversible,
  but a future automated device lab may own stronger evidence.

#### Keep the remote controller inside the locked Python probe

- **When** — Slice 03 mobile-controller pass.
- **The choice** — The disposable HTTPS-tunnel endpoint uses `aiohttp`, added to
  the probe's own locked Python environment, to serve one page and one
  authenticated WebSocket. For example, starting the Cloud matrix does not
  launch a second Node service or introduce a production API; the same Python
  process that writes evidence also owns controller lifetime and teardown. The
  unbuilt alternative added a separate server runtime solely to bridge Safari
  into the existing Python browser decoders.
- **The gap** — The plan selected Python for the probe but did not choose the
  loopback HTTP/WebSocket library or whether the mobile bridge should be a
  second process.
- **The reach** — Probe setup now includes one direct dependency and one lockfile
  update, while production packages remain untouched. Future probe-only routes
  should stay on this narrow server rather than turning it into application
  infrastructure.
- **Verdict** — sound. One locked event loop gives controller commands, tunnel
  lifetime, and evidence capture a single owner with less operational surface.
- **Confidence** — high.

#### Correlate each provider-privacy check with the sample's room

- **When** — Slice 03 provider-readiness pass.
- **The choice** — The same random sample ID that identifies a local timing row
  also derives its provider-visible LiveKit room name. After that room ends, the
  matrix pauses and tells the operator to search for the room in Agent Insights
  (or an account API), verify that it contains no uploaded audio, transcript,
  trace, or log, and type the room name together with the local attempt ID. Only
  that exact pair sets provider absence to true. A typo, unattended run, or
  confirmation of a different/latest room stays false and makes closure RED.
  The unbuilt alternative stored a second audit mapping or trusted a local label
  that the provider dashboard could not display.
- **The gap** — The spec required post-session provider evidence for every
  `record=False` attempt, but LiveKit documents no portable Agent Insights API
  across all plans and the original random room was unrelated to the local
  attempt label.
- **The reach** — Every matrix row now has one non-secret correlation path to
  the provider object an operator inspected. Scale-plan automation may replace
  the prompt later, but it must produce the same per-room, per-attempt proof and
  must not green rows from source documentation alone.
- **Verdict** — sound. One derived room name closes the evidence-binding gap
  without adding a service, compatibility format, or plan-specific fallback.
- **Confidence** — medium; it is the simplest cross-plan baseline, while the
  actual account may later offer a stronger automated query.
