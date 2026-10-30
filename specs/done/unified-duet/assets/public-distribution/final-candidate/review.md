# Pass review

The requested outcome remains one usable public `duet` CLI with preserved native
behavior, while npm is only an external distribution channel. This pass adds no
product restriction, VM mechanism or new source dependency version.

Shape review kept the existing public package builder as the sole owner. The
only production change preserves one existing optional native owner. The new
probe drives the outer installed CLI; HTTP and launchctl are its external
fixtures. Native runtime checks reuse the existing probe and PTY capture.

Diff review checked empty install, missing optional owner, repeated sync install
and uninstall, rejected Linux platform, and preservation of login and certificate
bytes. The package regression earned red before the fix. A publisher fixture's
JSON result now carries the record annotation required by the current type
checker; it changes no runtime behavior. Types, changed-file lint and diff
whitespace checks pass. The owning Docker gates passed 17 tests and 91 assertions.

Docs review adds Bun/Node prerequisites and npm installation to the README that
the public artifact actually packs, and links this bounded evidence from the
existing public-distribution hub. The source and registry release claims remain
separate. The new receipt records borrowed contract source hashes; those copies
were restored before the focused commit.

The configured independent Codex review found no actionable regression and
built the public package successfully. Its sandbox could not access Docker, so
it did not rerun the container gates. The owner's actual Docker results are
retained; the independent review is a diff review, not replacement test evidence.

No live publication, deprecation, credential transfer or VM write occurred.
