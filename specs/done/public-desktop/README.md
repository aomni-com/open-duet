# Public Desktop API and Human Handoff

## Overview

Duet exposes its shared VM desktop as public REST primitives plus a short-lived
iframe capability. A customer can reproduce Duet's desktop pane without a Duet
SDK: mint a viewer URL on their backend, embed it on the approved origin, read
desktop status, and focus an existing agent window.

The same surface supports human handoff. An agent can foreground the exact page
it wants a person to see, link the agent's desktop, and optionally end its turn
with a `Done` / `I'm stuck` question. The next turn starts a fresh browser batch
and rediscovers the presented page from current browser state.

## Why this shape

The desktop is one shared VM framebuffer, not a per-agent security boundary.
Agents, the user, and customer integrations may see and operate the same Chrome
profile and windows. Agent ownership organizes presentation and resource use;
it does not create separate trust domains.

Viewer expiry is admission-only. The capability URL limits when a new HTTP or
WebSocket connection may begin; it is not a lease timer for a connection that
already passed admission. This keeps a healthy VNC session stable instead of
visibly replacing the iframe every 90 seconds.

Origin binding is exact and per grant. The gateway writes the grant's canonical
origin into `frame-ancestors` for that response rather than maintaining a broad
workspace allowlist. A wildcard would turn the capability into the only embed
boundary and make accidental disclosure materially easier to exploit.

The public API uses the existing workspace `sessions` capability. A second
desktop scope would duplicate the authority already required to operate agent
sessions without creating meaningful isolation inside the VM.

The headed browser is the right handoff tool when a human should see, log in,
confirm, or continue the work. Firecrawl remains preferable for unattended
search, crawling, bulk extraction, and datacenter-IP fallback.

## Public contract

All operations require `ws:{workspaceSlug}:sessions`:

| Method | Path | Request | Success |
|---|---|---|---|
| `POST` | `/v1/ws/{workspaceSlug}/desktop/session` | `{ embedOrigin }` | `{ entryUrl, expiresAt, phase, screen }` |
| `GET` | `/v1/ws/{workspaceSlug}/desktop/status` | none | `{ phase, viewers, owners }` |
| `POST` | `/v1/ws/{workspaceSlug}/agents/{agentSlug}/desktop/focus` | `{ requestId }` | `{ focused }` |

`embedOrigin` must already equal `new URL(input).origin`. It is HTTPS except
for loopback HTTP and contains no credentials, path, query, fragment, wildcard,
or alternate default-port spelling. `screen` is the real VM framebuffer size.
`entryUrl` is capability-bearing and must never be logged or persisted.

The route for every user-facing desktop, including root, is:

```text
/w/{workspaceSlug}/agents/{agentSlug}/desktop
```

Root uses `agentSlug = root`. The workspace-level desktop view remains hidden.

The general authenticated API ceiling is 600 requests per fixed 60-second
window per stable non-VM principal. Desktop participates normally; `system_vm`
credentials and authentication-bypassed routes are exempt, while existing
stricter operation-specific limits remain additional ceilings. Public error
unions and endpoint metadata live with the shared schemas rather than in the
docs.

## Invariants

- One VM owns one X display, framebuffer, Chrome process, default browser
  context, and shared profile.
- `entryUrl` expiry rejects fresh HTTP and WebSocket admissions but never
  terminates an admitted relay.
- Each grant carries one exact canonical embedding origin; no wildcard or
  workspace-global origin list exists.
- Viewer URLs contain no redundant public token field. The public mint response
  remains `{ entryUrl, expiresAt, phase, screen }`.
- Focus is idempotent and focus-if-present. It never creates a browser window.
- Root and named agents use stable owner identity, never mutable slug, for
  managed-window state.
- Browser batch handles do not cross turns. A resumed handoff starts with a
  fresh target, then rediscovers and may reactivate the original marked page by
  URL, title, or visible evidence.
- Chrome restart must not replace KasmVNC. The aggregate target requires Kasm,
  wants the self-restarting browser, and owns both units for aggregate stop.
- Desktop capabilities and browser debugger URLs never enter retained staging
  artifacts.
- Production receives the exact image digest accepted in staging; it is not
  rebuilt during promotion.

## Code map

- Public schemas and endpoint metadata: `packages/contract/src/desktop/index.ts`
  and `packages/contract/src/endpoints/index.ts`.
- Public authorization, errors, and mint/status/focus routes:
  `apps/api/src/routes/desktop.ts`.
- VM grant admission, exact CSP, and VNC relay:
  `packages/gateway/src/routes/desktop.ts`.
- Browser owner windows, batches, focus, discard, and capacity:
  `packages/gateway/src/desktop/browser-manager.ts`, with durable state and
  atomic persistence in `packages/gateway/src/desktop/browser-ledger.ts`.
- Product iframe lifecycle: `apps/web/spa/desktop/workspace-desktop.tsx`.
- Image-installed Chrome actuator and desktop unit graph:
  `packages/vm-image/desktop/chrome-extension/` and
  `packages/vm-image/systemd/duet-desktop.target`.
- Agent guidance: `packages/skills-registry/skills/workspace-browser/SKILL.md`
  and `packages/skills-registry/skills/duet/SKILL.md`.
- Public developer guide and executable example: `apps/docs/app/desktop/` and
  `apps/docs/examples/desktop-browser.ts`.
- Cross-service acceptance:
  `packages/test-harness/src/staging-e2e-synthetic` and
  `packages/test-harness/src/staging-e2e-synthetic`.

Focused tests sit beside those owners. The image verifier additionally checks
the installed extension, fixed framebuffer, Chrome profile, and systemd
dependency shape; the CDP proxy and its focused tests enforce the single
default-context contract.

## Dead ends and divergences

- Per-agent virtual desktops were rejected in favor of one top-level Chrome
  window per stable agent identity. They would not provide independent streams
  on one X display, and separate displays cannot share one live Chrome profile.
- Page lifecycle freezing and window minimization did not reduce renderer CPU
  on the pinned Chrome build. Background batch tabs use destructive discard
  instead; tab identity changes and in-memory page state is intentionally lost.
- A transparent CDP proxy was not treated as agent isolation. The VM is one
  trust domain, and cross-window inspection is useful for user-directed work.
- The first Chrome/Kasm repair removed a browser-to-Kasm requirement but missed
  the reverse `Requires=` edge from the aggregate target. A held staging VM
  showed Chrome's forced-extension restart deactivating the target and replacing
  Xvnc. The shipped target requires Kasm and only wants Chrome. Relay heartbeats
  were tested and removed because they masked this process-lifecycle defect.
- The live handoff test uses durable session history after asynchronous answer
  submission. Long-held `/answer/wait` transport behavior belongs to its own
  acceptance journey and must not obscure browser handoff correctness.

The detailed decision history, including rejected alternatives and confidence,
is retained in [choices.md](choices.md).

## Release evidence

The focused staging journey passed on immutable image digest
`sha256:8ad8f9528bf575b22ee2d8d26ac1bd15238d969492c2c8df4d569e8b7aa27187`.
It proved origin binding, admission-only viewer lifetime, shared-profile owner
windows, exact focus, discard/reactivation, deletion cleanup, and the terminal
human-handoff/resume flow. The same bytes were promoted to production without a
rebuild. Final staging and production fleet inventories reported every attached
live VM on that digest.

No standalone visual baseline lives in this spec. The desktop appearance was
not redesigned; live product and framebuffer screenshots were acceptance
evidence for focus behavior, while the existing VM Desktop visual provenance
remains owned by `specs/done/vm-desktop/`.
