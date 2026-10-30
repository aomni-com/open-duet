# exe.dev cp snapshot semantics

Date: 2026-07-06
Marker: SLICE01B-PROBES-5T8V

## Verdict

clone boots; copied files are line-consistent, but non-fsynced writes can roll back. The copy took 940 ms; the clone became SSH-ready in 5530 ms after `cp` returned. The source writer remained alive after copy and source sequence numbers advanced during the operation.

## Sequence evidence

| VM/file                | lines | last seq | monotonic | duplicates | torn lines | trailing newline |
| ---------------------- | ----: | -------: | --------- | ---------: | ---------: | ---------------- |
| source before fsync    |   333 |      333 | true      |          0 |          0 | true             |
| source before buffered |   333 |      333 | true      |          0 |          0 | true             |
| clone fsync            |   349 |      349 | true      |          0 |          0 | true             |
| clone buffered         |     0 |        0 | true      |          0 |          0 | true             |
| source after fsync     |   793 |      793 | true      |          0 |          0 | true             |
| source after buffered  |   792 |      792 | true      |          0 |          0 | true             |

## Timings

- source create returned: 1112 ms
- source SSH-ready: 5464 ms
- `cp` returned: 940 ms
- clone SSH-ready after `cp`: 5530 ms

## Mechanics pinned

- `ssh exe.dev help cp` accepts `cp <source-vm> [new-name]` plus `--cpu`, `--memory`, `--disk`, and `--copy-tags`.
- Source VM: `duet-test-cp-src-20260705t211233-z13o`; clone VM: `duet-test-cp-clone-20260705t211233-kz16`.
- Both VMs used names beginning `duet-test-`; the source was created with `--cpu 1 --memory 2GB --tag duet-test`, and `cp` copied the tag by default.
- Source files are line-consistent after copy; clone files are line-consistent.
- The fsynced file is the reliable backup signal. The buffered file rolled back in the clone despite visible source lines before copy, so backup code must not assume non-fsynced writes are captured.
- Final `duet-test-*` leak check: none.

## Cleanup

- deleted: duet-test-cp-clone-20260705t211233-kz16, duet-test-cp-src-20260705t211233-z13o
- final `duet-test-*` leak check: none

Key observed lines:

```
cp duration=940 ms
clone booted=true
source writer alive after cp=true
source fsync last after=793, clone fsync last=349
source buffered last after=792, clone buffered last=0
clone crash-consistent=true
```
