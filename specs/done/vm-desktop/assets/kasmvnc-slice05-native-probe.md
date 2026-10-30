# Shared Chrome native probe

Date: 2026-08-12T15:08:53.986Z

## Verdict

Passed: one systemd-owned headful Chrome uses the shared durable profile and
loopback-only CDP on native exe.dev.

## Evidence

- VM: `duet-test-shared-chrome-20260812t150714-5iqu`
- Image: `ghcr.io/aomni-com/duet-vm-image:probe-vm-desktop-s05-019ff5b3-03`
  (`sha256:22406dceedf23bcaacffb0df378332c54dbe41edba2c1e40090a26d7e4e8c0a0`)
- Control-plane create: 85,411 ms (uncached)
- Boot to SSH: 1,329 ms
- Chrome: `151.0.7922.137-1` / `Chrome/151.0.7922.137`
- CDP: `ws://192.0.2.1:9222/devtools/browser/375f3aee-8372-4980-b61c-6fc3844f483d`
- Window class: `WM_CLASS(STRING) = "google-chrome (/home/synthetic-user/.duet/chrome)", "duet-browser"`
- Geometry: `x=72,y=48,width=1296,height=720`
- Agent-driven visible page: `Duet shared Chrome probe`
- Cookie after Chrome restart: `duet_shared_login=native-probe`
- Profile restart witness: `duet-slice05-1786547329367038485`
- Deleted: `duet-test-shared-chrome-20260812t150714-5iqu`
- Leak check: no `duet-test-*` VMs remain

The unique probe tag did not change a staging or production image pointer. The
diagnostic runs also deleted their exact VMs before the passing run; the final
account sweep found no test VM leak. The passing run closes Chrome's visible
pages through loopback CDP before systemd tears down X, then proves the cookie
exists in the profile database and is readable again after a full target
stop/start.
