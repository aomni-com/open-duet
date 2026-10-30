# Slice-11 watcher-integration E2E

Run: 2026-07-13T05:40:26.795Z on VM `duet-test-attribution-e2e-20260713t053926-c49s` (deleted after capture).
Kernel `6.12.93`, Bun `1.3.14`. Path under test end to end: real kernel
events → `helper-main.ts` → `actor-resolver.ts` → `pipeline.ts`, asserting on
the attributed `DriveFileEvent`s the pipeline relays (captured via a stub fetch).

## Exactly-once + attribution assertions

| # | Assertion | Observed | Result |
| - | --------- | -------- | ------ |
| A | agent-session write → `session:e2e1` (create+write pair) | `{"kind":"create","actor":"session:e2e1","path":"e2e/sess.txt"}`, `{"kind":"write","actor":"session:e2e1","path":"e2e/sess.txt"}` | PASS |
| B | terminal (non-cgroup) write → `terminal` | `{"kind":"create","actor":"terminal","path":"e2e/term.txt"}`, `{"kind":"write","actor":"terminal","path":"e2e/term.txt"}` | PASS |
| C | session read attributed; terminal read dropped (Q1) | read `{"kind":"read","actor":"session:e2e1","path":"e2e/sess.txt"}`; terminal-reads-dropped=0 | PASS |
| D | proxied PUT **exactly once** — gateway-pid watcher write dropped (L9) | watcher events=0, raw helper frames=0 | PASS |
| E | share-synced edit **exactly once** — syncthing-pid watcher write dropped | watcher events=0, raw helper frames=0 | PASS |
| F | restore → one `system` event, zero per-file storm (L6) | storm=0, restore=`{"kind":"restore","actor":"system"}` | PASS |
| G | symlink ops attribute best-effort (open-less `ln`/`rm`→terminal, boundary), never wrong, path always correct | `{"kind":"create","actor":"terminal","path":"e2e/link1"}`, `{"kind":"rename","actor":"session:e2e1","path":"e2e/link2"}`, `{"kind":"delete","actor":"terminal","path":"e2e/link2"}` | PASS |

Telemetry after the run (L12): droppedReads=0, overflow=0, cgroupMisses=2, helperRestarts=0. Clean shutdown exit=0.

Verdict: **GREEN** — the wired path attributes agent execs to their session, terminal writes to `terminal`, drops unattributed reads, and each of the gateway-pid (proxied PUT) and syncthing-pid (share sync) writes produces zero watcher events so the semantic event is the sole record; restore collapses a 20-file storm to one event; symlink ops attribute best-effort per the slice-09 open-less boundary (open-less `ln -s`/`rm` degrade to `terminal`, never a wrong session, path always correct).
