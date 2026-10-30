# Owned-source entrypoint parity

The [receipt](receipt.json) ties the imported CLI to the frozen source through the
actual maintained Linux constructor. [Build inputs](build-inputs.json.gz) record
every snapshot file/link; build/install/probe logs and compressed runtime/TUI
traces retain the observed result. The [dependency closure audit](../source-ownership/closure.json)
owns version/integrity preservation. This proof covers the controlled paths named
in the receipt, not every provider or live VM behavior.

The [comparison](compare.py) permits only the requested major-version labels
before applying the shared [packaging oracle](../packaging/compare.py). It rejects
a changed model request. Paths, timing/RSS and generated memory metadata follow
the existing source proof's declared handling; requests are otherwise unchanged.

The shared probe flushes commands because the fixture keeps stdin open. Its
finally block releases a pending model fixture before stopping the server, and
the container command has an outer deadline. The hang control fails that gate.
This hardens the proof producer; no harness runtime change was needed. The
original stream stall's precise cause remains unproved.

The [plain-JS diagnostic](js-variation.json) separates source whitespace from
build-directory effects. Its hashes are observations, not a substitute for the
fresh executable proof or a claim of compiler byte reproducibility.
