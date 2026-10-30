# External CLI acceptance snapshot

The [receipt](receipt.json) identifies one packed unified CLI and the exact
source snapshot used to construct it. All three clean npm installs consumed
that same tarball. This extends the earlier native tooling proof to the
composed login, workspace, file and sync commands. It does not certify a later
build or registry release.

[The journey probe](probe.ts) executes the installed CLI against a loopback
HTTP fixture. It approves one human login, verifies that saved credential on
account and file requests, and checks byte-exact file transfer. On Macs it uses
the installed optional stock Syncthing binary without a binary override:
generation, device identity, registration and repeated-install preservation all
run normally. A scratch PATH replaces only launchctl so no real launch service
or desktop is touched. Linux verifies the documented Mac-only rejection.

The existing native packaging probe covers memory persistence, semantic vector
recall, RPC continuation, actual image resizing and ripgrep. The installed
bundle also passes the frozen Pi OAuth originator fixture and initializes its
native terminal UI in a private PTY. Mac x64 uses actual x64 Bun/native modules
under Rosetta; it is not a physical Intel Mac result.

The cold x64 run exposed a real packaging omission: Pi loads its optional
clipboard owner dynamically, outside the static bundle. The staged package now
retains that upstream owner's frozen version as an optional dependency. The
maintained public-pack test fails when the external installation cannot resolve
it with Bun automatic installation disabled. Native TUI startup then passes in
the existing four-second window without registry resolution. No clipboard read
or write is exercised. An additional offline Linux diagnostic on the existing
compiled payload, with a synthetic display address, verifies its missing-native
fallback without registry resolution or a cache directory; it is not evidence
for a newly built VM payload.

[The Linux verification script](verify-linux.sh) accepts an already installed
package and the immutable existing agent-test image ID. It runs with no network
and mounts only the install, probes and output. Mac reproduction uses the same
journey probe with the installed entry path and the appropriate Bun executable,
the existing native probe and the existing private-PTY capture. No alternate
package builder or publication mechanism is introduced.

The recorded owning tests pass, and the production package type check and
changed-file lint pass. The original tooling tarball fails the new journey at
login; the omitted clipboard owner fails the actual Docker package test. Both
negative controls are retained beside the green transcripts.

Publication remains open: anonymous registry reads still report the major
version absent and duetfs undeprecated. The final strict source, npm publishing
credential transfer, actual publication, fresh registry install and duetfs
deprecation belong to the operational cutover. Changes after this source
snapshot require a new package receipt. No live write occurred in this pass.
