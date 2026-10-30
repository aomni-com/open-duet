# Runtime constructor proof

The [receipt](receipt.json) records a constructed Linux release, its source
inputs, and the native checks earned by those exact bytes. This is the
constructor part of slice 06; API transport, activation, rollback, and image
consumption still require their integration gates.

The [API constructor](../../../../../apps/api/scripts/build-runtime-release.mjs)
uses the existing compiled payload owner. Its output is the release inventory,
without an install tree. Consumers must copy that output: independently rebuilding
the CLI would create a different identity even if its source is unchanged.
The stable scratch path removes one known source of compiler identity churn;
this receipt makes no claim that repeated builds produce identical bytes.

[probe-release.sh](probe-release.sh) checks an already constructed release in
disposable Linux containers. Pass the release directory and a scratch evidence
directory. Its [probe](probe.ts) uses controlled loopback responses and a scratch
home; execution containers have no network, checkout, or node_modules. The
Docker image build installs the VM's ripgrep prerequisite. On Linux the runtime
constructor itself uses Bun directly and needs no Docker.

The alias probe establishes that Bun reports the physical binary path when
invoked through `current/duet`, so the existing native loaders find adjacent
sidecars after a release-link switch. TUI acceptance requires initialized content
and absence of loader errors in a PTY transcript. It is not a visual review.
Missing and corrupt Photon controls must fail the actual image assertion;
a timeout is not an accepted failure control.

Compressed captures preserve full RPC requests and native results. They contain
fixture credentials and synthetic data only. The source input map identifies
the root CLI snapshot used for the build; those temporary source copies were
restored before this focused change was committed.
