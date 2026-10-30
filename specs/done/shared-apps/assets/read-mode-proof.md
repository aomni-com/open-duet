# Read-mode Syncthing proof

Recorded 2026-07-15 on macOS arm64 with the repository-pinned stock binary:

```text
syncthing v2.1.2 "Hafnium Hornet" (go1.26.5 darwin-arm64) user@example.invalid 2026-06-26 05:22:40 UTC
```

Run from the repository root after staging the gitignored binary with
`bun packages/duetfs/scripts/release-syncthing-packages.ts`:

```sh
bun specs/shared-apps/assets/read-mode-probe.ts
```

The probe creates two temporary Syncthing homes and folders. Both instances
listen only on random `192.0.2.1` ports; global discovery, local discovery,
relays, NAT traversal, and upgrades are disabled. The creator folder is
`sendonly`; the viewer folder is `receiveonly`.

Captured output:

```text
PASS 1a creator file auto-pushed to viewer
PASS 2 viewer local addition survived and never reached creator
PASS 3a selective repair reverted a tracked modification only
PASS 3b selective repair restored a tracked deletion only
PASS 1b creator update won over viewer edit
PASS 4a viewer edit preserved as tracked.sync-conflict-20260715-091556-GVJNNXT.txt
PASS 4b colliding local file preserved as collision.sync-conflict-20260715-091557-GVJNNXT.txt
TRAP before folder revert: local addition present
TRAP after folder revert: local addition deleted
PAIRING creator=sendonly viewer=receiveonly
RESULT all read-mode constraints proven; folder-wide revert rejected
```

## Mechanism selected

Syncthing v2.1.2 exposes no per-file revert operation. Its
`POST /rest/db/revert` endpoint is folder-wide and the probe confirms that it
deletes viewer-local additions (and, in the exploratory run, `.sync-conflict`
copies as well). It therefore cannot be the enforcement primitive.

The selective seam is `LocalIndexUpdated.data.filenames` plus
`GET /rest/db/file`. On a receive-only folder, a creator-tracked file has
`global.localFlags = 0`; a viewer-local addition or conflict copy has nonzero
receive-only local flags in the global record. Enforcement touches only the
former. Before repairing a modification, the gateway atomically renames the
viewer bytes to a `.sync-conflict` copy, then requests a targeted
`POST /rest/db/scan?folder=...&sub=...`. Syncthing pulls the creator version
without discarding the viewer edit. A tracked deletion needs two targeted
scans: materialize an empty placeholder and scan it, then remove it and scan
again. This moves Syncthing from its already-recorded local deletion state
back through a detectable path change, after which it pulls the global
creator version. No folder revert is used.

The creator is `sendonly`, not `sendreceive`, because the product contract has
one authority for a read share. The viewer's `receiveonly` type already keeps
viewer changes local; `sendonly` additionally prevents the origin from ever
applying an unexpected peer index while still publishing creator updates.
The gateway persists both share mode and origin/recipient role so boot
reconciliation reasserts this pairing instead of guessing from mode alone.
