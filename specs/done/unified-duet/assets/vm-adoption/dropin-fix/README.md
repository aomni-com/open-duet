# Effective gateway boot wiring

Systemd drop-ins override the base unit. The known Bun override selected the old
two-artifact bootstrap even after the one-shot adopter installed the held runtime
unit. That bootstrap re-adopted the old gateway, leaving no native CLI at the
current path. The adopter now includes that override in its existing snapshot,
removes it only after the idle gateway stops, and checks systemd’s effective
commands before target startup. Precommit recovery restores the snapshot; another
command override defers without starting the target.

The archived driver used the existing disposable full-old systemd fixture and
platform launch/settlement contract. Its API serves the actual frozen old
manifest and bundles, so the old bootstrap really can adopt that cohort. The
recorded red outcome failed native probing after legacy re-adoption. The emulated
process reports a generic probe failure; this is not a reproduction of the live
Linux `posix_spawn` error text. Green certifies the unchanged held runtime and
reads the real memory row through the native CLI. Interruption after actual held
syncs restores exact override bytes, mode and owner.

This is local Ubuntu systemd on an ARM Docker kernel with x64 runtime through
Rosetta. The Syncthing unit is a synthetic process marker, and fanotify is not
certified. State and keys are synthetic. It proves the boot-wiring and restoration
regression, without claiming a live VM or stock Syncthing protocol result.

[The receipt](receipt.json) binds source, immutable inputs, observations and
cleanup. Its `evidenceSha256` and invocation retain the original observation;
`referenceArchives` locates the lossless source archives and binds their compressed
and original byte hashes. Gzip headers omit filenames and use zero timestamps.

The [driver reference](systemd-drill.ts.reference.gz),
[reset reference](reset-fixture.sh.reference.gz) and
[API reference](fixture-api.js.reference.gz) preserve the disposable reproducer
without retaining executable fixture producers. They require the parent proof’s
full fixture setup, identified old bundles, CLI dependencies and memory store;
they are historical evidence, not an installer or shipping test framework.
