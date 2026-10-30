# Mac sync CLI review receipt

Source checkpoint: 667840376 in the managed unified-cli-sync worktree. The sync source, stock generated-config XML fixture, and its two scripts moved from packages/duetfs into packages/duet; Git retains their original source. No Mac migration, alias binary, second login, or grant parser was introduced.

Wire contract (superseded below): the initial pass POSTed name, Syncthing peer ID and optional cached machineId. The account-switch correction below removes that redundant input. The returned machine ID remains saved in canonical config. Workspace registration and remint POST machineId plus that same peer to /v1/ws/:slug/mirror-devices. The daemon reads existing account machines and current whoami permissions; it never POSTs account registration. It derives eligible mirrors from the backend's files:write projection, rather than duplicating the membership policy.

Shape review: One Mac identity owner, one canonical user-config owner, existing per-workspace transfer processes and tunnel framing. Removed stale credential-as-machine comments and duetfs labels. Launch agent label is so.duet.sync; packaged script paths use dist/cli-entry.js. Removed the old daemon fetchWorkspaces override, whose only callers were tests; all daemon cases now exercise actual account-list/whoami payloads through the HTTP boundary. Existing injected process, clock, filesystem, and transfer boundaries remain their actual owners.

Diff/lifecycle review: Machine removal stops all local mirrors and does not auto-register. A restored account machine can resume. Lost membership or writable permission drops only its workspace. A workspace 404 stops its failed mirror, preserves the other workspace, and resumes after backoff. A transient poll failure preserves the live handle. Auth loss stops handles and clears connected status. Explicit activation's final save rereads current config to preserve concurrent user-key changes. Failed initial registration now stops the Syncthing process that had already been started.

Red/green evidence: machineId missing/wrong mirror request; missing copied certificate before config generation; removed account machine leaving both mirrors alive; terminal remint refusal leaving the bridge open; conflicting target reaching binary resolution before usage refusal. Additional falsification: old captured daemon key/origin fails replacement assertions; ignoring whoami's writable projection starts the viewer workspace and fails the actual HTTP-backed behavior case. Restored source is green.

Final gates: 68 sync tests passed across 12 files, 0 failures; owning package check-types passed with the parent-supplied ESNext/Bundler configuration and FetchLike context; scoped lint, formatting, and git diff checks passed. Exact test transcript is retained beside this receipt. No root test run or live resources were used. The parent owns complete built-entry dispatch, public packaging, release and staging journeys; this pass does not claim those final integration gates.

Real engine proof: the moved release script downloaded official Syncthing v2.1.2 macOS arm64/x64 archives, verified archive/executable hashes, staged both packages, and npm dry-run-packed each with its binary. No publication happened. The moved scratch probe ran real stock Syncthing peers and the shared WS framing. It proved two workspace homes share a Mac certificate/peer ID, bidirectional convergence, symlink transfer, git/dependency ignores, reported conflict copies, token remint, kill-9 recovery, clean closure, and registration404 cleanup. Its complete credential-free transcript is retained. The scratch directories and child processes were removed; no developer sync state was used.

Docs review: package README links down to src/sync/README.md, which states identity/process/lifecycle principles and links the moved stock-engine notice. This receipt and cli-choices.md are pass-local evidence; the parent owns the canonical plan/handoff and global choices ledger. Codex CLI review was already unavailable under the supported account default; no installation or model workaround was attempted. TUI/browser presentation was unchanged.

## Account-switch correction

The final account-registration request is `{name, syncthingDeviceId}`. The
existing authenticated-user/peer index owns row selection. The CLI saves the
returned ID for workspace mirror registration and tunnel attribution. Removing
the cached ID deletes the alternate database lookup, its mismatch/missing-row
refusals, and the now-unreachable account-route 404 mapping.

Review checked new-account activation, same-user retries, explicit restoration,
removal of one account's row without affecting the other account on the same
Mac, and preservation of the certificate and canonical key/origin/default
workspace. No new product restriction, persisted field, endpoint, dependency,
credential cache, or compatibility parser was added. The published resource guide
already describes registration by name and peer; the contract's endpoint registry
consumes the updated request schema directly. Source README and slice 04 now
state the same ownership rule.

Red/green: the cached-foreign-ID command regression failed with the original POST
and passes with the new account's ID persisted. Raw HTTP validation accepted the
removed optional field before the schema change and rejects it afterward. The
two-user model case was falsified by selecting the peer without its user: the
second user incorrectly received the first user's ID. Restoring the indexed
owner query passes. Durable transcripts are in cli-account-switch-tests.txt.

Gates: 69 sync tests, 6 account-contract tests, 6 sync-model tests and 2 real API
route tests pass. Agent declaration generation, Duet, contract, backend and API
type checks pass; changed-source lint and formatting pass. Consumer type checks
initially exposed a fresh-worktree setup diagnostic at agent resolve.ts:106;
building the owned core declarations with its existing check-types script fixes
the setup without modifying agent source. No full root suite or live resource
writes occurred. Root owns the joined CLI packaging and staging closeout.
