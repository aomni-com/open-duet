# Slice 07 live staging acceptance

- Run: `staging-e2e-synthetic`
- Image: `ghcr.io/aomni-com/duet-vm-image@sha256:1d1dbcb4af6bd796ec28ba74fbea9f4c339717f9ca36bfa1d664d6e6f7731c93`
- Journey: `agent-browser-windows`
- Result: PASS; cleanup deleted every recorded resource and reported no orphan.

The live journey proved root plus two named owners, two fresh Alpha batches in
one Alpha window, distinct Beta and root windows, shared cookie state, exact and
idempotent focus, idle batch-tab discard, owner cleanup on agent deletion, and
credentialless/expired desktop refusal. Native window inventory and product
status agreed before each screenshot.

The first screenshot set exposed two evidence defects: an unrelated migration
notice obscured the desktop, and the owner rail could be captured before its
poll caught up with native focus. The journey now dismisses that notice before
navigation and waits for the rendered focused-owner accessibility label. The
rerun above passed and a fresh unprimed visual review found no observable defect.

Retained evidence:

- [Alpha product](agent-browser-alpha-product.png)
- [Alpha framebuffer](agent-browser-alpha-framebuffer.png)
- [Beta product](agent-browser-beta-product.png)
- [Beta framebuffer](agent-browser-beta-framebuffer.png)

The Alpha/Beta product pair changed 4.28% of pixels and the raw framebuffer pair
changed 10.67%, with the changes concentrated in the selected owner chip and the
foreground Chrome content. These measurements support comparison; the acceptance
decision came from semantic and visual inspection, not a pixel threshold.

## Fleet result

The state-preserving staging fleet rail converged 16 existing VMs to the accepted
digest. It initially left exactly `Example User-zhang-s-workspace` because that workspace's
archive exceeded Convex's hard 1 GiB single-file limit. After the user explicitly
authorized scratch reprovision for this prelaunch fleet, the same fleet rail ran
with discard while that workspace was the sole candidate. Its prior VM filesystem
state was not archived and is not recoverable through Duet; no other staging row
used the exception. The final dry-run reported no candidate.

This is not a browser-window defect. The durable postlaunch fix remains the
separately planned object-storage archive rail in `specs/archive-offload/`; it has
an intentionally open provider decision. For this completed prelaunch rollout, the
user explicitly changed the convergence policy: preserve state by default, but
scratch reprovision an exact workspace that cannot archive.

### Compression probe

The blocked VM was inspected read-only over its existing SSH control-plane seam.
The probe streamed the exact current archive selection through low-priority,
single-threaded Zstandard without retaining or exporting its contents. Fast
compression still exceeded 1 GiB. A stronger practical level remained between
1.5 and 2 GiB, so a compressed single Convex object cannot clear the blocker.

Splitting the archive into several Convex objects was rejected as a release
workaround: the already-agreed archive architecture moves subscriber bytes out of
Convex entirely, and a chunk manifest/upload/restore protocol would become a
second storage system that still fails as workspace drives grow. The evidence
confirms that object storage is load-bearing before archive retention becomes a
launched product promise. It is not required to migrate this disposable prelaunch
fleet under the user's explicit scratch-reprovision authorization.
