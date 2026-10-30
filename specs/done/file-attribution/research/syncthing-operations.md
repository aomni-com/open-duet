# Syncthing operations — walk-2 research record (2026-07-13)

Condensed verdicts from three research passes backing the walk-2 amendments
in [MAP-SYNC.md](../MAP-SYNC.md). Facts graded: [DOC]=official docs,
[SRC]=verified in syncthing source, [CODE]=this repo, [FORUM]=maintainer
statements, [MECH]=deterministic mechanism inference.

## A. How VMs run Syncthing today (repo audit)

- Home = `/home/synthetic-user/.duet/syncthing` (`duet-syncthing.service:10`) —
  inside the archived `stateDir`, so **identity + index survive
  retire→restore** [CODE] — L16 closed (contingent on the L2/slice-15 fix,
  since any drive symlink aborts the whole restore today).
- Installed as unpinned apt `syncthing` (`Dockerfile:67`); no
  `--no-upgrade`, no `autoUpgradeIntervalH=0` [CODE].
- Hardening is lazy and partial: `disableSyncthingDiscovery()` runs only
  inside device/folder add (`routes/sync.ts:83,140`); `natEnabled` never
  touched; listener at default `0.0.0.0:22000`+QUIC+relay registration;
  crash reporting defaults ON; usage reporting undecided [CODE+DOC]. A
  fresh VM phones Syncthing infrastructure until its first share.
- Gateway REST client calls only `/rest/config` (read-modify-write PUT) and
  `/rest/system/status`; API key scraped from generated `config.xml`
  (`syncthing-client.ts:78-85`) [CODE]. No events consumer, no scan
  trigger exists yet.
- Star topology confirmed: peers dialed only via loopback bridges
  (`tcp://192.0.2.1:<bridgePort>`), no peer↔peer wiring [CODE].
- No inotify sysctl anywhere in vm-image [CODE].

## B. Operational facts (docs + source)

- **Events**: `GET /rest/events/disk` = pre-filtered long-poll for
  `LocalChangeDetected`+`RemoteChangeDetected`; `since=` cursor; buffer
  1000/subscription, gaps detectable by id discontinuity [DOC/SRC].
  `RemoteChangeDetected` fires from the puller DB-commit path
  (`updateLocalsFromPulling`) per applied item, carries `modifiedBy` —
  docs' "upon scan" wording is misleading [SRC]. `ItemFinished` has
  `error` but no `modifiedBy` [DOC/SRC].
- **`POST /rest/db/scan`** is synchronous (blocks until scan completes,
  `lib/api/api.go:1535`); `sub` repeatable [SRC].
- **Watcher**: `fsWatcherDelayS` min 0.01, values ≤0 silently DISABLE the
  watcher [SRC]. Linux needs `fs.inotify.max_user_watches=204800` for
  dev-tree scale [DOC]. `maxConcurrentScans` deprecated →
  `maxFolderConcurrency` (default = nCPU) [SRC].
- **Isolation set**: `globalAnnounceEnabled/localAnnounceEnabled/
relaysEnabled/natEnabled=false`, `urAccepted=-1`,
  `crashReportingEnabled=false`, `autoUpgradeIntervalH=0` + `STNOUPGRADE`,
  `listenAddress=tcp://192.0.2.1:22000`, GUI on loopback [DOC/SRC].
  Official binaries auto-upgrade by default (`autoUpgradeIntervalH=12`)
  [SRC].
- **v2.x**: SQLite `index-v2`, one-way migration from v1 LevelDB (old db
  kept 2 weeks); downgrade unsupported [SRC/DOC].
- **`.stfolder` marker**: missing marker halts the folder; marker restored
  over an incomplete tree ⇒ missing files propagate as deletions [DOC] —
  the reason restore must stop the service around the drive swap.
- **Conflicts**: loser = older mtime, renamed
  `*.sync-conflict-<date>-<time>-<deviceId>`; modify-vs-delete preserves
  content; `maxConflicts` docs self-contradict (−1 vs 10) [DOC].
- **Mixed-platform defaults**: xattrs/ownership not synced unless opted in;
  `caseSensitiveFS=false` keeps APFS↔ext4 case-clash protection [DOC].
  **`ignorePerms=true` strips the executable bit** (receiver creates
  default perms) → git mode-change noise; keep `false` for Linux↔macOS
  [DOC/FORUM] — this flipped knob K5.
- **Distribution**: MPL-2.0 (NOTICE pointing at source suffices for
  bundling unmodified binaries); official macOS binaries Developer-ID
  signed + notarized; ~11–12MB/arch [DOC/SRC].

## C. Git × sync verdict (the decision-forcing pass)

Maintainer position, decade-consistent [FORUM]: _"Can Syncthing reliably
sync local git repos? definitely no"_ — concurrent changes per-file-"merge"
two histories into a repo valid on neither machine; atomic-directory-sync
(syncthing#7627) closed, never implemented. Reported post-mortems match our
topology (conflict copies of `.git/index`/`HEAD`/refs → "nuke and
re-clone").

Deterministic breakers: **worktrees** (absolute `gitdir:` paths break at
different mount points; `git worktree repair` ping-pongs; fix =
`worktree.useRelativePaths`, git ≥2.48) [DOC]; **node_modules**
(wrong-arch platform binaries clobber the other side bidirectionally;
hardlink farms materialize as copies) [MECH/FORUM]. Inevitable-under-load:
refs-before-objects ordering (no cross-file ordering exists) [DOC/SRC],
conflict copies inside `.git` [FORUM], **`.git/index` ping-pong** — git's
index caches inodes, Syncthing writes new inodes, `git status` (IDE-driven)
rewrites the index, which syncs, forever [MECH, corroborated].

**Decision (walk 2):** `.git` and `node_modules` are excluded from the
mirror. Worktree files sync live (the product's liveness value);
git history travels via real remotes. The shared-worktree discipline
(same branch checked out on both sides; commits arrive via `git pull`) is
documented, not enforced, in v1. A **git concierge** (auto-bootstrap
init/remote/fetch/reset gated on folder convergence; align-when-safe
branch following; loud divergence in status) is a named deferred slice —
build when daily use shows the friction. "Don't sync repo files at all"
was considered and rejected: it hollows the product's core value and
trades concierge edge cases for dynamic-subtree-exclusion surprises.

Primary sources: forum.syncthing.net threads 1774, 8404, 11969, 23160,
10421; syncthing#7627; git-scm.com/docs/git-worktree, racy-git;
docs.syncthing.net (syncing, config, faq, rest/events-get, db-scan-post,
advanced/folder-caseSensitiveFS); apenwarr.ca/log/20181113.
