# Restore decoder metadata memory

Measured 2026-09-29 in Linux using `mcr.microsoft.com/playwright:v1.61.0-jammy`
and Python 3.10.12. Each decoder ran in a fresh subprocess; RSS below is that
process's `resource.getrusage(RUSAGE_SELF).ru_maxrss`, excluding fixture creation.

| Entries | ZIP64 count footer | ZIP bytes | Peak RSS (KiB) | Decoder seconds |
| --- | --- | --- | --- | --- |
| 1,003 | no | 1,166,705 | 12,580 | 0.014 |
| 70,003 | yes | 9,566,781 | 61,264 | 0.391 |

The fixture contains empty portable-record entries plus a forced-ZIP64 1 MiB
Drive file, an empty directory, and an absolute dangling symlink. Independent
post-extraction assertions verified exact file bytes, modes `0751` and `0550`,
and the unchanged link target. This measures entry-count metadata, not a
maximum supported file count or a large-payload throughput claim.

The decoder uses public Python `ZipFile` parsing and streamed payload reads.
Central-directory metadata grows with entry count, as in the encoder; SQLite,
pickle, and private ZIP parsing hooks are unnecessary for this contract. A small
footer consistency check retains rejection of a mismatched declared entry count.

The existing restore, birth-seed, and attribution-suppression suites passed
(15 tests), including ZIP64, path/link containment, metadata preservation,
malformed-archive rejection, and disk-capacity refusal. Gateway typechecking
passed. Independent Codex review found no actionable regressions. The mounted
Drive installation code was unchanged.
