# Staging adoption

The first existing-VM canary deferred when the work census encountered unreadable
kernel-process environment files. Its original gateway process remained running,
with identical boot, selected state, saved credentials, runtime credentials,
Syncthing process and workspace Bun. The compressed snapshots retain hashes and
metadata only, never credential or user-content bytes.

The corrected census permits the target to start. Its next attempt restored the
old layout because idle sync could not satisfy probation inside the adoption
deadline. [The receipt](canary-certification-restored.json) binds unchanged boot,
state and credential hashes; only the gateway process changed during restoration.
The old API permits a slower idle cadence than the bounded adoption job can wait
for. Certification must obtain real sync acceptance through the existing refresh
route, without fabricating health or relaxing probation.

The [corrected canary](canary-adopted.json) completed real health probation and
opened normally. Every runtime artifact matches the frozen manifest, the managed
CLI is1.0.0, and active npm/duetfs command paths are gone. Boot identity, selected
state and all credential hashes match; only the gateway process changed. The
[hub adoption](hub-adopted.json) and [fleet receipt](fleet-adopted.json) cover the
remaining VM and the canary’s process-preserving rerun. The hub’s personal
credentials, VM/model keys and state are unchanged; its managed App cache was
renewed by the existing pre-roster startup-pruning bug. [Backend hash checks](hub-app-key-audit.json)
verify active replacements, and strict source corrects that churn. Private
restoration/recovery copies still belong to the transition window.

Failed attempts are retained as failures, separately from this adoption.
Unreadable actual gateway or runner work must still defer. The lifecycle fence
and runtime-update pause remain closed.
No provider reboot, resize or reprovision occurred.
