# Stop settlement

An already interrupted checkpoint with no live runner, pending command, or wake must not be hydrated by a pause sweep. A missing bound root must not cause endless launch attempts merely to stop a runner that does not exist. Settlement must survive restart and preserve an explicit resume path.

Owner: gateway agent-session coordinator and ledger. Keep native execution state authoritative; record gateway-owned stop/delivery state separately when the runner cannot author an ending. Backend interruption projection must use its existing terminalization/discovery owner.

First red case: seed an interrupted unfinished relay checkpoint, pause repeatedly, and restart the controller. Assert no runner launches or turn_started events and no retry loop. Next prove absent-root settlement, transient failure handling, and pause/resume races. Tests use temporary directories and controlled process/network seams; no customer VM work.

Checkpoint reconciliation is a subsequent seam. Before implementing it, reproduce a late repair racing newer input and an autonomous wake with the same input cursor; choose an evidence-bearing conditional application contract.

Delegated decisions: internal helper names and test fixture organization. No automatic resumption or successful-completion inference is delegated.

Implemented with a gateway-owned stop cursor and an input-fenced durable system report. Native interrupt delivery remains distinct from local stop settlement: the latter returns an undelivered receipt so the API also consumes upstream queued input. Quiesce recognizes the durable local settlement and does not retry hydration. Regression review also required preserving observation retries across pause; launch gates stay enforced inside recovery callbacks.

The conditional projection seam is VM-authenticated GET/POST `interrupted-checkpoint`. It compares both backend event sequence and accepted input cursor and refuses pending input/archives. It runs without model execution, with bounded request timeouts and increasing retry delays. Native interrupted checkpoints from before this release are eligible when the evidence matches.

A repaired or gateway-settled ending also records its covered input cursor. That makes the canonical terminal visible to API waiters for that input, not merely to status/list readers. The repair's existing cursor fence is the authority for that coverage.
