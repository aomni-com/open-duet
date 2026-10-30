# Cutover — staging

> **Superseded by [Finish it](#finish-it) at the bottom.** The renames below
> landed via the session-vertical clear; what remains is the *schema-audit*
> field strip, which the same runbook shape covers with a committed script.

**Status: HALF EXECUTED.** The data step ran; the deploy did not — `convex
import` was allowed by this environment's permission classifier and every deploy
command (`convex deploy`, `convex dev --once`) was refused.

**Done:** `agentSessions`, `agentSessionEvents` and `agentSessionRelayReceipts`
cleared on `chatty-llama-452`. The admin and official-hub seed survived, which is
the whole reason the wipe was narrowed to the session vertical.

**Left:** one deploy per environment. Both are one command; see
[Finish it](#finish-it). Staging currently sits in a safe intermediate state —
the *old* schema is still deployed and there are no session rows for it to
disagree with.

**Read [the incident](#incident-a-deploy-went-to-production) before running
anything.**

---

## What the slice got wrong, and it is not a detail

Slice 13 specifies `convex export` → transform → `convex import --replace-all`.
**That sequence cannot converge.** Convex validates an import against the
**deployed** schema, not against the one in your working tree:

- New-shaped rows (`turnStatus`, `bucket`) are rejected while the old schema is
  live — *"Object is missing the required field `status`"*.
- The new schema cannot deploy while old-shaped rows are live — the deploy's own
  validation rejects them.

Measured, both directions, against `chatty-llama-452`. There are exactly two
ways out, and the slice only anticipated the second:

1. One deploy with `schemaValidation: false` in `defineSchema`'s second
   argument, then the import, then restore the file and redeploy. The final
   redeploy is what actually proves the migrated data satisfies the real schema.
2. Clear the blocking rows first, then deploy normally.

**(2) is the chosen route** (Example User, 2026-08-07), narrowed from "wipe staging" to
"clear the session vertical" — `agentSessions` is the only table whose shape
blocks the deploy, so the admin and official-hub seed survive and no re-seed
runbook is needed.

## The float64 landmine

Convex exports a float64 as `1785947866913.0`. **`JSON.stringify` drops the
`.0`**, which retypes the value as int64, and the schema rejects it:

```
Path: .createdAt   Value: 1785947866913   Validator: v.float64()
```

The first transform was three lines of `JSON.parse` → rename → `JSON.stringify`
and silently corrupted every timestamp in all 7 rows. The schema caught it and
the import aborted with staging untouched.

Any future transform of a Convex export **must preserve number spelling
byte-for-byte**. The working version parses with a raw-number hook and
re-serialises manually; verification was 54 number literals identical before and
after, and 0 semantic mismatches.

## Snapshot taken

| | |
| --- | --- |
| deployment | `chatty-llama-452` (dev-slot deployment named `staging`) |
| export (no storage) | sha256 `a183b68e425e923339166ece32d0a75db0b58b66dd5aa24a1c34847c3b8879d6` |
| export (with storage) | sha256 `848d724840d5effdba1f0ccc4a8ac8f7fc0b3e2843bf65afc6e035eeec7a15c1` |
| stored files | 187 |
| tables | 72 |

The second export exists because the first had no `_storage` directory, and
`import --replace-all` of a storage-less snapshot risks the stored files.

## What the data actually needs

Measured on the export, not assumed:

| rename | rows affected |
| --- | --- |
| `status` → `turnStatus` | 7 of 7 |
| `startMode` → `requestedMachine` | 2 of 7 |
| `stateMachine` → `machineState` | 0 — the column is not present in any row |
| `relaySummary` → `machine` | 0 — same |

Backfilled `bucket`, computed by importing `bucketOf` from `@repo/contract`
rather than reimplementing the rule:

| bucket | rows |
| --- | --- |
| `asking` | 1 |
| `done` | 6 |

`workspaceMembers` needs **nothing**. Slice 08 dropped `sessionsReadFloorAt`; the
read floor is `membership._creationTime`, which every row already has. The slice
text still lists that column — it is stale.

## Runbook

Superseded by [One command](#one-command). The first half of this cutover — the
renames and the session-vertical clear — is already done; what the script now
carries is the schema-audit field strip and the two deploys.


## Incident: a deploy went to production

`convex deployment select staging` sets the **dev** deployment. `convex deploy`
ignores it and always targets **production**. The CLI prints a reassuring
`✔ Selected deployment: … staging` and then deploys somewhere else.

On 2026-08-07 this branch's functions and schema were deployed to
`elated-hippopotamus-235` (production) with `schemaValidation: false` still set
from step 1 of the validation-off route.

**Impact, verified by reading production afterwards:**

- `agentSessions`: **0 rows**. `oauthAuthorizationRequests`: **0 rows**. Those
  are the only two tables this branch changes destructively, so the new schema
  is in fact compatible with production's data.
- No data imported, deleted, or altered. The admin and official-hub seed are
  intact.
- Production is running unmerged branch code, with schema validation **off**.

**Outstanding.** Either redeploy production from this branch with the real
schema (validation returns to on; production's data already satisfies it), or
roll back to `acc41ac9`. Both need `convex deploy`, which is blocked here.

**The rule this cost us:** to deploy to a non-production Convex deployment, use
`convex dev --once`. `convex deploy` means production, always, regardless of what
`deployment select` last printed.


---

## Done (2026-08-08)

Both deployments carry the full schema, validation on. Staging via `convex dev
--once`, production via `convex deploy`.

### What actually worked, and what did not

The first route was `export → transform → import --replace-all`: ~800MB moved
through disk twice, including 188 stored files, to delete two keys off 32 rows.
It was slow, and it failed twice before working —

1. **`JSON.stringify` corrupts a Convex export.** A float64 is written
   `1785947866913.0`; `stringify` drops the `.0`, retyping every timestamp as an
   int64 the schema rejects. Fixed by rewriting the raw JSONL textually.
2. **An empty table must stay a zero-byte file.** Writing `'\n'` for one gives
   Convex a blank first line and the whole import dies with *"Row 1 wasn't valid
   JSON: EOF while parsing a value at line 2 column 0"*. Nothing caught it until
   a real import: a table with no rows has nothing to compare, so a row-level
   verification passes on a corrupt file.

**The whole approach was unnecessary.** `convex import --table X --replace`
**preserves `_id`** — measured on 32 staging workspaces, every id identical
before and after. The belief that it reminted ids was an assumption, never
checked, and it is what justified the whole-snapshot route. One table at a time
is seconds, touches nothing else, and cannot endanger file storage.

[`strip-fields.mjs`](./strip-fields.mjs) is that: export one table, cut the
fields textually, `--replace` it back. `creditTransactions` was cleared outright
rather than patched (Example User's call — the ledger is disposable pre-launch).

### What was applied

| deployment | table | change |
| --- | --- | --- |
| staging | `workspaces` | dropped `lastActivityAt`, `acceptedActivityGeneration` (32 rows) |
| staging | `creditTransactions` | cleared (191 rows) |
| staging | `agentSessions`, `agentSessionEvents`, `agentSessionRelayReceipts` | cleared earlier, for the renames |
| production | `workspaces` | dropped `lastActivityAt`, `acceptedActivityGeneration` (2 rows) |

Production's `agentSessions`, `oauthAuthorizationRequests`, `gatewayGenerations`
and `usageRollups` were all empty, so nothing else needed touching.

### Closeout gate

```bash
bun run e2e:staging -- --journey session-buckets
```

**Never** the bare `bun run e2e:staging` — ~60 minutes and real staging
resources.
