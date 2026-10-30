# Agent-owned browser windows

## Overview

Duet gives root and each browser-using agent identity one managed Chrome window on
the shared VM desktop. Temporary sessions do not become permanent window owners:
they open fresh batch tabs inside their agent's window, so concurrent sessions do
not accidentally reuse a page and users do not have to garden thousands of
session-shaped windows.

This is organization and resource scheduling, not isolation. The user and every
agent see the same desktop and share one Chrome profile and default browser
context. An agent may inspect or operate another visible tab or window when that
is useful. [`SECURITY.md`](../../../SECURITY.md) remains the trust-boundary record.

## Why this shape

Chrome can share live cookies and profile state safely only through one browser
process using one profile directory. That process is attached to one X display,
while Kasm streams that display's single foreground. Separate X displays would
permit independent screens but would require competing Chrome processes or
separate profiles. XFCE workspaces would organize windows cheaply, but every
viewer would still see whichever workspace is globally selected and XFCE's
workspace limit is far below Duet's possible agent count.

Stable agent identity is therefore the useful ownership unit. A session is a
temporary automation lease; an agent window is the durable place where related
tabs collect. Root adopts Chrome's bootstrap window, while named-agent windows
are created lazily. New browser use and the agent Desktop door bring the exact
managed window forward, preserving the shared-desktop mental model.

Chrome's DevTools Protocol cannot create a tab in a specified existing Chrome
window. A small force-installed extension owns that native operation. The gateway
still owns identity, policy, persistence, and the automation lease; the extension
is only an actuator. This split avoids unreliable X11 title/class matching while
keeping one clear policy owner.

Renderer CPU mattered more than retaining in-memory page state. Both CDP page
freezing and Chrome-window minimization failed to reduce timer activity or CPU on
the pinned browser. Native tab discard did reduce renderer CPU to zero, but Chrome
replaces the native tab/target identity and reloads on activation. Duet accepts
that boundary only for idle agent-batch tabs; human-created tabs are excluded.

## Principles and invariants

- One X display, one Kasm stream, one Chrome process, one profile, and one default
  browser context remain load-bearing. Agent ownership must not introduce a
  second Chrome process or browser context.
- Browser ownership is `{kind: 'root'}` or a stable agent id. A browser invocation
  owns a temporary batch, while its session envelope resolves the stable owner;
  anchor ids resolve and tear down ownership, and mutable slugs and names are
  presentation only.
- Only an existing gateway session envelope without an agent anchor is root.
  Missing, discarded, or unresolved bound sessions never fall back to root.
- Each browser invocation receives a fresh initial tab. Additional pages and
  popups attributed to that batch share its lifetime, while browser-wide target
  visibility remains intentional.
- The extension owns exact-window create/restore/focus/close mechanics. The
  gateway browser manager owns policy and the durable `.duet/desktop` ledger. The
  CDP proxy owns live automation leases. The desktop supervisor/systemd target
  alone starts and stops Kasm, X, and Chrome.
- Root counts toward the managed-window cap. Capacity may evict only an idle,
  least-recently-active managed window; if every window is protected, callers get
  a typed retryable capacity response.
- Automation disconnect and native focus loss begin the idle grace. Idle
  batch-attributed background tabs may be discarded and rebound to Chrome's
  replacement ids. Human-created tabs are not automatically discarded or
  batch-expired, though their managed window can still be evicted by the declared
  window policy.
- Gateway restart reconciles known records against live Chrome and discards stale
  bindings rather than guessing. Chrome restart, Chrome maintenance, and full
  desktop stop are destructive browser-generation boundaries.
- Opening an agent's Desktop route performs one idempotent focus-if-present
  mutation. That mutation never creates a window, starts Chrome, consumes capacity,
  or ties a focus side effect to viewer-grant renewal. The route's ordinary viewer
  grant may still start the shared desktop.
- Foreground selection is global and last-action-wins. Managed windows are a UX
  boundary, never an access-control boundary.
- Image promotion is exact-byte: production receives the staging-accepted digest,
  never a rebuild. Fleet reprovision preserves VM state by default; any scratch
  exception must be explicitly authorized and scoped to the exact blocker.

The exact constants and wire schemas live in
[`packages/contract/src/desktop/index.ts`](../../../packages/contract/src/desktop/index.ts);
this rationale deliberately does not duplicate them.

## Code map

- [`browser-manager.ts`](../../../packages/gateway/src/desktop/browser-manager.ts)
  is the policy/state-machine owner. Its focused tests pin owner reuse, capacity,
  discard/rebind, expiry, reconciliation, and generation changes.
- [`browser-ledger.ts`](../../../packages/gateway/src/desktop/browser-ledger.ts)
  owns durable logical records and atomic persistence.
- [`browser-batches.ts`](../../../packages/gateway/src/desktop/browser-batches.ts)
  resolves a gateway session to a stable owner and starts a fresh batch.
- [`cdp-proxy.ts`](../../../packages/gateway/src/desktop/cdp-proxy.ts) and
  [`extension-bridge.ts`](../../../packages/gateway/src/desktop/extension-bridge.ts)
  own the automation relay and native actuator channel respectively.
- [`routes/desktop.ts`](../../../packages/gateway/src/routes/desktop.ts) exposes the
  VM-local batch, focus, status, extension, and inventory surfaces;
  [`supervisor.ts`](../../../packages/gateway/src/desktop/supervisor.ts) retains
  process-lifecycle ownership.
- [`packages/vm-image/desktop/chrome-extension/`](../../../packages/vm-image/desktop/chrome-extension/)
  contains the minimal native actuator. The Chrome service, launcher, and image
  verifier in [`packages/vm-image/`](../../../packages/vm-image/) pin the one-browser
  image contract.
- [`apps/api/src/routes/desktop.ts`](../../../apps/api/src/routes/desktop.ts) resolves
  the product route to stable identity. The one-shot UI effect and owner rail live
  in [`apps/web/spa/desktop/`](../../../apps/web/spa/desktop/).
- [`staging-e2e-synthetic`](../../../packages/test-harness/src/staging-e2e-synthetic)
  is the focused live acceptance journey. It proves shared profile state, stable
  owner windows, fresh batches, exact focus, idle discard, and deletion cleanup.

## Dead ends and boundaries

- Per-agent virtual desktops do not provide independent viewing and have a small
  hard workspace cap.
- Separate X displays conflict with one concurrently writable Chrome profile.
- Per-session windows turn temporary sessions into an unbounded cleanup burden;
  one canonical tab per agent instead makes concurrent sessions collide.
- Raw CDP plus a timer cannot know when automation has disconnected. The gateway
  proxy is needed for an exact lease boundary.
- Full CDP virtualization would prevent intentional cross-window inspection and
  add machinery without creating a meaningful security boundary inside the VM.
- CDP cannot place a new tab into a chosen existing window. X11 window ids cannot
  be inferred safely from Chrome ids, class, PID, title order, or coordinates.
- CDP lifecycle freeze, window focus changes, and minimization did not quiet the
  renderer on pinned Chrome. Extension-native tab freeze was rejected by Chrome;
  discard is the measured CPU-saving mechanism and carries a reload/state-loss
  boundary.
- Window-only streaming remains a separate transport problem: cropping, input
  coordinate translation, clipboard, resize, decoration, and window recreation
  are not Kasm configuration details. The managed Chrome window id is preserved so
  that future transport can address it without changing ownership.

## Visual provenance

The final live staging journey produced the acceptance pair below. These are real
product and framebuffer captures, not mockups. They were judged for one question:
selecting Alpha and then Beta must put the corresponding existing Chrome window on
top while the desktop framing stays unchanged.

- [Alpha product capture](assets/staging-acceptance/agent-browser-alpha-product.png) and
  [Alpha framebuffer](assets/staging-acceptance/agent-browser-alpha-framebuffer.png)
- [Beta product capture](assets/staging-acceptance/agent-browser-beta-product.png) and
  [Beta framebuffer](assets/staging-acceptance/agent-browser-beta-framebuffer.png)

The native extension/focus image in
[`assets/native-probes/2026-08-13-extension-focus.png`](assets/native-probes/2026-08-13-extension-focus.png)
is earlier exact-image evidence that a minimized or obscured Chrome window can be
restored and become the X11 active window. It drove the decision to keep X11 as a
verification oracle rather than the production placement mechanism.

The retained probe reports under [`assets/native-probes/`](assets/native-probes/) document
the failed freeze approaches and measured discard economics. Final staging and
production rollout evidence is retained under
[`assets/staging-acceptance/`](assets/staging-acceptance/) and
[`assets/production-rollout/`](assets/production-rollout/).
