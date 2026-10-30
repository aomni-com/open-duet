# Existing-VM adoption evidence

The transition evidence uses a bounded systemd job whose private recovery
program survives host disconnection and process death. Systemd removes the job's
mutators before recovery; a matching settlement record proves that ownership has
ended. A receipt by itself cannot authorize deleting a host transfer.

The original gateway is frozen only after payload staging. Its production agent,
Train and backup ledgers, process group and runner cgroups determine whether work
is idle. Unknown work defers. The gateway service stops with kill-first semantics
before boot layout changes. No provider restart, VM reboot, disk replacement,
desktop stop or Syncthing stop occurs.

The held target proves its CLI, memory store and real boot probation before a
durable commitment allows ordinary admission. Once committed, recovery cannot
restore the old layout or stop an open gateway. Completed reruns independently
check the installed bytes and preserve the gateway process. The existing runtime
release manager remains the only installer and repair owner.

## Scope of this drill

The disposable fixture runs real Ubuntu 24 systemd and the frozen production-old
gateway source. Its exact old unit is the read-only staging-hub unit captured in
`old-gateway.service.reference.gz`, including workspace Bun 1.3.14 and an absent
isolated gateway runtime. The old npm agent CLI is 0.3.36; its real memory database
contains the record shown in the receipts. The unused duetfs command is an inert
version-only fixture. Every credential and data marker is synthetic.

The new eight-artifact release is the frozen held candidate
`0.0.0+0aac13839e00a21e0972783346f82bb2c4286e5f748089c5aae95f9faab78fb2`.
Its stable bootstrap and gateway-only Bun 1.4.2 come from the already verified
image owner. No release bytes are rebuilt or mixed for these drills. The locally
bundled old gateway has version `0.0.0+01212abf6ba1`; this is source-equivalent to
the live baseline, not a claim that its bundle equals the live build's bytes.

The kernel/systemd fixture is ARM with x64 Bun/native CLI running through Rosetta.
Gateway service, cgroups, production ledgers, memory, sync and certification run
for real. Fanotify attribution fails under this emulation, so these receipts do
not certify that native x64 subsystem. The separate physical-runtime and image
checks remain required. The boot ID belongs to the disposable Docker kernel;
equality proves this drill never rebooted it, not that an existing VM was touched.

`success.json` covers the full transition and actual probation; `noop.json`
retains the same open MainPID. Parent death while frozen and during certification
kills all job mutators, then resumes or restores the original runtime. The missing
current index repairs from a separately verified local copy when the fixture API
returns no manifest. Repeated held gateway process deaths cause quarantine and
restore the old runtime with the existing memory record intact.

The reload-failure red probe reproduces the independent review's frozen-process
bug. Its green receipt deliberately reports recovery failure: the same original
process resumes even when daemon reload fails. This prevents permanent freezing
without concealing failed wiring restoration. The interrupted-install receipt
covers parent loss before installation completes. The reference probes are
compressed evidence scripts, not a second migration implementation.

Private original and recovery copies retire only after both current and previous
are certified strict ordinary releases and every platform job and transfer has
settled. The [closeout gate](../../README.md#preserve-existing-machines-and-work) owns that boundary.
Transfer inputs never become active boot paths or an ongoing delivery service.

[Host controller proof](host/README.md) records inventory and transfer ownership
separately from the disposable in-VM systemd evidence.

## Final host boundary

`host-systemd-green.json` runs the actual host controller through archive creation,
SCP, Exedev SSH commands, the final committed helper, systemd launch, real target
certification, settlement and transfer deletion. Only external account and
transport edges map to the disposable Docker fixture. The before-state identifies
a running old gateway, its npm CLI and the absent isolated Bun. A second complete
controller run preserves the same open gateway and removes its own transfer.

The permission red record shows why the host must use its existing sudo access
to read root-owned atomic receipts. Unsudoed reads falsely reported an unfinished
migration after the helper had completed. The archive red probe rejects changed
bytes before any helper launch and keeps the original gateway PID.

`host-boundary-receipt.json` binds the final helper commit, bundle hash and exact
corrected controller source. It also records a native probe timeout
observed in the emulated fixture during one repeat: recovery and host cleanup completed, the unchanged
standalone CLI subsequently passed, and the final full repeat passed. No gate or
timeout was relaxed. The compressed host fixture is historical reference evidence
for its recorded source revision.

[Staging adoption](staging/README.md) records actual existing-VM outcomes, separately
from the disposable constructor and systemd proofs.

## Certification with an idle control plane

The old API can direct an idle VM to sleep five minutes between syncs. Runtime
probation still needs three completed syncs and a minute of uptime, so passive
health polling cannot certify it within the bounded migration job. The certification proof
uses the existing authenticated roster-refresh route to run the actual sync
client and complete directive sink. Health remains authoritative; no marker,
threshold, payload or production timeout is changed. Health checks use a one
second cadence, explicit refreshes fifteen seconds, and process-stop waits keep
their short cadence.

`idle300-red.json` and `idle300-green.json` use the same frozen runtime, five minute
API polling directive and 75 second disposable certification cap. That cap exceeds
real probation; before the fix it restores an uncertified target after eighty
seconds of observed uptime, while the correction certifies at sixty-seven seconds.
`refresh-parent-loss.json` verifies recovery after an actual refresh request with
admission still held. The completed-refresh edge is observed immediately before
sleeping, so a late successful refresh cannot be missed just because a polling
sleep crosses the deadline. Its regression uses controlled platform clock/sleep.

[Effective boot-wiring regression](dropin-fix/README.md) records legacy drop-in
retirement and exact precommit restoration in the disposable systemd fixture.

The [production corrected-helper canary](production-fixed-canary/receipt.json)
records the existing VM adoption, effective launch wiring and unchanged OS boot.

The [corrected production fleet receipt](production-fixed-fleet/receipt.json)
keeps host outcomes separate from independently reconciled VM settlement and
records the remaining background-process deferrals.
