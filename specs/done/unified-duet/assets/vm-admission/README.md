# First-adoption admission research

The old gateway has no externally callable maintenance gate covering agent,
Train and backup starts. Quiescing interrupts turns; blocking new TCP connections
does not block requests on existing keepalive connections or autonomous wakes.
These bounded probes establish a possible process-level cut, not a completed
VM migration. The remaining adoption/rollback/boot certification gates stay in
[slice 07](../../README.md#preserve-existing-machines-and-work).

## Evidence and limits

[receipt.json](receipt.json) records the frozen source and both live deployment
source-tree identities. The entire gateway and systemd trees are identical across
those three revisions. Read-only SSH confirmed the staging hub's actual service
has the original kill behavior and no watchdog. No live VM was changed.

The two frozen test excerpts reuse the original gateway and Train test fixtures;
they are appended to those files in a private source archive, not a replacement
test harness. [runtime-green.txt.gz](runtime-green.txt.gz) contains the Linux
run: 2 tests, 20 assertions. SIGSTOP stops every Bun main-process thread, while
accepted agent input, a Train job and a backup remain visible in durable state.
A fresh logical Train request cannot be admitted until SIGCONT. A second probe
holds the real Train route before its runner starts: the persisted snapshotting
phase already makes the production busy predicate true despite no child PID.
External runner/Train/backup responses are controlled; this is admission
evidence, not model or archive quality evidence.

[systemd-green.txt.gz](systemd-green.txt.gz) uses native ARM systemd with the
original unit's restart/kill configuration and substituted fixture executable,
user and paths. A stopped main PID remains active past RestartSec; its child
continues running. systemd provides no automatic rescue for a lost controller.
[guardian-green.txt.gz](guardian-green.txt.gz) shows an independent bounded
guardian survives controller SIGKILL and resumes the same PID, checking its
process start time. It does **not** prove final-cut coordination with a migrator.

Normal systemd stop sends SIGCONT after its initial signal, as the
[upstream kill contract](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.kill.xml)
specifies: queuing a stop and then killing the frozen PID leaves a resume gap.
The tested alternative installs
a temporary runtime drop-in selecting SIGKILL before freezing. The stop never
resumes the main process, suppresses automatic restart, and ends with MainPID
zero. Resetting the failed-unit marker yields inactive; removing the drop-in
and reloading restores the original signal. See
[kill-first-green.txt.gz](kill-first-green.txt.gz). All systemd probes ran in a
disposable Ubuntu container, not a complete old Duet image.

## Contract the migration must still prove

Stage and verify the target before the cut. One bounded remote owner must
coordinate the freeze, complete durable/process census, stop and recovery.
Controller loss cannot leave a frozen gateway, and a guardian cannot resume
admission concurrently with the committed stop. Busy, unreadable or ambiguous
state resumes the old process immediately and defers without changing boot
wiring. Stop the service with kill-first semantics only after a conclusive idle
census; mutate boot wiring only after the old process is gone.

Use the production agent ledger fold on a private copy: terminal events may be
in relay journals rather than the base envelope. Accepted commands, due wakes,
every nonterminal Train phase and capturing backups are protected work. Future
wakes must survive and re-arm. Check owner-marked RPC processes across all of
/proc and the separate runner cgroups, whose placement is best effort. App
servers and the attribution helper are normal long-lived service children;
rejecting every descendant would prevent migration of ordinary workspaces.
Existing app ownership markers and validated app anchors distinguish their
trees; unknown transient children remain a deferral, never an excuse to kill.

The compressed systemd scripts are frozen research references corresponding to
the receipt's hashes. The bounded guardian reference deliberately does not
implement a migration transaction or resolve its final-cut race.
