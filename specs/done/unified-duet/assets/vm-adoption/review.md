# Adoption helper review

The complete helper and job owner received an independent read-only Codex review.
It found that pre-layout recovery depended on daemon reload before resuming the
frozen original process. The actual systemd red probe retained the frozen PID;
the correction resumes that pinned process in finally after mutators are fenced.
The green probe resumes the same PID while retaining an honest recovery-failure
record and a matching platform settlement.

A separate repeated-process-crash drill exposed unconditional reset-failed on a
unit that systemd had already unloaded. The stop owner now observes actual state,
resets only a failed unit and then verifies inactive/MainPID zero. The corrected
crash drill restores the original layout and memory after target quarantine.

An independent follow-up review of both corrections found no actionable defect.
The seven narrow behavioral tests, helper/import type closure, formatter and
linter passed. Disposable process/cgroup proofs complement those tests; they do
not replace the physical runtime, new image or live staging gates owned by the
parent implementation.

A safely deferred live canary exposed a census assumption that the container's
PID namespace had hidden: kernel thread environments return ESRCH even though
their process entries remain present. Read-only diagnosis found 187 such errors,
all with kernel parents; no service or credential state was changed. The census
now establishes command/topology ownership before requesting environments.
Unrelated services and kernel threads cannot obscure gateway work, while unknown
gateway-tree, gateway-cgroup or possible detached RPC environments still defer.
The new tracer earned red/green, eight tests and 22 assertions passed, and a
focused independent review plus twelve additional scratch checks found no defect.

Certification review found that a refresh completing near the deadline could
certify the runtime but be followed by a sleep crossing that deadline. The helper
now immediately re-reads authoritative matching-version health after refresh
completion. Its regression earned red when that observation was removed and green
when restored. A follow-up identified a real-timer race in the test; the final
tracer advances only the external platform clock/sleep and restores both overrides
before cleanup. Independent final review found no determinism or isolation defect.
The real five-minute-idle systemd drill certified without changing probation or
release bytes, and supervisor death during refresh restored the original layout.
