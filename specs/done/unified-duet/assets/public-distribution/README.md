# External package tooling evidence

The public artifact is a JavaScript bundle with private workspace code and the
patched SDK included. Native dependency packages keep ownership of their
platform selection and file-relative assets. The publisher consumes the staged
directory from [the package builder](../../../../../packages/duet/scripts/build-public-package.ts),
rather than publishing the workspace's development manifest.

The [receipt](receipt.json) separates native packaging proof from the remaining
unified command and publication gates. It records the frozen inputs, artifact,
real install results and platform limitations. The controlled model/OAuth HTTP
fixtures use synthetic credentials; no model evaluation or live account is used.

[The maintained test](../../../../../packages/duet/test/public-pack.test.ts) runs
through the existing disposable agent container harness. [The reproducer](reproduce.sh)
adds an ordinary npm install outside the checkout. These are package/runtime
checks, not visual style acceptance or VM transport proof.

[Choices](choices.md) explains the packaging ownership decisions. Root integration
must rerun the staged tarball against the composed login, remote file/import and
sync commands before this evidence can close external distribution.

The [Mac x64 receipt](mac-x64-receipt.json) supersedes the original selection-only
qualification for the same frozen tarball. Its retained reproducer runs the
actual x64 CLI under Rosetta with a private home and terminal.

[Publisher tooling evidence](publisher/README.md) covers the repo-owned main-push
publisher and its actual npm fixture, separately from live release cutover.

The [Docker runtime receipt](docker-runtime.md) verifies the existing runner's
pinned Node/npm prerequisite alongside Bun, including actual publisher and native gates.

[Unified external acceptance](final-candidate/README.md) verifies a composed CLI
snapshot in clean npm installs on Linux and both Macs, including one login,
file commands and actual stock sync initialization. Its source receipt bounds
that claim; the final registry publication and cutover are still open.

[Publisher ownership handoff](publisher-handoff/README.md) records the transferred
Actions credential and retired one-time transfer, separately from publication.
