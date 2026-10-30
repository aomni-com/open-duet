# Frozen reference inputs

These source snapshots are evidence for a reproduction probe, not production code
to import wholesale. [manifest.json](manifest.json) owns source paths, revisions, exact content
hashes and dependency/config identities. Preserve bytes and regenerate the manifest
only when explicitly changing the reference, never to make candidate parity pass.

The [runnable oracle](../../research/reference-probe.ts) loads unchanged source
snapshots at runtime. The manifest freezes its runners, controlled fixture corpus,
transcript, placeholder environment and Bun identity. The runner verifies all frozen
artifact hashes before replay; change the oracle only with an explicit evidence
revision, never to make a candidate pass. Snapshot files use `.txt` to keep historical
code out of production compilation and test discovery.

[Reference evidence](../../research/reference.md) owns runtime/source-only verdicts
and harness limits. The controlled transcript is a provider/handler oracle, not
proof of legacy deployment or authentication.
