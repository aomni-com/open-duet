# Temporary VM lifecycle fence

This is the deployment bridge for the final unified-runtime inventory. It pauses
VM attachment and resize admission while existing workspace work continues. It adds no table,
column, lease, or recurring worker. `DUET_VM_LIFECYCLE_PAUSED` is read at admission.
Remove its config reader, admission branches,
and explicit replay mutation after both environment cutovers and deferred work
have settled.

The production-only `production.patch.gz` (decompress before applying) is independently applicable to the two recorded live
backend baselines. Their patched files match the tested feature source exactly.
Deploy that compatible backend before closing the fence; deploying the complete
feature backend first would change the old VMs’ control-plane contract.

## Closing and draining

Record the deployed compatible revision, then set the call-time config fence to
closed and retain the environment-write acknowledgement. Each admission mutation
reads the environment variable inside its transaction. The frozen Convex sources
in `env-transaction.json` establish that this read participates in its transaction
read set, so an old admission must commit before the edit or retry under the fence.
This platform proof is not a live cutover receipt.

Keep a complete before/after workspace and provider inventory. Attachment runs, disk-resize runs,
teardown runs, and capturing replacement operations are admitted work that must
settle. A provider create admitted before closure can finish and record normally;
a fence refusal at record would delete a VM that may already contain work.
An earlier teardown can retain an accepted subscription recovery without admitting
a new teardown. Its completion leaves the recovery backup pinned and the workspace
pending behind the same attachment scheduling fence.

A restoring recovery with no VM, residual VM state, attachment run, or teardown
run is deferred intent, not an outstanding provider create. Keep it in the replay
ledger. A newly created VM awaiting registration is still admitted work and must
not be mistaken for a deferred birth. Reconcile provider-only objects as well as
workspace attachments before declaring the old-image birth delta settled.

CPU and memory resizing uses an existing cron with platform execution state.
Drain its in-progress next-run state and separately scheduled nonterminal runs
using the indexed system seams in `cpu-drain.json`. Missing or unreadable state
cannot prove a drained sweep. New candidate reads return no work while closed;
already admitted actions finish their provider calls before that state settles.
The metadata receipts whitelist state and function identity, never cron arguments.

The alignment procedure performs no provider resize, reboot, or reprovision:
it updates files inside the VM and restarts only an idle gateway service.
Blocking ordinary lifecycle reboots protects that procedure from interference.

## Reopening

Set the verified image as the configured default before reopening admission.
Replay only explicitly inventoried accepted requests from the fence interval,
one workspace ID at a time, through the existing attachment request owner.
The replay verifies the configured image identity and rechecks lifecycle state;
it preserves recovery while using the new image. Historical VM-less provisioning
rows can be intentionally unserviced, so their status alone never admits replay.
Skipped or failed rows remain visible operational work. Deferred disk capacity stays
in the accepted billing plan. Reopening explicitly replays only affected payers
whose accepted upgrades were observed in the fence-interval ledger, through the
existing disk reconciliation owner. That owner applies the payer’s plan across
its workspaces. With no observed upgrade requests, make no disk replay calls;
this is not a fleet alignment resize or reboot.

`receipt.json` binds the source and narrow gates. The compressed red/green logs
retain the admission, destination selection, delayed create, and recovery-pin
counterexamples. No live deployment, environment edit, or provider mutation was
performed by this pass.

[Staging deployment](staging-deployment.json) records the compatible backport,
closed admission fence and paused runtime updates. Its complete plan is a
point-in-time drain observation; the controller repeats it before every cut.
Production remains on its original unfenced backend.
