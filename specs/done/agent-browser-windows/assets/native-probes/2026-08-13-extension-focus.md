# Slice 00 gates A+B — forced extension, exact channel, and focus

Date: 2026-08-13T22:27:39.659Z

## Verdict

**PASS:** the pinned Chrome supports deterministic forced MV3 installation, exact window/tab/target commands over the loopback channel, suspension/restart reconnect, and independently verified native focus.

## Exact substrate

- Image: `ghcr.io/aomni-com/duet-vm-image@sha256:71285a0068a6ed54ca33dd48791d0fe5ad2c3ccf69738ed5b25c9f9bd5c327dd`
- Chrome: `151.0.7922.137-1` (expected `151.0.7922.137-1`)
- Extension id: `GENERATED_EXTENSION_ID`
- Manifest public key: `GENERATED_LOCALLY`
- Install policy: `/etc/opt/chrome/policies/managed/duet-browser-extension-probe.json`
- Update manifest: `http://192.0.2.1:18765/update.xml`
- CRX: probe-only RSA key + exact Chrome `--pack-extension`; no Web Store or interactive install
- Live Chrome launch bytes: unchanged image-owned systemd command; no extension command-line flags

## Channel and generation evidence

- Exact mapping: Chrome window `1066217166`, tab `1066217168`, CDP target `A1E06C90F43858751BE8AD967BEC27F2`
- Initial browser generation: `9dc8ad1a-f59f-4ae7-b756-ab7d4c0f280e`
- Restarted browser generation: `56209897-9ea5-4e5c-a050-1124f43d6311`
- Extension connections: `3` (initial, after natural 60-second worker suspension, after Chrome restart)
- Native events retained by broker: `20`
- Keepalive: 20s; explicit suspension alarm: 60s

## Independent focus oracle

- Chrome window id (actuator): `1066217166`
- X11 `_NET_ACTIVE_WINDOW` (oracle only): `0x800017`
- X11 `_NET_WM_NAME`: `_NET_WM_NAME(UTF8_STRING) = "DUET_FOCUS_1786659967508 - Google Chrome"`
- Screenshot: [`2026-08-13-extension-focus.png`](2026-08-13-extension-focus.png)
- The extension debounces transient `WINDOW_ID_NONE` for 250ms and emits only a settled focus after independently querying Chrome.

## Lifecycle and cleanup

- VM: `duet-test-browser-extension-20260813t222604-csbd`
- Control-plane create: 1465 ms
- Boot to SSH: 1629 ms
- Deleted: `duet-test-browser-extension-20260813t222604-csbd`
- Exact cleanup: probe VM `duet-test-browser-extension-20260813t222604-csbd` is absent
- Full failure command/stderr: not applicable
- Diagnostic attempts: [`2026-08-13-extension-focus-attempts.md`](2026-08-13-extension-focus-attempts.md)

## Accepted boundary

The forced policy plus loopback update source is viable on the pinned image. The
extension is an actuator only; the gateway owns commands and generations. X11
proves focus but supplies no persisted id. The probe-only alarm permission exists
only to force a suspension/reconnect observation and is not required by the final
20-second WebSocket keepalive design.
