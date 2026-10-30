# Helper supervision lifecycle (slice 10)

Date: 2026-07-13

## Verdict

works: the real supervisor spawns the helper, restarts it after SIGKILL, and leaves no orphan on stop.

The VM-side driver imports the PRODUCTION `createHelperSupervisor` + `spawnHelperProcess`
(bundled by absolute-path import) and manages the PRODUCTION `helper.js` bundle, run under a
real systemd transient unit (`systemd-run --unit=duet-helper-probe`). Reproduce with
`packages/exe/scripts/probe-image-systemd.ts` (`runHelperLifecycleProbe`). VM tagged
`duet-test`, deleted in `finally`.

## Evidence

```
vm=duet-test-helper-supervision-20260713t050027-mqs3
systemd-supervised=true
ready=true                     # helper reached `ready`; protocol v1 matched
firstHelperPid=404
sigkilled=true                 # pkill -9 -f helper.js on the running generation
restarted=true (helperRestarts=1)
secondHelperPid=419            # a fresh generation, distinct pid
orphanAfterStop=false          # supervisor.stop() left no helper process behind
```

## Supervisor log + unit teardown

```
SUP:{"event":"helper_restart","helperRestarts":1,"backoffMs":200}
Running as unit: duet-helper-probe.service; invocation ID: d5c9962e08224c2abd79ca2f8b73baac
Finished with result: success
Main processes terminated with: code=exited/status=0
Service runtime: 648ms
Memory peak: 1.0M
```

## What this covers vs. the unit tests

- Live on a real VM: fresh start → `ready`; SIGKILL-helper → supervised restart within the
  backoff window; clean stop → no orphaned root helper.
- Release-artifact swapping (index.js + helper.js + `helperSha256` manifest, atomic install,
  helper-hash-mismatch aborts the whole update) is covered by the `gateway-update` and
  `gateway-release-build` unit tests; it needs no VM.
</content>
