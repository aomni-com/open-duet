# CDP proxy native gate — infrastructure attempts

Date: 2026-08-13

The exact-image Gate D runner attempted the immutable staging image
`ghcr.io/aomni-com/duet-vm-image@sha256:71285a0068a6ed54ca33dd48791d0fe5ad2c3ccf69738ed5b25c9f9bd5c327dd`
three times. exe.dev returned HTTP 504 `command timed out` from `new` each time,
before a VM or SSH session existed. The runner's exact-name cleanup audit found
none of its three requested VM names after those responses.

These attempts say nothing about CDP relay mechanics. They are retained so a
later successful run does not hide the infrastructure failure history. The final
Slice 00 integration pass owns the global `duet-test-*` leak audit because all
four kill-gate lanes may legitimately hold independent probe VMs concurrently.
