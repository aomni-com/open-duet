# Slice 00 proofs — VM sync rail

Measured 2026-07-15 from branch `vm-sync-rail/00-proofs`. Marker:
`vmsyncrail-s00-proofs`. No npm publication or Convex operation was performed.
The only VM used was `vmsyncrail-s00-proofs-1784067055`, created for these
measurements and deleted at the end (cleanup evidence below).

## 1. Bun CLI rail mechanics — PROVEN

The disposable Linux VM was created directly through exe.dev and reached an SSH
shell:

```console
$ ssh exe.dev new --name vmsyncrail-s00-proofs-1784067055 \
    --comment vmsyncrail-s00-proofs --no-email --json
{"vm_name":"vmsyncrail-s00-proofs-1784067055",...,"ssh_dest":"service.example.invalid",...}

$ ssh service.example.invalid -- uname -a
Linux vmsyncrail-s00-proofs-1784067055 6.12.93 #1 SMP Fri Jun 19 19:36:16 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux

$ curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
$ /home/synthetic-user/.bun/bin/bun --version
1.3.14
```

Each candidate used its own `BUN_INSTALL` under an exedev-owned rail prefix. The
active command was a stable link in `.../bin`; activation used `ln -s` to a
temporary link followed by same-filesystem `mv -T`:

```sh
BUN=/home/synthetic-user/.bun/bin/bun
RAIL=/home/synthetic-user/.duet/cli-rail
BUN_INSTALL="$RAIL/candidates/agent-0.2.2" \
  "$BUN" add -g '@duetso/agent@0.2.2'
ln -s "$RAIL/candidates/agent-0.2.2/bin/duet" "$RAIL/bin/.duet.next"
mv -Tf "$RAIL/bin/.duet.next" "$RAIL/bin/duet"
```

Exact install and exact downgrade both produced isolated Bun global trees and
callable commands:

```console
== exact install 0.2.2 + activation ==
installed @duetso/agent@0.2.2 with binaries:
 - duet
candidate=agent-0.2.2 global_dir=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.2/install/global bin=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.2/bin package_version=0.2.2 command_target=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.2/install/global/node_modules/@duetso/agent/dist/src/cli-entry.js
0.2.2
active_link=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.2/bin/duet active_version=0.2.2

== exact downgrade 0.2.1 + activation ==
installed @duetso/agent@0.2.1 with binaries:
 - duet
candidate=agent-0.2.1 global_dir=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.1/install/global bin=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.1/bin package_version=0.2.1 command_target=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.1/install/global/node_modules/@duetso/agent/dist/src/cli-entry.js
0.2.1
active_link=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.1/bin/duet active_version=0.2.1
```

A nonexistent exact version failed in a separate prefix. The active command
remained the downgraded 0.2.1 command:

```console
== failed install leaves active command ==
install_exit=1
error: No version matching "999.999.999" found for specifier "@duetso/agent" (but package exists)
error: @duetso/agent@999.999.999 failed to resolve
active_link=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.1/bin/duet active_version=0.2.1
```

For smoke-failure injection, 0.2.2 was installed into another candidate and its
candidate entry point was moved aside before running the real `duet -v` smoke.
The candidate failed and was not activated:

```console
== failed post-install smoke leaves active command ==
candidate=agent-bad-smoke ... package_version=0.2.2 ...
smoke_exit=127
bash: .../agent-bad-smoke/bin/duet: No such file or directory
active_link=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.1/bin/duet active_version=0.2.1
```

The staging and active directories were writable by `exedev` and on one
filesystem:

```console
same_filesystem=yes
exedev:exedev 755 /home/synthetic-user/.duet/cli-rail
exedev:exedev 755 /home/synthetic-user/.duet/cli-rail/bin
exedev:exedev 755 /home/synthetic-user/.duet/cli-rail/candidates
exedev:exedev 755 /home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.1/install
active_resolves=/home/synthetic-user/.duet/cli-rail/candidates/agent-0.2.1/install/global/node_modules/@duetso/agent/dist/src/cli-entry.js
atomic_swap_primitives
/usr/bin/ln
/usr/bin/mv
```

The image already establishes the production Bun prefix and ownership at
`packages/vm-image/Dockerfile:135-146`; the gateway service uses that bin path
at `packages/vm-image/systemd/duet-gateway.service:6-17`. The durable verifier
now checks the prefix, `exedev` ownership/writability, command location, and
command/package version equality in
`packages/vm-image/scripts/verify-image.ts`.

**Verdict:** Bun supports the staged-directory + atomic-link-swap design. Slice
08 must use one explicit user-owned Bun prefix and may not fall back to npm.

## 2. duetfs npm publication (R1) — RELEASE-BLOCKING

### Namespace ownership — PROVEN

The registry package is owned by the same email as this repository's configured
maintainer. `npm whoami` was unavailable locally, so ownership is grounded in
the public owner record plus the exact git identity; this proves control by the
current repository owner, not an npm organization grant.

```console
$ npm view duetfs --json
{
  "_id": "duetfs@0.0.1",
  "maintainers": ["Example User <user@example.invalid>"],
  "version": "0.0.1",
  "description": "The shared drive for AI agents — CLI coming soon. https://service.example.invalid",
  "_npmUser": "Example User <user@example.invalid>"
}

$ npm owner ls duetfs
Example User <user@example.invalid>

$ git config user.name; git config user.email
Example User
user@example.invalid

$ npm whoami
npm error code E401
npm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami
```

**Inference:** the matching owner email establishes that the namespace is ours.
There is no logged-in npm credential on this machine, so this slice did not and
could not prove that this particular checkout can publish; no publish was
attempted.

### Pack — PROVEN

`npm pack --dry-run --json` ran `prepack`, built both bundles, and returned a
61-entry artifact:

```console
$ cd packages/duetfs && npm pack --dry-run --json
> duetfs@0.1.0 prepack
> bun run build
Bundled 172 modules ...
[
  {
    "id": "duetfs@0.1.0",
    "size": 441293,
    "unpackedSize": 2512805,
    "filename": "duetfs-0.1.0.tgz",
    "entryCount": 61,
    "bundled": []
  }
]
```

The exact tarball copied to the Linux VM was generated with `npm pack` (not
published) and hash-checked on both hosts:

```console
$ shasum -a 256 /tmp/vmsyncrail-duetfs-artifact/duetfs-0.1.0.tgz
d07c182fd7d002e3616e3f5c8d6a72dbe5b8b5eb6e487d08631fe51f375b2d3e  .../duetfs-0.1.0.tgz

$ ssh service.example.invalid -- \
    sha256sum /tmp/duetfs-0.1.0.tgz
d07c182fd7d002e3616e3f5c8d6a72dbe5b8b5eb6e487d08631fe51f375b2d3e  /tmp/duetfs-0.1.0.tgz
```

### Clean Linux/Node 24 install — DISPROVEN

The host was Linux x86_64 with Node 24.18.0 and npm 11.16.0. A clean npm global
install exited 1, both normally and with `--omit=optional`:

```console
$ node --version; npm --version
v24.18.0
11.16.0

$ npm install -g --prefix /tmp/duetfs-clean-npm /tmp/duetfs-0.1.0.tgz
npm error A complete log of this run can be found in: /home/synthetic-user/.npm/_logs/2026-07-14T22_13_42_027Z-debug-0.log
$ echo $?
1

$ npm install -g --omit=optional --prefix /tmp/duetfs-clean-npm-omit /tmp/duetfs-0.1.0.tgz
npm_omit_optional_exit=1
```

The npm debug log stopped immediately after resolving `ai@^7`; installing
`ai@^7` alone succeeded. The packed manifest still contains workspace
protocols (`packages/duetfs/package.json:32-35`):

```json
"optionalDependencies": {
  "@duetfs/syncthing-darwin-arm64": "workspace:*",
  "@duetfs/syncthing-darwin-x64": "workspace:*"
}
```

**Inference:** the unreplaced `workspace:*` specs are the remaining artifact
difference and the likely npm failure cause. Slice 08 must prove the fix with a
new clean-artifact test rather than accepting this inference as diagnosis.

Bun 1.3.14 resolved the same tarball and returned exit 0, but did not create the
advertised global bin entry, so the installed CLI was not callable:

```console
$ BUN_INSTALL=/tmp/duetfs-clean-bun bun add -g /tmp/duetfs-0.1.0.tgz
installed duetfs@/tmp/duetfs-0.1.0.tgz with binaries:
 - duetfs
22 packages installed
bun_install_exit=0

$ ls -la /tmp/duetfs-clean-bun/bin
total 8
drwxr-xr-x 2 exedev exedev 4096 ... .
drwxr-xr-x 4 exedev exedev 4096 ... ..

$ /tmp/duetfs-clean-bun/bin/duetfs --help
bash: .../bin/duetfs: No such file or directory
```

### Stable version command — DISPROVEN

```console
$ cd packages/duetfs && bun run build
$ ./dist/duetfs --version
Unknown command: --version
$ echo $?
64
```

**Verdict:** the namespace is ours and packing works, but the current exact
artifact fails the clean Linux install contract and has no stable version
command. This is **RELEASE-BLOCKING for R1**. Slice 08 must replace published
workspace specs with publishable exact versions, make the Bun-installed command
materialize, add `duetfs --version`, and repeat the exact-artifact Linux test.
Slice 09 may not publish/roll out duetfs until that gate is green.

### Slice 08 local exact-artifact closure — PROVEN; Linux rerun pending

`packages/duetfs/src/pack.test.ts` now creates the real `npm pack` tarball and
checks that its manifest contains no workspace protocol, its optional package
versions are exact, and its advertised bin target exists. It then clean-installs
that same tarball into temporary npm and Bun prefixes and invokes
`duetfs --version` from both installed bin directories. The package bin now
points at the executable bundled CLI entry, so Bun materializes the link.

```console
$ cd packages/duetfs && bun test src/pack.test.ts
1 pass
0 fail
```

This local macOS proof closes the artifact construction, npm/Bun install, bin,
and version-command defects. Before publication, slice 09 must copy the newly
packed tarball to Linux with Node 24/npm 11 and repeat the clean npm install;
no real Linux VM was used in slice 08.

## 3. Cutover window — OPEN

### Current gateway under legacy-endpoint 404s — PROVEN

A temporary Bun HTTP fixture returned 404 to every request. A current
`createGatewayRuntime` instance used real HTTP fetches to it, with a durable
fixture token for the old-VM case. The harness started both the heartbeat and
anchor loops, waited through retries, then called health, file, archive, and
runner routes. A second runtime had no token, proving the registration retry
path parks while the HTTP app remains live. The harness was removed after the
run.

```console
$ bun .vmsyncrail-cutover-probe.ts 2>&1
heartbeat failed; retrying
anchor list failed with HTTP 404
anchor list failed with HTTP 404
heartbeat failed; retrying
...
{"phase":"seeded-old-vm","health":{"status":200,"body":{"imageVersion":"unknown","gatewayVersion":"0.0.0","uptimeSeconds":2}},"files":{"status":200,"body":{"entries":[{"name":"proof.txt","path":"proof.txt","type":"file","size":14,...}]}},"archive":{"status":200,"contentType":"application/x-tar","bytes":30720},"runner":{"status":400,"body":{"error":"invalid_request"}},"legacyRequests":["POST /v1/vm/heartbeat","GET /v1/vm/anchors",...,"POST /v1/vm/heartbeat",...]}
register failed; retrying
register failed; retrying
...
{"phase":"register-retry","healthz":{"status":200,"body":"ok"},"registerAttempts":2,"tokenExists":false}
```

The runner response is 400 because the probe deliberately sent `{}`; it proves
the authenticated runner route continued parsing and responding without
starting an agent. The retry mechanics are owned by
`packages/gateway/src/runtime/http.ts:445-472,654-664`; anchor failures are
contained by `packages/gateway/src/routes/anchors.ts:150-162`.

### Full force-reprovision timing — OPEN

This could not be measured honestly with the standalone disposable VM. The full
path requires a real workspace row, archive, teardown/attach retriers,
registration, and restore. Creating or operating staging/production Convex data
was outside this slice's hard safety boundary. VM create/SSH timing alone is not
a substitute.

With the owner present during slice 09, after provisioning and destructive
automation are frozen, run this against a designated staging workspace created
for the drill. It waits for an observed cut followed by two consecutive healthy
file-route responses, so an immediate response from the old VM is not mistaken
for completed reprovision:

```sh
API_URL=https://service.example.invalid
SLUG='<owner-created-disposable-workspace-slug>'
DUET_API_KEY='<owner key with admin + files:read for that workspace>'
start=$(date +%s)
curl -fsS -X POST "$API_URL/v1/ws/$SLUG/reprovision" \
  -H "authorization: Bearer $DUET_API_KEY"
seen_cut=0
consecutive_healthy=0
while :; do
  code=$(curl -sS -o /tmp/vmsyncrail-reprovision-files.json -w '%{http_code}' \
    "$API_URL/v1/ws/$SLUG/files?list=1" \
    -H "authorization: Bearer $DUET_API_KEY" || true)
  if [ "$code" = 200 ]; then
    if [ "$seen_cut" = 1 ]; then
      consecutive_healthy=$((consecutive_healthy + 1))
      [ "$consecutive_healthy" -ge 2 ] && break
    fi
  else
    seen_cut=1
    consecutive_healthy=0
  fi
  elapsed=$(( $(date +%s) - start ))
  [ "$elapsed" -lt 120 ] || { echo "FAIL: not recovered within 120s"; exit 1; }
  sleep 1
done
elapsed=$(( $(date +%s) - start ))
echo "force_reprovision_seconds=$elapsed"
test "$elapsed" -lt 120
```

### Retirement/cleanup races — DISPROVEN without a freeze

The one-minute stale-heartbeat cron only changes `active` to `unhealthy`; the
threshold is two minutes (`packages/backend/convex/crons.ts:5-12`,
`packages/backend/convex/domains/workspaces/provisioningCore.ts:21-53`). The
five-minute leaked-teardown sweep selects only `deleted`/`retired` workspaces
(`packages/backend/convex/crons.ts:32-39`,
`packages/backend/convex/domains/workspaces/provisioningCore.ts:85-105`). Neither
directly destroys a parked active old VM.

However, the hourly idle-retirement cron selects `active` VMs idle for seven
days (`packages/backend/convex/crons.ts:14-21`,
`packages/backend/convex/domains/workspaces/provisioningCore.ts:108-125`) and
then archives and marks them retired
(`packages/backend/convex/domains/workspaces/provisioningActions.ts:111-158`),
which schedules teardown. Therefore an eligible idle VM can be selected during
the first two minutes of the blackout before the health cron moves it out of
`active`.

**Verdict:** route availability and retry parking are proven. The literal
reprovision-time kill criterion remains **OPEN**, and destructive automation is
**DISPROVEN safe unless frozen**. Slice 09 must freeze at least idle retirement
and teardown automation before the API cut, run the human timing command, and
stop if the result is not acceptable under the 120-second bound.

## 4. Bootstrap auth (R4) — PROVEN

The durable state and release trees are separate by construction:

- Token: `REDACTED`, derived from the configured state dir
  and written mode 0600 (`packages/gateway/src/vm/phone-home.ts:142-155,174-175`).
- Releases: `/opt/duet/releases`; active link: `/opt/duet/current`
  (`packages/gateway/src/gateway-update.ts:21-23`).
- Stable image-owned programs: `/opt/duet/bin`; the current pre-start guard is
  there and runs before `/opt/duet/current/index.js`
  (`packages/vm-image/systemd/duet-gateway.service:16-17`).
- Extra headers enter the exe.dev VM create environment in
  `packages/backend/convex/domains/workspaces/vmAttach.ts:232-249`, are passed to
  the gateway service at
  `packages/vm-image/systemd/duet-gateway.service:15`, and are parsed without
  release-local state at `packages/gateway/src/runtime/env.ts:160-167`.
- Existing authenticated fetches compose extra headers with `Authorization:
Bearer <vm token>` at `packages/gateway/src/vm/archive.ts:139-150` and
  `packages/gateway/src/vm/phone-home.ts:96-114`.

The disposable VM repeated that contract with a protected local artifact
fixture. The probe executable was deliberately outside the release tree:

```console
$ DUET_GATEWAY_EXTRA_HEADERS_JSON='{"bypass-tunnel-reminder":"duet"}' \
    /opt/duet/bin/bootstrap-auth-probe.sh
process_path=/opt/duet/bin/bootstrap-auth-probe.sh release_dir=/opt/duet/releases outside_release=yes
token_path=/home/synthetic-user/.duet/vm-token owner=exedev:exedev mode=600 bytes=17
probe_user=exedev extra_headers_source=DUET_GATEWAY_EXTRA_HEADERS_JSON
artifact-ok auth=Bearer [REDACTED] extra=duet
```

**Verdict:** slice 04's stable bootstrap can authenticate without importing
current-release code. It should read `/home/synthetic-user/.duet/vm-token`, inherit and
parse `DUET_GATEWAY_EXTRA_HEADERS_JSON`, and fetch the release manifest/artifacts
with both header sets. This proof does not cover fleet-wide boot-storm capacity,
which remains R4 follow-up work outside slice 00's stated question.

## Cleanup

The only created VM was deleted, and a recursive JSON search of `exe.dev ls`
found no remaining object with its name:

```console
$ ssh exe.dev rm vmsyncrail-s00-proofs-1784067055 --json
{"deleted":["vmsyncrail-s00-proofs-1784067055"],"failed":[]}

$ ssh exe.dev ls --json | jq --arg vm vmsyncrail-s00-proofs-1784067055 \
    '[.. | objects | select(.vm_name? == $vm)] | {remaining: .}'
{
  "remaining": []
}
```

## Kill-criteria evaluation

| Criterion                                   | Status                                                                                                                                                                                                               | Consequence                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| duetfs unpublishable under our ownership    | Literal namespace criterion **not triggered**: ownership and dry-run pack are proven. R1 is nevertheless **RELEASE-BLOCKING** because the exact artifact is not clean-installable and has no stable version command. | Slice 08 must close the artifact/version failures; slice 09 cannot publish or roll it out before then.                            |
| no shared writable prefix possible          | **Not triggered.** Bun candidate prefixes and atomic activation are proven on Linux as `exedev`.                                                                                                                     | Slice 08 may implement the single Bun rail; no npm fallback.                                                                      |
| reprovision cannot fit an acceptable window | **OPEN**, not guessed. Measuring the full path would have touched prohibited workspace/Convex state.                                                                                                                 | Slice 09 remains gated on the owner-run command above and must stop if the measured result misses the accepted/120-second window. |

Slice 04 is unblocked by the R4 auth proof. Slice 08 is blocked by R1. Slice 09
is blocked by R1, the open timing measurement, and the required destructive-cron
freeze.

## Slice 09 cutover — executed 2026-07-15 (staging)

Cutover ran autonomously per owner authorization. Sequence: Convex deploy A
(additive) → publish `@duetso/syncthing-darwin-{arm64,x64}@2.1.2` + `duetfs@0.1.0`
(scope corrected from the nonexistent `@duetfs`/`@duet` to the owned `@duetso`)
→ image build → **api cut** (heartbeat/anchors removed, `/v1/vm/sync` live) →
versionPins purge → post-purge Convex deploy → unpause.

**Bugs the cutover surfaced and fixed (all now on staging):**
- `versions.image` was pinned to `ExactSemverSchema` but the provisioner sends
  `DUET_IMAGE_VERSION=<ghcr digest ref>`; every sync 400'd, starving persistence
  until the 2-min staleness cron flipped fresh workspaces unhealthy. Fixed:
  `image` is `z.string().min(1)` (identity ref, not semver). This was caught by
  the post-cut e2e gate, root-caused via the gateway journal on a kept debug VM.
- `staging-e2e-synthetic` runner imported `stagingLiveLegsPassed` from the wrong module
  (dropped re-export); docs sitemap pin was stale (missing file-activity,
  mirror-devices, sync pages). Both fixed.
- `verify-image.ts` rail probe used `readlink -f` (followed to the entry file);
  fixed to single-hop `readlink`.

**Reprovision / fresh-provision timing:** the staging fleet was empty at cut
time (no blackout, no cron freeze needed). Fresh provision through the new rail
reaches `active` in ~35s (e2e `workspaceActive` step), well under the 120s
kill-criterion.

**Incident drills on a live staging VM (image 7b8a11f8), all self-healed:**
- Helper deletion → `gateway_release_bootstrap status=repaired`, helper.js
  restored hash-verified.
- Helper kill → gateway PID unchanged (survived), helper respawned (containment
  works; slice 01).
- Fresh crashing release (`badcafe0drill`, no prior marker) → 3 crash cycles →
  `rolled_back` to previous → `healthy` → `quarantinedVersion` recorded. The
  2026-07-15 incident, replayed, ending in autonomous recovery.
- Manual agent downgrade 0.2.2→0.2.1 → `cli_reconcile status=applied` pulled it
  back to 0.2.2 (rail corrects drift, not just planned pushes).
- Pause + downgrade → drift held across ~45s of polls; unpause → converged to
  0.2.2 within one window.
