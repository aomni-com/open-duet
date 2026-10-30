# Unified command evidence

The composed CLI keeps local execution separate from remote targets and uses
one saved login. Its maintained tests live in the public CLI workspace; native
assets and external package identity remain owned by the public package builder.

[The receipt](receipt.json) records the actual entry points and verification
limits. The paired wider-gate logs preserve the fixture failures and repaired
run. They do not claim publication, a new image, or live VM convergence.
[Dependency closure](closure.json) keeps the imported external graph frozen and
reports newly composed repository workspaces separately.

[Mac lifecycle](../sync-machines/cli-built-lifecycle.md) and
[fixture isolation](../sync-machines/cli-test-isolation.md) own their detailed
transcripts. [Public packaging](../public-distribution/README.md) owns native
platform and clean-install evidence. Image and fleet acceptance remain later
slices; the image source has only removed its obsolete duetfs installation.
