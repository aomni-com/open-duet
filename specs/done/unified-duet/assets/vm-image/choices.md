# Image construction choices

## Exact inventory consumption

When: VM image consumer pass.

Decision: The host image script copies the API constructor's already-built
runtime directory into a small Docker context. Docker installs OS tools and
copies that directory intact; it does not build another application copy.
Without supplied output, the host invokes the same constructor once.

Gap: The spec fixed shared output but left Docker layer placement open.

Rationale: Bun embeds build paths, so independently rebuilding the CLI in Docker
could give the image and API different content identities. Copying the finished
inventory preserves the actual selected bytes and removes the full monorepo
dependency installation from Docker.

Consequence: A release operator must supply the frozen output shared by API and
image; registry packages are unrelated to VM application updates.

## Managed command path

When: VM image consumer pass.

Decision: `/usr/local/bin/duet` is a stable symlink to the managed current
release. Login shells and systemd retain workspace Bun on PATH. The gateway
uses its separately pinned Bun explicitly and captures physical child commands.

Gap: The spec fixed current-release selection but left the stable public path
open.

Rationale: The normal system binary directory works for SSH and systemd without
a separate CLI candidate directory or registry installation tree.

Consequence: Interactive commands follow the latest activated release; admitted
gateway work remains tied to the cohort from which that process started.

## Real first-boot verification

When: VM image consumer pass.

Decision: A scratch probe runs the actual stable bootstrap and gateway bundle,
registers against controlled loopback API responses, waits through normal boot
probation, and runs the compiled CLI with the model credential it received.

Gap: The old desktop verifier prewrote a VM token and therefore could not prove
first registration or model credential delivery.

Rationale: The control plane and model provider are the external seams. Keeping
the production entry points real verifies the image without creating a paid VM
or modifying live workspace state.

Consequence: This local gate proves packaged first boot and protocol behavior;
live provisioning and exact-digest promotion still belong to fleet closeout.
