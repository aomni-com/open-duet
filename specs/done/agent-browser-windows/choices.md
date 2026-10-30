# Choices ledger

This is the consolidated decision record for the shipped feature. It contains no
open or provisional choices.

## Unsound

None.

## Needs user

None.

## Sound

### A Chrome extension is the exact-window actuator

- **When:** Native mechanism proof and image integration.
- **The choice:** When an agent asks for another page, Chrome's DevTools Protocol
  can create a page but cannot say “put this tab in window 42.” Duet therefore
  force-installs a minimal extension that can call Chrome's native tab/window APIs.
  The gateway tells it which already-managed window to use and keeps all identity,
  eviction, and retention decisions itself. The unbuilt alternative was to guess
  the window from X11 titles, class, PID, or creation order; every Chrome window
  shares those signals and restart can reuse numeric ids.
- **The gap:** The product required one exact window per owner, but the initial
  design exploration did not know which pinned-Chrome mechanism could address an
  existing window.
- **The reach:** The extension remains an actuator, not a second policy store. Its
  image build generates its own signing identity. The gateway reads the derived
  public extension ID from the image rather than depending on a global key.
- **Verdict:** sound — the exact-image probe proved native placement and focus while
  keeping policy in one gateway owner.
- **Confidence:** medium.

### Browser-wide CDP visibility stays intentional

- **When:** Automation proxy integration.
- **The choice:** The gateway proxy counts exactly when an automation client is
  connected and redirects page creation into the caller's managed window, but it
  does not hide other tabs or windows. A user can ask an agent to inspect something
  already visible elsewhere on the shared desktop, and the agent can do so. The
  unbuilt alternative was a virtualized DevTools view that filtered every target,
  event, and command; that would be complex and would contradict the shared-screen
  product model without creating a VM security boundary.
- **The gap:** Exact lease accounting required a proxy, but proxying did not itself
  decide whether target visibility should become isolation.
- **The reach:** New CDP behavior must preserve normal browser-level Playwright
  semantics. Access control belongs at the workspace VM boundary, not per window.
- **Verdict:** sound — it matches the user's explicit expectation and the one-trust-
  domain security model.
- **Confidence:** high.

### Stable agent identity owns the window; sessions own fresh batches

- **When:** Ownership contract design.
- **The choice:** Suppose one agent has hundreds of short conversations. They all
  reuse the same managed Chrome window, but each `duet-browser` invocation starts a
  fresh tab and receives its own temporary automation lease. Root is an explicit
  owner and adopts Chrome's bootstrap window. The alternatives were a window per
  session, which grows without user cleanup, or one tab per agent, which makes
  simultaneous sessions overwrite one another.
- **The gap:** The original desktop keyed a tab by session; the product needed a
  durable grouping that survived temporary session churn.
- **The reach:** Owner keys are root or stable agent id. Anchors resolve and delete
  owners; slugs only label them. Missing or unresolved sessions never become root.
- **Verdict:** sound — it bounds native windows without reintroducing tab collision.
- **Confidence:** high.

### Exact automation disconnect and native focus define activity

- **When:** Lease and idle-policy integration.
- **The choice:** The gateway treats the CDP WebSocket as the automation lease: a
  command updates live activity and the final disconnect persists its last command
  time. Native focus is the human-use signal. Only after there is no lease and the
  window has lost focus does the idle grace begin. Persisting every Playwright
  command would fsync hundreds of times per interaction; remembering only the
  final lease time avoids that churn while the live manager still sees exact
  activity.
- **The gap:** A `duet-browser` invocation timestamp cannot tell whether a command
  is still running or whether a human is reading the foreground page.
- **The reach:** Resource cleanup and eviction must consult live leases and native
  focus through one serialized manager. A timeout from batch creation alone is not
  an acceptable substitute.
- **Verdict:** sound — the signals correspond to the two real drivers and avoid
  mid-command cleanup.
- **Confidence:** high.

### Idle batch tabs use discard, not fictional freeze

- **When:** Pinned-Chrome CPU experiments.
- **The choice:** Non-destructive page freeze, background focus, and minimization
  left timers and renderer CPU running. Chrome also rejected the extension's
  proposed native freeze field. `chrome.tabs.discard()` removed the renderer CPU,
  but Chrome returned a replacement tab/target id and reloaded on activation,
  losing DOM and in-memory state while keeping the URL and browser storage. Duet
  follows the replacement as one logical batch tab and applies discard only after
  its automation lease is gone and it is in the background. Human-created tabs are
  not auto-discarded.
- **The gap:** The requested power saving named an outcome, but pinned Chrome's
  viable mechanism and state-loss boundary were unknown.
- **The reach:** The ledger stores logical identity separately from current native
  ids, and discard/reconciliation updates them atomically. Product language must
  promise renderer CPU savings, not suspension of profile-wide workers.
- **Verdict:** sound — it is the only measured mechanism that achieved the stated
  CPU priority, with the destructive boundary constrained and visible.
- **Confidence:** high.

### One desktop loop drives time-based cleanup and stack retention

- **When:** Resource lifecycle implementation.
- **The choice:** The existing desktop loop asks the browser manager to evaluate
  discard and expiry, then asks the desktop supervisor to evaluate stack retention
  and reaping. Browser mutations still enter the manager's serialized queue, while
  capacity is checked synchronously when a new batch starts. A delayed loop that
  finds a tab past both idle-discard and final-expiry deadlines closes it directly
  instead of discarding and then closing a replacement. The unbuilt alternative
  was a collection of per-owner timers whose callbacks could race a new lease,
  focus event, eviction, or Chrome restart.
- **The gap:** The policy fixed multiple time boundaries but not their scheduler or
  ordering when several become eligible together.
- **The reach:** Time thresholds define eligibility; physical action can lag by one
  desktop tick. New time-based browser rules belong in the manager tick/queue, and
  process-lifecycle rules remain in the supervisor rather than side timers.
- **Verdict:** sound — one desktop loop and owner-specific serialized queues make
  races and restart behavior inspectable without merging process ownership into the
  browser manager.
- **Confidence:** high.

### Capacity protects active work and fails visibly when full

- **When:** Managed-window policy.
- **The choice:** Root and named agents share one finite managed-window pool. When a
  new owner arrives, Duet evicts the least-recently-active idle managed window. A
  window with a live lease, current native focus, or cooling grace is protected. If
  every slot is protected, the caller receives a typed retryable capacity error;
  Duet neither steals an active window nor silently shares one with the new owner.
- **The gap:** A cap alone did not define which work could be lost or what admission
  should do when no safe victim exists.
- **The reach:** Human-created tabs inside a managed window inherit that window's
  declared eviction fate. Unmanaged human top-level windows remain outside this
  ledger and cap.
- **Verdict:** sound — overload is bounded, deterministic, and observable.
- **Confidence:** high.

### Reconciliation validates witnesses and treats Chrome restart as destructive

- **When:** Durable manager and restart handling.
- **The choice:** A gateway restart reloads its small ledger and retains a native
  window id only when the recorded tab and CDP target still witness that same
  window. It never claims a window from a matching number, title, or class alone.
  A newer extension connection supersedes older in-flight reconciliation. If the
  Chrome process generation changes, old targets, windows, batches, and unused
  grants are discarded and recreated lazily rather than migrated.
- **The gap:** Gateway can restart independently of Chrome, while Chrome can reuse
  numeric ids and cannot preserve meaningful automation ids across its own restart.
- **The reach:** Ambiguous survivors can remain unmanaged until manual close, a
  Chrome generation boundary, or full desktop shutdown; managed-window LRU cannot
  see them. Simple validation is preferred over elaborate orphan recovery. Chrome
  maintenance may override page retention rather than delaying updates.
- **Verdict:** sound — it preserves recoverable ownership without guessing across
  an identity boundary Chrome does not support.
- **Confidence:** high.

### Agent Desktop focus is a separate, idempotent, focus-if-present action

- **When:** Product integration.
- **The choice:** Opening an agent's Desktop destination sends one request to focus
  that owner's existing window. Repeating the same request is harmless. If no
  managed window exists, it returns `focused: false` and creates nothing. Viewer
  grant minting and renewal remain workspace-wide and carry no focus side effect;
  otherwise a cache refresh could steal foreground minutes after the user chose a
  different window.
- **The gap:** The product route originally showed the same workspace stream for
  every agent and had no owner-selection contract.
- **The reach:** Focus request identity is separate from viewer credentials and
  stable owner identity is resolved server-side from the route slug. Missing focus
  never starts Chrome or consumes capacity.
- **Verdict:** sound — user navigation or browser activity orients the shared screen
  without coupling foreground changes to credential refresh.
- **Confidence:** high.

### Browser activity retains the stack, but does not promise durable pages

- **When:** Desktop lifecycle policy.
- **The choice:** Live runners and viewers still start the shared desktop eagerly.
  Recent browser activity retains Kasm, X, and Chrome long enough for a later turn
  to revisit tabs, while idle discard handles CPU. Chrome update, Chrome restart,
  and full desktop stop may still close all pages. The alternative was to keep the
  whole browser alive as a hard durability promise, which would delay maintenance
  and confuse a resource-retention preference with data durability.
- **The gap:** The user preferred CPU savings over memory savings and wanted tabs
  available across nearby turns, but accepted that the retention duration could be
  tuned later.
- **The reach:** Page retention is best effort within one Chrome generation. Durable
  user data belongs in files/profile storage, not open renderer state.
- **Verdict:** sound — it separates process cost policy from persistence guarantees.
- **Confidence:** high.

### Production promotes accepted bytes and isolates scratch exceptions

- **When:** Staging and production fleet rollout.
- **The choice:** The image accepted in staging is copied by immutable digest into
  production rather than rebuilt. Fleet reprovision first attempts to archive each
  workspace independently. During this prelaunch rollout, one archive-blocked
  workspace could be recreated from scratch only after a dry run proved it was the
  sole remaining candidate and the user explicitly authorized the loss. The
  alternative was a broad discard flag that would erase healthy workspaces merely
  because one archive failed.
- **The gap:** The rollout choreography assumed state-preserving archives, but the
  existing archive service could not accept one oversized/stuck workspace and the
  product had not launched.
- **The reach:** Exact-byte promotion remains mandatory. State preservation remains
  the default; a future scratch operation needs the same explicit scope and must
  report that prior VM filesystem state is unrecoverable through Duet.
- **Verdict:** sound — the exception matched the user's prelaunch risk tolerance
  without weakening fleet-wide safety.
- **Confidence:** high.
