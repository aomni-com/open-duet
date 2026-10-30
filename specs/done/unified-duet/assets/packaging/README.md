# Linux payload proof

The [receipt](receipt.json) freezes what ran against the unchanged harness source
and the relocated executable. The [probe](probe.ts) drives the real CLI with
controlled model and embedding responses; the [comparison](compare.py) checks
complete requests and observable outputs. Compressed runtime traces retain the
full input/output evidence. The reproducer also reruns both Photon failure controls
and checks real TUI initialization; [gate controls](gate-controls.json) record the
blank/failed initialization cases. These probes do not replace later live VM gates.

Use [reproduce.sh](reproduce.sh) with the source checkout and a scratch output
directory. It archives the frozen commit, invokes the existing SWE-bench packager,
and runs source and candidate in disposable Linux containers. Candidate containers
have no checkout or node_modules, registry/network access, or real user home.
Docker image pulls, dependency installation and OS prerequisites belong to the
build phase. If a local credential helper hangs public pulls, point Docker at a
scratch config and its existing local socket; do not modify the user's credentials.

The reference's PGlite assets alone are insufficient. Pi's maintained image
loader also needs Photon WASM next to a compiled executable. Without it, a large
image read silently omits the image; the same read against source resizes and
sends it. Copying that existing sidecar restores parity without changing the
loader. Its missing/corrupt cases fail the image assertion; PGlite's missing/corrupt
cases fail database initialization. Managed release inventory verification must
cover both, before activation.

Bun also embeds the scratch build directory in Photon's loader. Two unchanged
reference builds consequently produced different executable hashes. Release
consumers must share the exact built inventory rather than independently rebuild
and assume source equality implies byte equality. A stable build path prevents
this particular source of identity churn; this proof does not claim complete
compiler reproducibility.

TUI evidence is an offscreen PTY initialization transcript, not a screenshot or
visual redesign. Startup/RSS measurements are descriptive observations under
Docker's x64 emulation; they are not performance budgets for a real VM.
