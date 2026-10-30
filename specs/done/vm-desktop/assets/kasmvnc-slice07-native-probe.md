# Workspace-browser native probe

Date: 2026-08-12T16:04:40.119Z

## Verdict

Passed: the authored default skill was discovered and its exact workflow drove
the session-owned tab in the shared visible Chrome.

## Evidence

- VM: `duet-test-workspace-browser-20260812t160419-2bbd`
- Image: `ghcr.io/aomni-com/duet-vm-image:probe-vm-desktop-s06-019ff5b3-01`
- Control-plane create: 2129 ms
- Boot to SSH: 1219 ms
- Discovered skill: `workspace-browser`
- Session target: `E835B04216416F3EF8E50BFFB109493A`
- Shared native Chrome window: `1982726600`
- Page title: `Agent Session · Duet Workspace Browser`
- Browser input: `Typed by the agent through Playwright`
- Recent drivers: `[{"sessionId":"agent-kill-gate-4","at":1786550671047}]`
- Screenshot: `kasmvnc-slice07-agent-browser.png`
- Deleted: `duet-test-workspace-browser-20260812t160419-2bbd`
- Leak check: no `duet-test-*` VMs remain

## Visual comparison

The target was a truthful 1440×900 frame showing the ordinary shared Chrome
window, the exact agent-owned tab, and legible input produced by browser
automation. Compared with the slice-05 shared-Chrome proof, both captures use
the same viewport and desktop framing. The first unprimed critique passed the
visual quality but rejected the page's self-authored claim as standalone causal
proof. The accepted recapture therefore includes a separate live X11 evidence
window populated from the gateway status and raw CDP results: it exposes the
session id, exact target, native Chrome window, ready phase, and most-recent
driver beside the filled Chrome tab.

The candidate is deliberately far away from slice 05 in page pixels
(`distance=0.55843`, candidate edge-energy ratio `1.49468`) because it adds a
dark proof page, a second tab, explanatory copy, and the filled input. Those
differences move toward the slice-07 target rather than indicating a regression;
the Chrome frame and desktop remain intact.

The fresh unprimed critique passed the recapture: matching session identity,
exact CDP target, native window, gateway-ready state, and most-recent driver sit
beside visibly typed input in headful Chrome, with no clipping, blank frame,
layering, or rendering defect. A still image cannot independently map Chrome's
opaque target id to its selected tab or provide a before/after timeline; the
native harness assertions and retained report cover that residual forensic
limit.
