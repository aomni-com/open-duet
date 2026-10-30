# macOS Syncthing wrapper — pin + dial-only + E2E probe (slice 21)

The Mac-side `duetfs sync` wrapper's supply-chain pins, the L24 dial-only
verification, and the local end-to-end run. Binary: Syncthing **v2.1.2**
"Hafnium Hornet" (`go1.26.5 darwin-arm64`), the same pin as the VM image
(`packages/vm-image` `SYNCTHING_VERSION=v2.1.2`).

## macOS v2.1.2 sha256 (recorded in `packages/duetfs/src/sync/binary.ts`)

From the official signed `sha256sum.txt.asc` for the v2.1.2 release
(github.com/syncthing/syncthing), cross-checked by download + local hash. The
linux-amd64 line matches the existing Dockerfile pin
(`0cea2466…`), confirming same-release provenance.

| Asset                            | Archive (.zip) sha256                                              | Extracted `syncthing` sha256                                       |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `syncthing-macos-arm64-v2.1.2`   | `fa2002f320170b64f226ff65831ccec516b59d7bba365acb51731dd079e52d1a` | `0325655f864024e0eecd78df07bdedbad46cefc91f480503ff615b6211081869` |
| `syncthing-macos-amd64-v2.1.2`   | `f04b3d7f1492457e929119b91561f0ddc6bada070f46b68bd2464cda04983424` | `24cd4219041087bf67a2773fe0aa8ad976b8e579b4768c31df365a58058f1743` |

`binary.ts` verifies the **extracted binary** sha on resolve; the archive sha is
the value you can cross-check against upstream without unpacking. The arm64
binary was executed on this machine and self-reports `syncthing v2.1.2` — the
major-pin check refuses anything but the v2.x line.

## L24 dial-only — verified on the real binary

A `syncthing generate` config patched with a single empty
`<listenAddress></listenAddress>` (what `hardenMacSyncthingConfig` writes) yields
an instance whose startup log shows only `GUI and API listening (192.0.2.1:…)`
— **no** `TCP listener`, relay, or discovery line, and no BEP inbound socket
(`lsof`). An empty entry disables listening; the Mac only ever dials the
loopback bridge. (Removing the element entirely instead falls back to the
built-in default listener — the empty entry is load-bearing.)

## `(?d)**/node_modules` — a slice-19 contract bug this probe caught

The mirror ignore set shipped `(?d) **/node_modules` (a space after the
modifier). Live-tested against v2.1.2 (`POST /rest/db/ignores` + scan + read
`globalFiles`):

| Pattern                    | globalFiles | node_modules excluded? |
| -------------------------- | ----------- | ---------------------- |
| `(?d) **/node_modules`     | 2           | **NO — leaks**         |
| `(?d)**/node_modules`      | 1           | yes                    |
| `**/node_modules`          | 1           | yes                    |

Syncthing takes the space as part of the pattern, silently defeating the match
— a wrong-arch `node_modules` would have mirrored onto every device, the exact
failure G1 exists to prevent. Fixed in `packages/contract/src/mirror/index.ts`
(the gateway VM side consumes the same constant, so the fix lands on both
sides); tests in `contract` and `gateway` updated.

## End-to-end (real, local, foreground)

`packages/duetfs/scripts/sync-e2e-probe.ts` runs the REAL production modules —
`createSupervisor`, `startMirrorBridge` (re-minting through a real WS tunnel),
`configureLocalMirror`, `waitForConvergence`, `listConflicts` — against TWO real
Syncthing v2.1.2 instances on this machine: a dial-only Mac instance dialing a
loopback bridge → real token-gated WS tunnel → a plain-listener "VM" instance.

```
Mac device up (dial-only; config has no default listener)  ✓
converged (peer connected, index exchanged, both directions quiet)  ✓
README.md + src/app.ts cloned; link.ts cloned as a SYMLINK  ✓
.git excluded (G1)   node_modules excluded (G1)  ✓
bridge re-minted the tunnel token (mints=2, remints=1)  ✓   ← L23
conflict surfaced, never auto-resolved: README.sync-conflict-…-TC3BBFV.md  ✓  ← Q6
kill -9 the Mac Syncthing mid-run → supervisor restart → clean resume  ✓
sync run exits cleanly (supervisor stopped, bridge closed)  ✓
```

### What ran vs. runbook

- **Ran, real:** binary acquire + sha + version-pin; supervisor
  lifecycle/hardening/restart; the bridge's L23 re-mint against a real
  token-verifying WS server; folder+device orchestration on a real loopback
  Syncthing; convergence + symlink + G1 exclusions; a genuine `.sync-conflict-*`;
  kill-9 resume.
- **Runbook (needs a provisioned exe.dev VM + Convex, deferred with the
  slice-19 L16 round-trip):** the one-command `duetfs sync run <workspace>`
  against a staging workspace registering through the **deployed** Duet
  `mirror-devices` API (so the tunnel is the real gateway tunnel, not a local
  echo), and the `mirror:<device>` row appearing in workspace activity (that
  attribution is the VM gateway's slice-18 translation — not observable from the
  Mac). The wrapper drives exactly the register→bridge→configure→converge path
  the local E2E exercises; the only unexercised leg is the WAN tunnel + the
  server-side activity write.

## Reproduce

```
DUET_SYNCTHING_BIN=/path/to/syncthing-v2.1.2 \
  bun packages/duetfs/scripts/sync-e2e-probe.ts
```
