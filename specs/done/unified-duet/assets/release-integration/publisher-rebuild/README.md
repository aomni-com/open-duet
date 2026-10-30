# Ordinary publisher-fix rebuild

The publisher-only source change leaves the CLI source/dependency closure
unchanged, but independently compiling it produced different bundled-module
ordering. The native engine text/read-only sections and seven other runtime
artifacts match exactly. The module source-name set is identical; that does not
claim the complete bundled JavaScript bytes are identical or prove every code
path equivalent. The [constructor proof](../../runtime-constructor/README.md)
already records this compiler reproducibility limit.

The new exact executable passed the native memory/vector/RPC/Photon/ripgrep
fixture offline in the verified image. Environment-prefixed invocation skipped
sidecar-failure controls despite generic probe stdout naming them. The snapshot
first shows twelve certified targets, then thirteen after ordinary probation.
Phydra remained healthy on certified R5 while live work deferred the R6 update.
No forced work completion or restart is inferred from this partial snapshot;
all thirty-one independent process identities remained unchanged.

This is a dated partial rollout observation, not final fleet acceptance. Large
binaries remain scratch; hashes and actual native results are retained.
