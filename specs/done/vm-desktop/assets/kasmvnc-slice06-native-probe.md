# Per-session desktop tabs native probe

Date: 2026-08-12T15:34:03.625Z

## Verdict

Passed: two sessions received distinct default-context tabs, and reactivation
raised the owning tab.

## Evidence

- VM: `duet-test-desktop-tabs-20260812t153349-p4jq`
- Image: `ghcr.io/aomni-com/duet-vm-image:probe-vm-desktop-s06-019ff5b3-01`
- Control-plane create: 2222 ms
- Boot to SSH: 1346 ms
- Session A target: `A6DED072942B0F4D0B9D007EE1393FC4`
- Session B target: `7754C0CDBAB95A78A19F3154F15D4BC6`
- Shared browser WebSocket: `ws://192.0.2.1:9222/devtools/browser/d8e0c0ba-bbad-4a8a-b26a-992c1ce99577`
- Shared default context: `2C2593B510863E5FE1FCF12B2C4EE2FF`
- Shared native Chrome window: `341706538`
- Successfully activated target after session A acted again:
  `A6DED072942B0F4D0B9D007EE1393FC4`
- Recent drivers:
  `[{"sessionId":"session-a","at":1786548839717},{"sessionId":"session-b","at":1786548839461}]`
- Deleted: `duet-test-desktop-tabs-20260812t153349-p4jq`
- Leak check: no `duet-test-*` VMs remain
