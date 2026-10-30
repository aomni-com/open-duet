# VM Desktop

VM Desktop gives every workspace VM one streamable graphical desktop and one
headful Chrome shared by the human and all agent sessions. Humans can watch an
agent work in the same browser profile where they signed in, while concurrent
agent sessions receive different tabs instead of fighting over one page.

This is the rationale and invariant record for the shipped feature. The code is
the source of truth for mechanics; this document explains why those mechanics
have their present shape.

## Why it is shaped this way

- **The product is observable work, not remote administration.** The main use is
  watching an agent browse. Opening Desktop therefore starts the stack instead
  of showing an empty state, and an agent action raises its own tab so the
  visible screen shows signs of life.
- **One display and one browser profile are the feature.** Human and agent tabs
  share cookies and login state in Chrome's default context. Per-agent tabs
  prevent accidental page collisions without introducing isolated browser
  contexts or separate desktops that would defeat shared login and observation.
- **The gateway is the only browser-visible door.** The VM's portless public
  HTTPS share already fronts the gateway. KasmVNC and Chrome DevTools bind only
  to loopback; the gateway authenticates the browser, injects Kasm's VM-local
  credential, and relays HTTP and WebSocket traffic through that existing
  share.
- **Runtime state stays beside the runtime.** Desktop phase, viewer count,
  recent drivers, and session-to-tab assignments are gateway memory, not Convex
  state. A durable mirror could disagree with the processes it claims to
  describe. The Chrome profile is durable gateway state under `.duet`, outside
  the synced Drive, because live browser databases are not safe file-sync
  material.
- **The image owns the experience.** The desktop environment, browser, visual
  composition, connection branding, service wiring, and narrow privileged
  helpers are reproducible image inputs. A fresh VM therefore has the same
  desktop without a mutable first-boot customization rail.

## Invariants

1. **The screen is exactly 1440×900.** The web pane scales the complete screen
   into symmetric letterboxing. It does not resize X, crop, stretch, or invent a
   responsive desktop resolution.
2. **There is one X display and one Chrome per VM.** Both product routes show the
   same pixels. Every Chrome target is created in the default browser context so
   cookies are shared; a session's target id is an in-memory convenience, not a
   security boundary.
3. **Demand owns lifecycle.** A live agent runner or a viewer opening Desktop
   starts `duet-desktop.target`. The gateway reaps it only after there are no
   live runners, no viewers, and the request grace has elapsed. There is no
   `desktopEnabled` field or other durable lifecycle owner.
4. **No browser-reachable desktop service listens outside loopback.** Public
   HTTP and WebSocket traffic always enters through the gateway; Desktop
   deliberately bypasses `apps/edge`.
5. **Kasm's local Basic credential is random at first state initialization.**
   It then persists with ordinary `.duet` archive/restore state, lives in a
   mode-0600 file, and is injected only into loopback upstream requests. The
   browser credential is a separate short-lived, digest-at-rest grant. The Kasm
   credential is never baked into the image or shared fleet-wide.
6. **Desktop URLs do not become durable credentials.** The API issues them only
   to authenticated browser members, returns `no-store` and `no-referrer`, and
   registers only a token digest with the VM. Credential-free, expired, and
   malformed paths fail closed.
7. **Desktop relay bytes are not tunnel frames.** Kasm uses WebSocket-to-
   WebSocket relay. It shares the gateway's single WebSocket router and digest
   grant implementation with the sync tunnel, but never the tunnel's TCP
   framing.
8. **Chrome DevTools stays on loopback without `--remote-allow-origins`.** The
   agent tooling contract returns the browser-level CDP URL plus the caller's
   exact `targetId`; the authored workspace-browser skill must select that
   target instead of guessing that the first page belongs to the caller.
9. **The browser version has two identical release paths.** Image build and the
   audited in-place update helper consume the same version and SHA-256 pin. The
   update gate refuses live agent work, blocks new desktop/runner starts during
   maintenance, and never leaves Google's autonomous update machinery behind.
10. **Reprovision preserves `.duet` and Drive unless state discard is explicit.**
    Chrome's regenerable caches are excluded from the archive, not its profile.
    `--discard-state` is intentionally destructive: the new VM starts empty and
    filesystem-authoritative reconciliation subsequently removes agent/app rows
    whose folders remain absent.

## Where the contracts live

- Shared dimensions, ports, URL grammar, grant TTL, Chrome pin, profile path,
  Kasm credential path, and cache exclusions:
  `packages/contract/src/desktop/index.ts`.
- Gateway lifecycle, browser target ownership, ingress, and Chrome maintenance:
  `packages/gateway/src/desktop/supervisor.ts`,
  `packages/gateway/src/desktop/browser.ts`,
  `packages/gateway/src/desktop/chrome-update.ts`, and
  `packages/gateway/src/routes/desktop.ts`. The one WebSocket discriminator is
  `packages/gateway/src/runtime/ws-router.ts`; expiring digest grants are in
  `packages/gateway/src/auth/digest-grants.ts`.
- Browser-member issuance and status:
  `apps/api/src/routes/desktop.ts` and `apps/api/src/gateway/client.ts`.
- The two product doors and the common fitted pane:
  `apps/web/spa/desktop/`, `apps/web/spa/routes/desktop.tsx`,
  `apps/web/spa/routes/product-destinations.ts`,
  `apps/web/spa/drive/agents-map-url.ts`, and
  `apps/web/spa/routes/agents-map/agent-surface/stage.ts`.
- Image composition and verification: `packages/vm-image/desktop/`,
  `packages/vm-image/systemd/`, `packages/vm-image/scripts/verify-image.ts`, and
  `packages/vm-image/src/vm-image.test.ts`.
- Agent control policy: the `workspace-browser` skill under
  `packages/skills-registry/skills/`. It prefers headed Chrome for interaction
  or one specific visible page, and Firecrawl for broad multi-page retrieval or
  as the datacenter-IP fallback.
- Live acceptance: `runAgentBrowserWindowsJourney` in
  `packages/test-harness/src/staging-e2e-synthetic`, registered
  as `agent-browser-windows` in `packages/test-harness/src/staging-e2e-synthetic`.
- Fleet rollout: `packages/backend/scripts/reprovision-fleet.ts`; normal
  workspace reprovision remains owned by
  `packages/backend/convex/domains/workspaces/provisioningActions.ts`.

## What the build taught us

KasmVNC 1.5.0 worked at 1440×900 without cross-origin isolating the product
app. The [initial transport probe](assets/kasmvnc-initial-probe.md) measured no
CPU on a static screen, about 3.5% of one core while a full-screen page
scrolled, and about 346 MB RSS for the desktop stack before Chrome. The later
[public gateway probe](assets/kasmvnc-slice04-public-probe.md) measured 5.70%
scrolling CPU across the complete relayed path.

The first plan assumed Kasm's own Basic authentication could be disabled. The
packaged runtime instead requires credential material, so the shipped design
creates a per-VM local credential and has the already-authenticated gateway
inject it. This preserves one user-visible gate without depending on an
unsupported Kasm mode.

Cold start is dominated by image availability. The retained
[public probe](assets/kasmvnc-slice04-public-probe.md) reached pixels in roughly
9 seconds with the image available; uncached pulls take materially longer. The
browser must therefore show a connecting state rather than promise an instant
empty desktop.

The first live product capture also exposed a geometry race: a transformed
agent pane briefly reported painted bounds smaller than its layout bounds,
leaving the desktop flush-left. The fit owner now measures layout space, and
the staging journey rejects unequal padding.

The pre-launch rollout deliberately allowed disposable VMs. The automated
runner originally treated a changed VM name as proof of replacement, but VM
names are deterministic; that caused repeated staging reprovisions. Completion
is now proven by workspace id, active status, and exact image digest. State
discard remains an explicit operator decision rather than a normal fallback.

## Rejected alternatives

- **x11vnc + websockify + noVNC:** more independently moving pieces than the
  verified single-port KasmVNC stack.
- **Per-agent displays or Chrome contexts:** they hide work from the shared
  desktop and split the login state the feature exists to share.
- **An advisory instruction as tab ownership:** two concurrent agents can still
  collide; the gateway must assign and return an exact target.
- **Routing through `apps/edge`:** its deployed fetch handler cannot terminate
  the desktop WebSocket upgrade.
- **Cross-origin isolating the whole app:** unnecessary for Kasm's working
  fallback and incompatible with arbitrary workspace apps lacking CORP headers.
- **Automatic Google APT updates:** they can replace browser binaries beneath a
  running shared Chrome and break later renderer creation unpredictably.
- **Deleting inherited `/headless-shell`:** it comes from the exe.dev base;
  deleting it in a later image layer hides the file without reducing transfer
  size.
- **Syncing the Chrome profile through Drive:** Chrome's live SQLite databases
  can be copied mid-write and a laptop would become a second incompatible
  writer. The existing `.duet` archive rail is the correct durability owner.

## Visual provenance

The approved direction came from
[`reference-desktop.png`](assets/reference-desktop.png), an accepted screenshot
captured from the scratch desktop prototype during the 2026-08-11 planning
probe. Its light macOS-like composition—wallpaper visible around a
non-maximized browser, an empty desktop, top panel, and dock—set the standard,
not a demand for pixel identity.

The progression is retained because each image proved a different boundary:
the [scratch exe.dev Kasm probe](assets/kasmvnc-probe-desktop.png), the
[exact local image verifier framebuffer](assets/kasmvnc-slice02-framebuffer.png),
the [local Docker gateway journey](assets/kasmvnc-slice03-gateway.png), the
[disposable public exe.dev VM](assets/kasmvnc-slice04-public.png), the
[native shared-Chrome probe](assets/kasmvnc-slice05-chrome.png), and the
[native workspace-browser skill probe](assets/kasmvnc-slice07-agent-browser.png).
Their system evidence is preserved in the neighboring probe reports under
`assets/`.

[`kasmvnc-slice08-desktop.png`](assets/kasmvnc-slice08-desktop.png), captured
from the exact local styled image, is the ready-state look: Duet wallpaper, no
desktop icons, readable top chrome, and a five-entry Plank dock with exactly one
browser. Loader branding is independently pinned by the image verifier rather
than this ready-state screenshot. The live staging
[product capture](assets/vm-desktop-staging-agent-visible.png) is the final
symmetrically fitted product standard. Its neighboring
[canvas-element capture](assets/vm-desktop-staging-framebuffer.png) preserves
the complete streamed desktop pixels at their rendered CSS size, with visible
agent-driven Chrome; it is not a raw 1440×900 framebuffer dump.

## Verification and deliberate limits

The registered staging journey proves cold connection, fixed 1440×900 geometry
with symmetric fitting, matching sampled framebuffer signatures through both
routes, a reported agent driver plus visible framebuffer change, reap/restart,
and credential-free and expired URL refusal. Its cleanup ledger fails unless
workspace teardown completes and the VM association is cleared.
Focused contract, gateway, API, web, image, and harness suites plus the image
verifier and screenshot critiques were green at shipment. The repository-wide
closeout retained unrelated baseline failures; this feature does not claim a
historically all-green root suite.

Audio packages are present but audio remains off. Responsive VM resolutions,
multi-monitor support, per-agent desktops, thumbnails, read-only viewers, and
state migration beyond the current archive/restore rail and explicit
destructive discard were deliberately not shipped. Adding any of them changes
a product or ownership decision rather than completing unfinished VM Desktop
work.

The final decision audit is retained in [`choices.md`](choices.md).
