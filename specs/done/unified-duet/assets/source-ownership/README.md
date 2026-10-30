# Owned source boundary

The frozen source inventory maps every tracked file to its maintained owner or
an explicit provenance reference. Source Git metadata, install trees and real
user state are excluded. License and original dependency/publication inputs
remain inspectable; the reference CI files are not active release writers.

The private harness owns runtime, protocol, memory and quality inputs. The
public CLI owns command composition and terminal presentation. Moving the
connected-provider snapshot into core removes the runtime's dependency on CLI
composition; core imports neither the HTTP contract nor the terminal UI.
Consumer TypeScript uses core declarations, while Bun bundles its source. The
source compiler and intentionally different contract Pi types stay separate.

The [closure receipt](closure.json) and [checker](check-closure.py) prove source
versions, package metadata and integrity through each dependency edge, together
with existing workspace ranges and exact Pi patch bytes. Repo-owned composition dependencies have no external identity in the source
lockfile; the checker reports them separately. Compatible shared
external packages use the frozen harness closure. Unrelated incompatible versions retain
ordinary scoped lock entries. The unused TypeScript peer on bun-ffi-structs sees
the root compiler; both actual imported-package compilers remain frozen.

The disposable runner installs from the root lock and patch owner, preserves
scratch HOME isolation, and retains product, benchmark and opt-in evaluation
coverage. Live evaluation credentials/artifact output are forwarded only in
explicit evaluation mode. No paid evaluation is part of this import gate.

The [gate receipt](gates.json) records focused consumer and source checks. The
production payload and complete matched requests are verified separately in
[source parity](../source-parity/README.md). External installation and npm
publication remain slice 09: the bundle check here does not certify publication.
