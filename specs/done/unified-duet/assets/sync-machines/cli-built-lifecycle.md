# Built sync lifecycle receipt

The new `packages/duet/test/sync-cli-lifecycle.test.ts` invokes the actual
`packages/duet/dist/cli-entry.js` produced by the existing `bun run build`.
Its source composition was copied from the root slice 05 WIP after 43e880d12;
these temporary production copies are excluded from the focused test commit.
The test takes no browser or desktop focus and does not touch the user's home,
launchd services, credentials, or mirrored files.

## Boundaries and outcomes

The ordinary executable is run as a child with scratch HOME and an isolated PATH.
A loopback HTTP listener validates the real account-registration body using the
contract schema and requires the saved human login. A fake external `launchctl`
executable models loaded/unloaded state. A deterministic external Syncthing
executable runs through the existing DUET_SYNCTHING_BIN override; each generation
writes different certificate/key bytes using its unique scratch home, so an
unintended regeneration would fail the persistence checks. Production registration,
config loading/saving, plist generation and deletion, status parsing/formatting,
command dispatch, output and exit handling all run normally.

Observed: cold JSON status, JSON install, human reinstall, JSON and human status,
JSON uninstall, repeated JSON uninstall, and human no-op uninstall all exit 0.
Installation writes the canonical machine ID, preserves the human key/origin/default
workspace, and points the plist at the same built CLI with `sync daemon` arguments.
Reinstallation reuses the certificate and key. Uninstallation removes only its
plist and modeled loaded service, preserves identity/config/mirrored file bytes,
and leaves an unrelated LaunchAgent untouched.

The fake launcher does not start a daemon. The status file is a fixture at the
daemon's filesystem boundary; these results prove its presentation, not daemon
liveness, OS login-time scheduling, or byte convergence. Native engine evidence
lives in [cli-native-probe.txt](cli-native-probe.txt), described by
[cli-review.md](cli-review.md). This test uses the normal development bundle;
the parent owns installed public tarball acceptance and live staging closeout.

## Review and gates

write-tests tracer: wrote one lifecycle journey, removed only sync registration
from an isolated temporary source copy, rebuilt the CLI, and saw the first status
invocation exit 1 with `Fatal: Unknown option: --json`. Restored registration and
rebuilt; the full lifecycle passes. No root source or new production hook changed.

Shape/diff/docs review: one story drives the outer executable and observes output,
files and the external service state. The fixtures stay at HTTP/process/filesystem
edges; there is no second production registry or command parser. Outputs are retained
below without user credentials. Every child exits (bounded timeout), the server
stops, and scratch HOME is removed on success or failure. The contract and README
continue to own product behavior; this receipt records the bounded evidence.

Gate: 1 test, 41 assertions, 0 failures. Changed-test lint and formatting pass;
owning public CLI type check passes after copying its already-migrated root tests
into the temporary checkout. Initial type diagnostics were from stale baseline
re-export imports/login fixtures, not the new lifecycle test. No broad root suite
or live operation ran. Configured Codex CLI review remains unavailable; this
receipt is the owner's review, not a claim of a separate Codex CLI pass.

## Source inputs

- `packages/duet/src/cli.ts`: `9aba5bb976c3e31db216386f985360b3eb153add172fa73ebe8845b0d0c42dc1`
- `packages/duet/src/cli-entry.ts`: `feef5b8cf21d327a7828bb8b0cbc064a1bc92786752ddc19fcb678715615bc7b`
- `packages/duet/src/config.ts`: `76ea8ce6bc839ada6c376de036480276353c883a73d26b8e7cf89368ed087366`
- `packages/duet/src/cli-support.ts`: `6e08c228cef63771f2a2fcaab7c9d6e51ef2808ea7b5b1d7435ccedf3c966df5`
- `packages/duet/src/sync/run.ts`: `d5d22c5bce4a1cb9438357e4e42bf6b25193683cc752329cea5e1a58a7905b85`

## Missing registration: red

```text
bun test v1.3.14 (0d9b296a)

test/sync-cli-lifecycle.test.ts:
45 |     const [exitCode, stdout, stderr] = await Promise.all([
46 |       child.exited,
47 |       new Response(child.stdout).text(),
48 |       new Response(child.stderr).text(),
49 |     ])
50 |     expect(exitCode, stderr).toBe(0)
                                  ^
error: Fatal: Unknown option: --json


Expected: 0
Received: 1

      at run (/Users/synthetic-user/.codex/worktrees/unified-cli-sync/duet/packages/duet/test/sync-cli-lifecycle.test.ts:50:30)
      at async <anonymous> (/Users/synthetic-user/.codex/worktrees/unified-cli-sync/duet/packages/duet/test/sync-cli-lifecycle.test.ts:98:30)
(fail) the built sync CLI installs, reports status and uninstalls without losing login or mirrored files [849.87ms]

 0 pass
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [898.00ms]
```

## Restored build: green command transcript

```text
bun test v1.3.14 (0d9b296a)

test/sync-cli-lifecycle.test.ts:
[
  {
    "args": [
      "duet",
      "sync",
      "status",
      "--json"
    ],
    "exitCode": 0,
    "stdout": "{\"ok\":false,\"running\":false,\"workspaces\":[]}\n",
    "stderr": ""
  },
  {
    "args": [
      "duet",
      "sync",
      "install",
      "--json"
    ],
    "exitCode": 0,
    "stdout": "{\"ok\":true,\"machineId\":\"fixture-mac\",\"label\":\"so.duet.sync\",\"plist\":\"/var/folders/3p/k21gnpt573b8yy45xvy27nd00000gn/T/duet-sync-cli-1S80DW/Library/LaunchAgents/so.duet.sync.plist\",\"syncthing\":\"v2.1.2\"}\n",
    "stderr": ""
  },
  {
    "args": [
      "duet",
      "sync",
      "install"
    ],
    "exitCode": 0,
    "stdout": "Installed so.duet.sync (Syncthing v2.1.2).\nThe mirror runs at login and starts now. Check it with 'duet sync status'.\n",
    "stderr": ""
  },
  {
    "args": [
      "duet",
      "sync",
      "status",
      "--json"
    ],
    "exitCode": 0,
    "stdout": "{\"ok\":true,\"running\":true,\"version\":1,\"updatedAt\":1791091219321,\"daemonPid\":123,\"workspaces\":[{\"slug\":\"studio\",\"state\":\"up-to-date\",\"localDir\":\"/var/folders/3p/k21gnpt573b8yy45xvy27nd00000gn/T/duet-sync-cli-1S80DW/duet/studio\",\"connected\":true,\"needBytes\":0,\"remoteCompletion\":100,\"conflicts\":0}]}\n",
    "stderr": ""
  },
  {
    "args": [
      "duet",
      "sync",
      "status"
    ],
    "exitCode": 0,
    "stdout": "studio  up to date       /var/folders/3p/k21gnpt573b8yy45xvy27nd00000gn/T/duet-sync-cli-1S80DW/duet/studio\n",
    "stderr": ""
  },
  {
    "args": [
      "duet",
      "sync",
      "uninstall",
      "--json"
    ],
    "exitCode": 0,
    "stdout": "{\"ok\":true,\"label\":\"so.duet.sync\",\"wasLoaded\":true}\n",
    "stderr": ""
  },
  {
    "args": [
      "duet",
      "sync",
      "uninstall",
      "--json"
    ],
    "exitCode": 0,
    "stdout": "{\"ok\":true,\"label\":\"so.duet.sync\",\"wasLoaded\":false}\n",
    "stderr": ""
  },
  {
    "args": [
      "duet",
      "sync",
      "uninstall"
    ],
    "exitCode": 0,
    "stdout": "so.duet.sync was not installed; nothing to do.\n",
    "stderr": ""
  }
]
(pass) the built sync CLI installs, reports status and uninstalls without losing login or mirrored files [1720.67ms]

 1 pass
 0 fail
 41 expect() calls
Ran 1 test across 1 file. [1.77s]
```
