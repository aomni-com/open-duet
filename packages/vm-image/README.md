# @repo/vm-image

`@repo/vm-image` owns the image boundary for Duet workspace VMs. It builds the
base runtime that exe.dev boots: the managed application runtime, Bun,
Syncthing, systemd units, and the
drive/state directories the gateway expects.

The Dockerfile pins separate gateway and workspace Bun runtimes. The gateway's
native stream fix must not silently change the runtime used by agent memory,
CLIs, or user apps: that upgrade has a separate compatibility gate. Systemd and
the gateway browser command name the gateway binary explicitly, while the
workspace binary remains on PATH. Stream-error garbage collection
is part of image verification: an upstream disconnect must reject the request,
not crash the gateway and every active session it supervises. The disposable
[stream probe](scripts/bun-stream-gc-probe.ts) exercises that native lifetime
boundary before an image can be published.

## Boundary

Image changes are for OS-level dependencies, boot wiring, and first-boot
contents. Application changes should ship through the whole runtime release owned by
[`@repo/gateway`](../gateway/README.md) when they
do not require a new OS image.

The image runs a stable runtime bootstrap before systemd enters current-release
code. That bootstrap delegates release validation, repair, and deterministic
rollback to [`@repo/gateway`](../gateway/README.md), keeping image scripts out of
the release-integrity contract. Systemd retries the gateway without a start
limit; the bootstrap's persisted probation and quarantine state is the circuit
breaker for a crashing release.

A process start is not evidence that a release is healthy. The gateway writes
its release-scoped healthy marker only after sustained runtime and successful
control-plane syncs. Until then, the bootstrap guard treats the release as on
probation; repeated crashes roll back to the retained previous release and
quarantine the failed candidate so systemd retries converge instead of looping
on the same bad bytes.

The desktop follows the same boundary. Its KasmVNC and XFCE configuration is
image content and stays outside the archived workspace roots, while a static,
demand-only `duet-desktop.target` remains inert until the gateway starts it.
Kasm's generated `xstartup` owns the XFCE session, so one forking service owns
both rather than competing systemd units. The gateway-facing Kasm credential is
generated locally on first start and persisted with VM state; it is an upstream
relay formality inside the workspace trust domain, not a second user
authentication layer.

The target also owns one shared headful Chrome. Its non-default profile at
`/home/exedev/.duet/chrome` is both the human's browser state and the agent CDP
state; Chrome listens for automation only on loopback port 9222. The image
requires Kasm, wants the self-restarting browser, and orders Chrome after Kasm:
a browser restart must preserve the admitted framebuffer stream, while both
services remain part of the aggregate target for start and stop. It installs an
exact SHA-verified Chrome package,
removes Google's apt source and
stock launchers, and ships one `duet-browser` launcher whose class matches the
running window. On target stop, the browser unit first closes visible pages
over loopback CDP so Chrome durably flushes cookies and other profile state;
bounded mixed-mode termination covers an already-dead or unresponsive browser.
The image also owns a narrow privileged installer for the audited gateway
trigger: it accepts only an exact Debian version plus SHA-256, fetches from the
fixed Google package pool, and restores the held-package and single-launcher
invariants after every attempt. Chrome never mutates unattended under a live
shared browser.

Native Chrome window operations belong to one image-forced MV3 extension. It
has no page content access or owner policy: it reports the browser's normal
windows and tabs, performs exact-window tab creation and focus, and relays
native lifecycle events over a loopback gateway channel. The gateway remains
the only owner of agent identity and browser resource policy. Both systemd and
the desktop launcher call one image-owned Chrome launcher so the profile, CDP,
class, and geometry invariants cannot drift.

Each image build generates a fresh extension signing identity in its disposable
build context. BuildKit mounts the private key only while Chrome packs the CRX;
the key is excluded from the context sent to Docker and from image layers. The
image keeps the public manifest key and installs Chrome's managed policy with
the derived extension ID. The gateway reads that same policy for update manifests
and websocket admission, so runtime updates use an existing image's identity
without requiring a VM rebuild. Infrastructure probes generate separate disposable
identities through the same helper; no signing key is committed.

The surrounding desktop is image-owned for the same reason: a fresh VM should
open into the approved composition without a first-boot download or a
workspace-owned preference layer. Theme and icon sources are immutable,
checksum-verified build inputs; XFCE owns the top bar, wallpaper, fonts, and
empty desktop, while Plank owns the small launch surface. Runtime verification
observes the active session—including the browser geometry and single browser
dock entry—rather than treating copied configuration as proof that the look
applied.

The browser-facing transition belongs to that same product surface: transport
branding and vocabulary stay out of sight while the desktop connects.

The image's `/usr/local/bin/duet-browser` agent command is only a stable path
into the current gateway bundle; it does not carry a second implementation.
That keeps per-session target allocation updateable with the gateway while the
Chrome binary and desktop launcher remain image-owned.
The default workspace-browser skill treats that launcher and the baked Python
Playwright client as one required-tools contract, so image verification catches
either half drifting away from the authored workflow.

The application bytes come from the API's [shared runtime constructor](../../apps/api/scripts/build-runtime-release.mjs).
`DUET_RUNTIME_RELEASE_DIR` supplies its frozen output to the image build;
`DUET_RUNTIME_BOOTSTRAP_PATH` supplies the matching stable bootstrap. The image
copies that inventory intact, including its manifest and content identity.
Without supplied output, the local build invokes the same constructor once.
There is no registry installation or independent application builder in Docker.
The stable `duet` command follows the managed current release, while an admitted
agent process uses the physical cohort captured by the gateway.

## Publishing

The provisioner boots workspaces from a published image, resolved at create time
from `DUET_VM_IMAGE_REF` (Convex `provisioningActions`, api `resolveVmImageRef`).
The image lives in GHCR at `ghcr.io/aomni-com/duet-vm-image`.

Two things drive the shape here:

- **`DUET_VM_IMAGE_REF` is an immutable digest (`…@sha256:…`), never a tag.**
  exe.dev caches an image by tag on first pull and reuses it — moving a tag to a
  new digest does _not_ invalidate that, so a tag-based ref silently boots stale
  VMs after a rebuild. The `:staging` / `:production` tags still exist as
  human-readable pointers and the promotion mechanism, but the provisioner ref is
  always the digest.
- **Production is a promotion of the exact staging digest**, never a separate
  rebuild — prod runs the same bytes `verify-image` passed on staging.

The digest is still a managed secret in `.env.{staging,production}` (fanned out
by [`scripts/secrets-push.mjs`](../../scripts/secrets-push.mjs)), kept current
automatically: `build-image:staging` and `promote-image:production` write the
pushed digest into the target `.env` after each push (see `recordDigestRef` in
`scripts/image-utils.ts`). So the flow stays build → promote → `secrets:push`
with no hand-edited refs. `build-image` takes an explicit `IMAGE_REF=…` for
probes and one-offs.

The new digest governs future provisioning. Existing workspace VMs receive
runtime releases in place through the [gateway release manager](../gateway/README.md),
preserving live work, durable state, and their actual image provenance. An
application update must never rewrite that original image reference or require
replacing the VM.

One-time registry setup, which no code captures:

1. **Create a GHCR token** — a GitHub [personal access token
   (classic)](https://github.com/settings/tokens) with the `write:packages`
   scope (that implies `read:packages`).
2. **Log Docker in** so pushes authenticate:

   ```bash
   echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
   ```

   This persists to `~/.docker/config.json`, so it's a one-time step per machine.

3. **Make the package pullable by exe.dev.** New GHCR packages are private by
   default; either flip it to **public** on the package's GitHub settings page
   (matches the public base image; no pull auth) — or keep it private and pull
   with `--registry-auth`, which requires wiring a `read:packages` token in as a
   provisioning secret.

## Pointers

- `Dockerfile` owns the VM filesystem, installed packages, bundled application
  release and enabled systemd services.
- `scripts/build.ts` owns the temporary Docker build context and image push.
- `scripts/verify-image.ts` owns the post-build toolchain check (run before push).
- `scripts/ensure-kasm-credentials.sh` materializes the VM-local credential the
  gateway injects when relaying to KasmVNC.
- `scripts/runtime-crash-drill.ts` replays crash-loop recovery entirely in local
  temporary directories.
- `systemd/` owns gateway, Syncthing, and demand-only desktop wiring.
