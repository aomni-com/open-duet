# Low-credit recovery — implementation choices

This ledger records decisions made during implementation where the approved spec did not already
choose the answer. Entries are grouped by verdict and ordered from lower to higher confidence within
each group.

## Sound

### Short secondary aliases retain the cleanup safety marker

- **When:** Slice 04 live-acceptance cleanup.
- **The choice:** The secondary AgentMail alias carries the shortened run suffix plus the literal
  `staging-e2e-synthetic` marker. The complete run id remains in the magic-link return URL for mailbox
  correlation.
- **The gap:** Keeping the complete run id in the email exceeded the 64-character local-part limit;
  shortening it without preserving the marker made the cleanup guard reject its own fixture.
- **The reach:** Secondary identities remain valid email addresses and remain eligible for the
  exact, synthetic-only cleanup path.
- **Verdict:** **Sound.** Address validity and cleanup authorization are both part of the fixture
  contract.
- **Confidence:** High.

### The stale-client refusal proof reloads behind its frozen identity

- **When:** Slice 04 live-acceptance hard-floor proof.
- **The choice:** After capturing the above-threshold identity and intercepting later identity reads,
  the journey reloads once before lowering the real balance. This drains requests that began before
  interception and leaves the composer submit control enabled for the race proof.
- **The gap:** Installing interception without a reload left an older in-flight identity request able
  to reveal the proactive gate before the synthetic Send click.
- **The reach:** The live journey can prove that the server refuses an already-enabled submission
  even if another fresh-state channel renders the proactive shell gate first.
- **Verdict:** **Sound.** The reload pins the composer precondition without requiring every shell
  projection to remain stale.
- **Confidence:** High.

### The hard-floor click follows the composer's form contract

- **When:** Slice 04 live-acceptance hard-floor proof.
- **The choice:** The journey finds the submit control from the exact editor it filled, through that
  editor's owning form, verifies it is enabled, and invokes its click handler directly. This models a
  submission already in flight if the proactive shell overlay lands between pointer-down and the
  server request.
- **The gap:** The shared composer intentionally changes visible and accessible wording across first
  messages and follow-ups; the hard-floor behavior is the same in both states.
- **The reach:** The journey cannot click another compose surface, does not turn reversible copy into
  an API contract, and does not ask Playwright to violate the modal's pointer interception.
- **Verdict:** **Sound.** Editor, form, submit state, and handler are the stable product structure the
  race proof needs.
- **Confidence:** High.

### The refusal oracle covers both composer transport seams

- **When:** Slice 04 live-acceptance hard-floor proof.
- **The choice:** The response oracle accepts only a workspace-scoped POST to either new-session
  creation or an existing session's messages endpoint, then applies the same exact `402` body
  assertions.
- **The gap:** The default chat can already exist by the time the live journey reaches its final leg,
  so the shared composer legitimately chooses the messages transport instead of session creation.
- **The reach:** The acceptance proves the shared refusal behavior without depending on whether this
  synthetic workspace has previously materialized its default session.
- **Verdict:** **Sound.** Both routes are first-class send seams and share the same server-owned spend
  guard.
- **Confidence:** High.

### The exact insufficient-credit refusal is proven on an active subscriber

- **When:** Slice 04 live-acceptance hard-floor proof.
- **The choice:** The stale-projection race runs after the real subscription and top-up, then restores
  the subscriber above threshold before later legs. The trial leg proves its subscribe gate without
  pretending its correct server refusal is an insufficient-credit top-up case.
- **The gap:** A trial at the hard floor correctly returns `subscription_required`; the slice's exact
  `insufficient_credits` contract belongs to a subscribed payer.
- **The reach:** Live acceptance now pins both recovery semantics: trials must subscribe, while an
  active subscriber whose balance is exhausted gets the top-up refusal and preserved draft.
- **Verdict:** **Sound.** Refusal codes follow entitlement state instead of test setup convenience.
- **Confidence:** High.

### One secondary trial owner also proves the member view

- **When:** Slice 04 live-acceptance journey.
- **The choice:** The journey creates one disposable second person with a trial workspace, then also
  makes that person a member of the subscriber's workspace. In their own workspace they see the
  trial subscription choices; after navigating to the subscriber's workspace they see the fixed
  owner-waiting gate. The unbuilt alternative created separate people and workspaces for those two
  views, which would provision another VM without changing the billing behavior under test.
- **The gap:** The spec required isolated trial and member evidence but did not say whether those
  roles needed separate user identities.
- **The reach:** The focused staging run owns two users, two workspaces, and one shared cleanup ledger;
  future additions should not multiply live VMs unless identity separation is itself the contract.
- **Verdict:** **Sound.** One real person can own one workspace and be a member of another, so the
  combined fixture is a normal product state and preserves both role boundaries.
- **Confidence:** High.

### Member setup bypasses invitation delivery because invitation behavior is not under test

- **When:** Slice 04 live-acceptance journey.
- **The choice:** After the second disposable account is created through the normal account path, an
  internal-key-gated staging fixture adds its membership directly. The browser still signs in for
  real and reads the deployed workspace projection. The unbuilt alternative sent and accepted an
  email invitation before reaching the same membership row, retesting the separate invite journey
  and adding mailbox failure modes to a billing-policy proof.
- **The gap:** The spec said a member must see the owner-waiting state but did not require the member
  to be created through the invitation user journey.
- **The reach:** This journey certifies billing behavior after membership exists; invitation creation,
  email delivery, and acceptance remain owned by the existing invite acceptance journey.
- **Verdict:** **Sound.** The fixture bypasses only setup outside this journey's contract, while the
  deployed browser, authentication, workspace summary, and gate remain real.
- **Confidence:** High.

### The billing boundary lives inside the shared workspace shell

- **When:** Slice 03 shell integration.
- **The choice:** A workspace can be visible through a normal workspace route, through global user
  settings, or through internal admin. All three already render the same `DriveWorkspaceShell`, so
  that shell now owns the one billing boundary. For example, if a member is editing a draft when the
  server projects low credit, the editor stays mounted and the shell places the owner-waiting modal
  above it. The unbuilt alternative mounted separate gates in each route, where one route could miss
  the stop or replace the editor and lose its draft.
- **The gap:** The spec required coverage everywhere the shell appears, but did not choose the exact
  React ownership point.
- **The reach:** Future destinations added inside `DriveWorkspaceShell` inherit entitlement and
  low-credit precedence automatically; they must not add their own billing gate.
- **Verdict:** **Sound.** The shared shell is the narrowest owner that covers every required
  destination while preserving the mounted task.
- **Confidence:** High.

### A fresh server projection resets the boundary's checkout state

- **When:** Slice 03 shell integration.
- **The choice:** The boundary's component identity includes workspace slug, payer, servicing state,
  and low-credit projection. In plain terms, when a return-from-checkout refresh changes `topup` to
  `null`, React discards the old modal instance—including its pending/error flags—instead of letting
  those flags leak into the next workspace or recovery kind. The unbuilt alternative kept one modal
  instance alive and manually reset an expanding list of local fields.
- **The gap:** The spec said only fresh server state clears the gate, but did not choose how local UI
  state is retired when that server state changes.
- **The reach:** New local checkout fields added later reset at the same projection boundary without
  another cleanup branch; workspace switches cannot inherit a prior workspace's failed checkout.
- **Verdict:** **Sound.** Component identity follows the server-owned state machine and makes stale
  local state structurally short-lived.
- **Confidence:** High.

### The blocking surfaces join the app's real modal stack only after mounting

- **When:** Slice 03 composed-shell visual review.
- **The choice:** Server rendering emits the complete dialog markup for stable first paint and static
  rendering tests. Once the browser mounts, the low-credit gate uses the existing Radix modal
  primitive and a body-level portal (a portal renders the same React component at the end of the
  document). This matters when a session dialog is already open: the billing gate then becomes the
  active focus trap instead of leaving keyboard focus inside the older dialog beneath it. The
  entitlement wall uses the same body-level layering boundary and remains above low credit when a
  workspace pauses.
- **The gap:** The approved direction required a real, non-dismissible modal but did not specify how
  it should coexist with an already-open product modal or with server-rendered tests.
- **The reach:** Any destination-level dialog can remain mounted beneath billing recovery without
  intercepting pointer or keyboard input; later billing surfaces should reuse this stack rather than
  inventing higher local z-indexes.
- **Verdict:** **Sound.** It preserves first render while delegating browser focus containment to the
  app's established modal system.
- **Confidence:** High.

### Checkout retries always reserve a fresh browser tab

- **When:** Slice 03 transport review.
- **The choice:** Every click opens the special `_blank` target instead of reusing one fixed named
  checkout window. Opener removal also sits inside the cleanup boundary. The first implementation
  reused a named tab, which can still expose a cross-origin Stripe `WindowProxy` during a retry and
  make the synchronous opener write throw.
- **The gap:** The spec required a reserved tab but did not choose whether later attempts reuse it.
- **The reach:** A retry cannot collide with an earlier Stripe tab; every failed setup closes only
  the fresh context it created.
- **Verdict:** **Sound.** Checkout attempts are independent, and avoiding cross-origin reuse is more
  important than keeping a stable browser-tab identity.
- **Confidence:** High.

### The live polling deadline includes reads that never settle

- **When:** Slice 04 harness review.
- **The choice:** Each state load races the remaining wall-clock budget rather than checking the
  deadline only after the load returns. The first implementation could wait forever on a hung read.
- **The gap:** The spec required a wall-clock bound but did not spell out whether it covered transport.
- **The reach:** The focused staging journey cannot hang indefinitely even when a deployment read
  neither resolves nor rejects.
- **Verdict:** **Sound.** A wall-clock bound must encompass all work inside the wait loop.
- **Confidence:** High.

### The recovery gate owns modal behavior instead of inheriting dismissal defaults

- **When:** Slice 02 presentation pass.
- **The choice:** The gate uses a focused ARIA modal shell with explicit Tab containment and Escape
  suppression. It does not use the ordinary dismissible dialog primitive, whose close, outside-click,
  and Escape defaults conflict with this stop state.
- **The gap:** The spec locked the behavior and allowed existing components, but did not choose the
  implementation boundary.
- **The reach:** Subscribe, top-up, and member variants share the same inescapable accessibility
  behavior without teaching the general dialog primitive about billing policy.
- **Verdict:** **Sound.** The exceptional non-dismissible behavior remains local to the exceptional
  surface.
- **Confidence:** High.

### Invalid automatic-top-up input disables its immediate toggle

- **When:** Slice 01 settings cutover.
- **The choice:** Because Billing Settings persists automatic top-up through the toggle rather than a
  separate Save button, a below-`$5` threshold disables that toggle until the input is valid.
- **The gap:** The spec required the form to reject or disable invalid save, but the existing form has
  no standalone save action.
- **The reach:** The UI cannot submit an invalid configuration while the API and backend retain their
  own independent validation.
- **Verdict:** **Sound.** It applies the requested constraint at the actual persistence control.
- **Confidence:** High.

### Live forward-progress polling stays separate from HTTP transport

- **When:** Slice 04 forward-progress harness pass.
- **The choice:** The staging harness now has a small polling owner that knows only how to load a
  state, ask whether it is complete, and ask whether it advanced. The low-credit journey will define
  what “advanced” means for a billing projection. The unbuilt alternative put this logic into the
  shared HTTP client, making transport code understand checkout phases and encouraging unrelated
  journeys to inherit billing-specific retry rules.
- **The gap:** The spec required a bounded forward-progress helper but did not choose its module
  boundary or whether progress semantics belonged to the helper or its caller.
- **The reach:** Future eventually-consistent staging journeys can reuse the time/no-progress bounds
  while retaining their own domain state machines; failures include the last summarized observation
  without teaching the HTTP layer those shapes.
- **Verdict:** **Sound.** Waiting policy is reusable harness behavior, while the meaning of progress
  belongs to the journey that owns the state.
- **Confidence:** High.

### Checkout-return refreshes coalesce around work in flight, not a timer

- **When:** Checkout-return refresh pass.
- **The choice:** Returning from the checkout tab commonly fires both a window-focus event and a
  document-visible event. Duet lets both events share the same identity refresh while that request is
  running. As soon as it settles—even if it failed—the next genuine return can refresh again. The
  unbuilt alternative used a fixed debounce timer, which could suppress a real second return merely
  because it happened within an arbitrary number of milliseconds.
- **The gap:** The spec required coalescing but did not choose whether the boundary was elapsed time
  or the lifetime of the server request.
- **The reach:** Slice 03's focus/visibility listeners inherit one-request-per-in-flight-return
  behavior, without changing global polling or creating a cooldown after failures.
- **Verdict:** **Sound.** The server round trip is the actual duplicate-work boundary, and clearing it
  on both success and failure preserves recovery from a transient network problem.
- **Confidence:** High.

### The hosted checkout replaces the reserved tab's blank history entry

- **When:** Hosted-checkout transport pass.
- **The choice:** A recovery click first opens a blank browser tab while the click still counts as a
  user gesture. When Stripe's URL returns, Duet uses `location.replace` in that tab. The unbuilt
  alternative was assigning a new location, which would leave the temporary blank page behind it in
  browser history; pressing Back from checkout could then land on a useless empty tab.
- **The gap:** The spec required navigating the reserved tab but did not choose replacement versus a
  new history entry.
- **The reach:** Every low-credit subscription and top-up handoff will inherit this browser-history
  behavior from the shared helper.
- **Verdict:** **Sound.** The blank document is implementation scaffolding, not a destination a user
  should be able to revisit.
- **Confidence:** High.

### The third-party checkout receives no opener reference

- **When:** Hosted-checkout transport pass.
- **The choice:** Immediately after Duet reserves the blank tab, it clears that tab's `opener`
  reference before navigating to hosted checkout. An opener reference is the browser handle a new
  page can use to reach the page that opened it. The unbuilt alternative left that handle attached
  while sending the tab to a third-party origin.
- **The gap:** The spec required a new tab and prohibited sensitive loading content, but did not state
  whether the reserved tab should retain access to the working Duet tab.
- **The reach:** Hosted billing pages cannot navigate or script the original workspace through the
  window relationship; return-to-workspace recovery therefore happens only through Duet's own focus
  and server-refresh seam.
- **Verdict:** **Sound.** The checkout does not need control of the working tab, and removing that
  capability preserves the promised independent-tab boundary.
- **Confidence:** High.

### A reactive refusal disables retry until recovery starts

- **When:** Slice 04 visual-refusal review.
- **The choice:** While an actionable spend refusal is visible, the composer keeps the rejected
  draft editable but disables Send and labels the control row “Add credits to send.” Clicking the
  billing action clears that refusal before opening Billing in a new tab, so returning users can
  retry immediately. A failed retry simply restores the server-owned refusal.
- **The gap:** The spec required a preserved draft and actionable `402`, but did not decide whether
  the still-visible Send control should remain enabled while the known blocker is unresolved.
- **The reach:** Both first-message creation and existing-session sends use the same visible state;
  generic failures remain retryable without visiting Billing.
- **Verdict:** **Sound.** The blocked action reads as blocked without turning a recovered draft into
  a dead end.
- **Confidence:** High.

### A mounted refusal clears only after observing a real recovery cycle

- **When:** Slice 04 final independent review.
- **The choice:** The composer remembers whether its current refusal has observed a non-null
  workspace recovery projection. It clears the refusal automatically only when that projection
  subsequently returns to null. This lets a top-up completed in another tab or by the workspace
  owner unlock Send without a reload. A refusal received while the browser still has a stale null
  projection remains visible until the browser has observed the actual recovery cycle.
- **The gap:** Clearing every refusal whenever the projection is null would erase the exact
  stale-projection `402` fallback this slice exists to preserve; never clearing would strand users
  who recover outside the notice's own link.
- **The reach:** First-message creation and existing-session sends both preserve their drafts and
  unlock reactively. The locked Send control uses billing-neutral copy because spend refusals also
  cover plan, payment, and cap problems—not only empty credits.
- **Verdict:** **Sound.** It distinguishes a proven recovery transition from an old browser answer.
- **Confidence:** High.

### Live billing cleanup is registered before Stripe creation

- **When:** Slice 04 independent harness review.
- **The choice:** The focused journey registers the existing email-scoped Stripe sweep before its
  customer-creation request, then adds exact resource records after IDs arrive. Its shared browser
  context also carries one VM-name list so both provisioned workspaces reach cleanup evidence.
- **The gap:** Exact-ID cleanup alone cannot recover a customer when Stripe accepts a POST but its
  response is lost, and the base fixture did not previously expose its VM inventory to nested setup.
- **The reach:** Transport failures leave no untracked Stripe customer, and `journey.json` reports
  every VM the two-workspace journey tears down.
- **Verdict:** **Sound.** Failure evidence is only trustworthy when lifecycle accounting survives
  the same partial failures the journey is meant to diagnose.
- **Confidence:** High.

### Live acceptance targets the shared composer contract, not one state’s label

- **When:** Slice 04 first deployed run.
- **The choice:** The staging journey locates the shared compose editor through its product data
  contract. It does not search for “Message Duet,” because a workspace with no root conversation yet
  correctly labels that same editor “Describe a task for Duet…”.
- **The gap:** The first live run reached the real root chat but timed out waiting for the
  existing-session label, so it never exercised the feature. Both product states were correct; the
  test had confused localized state copy with component identity.
- **The reach:** The exact same live journey now covers a first-message hard-floor refusal and remains
  valid if prior fixture state gives the root an existing conversation.
- **Verdict:** **Sound.** Stable product identity is the right automation seam; user-facing copy stays
  free to tell the truth about the current state.
- **Confidence:** High.

### The secondary live identity keeps provenance out of the email local part

- **When:** Slice 04 second deployed run.
- **The choice:** The secondary browser uses a short, run-unique AgentMail alias. The full run ID is
  carried in the magic link’s return URL, where mailbox matching can still prove provenance without
  exceeding the email local-part limit.
- **The gap:** Appending `-secondary` to the already-tagged run address produced a 65-character local
  part. The mail provider correctly rejected it, and the product surfaced that delivery failure as
  HTTP 500.
- **The reach:** Secondary login remains isolated and cleanup-labelled by the full run ID, while the
  generated recipient stays within the 64-character email contract.
- **Verdict:** **Sound.** Identity uniqueness, evidence provenance, and wire validity each live in the
  field that can safely carry them.
- **Confidence:** High.
