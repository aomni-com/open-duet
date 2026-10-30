# Agent runtime

This private workspace owns Duet's turn runner, resumable state, memory,
routing, connected-provider transports and workflow evidence. Hosts own
persistence and scheduling; the runner owns the work performed during a turn.
The public command composition and terminal UI belong to
[duet](../duet/README.md).

Protocol types have their own export. Train imports the isolated memory-store
export so filesystem memory does not pull the runner or terminal UI into its
process. The core never imports the CLI or HTTP contract.

Duet model traffic carries one process-selected billing workspace alongside
its routing tier. Hosts supply `DUET_WORKSPACE` before model resolution; the
shared gateway header owner keeps secondary requests on that same target.
An absent selection stays absent so bound VM credentials retain their own
workspace, while human-key selection requirements remain with the gateway.
Direct model generation through Duet retains the workspace and omits the routing
tier, so selecting a compound does not claim its tariff. Requests to providers
outside Duet carry no Duet billing selection. Shared SDK media generation owns
only the request and returned bytes; hosts select defaults and persist outputs.

The imported source and dependency closure are pinned by the
[source reference](../../specs/done/unified-duet/assets/source-reference.json).
Tests, evals and benchmark fixtures remain maintained inputs, including their
historical result records. Live evaluations require deliberate invocation.

Use this workspace's build, check-types and lint scripts. File-writing tests
and evals use the disposable root container runner through this package's test
and eval scripts; pass a focused test path or filter after --. Default test
suites use host-native Linux containers and isolate files in separate processes
with empty stdin, keeping native renderer state and terminal reads away from
later memory or subprocess tests. The root lockfile and Pi patch own
dependency installation.

Runtime design principles: files and commands remain the tool boundary; state
lives in memory and durable snapshots survive between processes; the agent
chooses state-machine transitions. Existing memory paths, routing policy and
provider behavior are preservation contracts, not cleanup opportunities.

The shipped virtual-model routing rationale lives in
[specs/done/model-router/README.md](specs/done/model-router/README.md).
