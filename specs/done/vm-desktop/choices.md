# Choices ledger — VM desktop exploration

Started 2026-08-11 with a live probe on two throwaway exe.dev VMs
(`duet-desktop-probe`, `duet-desktop-probe2`, both deleted) plus read-only
inspection of a staging workspace VM. Later sections bank the choices made
during implementation, live acceptance, branding, and fleet rollout. Terms are
defined where they first appear.

Entries stay grouped by the pass that made them; each records its confidence
explicitly so review does not depend on historical file order.

## Final audit — 2026-08-12

- **Needs user:** none.
- **Unsound:** none.
- **Sound:** all 43 previously banked implementation choices below, plus the
  deterministic fleet-convergence correction added at closeout. User-settled
  product decisions remain listed separately and are not relabeled as agent
  discretion.

The full scenarios remain intact below because the trigger, rejected
alternative, and future reach are the review surface. The closeout audit did not
compress them into headlines.

## Decisions — Example User, 2026-08-12

1. **Current workspace VMs are disposable.** Duet has not launched and the
   existing VMs are recent, so this rollout does not need a 1 GiB archive-size
   census or a preservation-first migration sweep. Delete and provision a fresh
   VM when an existing workspace cannot move cleanly. This supersedes the
   stage-2 rollout choice below for the current pre-launch fleet; revisit the
   preservation contract before launch rather than building migration machinery
   now.

## Decisions — Example User, 2026-08-11

The needs-user entries below are now settled; kept in full for the why.

1. **Bake into the one image.** New image, then reprovision or simply delete
   every workspace in both envs — pre-launch, both are wipeable. No on-demand
   install, no second image variant.
2. **Keep the probed look** (XFCE + WhiteSur + plank dock, no desktop icons).
3. **One browser, one profile.** Agent and human share the same headful Chrome
   *and the same profile* — human logs in, agent uses the session; they can work
   in different tabs. Watching the agent browse is a feature. `headless-shell`
   leaves the image once the agent's browser path points at headful Chrome.
4. **Fixed 1440x900, documented as a contract.** The web UI renders the stream
   at that aspect ratio; resize-on-connect is explicitly out.
5. **No `--remote-allow-origins=*`** — confirmed after ELI5: dropping the flag
   costs the agent nothing (only browser pages carry an Origin header; scripts
   connect fine under the default policy), so the flexible option and the safe
   option are the same option.
7. **Superseded first lifecycle rule: key the stack on the agent session, not
   the viewer.** The
   reaper tears the desktop stack down only when **no agent session is
   running** — it does not reap just because the human closed the viewer tab.
   So the stack is up whenever there's a live agent session (agent may browse
   with nobody watching, and the human can reattach at any time to see it), and
   down only once the session itself ends. RAM returns to ~0 at that point. The
   shipped rule also treats a viewer opening Desktop as demand; the final
   gateway-owned lifecycle entries below supersede this first formulation.

### Stage-2 decisions from the quadrant walk (Example User, 2026-08-11)

- **Desktop lifecycle owner: gateway-local, session-driven.** The in-VM gateway
  starts the desktop stack when an agent session starts and reaps it when the
  session ends — no Convex `desktopEnabled` field, no poll latency, no state
  that can disagree with what is running. The Computer tab connects and finds
  the desktop already there.
- **Fleet rollout: reprovision sweep across both envs.** `reprovisionWorkspace`
  already archives, provisions onto the new image, and restores; it defers any
  workspace with active agent sessions or train jobs
  (`provisioningActions.ts:51`). Chosen over deleting all workspaces because
  pre-launch is exactly when we want to discover a broken upgrade rail, and
  delete-everything remains the fallback if the sweep misbehaves.
- **Chrome profile: `/home/synthetic-user/.duet/chrome/`, not the drive.** The archive
  already carries the gateway state dir alongside the drive
  (`vm/archive.ts:186`), so the profile survives reprovision with no new
  mechanism. Rejected drive-hosting despite the user's willingness: Chrome keeps
  `Cookies`/`History`/`Login Data` as live SQLite databases, and a file-level
  syncer copying those mid-write ships torn pages while the user's laptop
  becomes a second writer. The cross-machine wish is served properly by signing
  into Chrome with a Google account inside the workspace — a Linux profile
  directory is not portable to macOS anyway (credentials are sealed to the OS
  keyring). **The archive gains cache exclusions** (`chrome/Default/Cache`,
  `Code Cache`, `GPUCache`, `chrome/ShaderCache`) so a regenerable few hundred
  MB cannot push a workspace past `ARCHIVE_MAX_BYTES` (1GB) and fail its
  reprovision with `413 archive_too_large`. **The cap itself stays at 1GB** —
  raising it was considered and dropped, since 1GB mirrors a Convex per-file cap
  rather than a choice of ours and the archive streams inside the Node runtime's
  10-minute ceiling; Example User: "realistically we won't hit it."
- **Chrome updates: pinned in the image + an explicit update trigger (option C),
  in scope now.** Corrects a common assumption: Chrome on Linux has **no**
  self-updater — it defers to APT, and Ubuntu's `unattended-upgrades` does not
  cover Google's third-party origin by default. Letting apt upgrade Chrome in
  the VM would also swap binaries under a *running* browser, after which that
  instance cannot spawn new renderers — with one browser shared by human and
  agent, that surfaces as the agent's next navigation dying mid-session. So the
  version stays part of the image digest, and a gateway-exposed trigger patches
  a CVE without a full reprovision sweep.

**Transport: KasmVNC** (not the probed x11vnc/noVNC trio). Modern browser-first
VNC server — WebP/QOI encodings, WASM decode, true lossless, audio, serves its
own client over one WebSocket port. Replaces x11vnc + websockify + noVNC.

### Verification — KasmVNC 1.5.0 on a scratch exe VM, 2026-08-11

VM `duet-kasm-probe` (Ubuntu 24.04 noble, 2 vCPU / 8GB), deleted after. Result:
**works, and is cheaper than the probed stack.**

- **One port does everything.** `:6901` serves the web client *and* the pixel
  stream, and carries its own auth: unauthenticated `401`, authenticated `200`.
  That is the single-WebSocket shape the gateway bridge wants — one route, not a
  client server plus a stream server.
- **Resolution contract honored.** `desktop.resolution` + `allow_resize: false`
  in `~/.vnc/kasmvnc.yaml` produced exactly `1440x900`.
- **CPU, measured on the transport we are actually shipping** (`/proc` jiffies
  for the `Xvnc` process, three 20s windows): **no viewer 0%**, **viewer
  attached on a static screen 0%**, **viewer attached while a full-screen page
  scrolls continuously 3.5% of one core.** This supersedes the H.264 figure that
  ledger entry 7 called unsound — the real transport is ~5x cheaper, and it
  confirms cost tracks *screen change*, not framerate.
- **Memory of the desktop stack, no browser:** ~346MB
  (Xvnc 152 / xfdesktop 68 / xfwm4 43 / plank 39 / xfsettingsd 29 / devilspie2 15).
- **Windows open maximized** via a 3-line `devilspie2` rule plus Chrome's
  `--start-maximized`.
- **Shared-profile Chrome with CDP works and needs no origin flag** — decision 3
  and decision 5 hold together.

Operational gotchas pinned (all systemd-unit relevant):

- `kasmvncserver` decides it is a packaged install by matching **its own
  invocation path against `^/usr`**. Started as `kasmvncserver` it resolves via
  PATH to `/bin/kasmvncserver`, fails the match, and dies hunting for a
  build-tree script. **Always invoke `/usr/bin/kasmvncserver`.**
- It requires a TLS keypair at startup **even with `require_ssl: false`**, and
  the distro snakeoil pair sits under `/etc/ssl/private` (mode 710), which a
  normal user cannot traverse — reported as "certificate file doesn't exist".
  Give it a Duet-owned keypair (the probe used `~/.vnc/pki`).
- `-select-de xfce` **overwrites `~/.vnc/xstartup`**, so session contents must be
  configured through it, not around it.
- Its argv defaults include `-drinode /dev/dri/renderD128`, which our VMs do not
  have; it degrades to software encoding without complaint.

**Landmine for the web UI:** the Kasm client is served with
`Cross-Origin-Embedder-Policy: require-corp` and
`Cross-Origin-Opener-Policy: same-origin`, because its threaded WASM decoder
needs `SharedArrayBuffer`, which needs cross-origin isolation. Embedding that
client in the Computer tab therefore interacts with our existing app-pane
iframe. Filed under stage 4 of the walk.

---

## needs-user — decide

### 1. Where the desktop packages live: image, on-demand, or a second image

**Confidence: low.**

**When** — the probe's sizing result, 2026-08-11.

**The choice.** A workspace VM today boots from one immutable image, pinned by
digest (`DUET_VM_IMAGE_REF`, e.g. `…@sha256:e656…`). That image has no X server,
so no desktop can appear. Three ways to change that, and the probe implicitly
assumed the first:

- **Bake it in.** Add ~1.7GB of desktop packages to the image. Every workspace —
  including the ones that will never open a desktop — pays that in registry pull
  and boot, forever.
- **Install on demand.** First time a user opens the desktop, run the apt install
  (~2–4 min) inside their VM. Because an exe.dev VM is a *persistent disk* (it
  reboots from disk; there is no memory snapshot), the install survives reboots —
  it is a one-time cost per workspace, not per session. The price is drift: two
  workspaces on the same image digest no longer have the same filesystem, which
  is exactly the property the digest pin exists to guarantee.
- **A second image.** Build `duet-vm-image-desktop` beside the plain one and have
  the provisioner choose per tier or per flag. Reproducibility intact, but now
  there are two images to build, verify, promote, and keep in step.

**The gap.** The user asked "do we need to rebuild the image" — a question about
cost and operations that the probe can inform but not settle.

**The reach.** This picks who pays: every workspace (bake), the first desktop
user in each workspace (on-demand), or the release process (second image). It
also decides whether "same digest ⇒ same filesystem" stays true, which every
future debugging session leans on.

**Verdict: needs-user.** **Provisional call:** on-demand install, behind an
explicit "enable desktop" action, while the feature is unproven — it keeps the
plain image lean and costs nothing until someone wants a desktop. Reverse it by
folding the same package list into the Dockerfile once demand is known; the list
is identical either way, so the work is not thrown away.

### 2. What the desktop should look like

**Confidence: low.**

**When** — the polish passes, 2026-08-11.

**The choice.** The probe picked XFCE (a conventional desktop environment), the
WhiteSur theme and icon set (a third-party macOS look-alike, MIT-licensed, from
GitHub), `plank` as the dock, Inter as the UI font, and a wallpaper generated on
the spot with ImageMagick. Concretely: the user says "open the desktop", and what
appears is a thin top bar with a clock, a dock of app icons along the bottom, and
a blue gradient behind them.

The unbuilt alternatives are quite different products: a **bare session** (just a
window manager, so an app opens maximized with no desktop furniture at all), or a
**single-app kiosk** (no desktop — the browser *is* the screen).

**The gap.** "Nice clean mac like desktop with a bottom row of apps" fixed the
direction but not how far to go, and taste here is the user's.

**The reach.** Furniture is a commitment: a dock implies app management, a
Trash implies a file manager, a settings panel implies users will change things
and expect it to persist. A kiosk implies none of that. Undoing furniture later
looks like a feature removal.

**Verdict: needs-user.** **Provisional call:** keep what the shots show (XFCE +
dock, no desktop icons). It's the demo that got a "looks nice", and every piece
is a package choice, reversible by changing the install list — nothing else in
the design depends on which desktop environment sits behind the VNC server.

### 3. A second browser in the image

**Confidence: medium-low.**

**When** — Chrome install, 2026-08-11.

**The choice.** Our image already ships `/headless-shell` — a 252MB Chromium 151
built **headless-only**: it can render pages and be driven, but it cannot draw a
window on a screen. So the probe installed Google Chrome 151 (~350MB) as a second
browser. A workspace with a desktop would then carry two Chromium-family browsers
that never share a profile, a cache, or a version number.

The unbuilt alternative: drop `headless-shell` and use one headful Chrome for
both jobs — run it against the virtual display and let the agent drive it there,
headless or not.

**The gap.** Nothing said whether the agent's existing headless browser and the
user's visible browser should be the same binary.

**The reach.** Two browsers means two update paths and two sets of bugs, and it
forecloses the nice property of the one-browser design: the agent and the human
looking at *the same tab*, which is most of why a visible browser is interesting
at all.

**Verdict: needs-user.** **Provisional call:** install headful Chrome and leave
`headless-shell` alone for now — nothing in the agent's current browser path
changes, so this cannot regress today's behavior. Reverse by pointing the agent's
browser client at the headful Chrome's debugging port and dropping
`headless-shell` from the image in a later rebuild.

### 4. The screen is a fixed 1440x900

**Confidence: medium.**

**When** — session start, 2026-08-11.

**The choice.** The virtual display is created at a fixed size. A user on a
laptop sees the desktop letterboxed or scaled inside their browser pane; it does
not reflow to their window. The alternative is resizing the X screen to match the
viewer's pane whenever it changes (the RANDR extension is already enabled, so the
plumbing exists).

**The gap.** No one specified whether the desktop is a fixed-size artifact or a
responsive surface.

**The reach.** Resize-on-connect has to be designed into the transport (the
viewer has to tell the VM its size, and the VM has to re-lay-out) — bolting it on
later means revisiting the same seam.

**Verdict: needs-user.** **Provisional call:** ship fixed 1440x900 for a first
cut; it is the simpler contract and the pane can scale. Reverse by adding a
resize message to the desktop WebSocket protocol before it has other consumers.

---

## unsound — redo from the corrected decision

### 5. `--remote-allow-origins=*` on a browser that also browses the web

**Confidence: high.**

**When** — first Chrome launch, 2026-08-11.

**The choice.** Chrome was started with `--remote-debugging-port=9222`, which
opens a local control channel (CDP — the Chrome DevTools Protocol, the same one
Playwright and DevTools speak: navigate, click, read the DOM, dump cookies), plus
`--remote-allow-origins=*`, which tells Chrome to accept CDP WebSocket connections
carrying *any* `Origin` header.

Walk the failure: the user, in that same visible Chrome, opens a random web page.
That page runs `new WebSocket('ws://localhost:9222/devtools/…')`. Normally Chrome
refuses because the page's Origin isn't allowed. With `*`, it is allowed — so the
page can drive the browser it is being viewed in: read every open tab, navigate
to internal URLs, exfiltrate what it finds.

This does not contradict `SECURITY.md`'s "the VM is one trust domain" — that
settles what *processes inside the VM* may do to each other. A remote web page is
not inside the VM's trust domain; it is exactly the untrusted party the boundary
exists for.

**The gap.** The probe needed CDP to work and reached for the flag that makes CDP
connections succeed, without separating "my script connects" from "any page
connects".

**The reach.** Flags copied out of a probe into a launcher and then into an image
are how this survives to production, and it would be invisible in review — one
token in a long command line.

**Verdict: unsound.** **Corrected decision:** a browser that loads untrusted
pages must not accept CDP connections from arbitrary origins. Keep Chrome's
default origin policy and have the in-VM agent connect as a local client (it does
not need the flag); if a remote debugging path is ever needed, terminate it at
the gateway with our own auth rather than loosening Chrome's. Note the final dock
launcher in the probe already omits the flag — the corrected decision is that it
never comes back.

### 6. The VNC server was open on all interfaces with no password

**Confidence: medium-high.**

**When** — both probe sessions, 2026-08-11.

**The choice.** `x11vnc -nopw -forever -shared` bound to `0.0.0.0:5900`, i.e. the
raw desktop protocol listening on every network interface with no authentication.
On the probe that was contained (a scratch VM, deleted), but it is the shape a
productized version would copy.

Walk what shipping it would mean: the desktop is reachable by anything that can
open a TCP connection to the VM on 5900 — no Duet auth, no workspace check —
rather than only through the gateway, which is the component that knows who a
workspace belongs to.

**The gap.** The probe was measuring feasibility, not designing ingress, so
"easiest thing that listens" won.

**The reach.** Every later decision — who may attach, whether a viewer is
read-only, when a session is reaped — belongs at one door. Two doors means the
rules only get enforced at one of them.

**Verdict: unsound as a pattern.** **Corrected decision:** the VNC server binds
`192.0.2.1` only, and the gateway's WebSocket route is the sole ingress, so the
workspace bearer is the only way in. No `-nopw` listener on a routable interface
at any point, including during development.

### 7. Stream cost was measured with the wrong codec

**Confidence: medium-high.**

**When** — the "17% of a core, ~530 kbps" measurement, 2026-08-11.

**The choice.** To answer "how expensive is streaming", the probe measured
`ffmpeg` grabbing the X display and encoding H.264 at 15fps. But the transport it
then recommended is VNC/RFB — a completely different scheme: RFB sends *changed
rectangles of pixels* rather than an encoded video stream, so its cost tracks how
much of the screen changed, not framerate. A mostly-static screen is nearly free
in RFB and still costs a steady bitrate in H.264; a video playing full-screen
inverts that.

So the quoted numbers describe a path we may never ship.

**The gap.** The probe measured what was easy to measure (ffmpeg was already
installed) rather than what it was about to recommend.

**The reach.** These are the numbers a capacity decision would be made from —
how many concurrent desktops a host can carry, whether the idle-CPU work stands.
Wrong-path numbers are worse than no numbers because they look rigorous.

**Verdict: unsound (evidence).** **Corrected decision:** measure the transport
actually proposed — an x11vnc session with a real client attached, at the target
resolution, across a typical workload (typing, scrolling, one video) — and quote
*that*. Until then, treat the H.264 figures as an unrelated data point about
video encoding on a 2-vCPU VM.

### 8. Sizing numbers came from a different base image

**Confidence: medium.**

**When** — the "+1.7GB, 4.5GB → 6.2GB" figure, 2026-08-11.

**The choice.** Both probes ran on exe.dev's stock `exeuntu` image, not our
`duet-vm-image`. Our image already carries pieces the probe installed from
scratch (ImageMagick, ffmpeg, a set of X libraries, fonts pulled in by
LibreOffice), so the true delta on *our* image is smaller than 1.7GB — but by an
unmeasured amount.

**The gap.** Convenience: `new` with no `--image` boots exeuntu, and the probe
took that default without noting it changes what the measurement means.

**The reach.** The image-versus-on-demand decision above turns on this number.

**Verdict: unsound (evidence).** **Corrected decision:** re-run the package
install against `duet-vm-image` and quote the delta measured there before the
size is used to decide anything.

---

## sound — the architecture now on the table

### 9. A short-lived token in the WebSocket URL

**Confidence: medium-high.**

**When** — the proposed design, 2026-08-11.

**The choice.** The browser cannot set HTTP headers when opening a WebSocket, so
the proposed desktop connection carries its credential in the URL query string
instead (`wss://<vm>.service.example.invalid/v1/desktop/<id>?token=…`), derived the same way the
existing sync tunnel derives its short-lived tokens. Today's VM-to-VM tunnel puts
that token in a header, which is strictly safer: URLs land in access logs, proxy
logs, and browser history in a way headers do not.

**The gap.** Browser WebSocket API limits, unstated anywhere in the plan.

**The reach.** It introduces the first *browser-held* VM credential in the
product; anything else the browser talks to directly will copy this pattern.

**Verdict: sound** — there is no header-carrying alternative in a browser, and a
short TTL bounds the exposure. Worth knowing you now own a credential-in-URL
surface, so the TTL should be minutes, not hours, and the token must be scoped to
one desktop session rather than the workspace.

### 10. The gateway is the only door; the edge is bypassed

**Confidence: high.**

**When** — the proposed design, 2026-08-11.

**The choice.** Duet's public routing layer (`apps/edge`, on Vercel) cannot carry
a WebSocket: completing one requires answering a request with `101 Switching
Protocols`, which a fetch-style serverless function cannot do. So the desktop
stream would connect from the browser **straight to the VM's gateway** on the
address exe.dev already publishes, skipping the edge — while ordinary app traffic
keeps going through the edge as it does today.

**The gap.** Nothing specified how a long-lived stream reaches a VM.

**The reach.** It splits public traffic into two shapes with different paths and
different auth. Anything the edge does for app traffic (header stripping, publish
policy, cache bounds) does not happen for desktop traffic, and would have to be
re-established at the gateway if it matters.

**Verdict: sound** — the constraint is real, and the gateway already terminates
WebSockets for the sync tunnel, so this reuses a proven path rather than adding a
relay host.

### 11. Reuse the one public port instead of opening another

**Confidence: high.**

**When** — the proposed design, 2026-08-11.

**The choice.** exe.dev lets a VM mark exactly **one** port publicly reachable;
every other port (3000–9999) requires an exe.dev login. Duet already spends that
one public port on the gateway (`setSharePublic` at attach time), with our own
workspace bearer as the real gate. The desktop therefore rides *through* the
gateway rather than being exposed on its own port.

**The gap.** The probe initially assumed a dedicated port was available; the
platform's one-public-port rule says otherwise.

**The reach.** Any future in-VM service that a browser must reach directly is
subject to the same rule — it goes through the gateway or it needs an exe.dev
login the end user does not have.

**Verdict: sound** — forced by the platform, and it keeps one authenticated door.

### 12. Start the desktop on demand and reap it

**Confidence: high.**

**When** — the recommendation, 2026-08-11.

**The choice.** The X server, window manager, dock, and VNC server only run while
someone is looking; they are not part of boot. Measured idle cost of the running
stack is ~375MB of RAM and no measurable CPU — small, but not free, and the fleet
was deliberately tuned down to a 0.015 vCPU idle floor.

**The gap.** Unspecified lifecycle.

**The reach.** Makes "is the desktop running" a piece of session state that
something must own and expire — which is new bookkeeping the feature has to
carry.

**Verdict: sound** — it protects a property (a cheap idle VM) that was expensive
to win.

### 13. Chrome's debugging port needs its own profile

**Confidence: medium-high.**

**When** — the CDP failure, 2026-08-11.

**The choice.** Chrome 151 silently refuses remote debugging when it runs on the
default profile directory: one log line, `DevTools remote debugging requires a
non-default data directory`, and the port simply never opens. The probe gave the
agent-drivable browser its own profile directory (`~/.chrome-agent`).

**The gap.** A vendor behavior nothing in the plan anticipated.

**The reach.** The agent-drivable browser therefore has its own history,
cookies, and logins, separate from any Chrome started another way — which is a
product-visible fact if a user ever logs into a site in one and expects the other
to know.

**Verdict: sound** — forced by Chrome, and one profile for the workspace browser
is the simplest resolution: everything launches through the same entry.

### 14. Our own launcher file rather than editing the packaged one

**Confidence: high.**

**When** — the dock-duplicate fix, 2026-08-11.

**The choice.** The dock drew Chrome twice: once as a launcher, once as an
unmatched running window. The matcher pairs a window to a launcher by comparing
the window's `WM_CLASS` (a string X11 windows carry to identify their app) with
the `StartupWMClass` line in a `.desktop` launcher file. Chrome's packaged
launcher claims `google-chrome`, so it always won the match and our launcher
never could.

The fix: ship our own launcher (`duet-browser.desktop`) that both starts Chrome
with the debugging flags *and* claims a distinct class, and start the browser with
`--class=duet-browser` so the window carries it. One icon, one owner, and a human
clicking the dock gets the same agent-drivable browser the agent expects — rather
than a second Chrome with no debugging port.

The alternative was editing `/usr/share/applications/google-chrome.desktop` in
place, which any `apt upgrade` of Chrome would silently revert.

**The gap.** Unspecified how a human-launched browser and an agent-launched one
relate.

**The reach.** Establishes that the workspace browser is *our* application entry,
not Chrome's — the place any future default (proxy settings, extensions, policy)
would hang.

**Verdict: sound** — survives package upgrades, and it collapses the human path
and the agent path onto one browser.

### 15. Probe hygiene on a shared account

**Confidence: high.**

**When** — throughout, 2026-08-11.

**The choice.** One exe.dev account serves both staging and production, so probe
VMs were tagged `#duet-probe` (never `#duet-workspace`), created with explicit
names, and deleted at the end with a leak check. Inspection of a real staging
workspace VM was read-only.

**Verdict: sound** — matches the standing rule that VM sweeps must be scoped, and
leaves no VM that a future cleanup could mistake for a workspace.

---

## Trivial discretion (not individually audited)

Wallpaper generated with ImageMagick rather than shipped as an asset; Inter as
the UI font; dock icon size and zoom; Chrome window geometry; Wikipedia as the
test page; running probe steps as piped script files rather than inline SSH
commands; `bun` installed on the probe VM to get a WebSocket client (the stock
image's Node 18 has no global `WebSocket` and no `npm`) — our own image already
ships bun, so this was probe-only scaffolding.

## Implementation choices — slice 00

### sound

#### Trusted path construction throws on an unsafe grant id

**Confidence: medium.**

**When** — slice 00, desktop contract vocabulary.

**The choice.** `desktopEntryPath` throws when its caller supplies an empty id,
a slash, or `..`, while `desktopGrantIdForPath` returns `null` for the same
shapes when parsing an incoming request. In practice, an internal caller that
tries to mint `grant/child` fails immediately instead of producing a URL that
silently treats `child` as proxy path data; an untrusted browser request simply
fails route recognition. The unbuilt alternative was making both functions
return a nullable result, forcing every trusted constructor call to branch on a
programmer error.

**The gap.** The plan required unsafe ids not to parse but did not specify the
constructor's failure API.

**The reach.** Every future desktop grant minter inherits fail-fast construction,
while the gateway request boundary remains non-throwing and default-deny.

**Verdict: sound.** The two call sites have different trust roles: construction
receives code-generated ids, while parsing receives network input.

#### Driver activity uses Unix epoch milliseconds

**Confidence: high.**

**When** — slice 00, desktop contract vocabulary.

**The choice.** `DesktopDriver.at` is an integer timestamp from the same
millisecond clock used by grant expiry. Concretely, when an agent last drives a
browser tab, the gateway reports a number such as `1786534000000`; the web app
can subtract its own current time to decide how recent that action was. The
unbuilt alternative was an ISO date string, which is easier to read in raw JSON
but must be parsed before every age comparison.

**The gap.** The plan named the field and injected clock but did not specify the
wire unit.

**The reach.** Gateway status responses and future driving-preview consumers now
share one numeric time vocabulary. Changing it later would be a wire-contract
change across the gateway, API, and web app.

**Verdict: sound.** Existing expiry contracts and injected clocks already use
epoch milliseconds, so this keeps time arithmetic consistent without a second
representation.

## Implementation choices — slice 01

### sound

#### An unknown WebSocket protocol closes with the standard policy-violation status

**Confidence: high.**

**When** — slice 01, gateway WebSocket router.

**The choice.** Every gateway WebSocket is tagged with the protocol that owns
it, such as `tunnel`. If a damaged or future caller supplies a tag the running
gateway does not know, the router closes that socket with WebSocket status 1008
(`policy violation`) and the reason `unknown websocket protocol`. The unbuilt
alternative was a normal close, which would make an unsupported protocol look
like an ordinary end of a valid session, or an exception, which could escape the
shared callback instead of rejecting only that socket.

**The gap.** The slice required an unknown tag to close rather than throw, but
did not choose the close status or diagnostic reason.

**The reach.** Future gateway WebSocket protocols inherit one observable
rejection contract. Clients and gateway diagnostics can distinguish a bad tag
from a valid protocol ending normally without adding protocol-specific fallback
branches.

**Verdict: sound.** Status 1008 is the protocol-defined close for a message that
violates endpoint policy, which is exactly an unregistered gateway protocol.

## Implementation choices — slice 10

### sound

#### The fixed logical desktop may shrink uniformly inside a smaller pane

**Confidence: high.**

**When** — slice 10, Desktop pane geometry.

**The choice.** The streamed screen remains exactly 1440x900, while its web
presentation may apply a uniform scale below 1 when the available pane is
smaller. It never stretches one axis independently and never enlarges the
desktop. The remaining space is centered as letterbox padding. The alternative
was rendering 1440x900 CSS pixels regardless of the pane, which would crop most
of the screen on a narrow browser and make both the shared desktop and the
driving signal unusable there.

**The gap.** The slice says both “never scale” and that the fitted rectangle
never exceeds its container at every size; those requirements cannot both hold
for a container smaller than 1440x900. The earlier decision ledger explicitly
says the fixed screen “can scale,” while rejecting resize-on-connect.

**The reach.** Kasm and the VM still expose one fixed 1440x900 surface, so input
coordinates and staging assertions remain stable. Only the browser's
presentation changes, and the pure fit function owns that transform for both
mounts.

**Verdict: sound and human-confirmed.** The choice preserves the binding fixed
screen/no-RANDR decision and the accepted letterbox shape. Example User reviewed the
desktop and mobile captures and responded “looks good.”

#### The driving indicator occupies a stable rail and never covers remote pixels

**Confidence: medium.**

**When** — slice 10, Desktop pane presentation.

**The choice.** Active drivers render as compact chips in a fixed-height rail.
When the fitted screen has a top letterbox, the rail uses that otherwise-empty
space immediately above the screen; when it does not, the pane reserves the
rail outside the framebuffer. The reserved geometry is identical whether the
driver list is empty or populated, so activity never covers remote controls or
makes the desktop jump.

**The gap.** The slice delegated whether the indicator is a chip row or an
overlay. The first candidate used an overlay; the fresh screenshot critique
caught that it covered the remote top bar and left mobile chips visually
detached from the screen.

**The reach.** Several concurrent drivers wrap inward within the rail. The
screen geometry remains stable while the user sees the “signs of life” signal
immediately, and the streamed pixels remain fully available for reading and
input.

**Verdict: sound.** It keeps activity visible without destabilizing or obscuring
the fixed screen. The accepted human checkpoint established the overall framing;
the later unprimed critique improved the activity treatment before the final
baseline was locked.

## Implementation choices — slice 03 gateway checkpoint

### sound

#### Desktop browser credentials travel in the inherited path prefix

**Confidence: medium-high.**

**When** — slice 03, gateway desktop ingress.

**The choice.** A browser opens a URL such as
`/v1/desktop/desktop-1.secret/`; when Kasm then asks for `static/app.js`, the
browser naturally requests it below that same credentialized prefix. The
gateway checks the secret once through its shared authenticator and strips the
prefix before forwarding `/static/app.js` to Kasm. The unbuilt alternative was
a third-party cookie minted by the first response, which would keep later URLs
cleaner but depend on browser iframe-cookie policy.

**The gap.** The plan required walking three credential-carriage options in
order and stopping at the first that works; it did not preselect one.

**The reach.** The API grant minter must construct the returned entry URL with
the same contract helper, and every future Kasm asset must remain relative to
the entry path. A browser render gate remains required to disprove root-relative
assets or redirects.

**Verdict: sound.** It is the first-ranked carriage option, avoids third-party
cookie policy, and keeps one credential boundary for HTML, assets, and socket.

#### Relay backpressure uses bounded queues and reconnectable closure

**Confidence: medium.**

**When** — slice 03, desktop WebSocket relay.

**The choice.** A browser can send up to 1 MiB while the loopback Kasm socket is
still connecting; once either live leg has more than 8 MiB waiting to flush,
the gateway closes the viewer with a retryable overload status. Concretely, a
paused laptop loses and reconnects its desktop instead of retaining an
ever-growing pixel queue in the VM. The unbuilt alternative was propagating
every frame regardless of backlog, which risks unbounded memory, or refusing
all frames before upstream open, which makes normal connection setup brittle.

**The gap.** The plan required bounded `getBufferedAmount()` behavior but left
the queue sizes and pre-open policy to the implementer.

**The reach.** These are now the gateway's desktop slow-consumer policy and may
need telemetry-based tuning under real stream load; they do not alter the Kasm
wire protocol.

**Verdict: sound.** Both bounds are finite, local, and failure recovers through
Kasm's normal reconnect path; KG2/load evidence should validate the magnitudes.

#### Credential-bearing desktop paths are templated before gateway logging

**Confidence: high.**

**When** — slice 03, shared HTTP logging boundary.

**The choice.** When a user opens
`/v1/desktop/desktop-1.secret/static/app.js`, the gateway log records
`/v1/desktop/:credential/static/app.js`; ordinary route paths and the VM-only
`/grants` and `/status` routes stay unchanged. The unbuilt alternative logged
the raw path like every other request, which would copy the browser-held secret
into the persistent gateway log for the credential's full remaining lifetime.

**The gap.** The plan said tokens must not enter logs but did not choose where
the path redaction belongs.

**The reach.** Every desktop HTTP result—success, refusal, or exception—passes
through the same templating helper, so later desktop subroutes inherit the
no-token log contract automatically.

**Verdict: sound.** Redacting at the single request-logging boundary covers all
outcomes without weakening authentication or hiding non-secret path tails.

#### Tell Kasm's viewer where its credentialized socket lives

**Confidence: high.**

**When** — slice 03, real-browser Kill Gate 2.

**The choice.** The viewer entry adds Kasm's supported `path=` parameter with
`v1/desktop/<grant>.<token>/websockify`. Static assets already inherit the
credential prefix, but without this parameter Kasm roots its socket at
`/websockify`, outside the authenticated route. The contract owns construction
of the complete viewer URL so API and test callers cannot accidentally recreate
only the document path.

**The gap.** Relative asset success did not prove the client socket was also
relative; the browser journey exposed its different default.

**The reach.** Every browser-facing desktop URL must use `desktopViewerPath`,
while credential-free gateway responses may continue returning the entry
prefix. Changing the public prefix or Kasm socket endpoint now has one owner.

**Verdict: sound.** It uses Kasm's intended configuration seam and preserves the
first-ranked path-prefix carriage without cookies or a vendored client.

#### Derive Kasm's loopback WebSocket Origin at the relay boundary

**Confidence: high.**

**When** — slice 03, real-browser Kill Gate 2.

**The choice.** The gateway's WebSocket client sends `Origin:
http://192.0.2.1:6901` when connecting to the loopback Kasm URL, deriving HTTP
from `ws` (and HTTPS from `wss`). Kasm rejects the upgrade without that origin.
The browser's public origin is not forwarded because Kasm is validating its own
direct upstream origin, while the gateway already enforces the product-facing
authentication and framing boundary.

**The gap.** Basic authentication alone made ordinary HTTP succeed but did not
complete Kasm's WebSocket handshake.

**The reach.** All desktop relays inherit the derived local origin; the behavior
is pinned at the injected WebSocket-connect seam and changes automatically if
the upstream scheme or port changes.

**Verdict: sound.** It satisfies the upstream server's handshake policy without
weakening the external origin or credential boundary.

## Implementation choices — slice 02

### sound

#### Keep Kasm's required Basic credential local to each VM and readable by the gateway

**Confidence: high.**

**When** — slice 02, while joining the image to slice 03's ingress relay.

**The choice.** KasmVNC will challenge both its ordinary web requests and its
WebSocket upgrade with HTTP Basic authentication. The browser must never receive
that upstream password because the gateway already authenticates the user. On a
VM's first desktop start, the image therefore generates a random password,
stores `{ username, password }` in a mode-0600 JSON file under the VM's archived
state directory, and rebuilds Kasm's own hashed password file. The gateway reads
that JSON and injects Basic auth only on its loopback requests. A restored VM
keeps the same local pair; a fresh VM gets a different one. The unbuilt
alternative was a password baked into the image, which would give every VM the
same plaintext, or disabling Kasm auth, which cannot be the relay's runtime
assumption.

**The gap.** The map said the Kasm auth layer should be stood down, while the
ingress probe found that Kasm still requires a working upstream credential. No
component owned its generation, persistence, or handoff path.

**The reach.** `DESKTOP_KASM_AUTH_PATH` is now an image-to-gateway contract, and
the state archive carries that file across reprovision. This does not create a
second user permission boundary: `SECURITY.md` defines the VM as one trust
domain, and only the gateway is public.

**Verdict: sound.** It satisfies Kasm's transport requirement without exposing a
fleet-wide or browser-facing secret, and gives generation and persistence one
owner.

#### Treat rendered pixels, not an open HTTP port, as desktop readiness

**Confidence: high.**

**When** — slice 02 verifier failure and timed framebuffer diagnostic.

**The choice.** Kasm's HTTP server returns `200` before XFCE has finished
starting. Under local amd64 emulation the first captures were a single-color X
background; `xfwm4` appeared after roughly three seconds and `xfdesktop` produced
a 1,774-color frame after roughly six. The verifier and exe.dev probe now poll
for a non-uniform 1440x900 capture while also checking that `xfce4-session`
remains alive. The unbuilt alternative was declaring readiness on HTTP `200`,
which would let a listener with no usable desktop pass the kill gate.

**The gap.** The slice required both “loopback answers” and a nonblank PNG but
did not define which event ended the startup measurement or how to handle the
normal gap between them.

**The reach.** Native cold-start telemetry now means “a user can see the
desktop,” not “the transport socket opened.” Later supervisor health checks can
choose a cheaper signal, but they must not reinterpret this probe's number.

**Verdict: sound.** The readiness condition directly proves the user-visible
contract and the bounded poll fails honestly if the session never renders.

#### Cap each clipboard direction at 16 MiB

**Confidence: medium.**

**When** — slice 02 Kasm configuration.

**The choice.** Kasm's zero defaults discard clipboard traffic, so the image
allows up to 16 MiB from browser to VM and independently up to 16 MiB from VM to
browser. That is large enough for rich HTML or an image without turning the
clipboard into an unbounded buffer. The unbuilt alternatives were a small text-
only cap that would make image paste fail unexpectedly, or a much larger cap
that would increase transient memory cost for little product benefit.

**The gap.** The plan required both caps to be raised but delegated no exact
limit.

**The reach.** Browser paste and copy behavior, and the maximum payload later
relayed by the gateway, inherit this 16 MiB ceiling.

**Verdict: sound.** It is a reversible sanity bound that supports the intended
bidirectional clipboard while keeping resource use finite.

#### Make the documented local image ref build and verify without publishing

**Confidence: high.**

**When** — slice 02 build verification.

**The choice.** The documented command uses `IMAGE_REF=duet-vm-image:local`.
Previously the build script always attempted to push whatever ref it received,
so a local verification unexpectedly became a registry write and failed. The
script now recognizes that exact local ref, builds and runs the full verifier,
then stops before push or digest-env recording. Every other ref keeps the
existing publish behavior. The unbuilt alternative was a second build script,
which would duplicate the production build path and let local verification
drift.

**The gap.** The slice promised a local command, but the existing build runner
implemented publish-only semantics.

**The reach.** Developers can reproduce Kill Gate 1 without registry authority,
while staging and production continue through the same build and verifier code.

**Verdict: sound.** One explicit local sentinel preserves a single build path
and removes an unintended external side effect.

### Trivial discretion (not individually audited)

The TLS certificate uses a ten-year RSA-2048 self-signed keypair; the verifier
artifact opt-in is named `DESKTOP_FRAMEBUFFER_PATH`; and the retained bare-XFCE
capture keeps the distro wallpaper and default Home/File System icons. These are
local, reversible implementation details with no new component boundary.

## Implementation choices — slice 04

### sound

#### Let Kasm's forking service own the XFCE session it already launches

**Confidence: high.**

**When** — slice 04, after inspecting a live Kasm start and its generated
`xstartup`.

**The choice.** The image ships one `Type=forking` service plus
`duet-desktop.target`. Kasm's generated startup script already executes
`xfce4-session`; the planned separate session service would start a second
desktop against the same display. The unbuilt alternative was to replace the
generated script and split ownership between two units purely to preserve the
plan's illustrative shape.

**The gap.** The slice delegated whether the units were two-plus-a-target or one
service with post-start work, and the live package behavior was not known when
the plan was written.

**The reach.** Kasm and XFCE start and stop together, and later slice-05 Chrome
can still be ordered between the target's units without giving the gateway a
startup sequence.

**Verdict: sound.** One owner matches the installed package's lifecycle and
avoids duplicate X-session processes.

#### Reconcile desktop intent every five seconds with a 90-second request grace

**Confidence: high.**

**When** — slice 04, desktop supervisor implementation.

**The choice.** The supervisor runs an immediate reconciliation and then a
five-second unref'd loop. A request stamps a 90-second grace period before an
otherwise unused desktop can be reaped. Each tick reads the target's actual
systemd state rather than trusting an in-memory phase, and start/stop work is
serialized. The initial request timestamp is empty rather than gateway boot
time, so an orphan target is reaped on the first demand-free tick. The unbuilt
alternatives were a long polling interval that makes agent-only starts or reap
visibly lag, or a short grace that races the first viewer WebSocket during
image-cold startup.

**The gap.** The plan suggested a 60–120-second grace but delegated both exact
timings and reconciliation mechanics.

**The reach.** Viewer disconnects and agent-session transitions converge within
five seconds, while even the measured 85-second uncached create-to-render path
fits inside the request grace.

**Verdict: sound.** The values are bounded, backed by native cold-start data,
and the injected-clock tests pin every start/reap rule without wall-clock
flakiness.

#### Hold the desktop for agent sessions, not train jobs

**Confidence: high.**

**When** — slice 04, production supervisor composition.

**The choice.** `hasLiveAgentRunners` reads the agent-session coordinator's
`activeCount() > 0`. It deliberately does not use the sibling aggregate that
also counts train runners. The unbuilt alternative would keep a graphical stack
alive for compute work with no browser tab and no viewer.

**The gap.** Both activity predicates were available at the composition root,
and their similar names made the broader one easy to select accidentally.

**The reach.** A human viewer or a live interactive agent session keeps the
target running; background train work never changes desktop lifecycle.

**Verdict: sound.** It preserves the plan's single owner for session counts and
uses exactly the product event that needs a shared browser.

#### Move the shared command runner out of archive ownership

**Confidence: high.**

**When** — slice 04, when the desktop supervisor became a second consumer of
the archive module's injected system-command seam.

**The choice.** The generic `SystemCommandRunner` and default process launcher
now live in `system-command.ts`; archive, desktop, phone-home, and share
convergence import that owner. The unbuilt alternative made desktop import a VM
archive module solely to execute `systemctl`, leaving an accidental dependency
between unrelated domains.

**The gap.** The plan said to reuse the existing seam but its previous location
encoded the first consumer, not the concept.

**The reach.** Future bounded OS commands use one runner without turning archive
code into infrastructure or creating parallel spawn adapters.

**Verdict: sound.** This is the smallest one-owner refactor that makes the
existing seam genuinely shared.

### Trivial discretion (not individually audited)

The public probe installs `xclip` as its X selection witness, uses a fresh
synthetic VM token only for the disposable journey, and publishes unique probe
tags without changing staging or production pointers. These choices are local
to evidence collection and do not add product authority or durable state.

## Implementation choices — slice 05

### sound

#### Install one exact Chrome package and remove every unattended repair path

**Confidence: high.**

**When** — slice 05 image packaging.

**The choice.** The image downloads Google's versioned
`google-chrome-stable_151.0.7922.137-1_amd64.deb`, verifies SHA-256
`e6dabf044cf9cd0279cfe86efa431682c18bfc06d06339ce055aaa87ae871727`,
installs it, and applies an apt hold. It then removes both `.list` and `.sources`
repository forms, Google's cron repair hooks, and both stock Chrome launcher
names observed across package versions. The unbuilt alternative was to trust a
version-constrained apt source, which still leaves a live mutation mechanism
beside the shared browser.

**The reach.** Every human and agent tab runs one known binary until an explicit
image update. Package repair cannot silently recreate a second launcher or
replace the executable beneath a running profile.

**Verdict: sound.** The native probe confirms the pinned package while the
image tests pin every removal path.

#### Use `1296x720+72+48` as the shared browser's pre-theme geometry

**Confidence: high.**

**When** — slice 05 launcher implementation.

**The choice.** On the fixed 1440x900 display, Chrome requests 90% width and 80%
height with symmetric 5% horizontal margins and a 48-pixel top offset. This
leaves wallpaper around the browser and reserves room for slice 08's top panel
and dock. The same command is owned by the sole launcher and systemd service;
slice 08's window rule will repeat these numbers for later windows.

**The reach.** Initial and subsequent shared-browser windows inherit a stable,
non-maximized composition. The stock desktop shortcuts currently peek behind
the left edge, a known visual defect that disappears when slice 08 disables
desktop icons.

**Verdict: sound.** Both the local X11 verifier and native VM report the exact
geometry; the remaining composition problem belongs to already-planned styling.

#### Preserve Chrome's sandbox and adapt only the cross-architecture verifier

**Confidence: high.**

**When** — slice 05 local image verification on Docker Desktop arm64.

**The choice.** The disposable amd64-under-Rosetta verifier container receives
`SYS_ADMIN`, unconfined seccomp, and a larger shared-memory mount so Chrome can
create its sandbox namespaces. These options are passed only to that one
verification container. The image launcher and native VM use ordinary Chrome
without `--no-sandbox`; `--remote-allow-origins` is absent everywhere.

**The reach.** Local verification remains honest about the shipped browser's
sandbox and loopback origin policy instead of making an emulator limitation a
fleet-wide weakening.

**Verdict: sound.** The same image subsequently passed natively on exe.dev with
no capability or browser-flag workaround.

#### Order Chrome after Kasm's one owned display/session service

**Confidence: high.**

**When** — slice 05 systemd wiring.

**The choice.** `duet-desktop-browser.service` requires and follows
`duet-desktop.service`; the target requires both. Slice 04 proved that Kasm's
forking unit already owns Xvnc and its generated XFCE session, so inventing a
second session unit merely to put Chrome textually “between” two units would
split one lifecycle. The browser restarts on failure and remains part of the
demand-owned target.

**The reach.** One target start brings up X/desktop then Chrome, one target stop
kills both control groups, and a browser crash heals without duplicating the
desktop session.

**Verdict: sound.** Native systemd startup, stop/start, CDP, and profile
durability all passed.

#### Close visible pages before systemd tears down the display

**Confidence: high.**

**When** — slice 05 native profile-lifecycle verification.

**The choice.** The browser unit's bounded `ExecStop` connects to Chrome's
loopback CDP endpoint and closes every visible page with unload handling before
systemd terminates the browser control group and Kasm tears down X. If Chrome
has already exited or never exposed CDP, the helper returns and the unit's
15-second mixed-mode stop remains the fallback. Alternatives tested and
rejected were relying on target-level termination alone, which lost a real
persistent cookie, and closing the browser object through Playwright, which
also failed to write the cookie row in the local reproduction.

**The reach.** Browser shutdown now follows the same user-visible close path as
closing its windows, giving Chrome time to commit cookies and other durable
profile state without exposing another port or weakening its origin policy.
An unresponsive page cannot indefinitely block desktop teardown.

**Verdict: sound.** A local red/green reproduction found the cookie row after
shutdown and reloaded it after restart; the native exe.dev probe repeated the
proof across a full `duet-desktop.target` stop/start and left no VM leak.

### Trivial discretion (not individually audited)

The local verifier waits up to 60 seconds for Chrome under amd64 emulation and
one second after a viewable exact-geometry window before capturing pixels. The
unique slice-05 probe tag and per-VM profile witness exist only for disposable
evidence and do not change product state.

## Implementation choices — slice 06

### sound

#### Return a browser socket plus an exact target id

**Confidence: high.**

**When** — slice 06, after attaching Playwright to a real shared Chrome.

**The choice.** `duet-browser` prints one JSON handle containing Chrome's
browser-level debugging socket and the current session's exact tab id. An agent
attaches Playwright to the shared browser, enumerates the pages, and selects the
page with that id. The planned URL-only output looked sufficient, but a real
`connect_over_cdp` call against a page-specific socket produced a Playwright
browser with no pages; returning only the browser socket would expose all pages
without saying which one belongs to the caller. The unbuilt alternative was to
guess that the first page is the session's tab, which fails as soon as a human
or another agent opens one first.

**The gap.** The plan specified URL-only output before verifying how Playwright
projects a raw Chrome target through its browser-level API.

**The reach.** Every browser skill and future agent integration must attach to
the shared browser and select by `targetId`; this is what preserves default tab
ownership without isolating cookies or forbidding access to other tabs.

**Verdict: sound.** The handle carries the minimum two facts required by the
real client, while the gateway remains the sole owner of the session-to-target
association.

#### Make the browser command a mode of the current gateway bundle

**Confidence: high.**

**When** — slice 06 gateway/image packaging.

**The choice.** `/usr/local/bin/duet-browser` is a four-line stable wrapper that
executes `/opt/duet/current/index.js --desktop-browser-cli`. The current gateway
bundle reads the runner's session id and VM-local token, asks its own loopback
route for a tab, and prints the handle. The unbuilt alternative was a separately
published CLI artifact whose protocol and update timing could drift from the
gateway route it calls.

**The gap.** The plan required the shim to ship beside existing gateway entries
but did not choose whether that meant another release artifact or another entry
mode in the existing artifact.

**The reach.** Gateway self-updates atomically update both the browser route and
its CLI consumer. The image owns only the stable executable path, so no third
release manifest entry or update rail exists.

**Verdict: sound.** One artifact owns both sides of the private loopback
contract and the native VM proves the wrapper follows it.

### Trivial discretion (not individually audited)

CDP allocations are serialized so simultaneous first calls cannot interleave;
browser-route failures collapse to one non-sensitive `503` response; and the
native probe uses a synthetic VM token only when a disposable VM has not yet
registered one. These are local implementation and evidence details with no new
product boundary.

## Implementation choices — slice 07

### sound

#### Disconnect automation without closing shared browser ownership

**Confidence: high.**

**When** — slice 07 workspace-browser skill authoring.

**The choice.** The skill lets its Playwright connection end after a browsing
batch but explicitly forbids launching another browser or context and forbids
closing the shared browser or its default context. It closes this session's
page only when the task itself requires closing the tab. The unbuilt alternative
was ordinary single-owner Playwright cleanup, which can read as permission to
tear down a browser that the human and every other agent still use.

**The gap.** The plan specified exact target selection but delegated the skill's
prose and examples; it did not spell out cleanup behavior for a shared browser.

**The reach.** Browser automation remains a temporary client of gateway- and
systemd-owned state. A completed agent command cannot log the human out, close
another agent's work, or destroy the profile-bearing Chrome process as an
incidental cleanup step.

**Verdict: sound.** The native Kill Gate 4 journey disconnected its Playwright
client while the shared Chrome remained visible for framebuffer capture and the
gateway still reported the exact session as the active driver.

### Trivial discretion (not individually audited)

The skill ships in the default roster as explicitly delegated by the slice; the
native proof uses a deterministic local data page so the exact session and typed
input remain legible without depending on an external website; and probe images
are first written under the exe package before accepted evidence is retained by
the spec.

## Implementation choices — slice 09

### sound

#### Wrap the dotted derived token as one base64url credential segment

**Confidence: high.**

**When** — slice 09 desktop grant minting.

**The choice.** The API base64url-encodes the dotted output of
`deriveTunnelToken` before hashing it and placing it in the desktop credential
path. The path grammar uses one dot to separate grant id from token, so carrying
the raw derived form would be ambiguous. The gateway authorizes the digest of
the exact wrapped credential returned to the browser.

**The reach.** Every desktop URL and token consumer sees one path-safe token
segment while the existing tunnel derivation remains the entropy and expiry
owner.

**Verdict: sound.** Contract path parsing accepts the wrapper alphabet, and the
integrated transport test proves the posted digest matches the returned browser
token without posting the token itself.

#### Require the VM acknowledgement to name the minted grant

**Confidence: high.**

**When** — slice 09 grant registration response validation.

**The choice.** A successful VM response must carry the exact credential-free
entry path for the newly minted grant id plus a valid desktop phase. The
alternative was accepting HTTP success or phase alone, which could return a
browser credential after a malformed or release-skewed acknowledgement.

**The reach.** API and VM release skew fails closed as `gateway_failed`; the API
never claims it registered a token unless the VM identifies that same grant.

**Verdict: sound.** The response adds no browser secret, and the focused tests
reject malformed acknowledgement shapes.

#### Keep workspace lifecycle refusals distinct from VM transport failure

**Confidence: high.**

**When** — slice 09 product route error mapping.

**The choice.** Paused, provisioning, and archived workspaces retain their
existing 402/409/410 vocabulary. Network errors, non-success responses, and
malformed VM JSON collapse to `502 desktop_gateway_failed` rather than exposing
transport details or pretending the workspace lifecycle changed.

**The reach.** The web pane can distinguish an actionable workspace state from
a broken gateway request without inheriting VM response internals.

**Verdict: sound.** Both mint and status routes share the mapping and apply the
same no-store/no-referrer headers to refusal responses.

### Trivial discretion (not individually audited)

Grant ids use twelve random bytes with a `desktop-` diagnostic prefix, and the
credential response headers are applied before authentication so refusal bodies
receive the same non-retaining policy.

## Implementation choices — slice 11

### sound

#### Poll status independently from grant renewal

**Confidence: high.**

**When** — slice 11's shared workspace-desktop data owner.

**The choice.** The mounted pane reads desktop status every two seconds while
the credential query follows its own expiry-derived renewal clock. The rejected
alternative was refreshing status only when the grant renewed, which would
leave lifecycle phase and recent-driver attribution stale for most of a grant's
lifetime.

**The reach.** Both doors show one gateway-owned phase and driver list without
reminting credentials or introducing a second desktop-state owner in the web
app.

**Verdict: sound.** Status is a separate API contract by design, and the query
key is workspace-scoped just like the one shared desktop it describes.

#### Put the no-referrer boundary on the iframe navigation

**Confidence: high.**

**When** — slice 11's live desktop mount.

**The choice.** The iframe declares `referrerPolicy="no-referrer"`. The API's
non-retaining response header governs the credential-mint fetch, but it cannot
govern the later, separate navigation to the credential-bearing viewer path.

**The reach.** Every direct or agent-surface desktop mount applies the policy
at the browser boundary that actually carries the entry URL.

**Verdict: sound.** It reinforces the existing credential-carriage design
without adding authentication state or changing the one-VM trust domain.

#### Compact both fixed agent doors while preserving their words

**Confidence: medium.**

**When** — slice 11's mobile visual correction after the first critique found
the Spanish Desktop label clipped.

**The choice.** At the measured narrow-card width, Files and Desktop use tighter
spacing and type while keeping both labels visible. An icon-only retry was
rejected by a fresh critique because the new Desktop door became harder to
discover; truncation was rejected because it hides the distinction in Spanish.

**The reach.** Narrow agent surfaces retain two named, independently targetable
doors; app selectors keep their ordinary measure and remain horizontally
scrollable.

**Verdict: sound.** The final unprimed critique passed the result, and the full
desktop/mobile baseline sweep found no overlap or clipping.

### Trivial discretion (not individually audited)

The shared session cache follows the slice's delegated renew-not-remount
preference; Desktop follows Files in the default arrangeable agent row as the
slice delegated; and the chosen Phosphor desktop glyph follows the existing
workspace-tab icon vocabulary.

## Implementation choices — slice 08

### sound

#### Give Chrome both desktop-identity hints

**Confidence: high.**

**When** — slice 08's live Plank integration.

**The choice.** The browser service supplies both `CHROME_DESKTOP` and
`BAMF_DESKTOP_FILE_HINT`, naming the one authored `duet-browser.desktop`
launcher. Supplying only one hint visibly left a pinned browser launcher and a
second running-browser entry.

**The reach.** Plank merges the pinned and live Chrome identity into the one
browser icon the desktop contract promises, while the image retains one
launcher owner.

**Verdict: sound.** The exact live verifier and final frame prove one browser
entry with a running indicator.

#### Correct WhiteSur's edge-dock indicator geometry in the image

**Confidence: high.**

**When** — slice 08's final visual correction.

**The choice.** The image-owned WhiteSur Plank theme copy changes `LineWidth`
from zero to four and lightens the ending fill. The stock zero positions half
the active dot outside a bottom-edge dock; moving Plank through the window
manager was rejected after the live dock window proved edge-anchored.

**The reach.** Every VM renders the browser's complete running indicator and
both lower dock corners without a recurring reposition loop or a second runtime
theme owner.

**Verdict: sound.** The rebuilt exact image and final fresh critique show all
edges and the complete active indicator.

#### Fetch immutable, checksum-verified WhiteSur release sources

**Confidence: high.**

**When** — slice 08's delegated fetch-versus-vendor decision.

**The choice.** The image build downloads tagged WhiteSur GTK and icon release
archives, verifies fixed SHA-256 digests, and installs only the needed theme
content. The alternative was vendoring the third-party trees into this repo.

**The reach.** Desktop appearance remains reproducible and license-attributed
without making a large upstream source snapshot part of Duet's authored code.

**Verdict: sound.** A changed tag payload fails the image build before any
theme bytes are adopted, and the exact build consumed the recorded pins.

### Trivial discretion (not individually audited)

The blue-violet wallpaper, WhiteSur light variant, five delegated dock entries,
48-pixel icon size, 120% zoom, and 28-pixel panel are taste decisions the slice
explicitly left to its implementer.

## Implementation choices — slice 12

### sound

#### Block new agent and desktop starts for the whole Chrome replacement window

**Confidence: high.**

**When** — slice 12's gateway update coordinator.

**The choice.** The updater first refuses if an agent process is already live,
then synchronously closes the gateway's existing runner-start gate before its
first asynchronous system command. Imagine no agent is running when an operator
clicks Update Chrome, but a turn arrives or a human opens a previously idle
desktop while the package is downloading: with only the initial busy check, that
request could open Chrome and have it replaced mid-navigation. Today the
desktop supervisor and agent-session coordinator each close their owned start
boundary, so neither start can enter until the installer releases the gate. Concurrent operator
retries share the one in-flight install rather than opening and closing that gate
independently, and an already-starting desktop drains through the supervisor's
operation queue before the updater probes browser activity. The coordinator
also re-arms durable scheduled wakes after maintenance, so a wake whose timer
fires in the same instant is delayed rather than lost.

**The gap.** The slice required refusal for a live session but did not say how
to close the race with a session that starts after the refusal check.

**The reach.** Future browser maintenance operations inherit one continuous
no-runner window; a second operator request is idempotent and cannot prematurely
re-admit agent work.

**Verdict: sound.** Each lifecycle owner enforces its own atomic start boundary
and preserves the promised “never kill an agent mid-turn” outcome under
concurrency.

#### Preserve demand-idle state across an update

**Confidence: high.**

**When** — slice 12's browser-unit restart sequence.

**The choice.** The updater asks systemd whether the shared browser was active,
stops and later starts it only in that case, and treats any answer other than
“active” or systemd's exact “inactive” status as a failure. A VM whose desktop
has never been opened therefore receives the patched package without paying for
a newly running browser; a broken sudo or systemd probe cannot be mistaken for
an idle browser and allow a binary swap underneath it.

**The gap.** The slice said to restart the browser unit after installation but
did not specify what happens on a demand-idle VM or an indeterminate activity
probe.

**The reach.** Explicit Chrome updates do not weaken the feature's demand-only
resource contract, and future system-command failures fail safe rather than
changing a possibly live process.

**Verdict: sound.** It restores exactly the pre-operation lifecycle state and
keeps uncertainty on the refusal side.

#### Keep the mutable Chrome pin shared but the privileged installer image-owned

**Confidence: high.**

**When** — slice 12's artifact contract and VM helper.

**The choice.** The exact Debian version and SHA-256 live with the shared
desktop vocabulary consumed by the gateway, image verifier, and native probe.
The Docker build carries the same values and a test compares it to that owner.
The root helper itself stays in the VM image and accepts only a version-shaped
value plus a 64-hex digest, downloads from Google's fixed Chrome package pool,
verifies before installing, and always restores the package hold and removes
Google's regenerated apt jobs and stock launchers. The alternative was either a
generic privileged apt command or separate pins that could make a reprovisioned
VM differ from an in-place-updated VM.

**The gap.** The slice named a pinned install through `SystemCommandRunner` but
did not assign ownership of the pin or define the root boundary that performs
apt work.

**The reach.** A gateway release can deliberately move Chrome without a full
image sweep, while the image and probes still detect pin drift; root authority
cannot be repurposed through this operation to install an arbitrary URL or
package.

**Verdict: sound.** One artifact identity feeds every consumer, while the narrow
image-owned helper preserves the reproducibility and single-launcher invariants
that unattended Google packaging would undo.

### Trivial discretion (not individually audited)

The delegated refusal is hard rather than forceable, the gateway reports the
installed version while the API retains its existing `{ ok, auditId }` operator
response, and the UI label is “Update Chrome” / “Actualizar Chrome.”

## Implementation choices — slice 14

### sound

#### Fit the desktop from layout dimensions, not painted bounds

**Confidence: high.**

**When** — the first live staging journey's agent-page capture.

**The choice.** The desktop pane reads `clientWidth` and `clientHeight` when it
fits the fixed 1440×900 surface. It does not read `getBoundingClientRect()`: the
agent surface unfolds from a transformed scale, so painted bounds can be 4.5%
smaller while layout is already at its final size. ResizeObserver does not emit
when only that transform changes, which otherwise leaves the stale narrow fit
flush against the left edge after the animation finishes.

**The reach.** Desktop fitting remains centered under transformed hosts while
ordinary resizes still flow through the same one ResizeObserver and one fit
owner. The staging journey now rejects unequal horizontal or vertical padding.

**Verdict: sound.** Layout dimensions are the coordinate space used by the
pane's `left`, `top`, width, and height styles; measuring that same space removes
the animation race instead of compensating for one transform value.

## Implementation choices — Duet desktop transition

### sound

#### Overlay the pinned transport UI instead of forking it

**Confidence: high.**

**When** — replacing the browser-facing desktop connection screen.

**The choice.** The image copies one Duet-owned stylesheet and the canonical
avatar into the bundled web root, then makes narrow, asserted replacements in
the pinned transport pages. The image build and live verifier both require the
Duet title, brand, animation, and favicon and reject the old favicon reference.
The alternative was copying and owning the transport's entire web client.

**The reach.** Transport upgrades keep their upstream implementation, but a
markup change that breaks the product surface fails the image build rather than
silently restoring visible vendor identity.

**Verdict: sound.** It gives the product one visible owner without creating a
second web-client fork to maintain.

#### Build the loader from the canonical Duet avatar

**Confidence: high.**

**When** — adding the requested blue avatar to the transition.

**The choice.** The VM image copies `apps/web/public/icons/duet-avatar.png`
instead of introducing a second loader-specific logo asset.

**The reach.** The desktop loader and web product cannot drift to subtly
different avatars; an avatar change reaches new VMs through the ordinary image
build and publication path.

**Verdict: sound.** One product asset remains the source of truth.

## Implementation choices — fleet reprovision operator

### sound

#### Orchestrate the fleet outside Convex through the existing one-workspace action

**Confidence: high.**

**When** — automating repeat staging and production image sweeps.

**The choice.** The operator command inventories attached live workspaces, then
calls the existing authenticated reprovision action by exact workspace id with
at most three replacements in flight. Imagine one VM still has an active agent
turn: that action already knows how to defer it, archive ordinary workspace
state, replace the VM, and attach the requested immutable image digest. The
command waits and retries that workspace while continuing the others, then
returns failure only after every independent candidate has finished or failed.
The alternative was a second fleet-sized backend action that duplicated those
lifecycle rules and could time out mid-sweep or let one bad VM starve every VM
behind it.

**The gap.** The user asked for a reusable all-environment reprovision script
but did not choose where fleet orchestration, concurrency, or partial-failure
handling should live.

**The reach.** Future image releases have one repeatable staging/production
command, while the backend keeps one owner for activity checks, archive policy,
and the workspace state transition. A workspace over the archive limit remains
an explicit destructive exception for the operator to discard and retry, rather
than making every future fleet run silently data-losing after launch.

**Verdict: sound.** It reuses the production lifecycle boundary, bounds the VM
boot burst, and makes partial failure visible without preventing unrelated
workspaces from finishing.

#### Make state loss an explicit pre-launch operator action

**Confidence: high.**

**When** — production image promotion encountered a workspace whose archive
could not finish within the backend action window.

**The choice.** Normal fleet reprovision still archives and restores workspace
state. An operator may add `--discard-state` only when the workspace is known to
be disposable; that flag skips archive creation but keeps the ordinary
credential revocation, VM teardown, deterministic replacement, and attach
lifecycle. The alternative was silently falling back to an empty VM whenever
archive preservation failed, which would turn a transient timeout into data
loss after launch.

**The gap.** The operator workflow had no explicit representation of the user's
pre-launch instruction to delete a VM whose state could not migrate.

**The reach.** Future development fleets can be swept despite disposable large
or slow state, while production defaults remain fail-closed and
state-preserving. “State” includes the Drive folders that authoritatively back
the Agents page: after an explicit discard starts an empty replacement, the
existing reconciler removes agent and app rows once their folders remain absent
for three polls. The UI becoming empty is therefore the expected downstream
effect, not a second deletion path.

**Verdict: sound.** The destructive behavior is named at the invocation site,
authenticated by the same internal operator boundary, tested to avoid the
archive endpoint, and never inferred from a transport failure.

#### Prove fleet convergence from desired state, not a changed VM name

**Confidence: high.**

**When** — the first automated staging sweep repeatedly selected workspaces it
had already replaced.

**The choice.** The fleet runner identifies a workspace by its database id and
calls it complete only when that row is active, attached, and names the exact
immutable image digest requested by the operator. It does not wait for a new VM
name. exe.dev intentionally derives a workspace VM's name deterministically, so
deleting and replacing the VM can produce the same name; treating “name changed”
as completion made the runner reprovision an already-correct workspace again.

**The gap.** The rollout asked for an automated convergence loop but did not
state whether provider VM names change across replacement.

**The reach.** Future staging and production image sweeps converge once per
workspace even when provider names are reused. The completion check follows the
actual requested outcome—active on this digest—rather than an incidental label.

**Verdict: sound.** Desired state is stable across provider naming schemes and
is already the source operators care about; the corrected test is falsified by
the original same-name replacement scenario.
