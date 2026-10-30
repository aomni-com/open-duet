# Constructor decisions

These decisions were reviewed in the slice 06 constructor pass. Required whole
inventory identity, the existing payload owner, and the lightweight asset owner
were prescribed by the implementation seam; the choices below fill its gaps.

## Discover workspace source dependencies from package manifests

**When:** constructor pass.

**Decision:** start from the core and public CLI packages, then follow their
local runtime and optional dependency declarations. Copy full source for those
packages and only manifests for the other locked workspaces. The alternative
was an additional hardcoded source-package roster.

**Gap:** the existing constructor copied two packages, but CLI composition now
imports other local owners.

**Rationale:** package manifests already own these dependency edges. Traversal
also preserves transitive edges, which a direct package list would miss. The
frozen installer still validates the same lock and declared patches.

**Consequence:** a newly declared runtime workspace dependency automatically
enters compilation. A missing required workspace fails before compilation;
packages outside the closure remain manifest-only inputs.

## Keep compilation scratch outside source and release output

**When:** constructor review.

**Decision:** use a fixed temporary path derived from the output directory,
remove it before compilation, and clean it in `finally`. Exclude the output
subtree from source copying. The alternative placed build input beneath output.

**Gap:** the builder needs a stable path without exposing its install tree in a
release or recursively copying a benchmark output inside the source package.

**Rationale:** an actual nested benchmark output reproduced the recursive-copy
failure. The external path resolves it while retaining one payload installer.
A fixed compilation path addresses the known embedded Photon path; it is not
proof of complete binary determinism.

**Consequence:** the same output directory is a single-owner build location.
Concurrent constructors must use distinct output directories. A completed
release has no build-input tree.

## Stage the full inventory before replacing a completed build

**When:** constructor pass.

**Decision:** assemble and hash in a sibling staging directory. Replace the
completed output only after every input has copied successfully. An optional
prepared-payload directory feeds this same constructor for focused filesystem
tests; it is not another installer or published distribution mode.

**Gap:** failure behavior when a required payload asset is absent was unspecified.

**Rationale:** publishing a partially copied inventory would make its manifest
misleading. The missing-Photon constructor test preserves the prior completed
manifest while refusing the incomplete input. The default API build exercises
the actual compiler rather than relying on this fixture seam.

**Consequence:** construction failures leave the previous completed build
available. This is a build step, not the VM's activation transaction; runtime
probation and rollback remain separately owned.

## Keep artifact identity independent of transport

**When:** constructor pass.

**Decision:** hash canonical JSON of `{formatVersion: 1, artifacts}` after
sorting artifact names. Each artifact object has keys `name`, `sha256`,
`byteLength`, `mode` in that order. The alternative hashed pretty manifest bytes
or included URLs and the resulting version.

**Gap:** the aggregate serialization recipe needed to be explicit.

**Rationale:** version cannot participate in its own hash, and moving identical
bytes to another URL should preserve identity. Byte lengths and modes are part
of the executable inventory. Tests independently calculate the canonical hash
and demonstrate helper-only and CLI-only identity changes.

**Consequence:** producer and consumer must share this canonical recipe. Root
integration will move serialization to the lightweight contract owner without
adding another packaging layer.

## Prove relocation with the actual executable

**When:** constructor native proof.

**Decision:** run the exact constructed CLI both physically and through a
`current/duet` directory alias, and inspect its reported executable path. Keep
the source loaders unchanged after both memory and image probes pass. The
alternative was to change loaders based on an assumed symlink behavior.

**Gap:** sidecar lookup under the eventual activation link needed evidence.

**Rationale:** the constructed Bun executable reports `/release/duet` through
the alias. The full native probe then reopens durable memory, recalls a vector,
and resizes an image through that alias using no source checkout or dependencies.

**Consequence:** current native lookup survives this directory alias pattern.
Root still owns capturing the executing release for gateway/helper processes
before changing activation links and testing the complete update transaction.
