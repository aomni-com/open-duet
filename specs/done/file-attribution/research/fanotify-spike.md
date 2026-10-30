# fanotify file-attribution spike

Final clean run: 2026-07-10T21:04:05.747Z on VM `duet-test-fanotify-20260710t210212-78jg` (deleted after capture).

## Environment

- Kernel: `6.12.93`
- Bun: `1.3.14`
- Privilege: `sudo -n true: ok`
- Drive: `/home/synthetic-user/drive`

## Criteria

| Criterion                       | Result | Evidence                                                                     |
| ------------------------------- | ------ | ---------------------------------------------------------------------------- |
| VM/kernel/passwordless sudo     | PASS   | `6.12.93`; `sudo -n true: ok`                                                |
| Bun FFI fanotify helper         | PASS   | helper initialized and decoded 13179 NDJSON records                          |
| Read, write, nested operations  | PASS   | existing events=4, nested/deeper events=2                                    |
| Subtree coverage                | PASS   | working strategy: `mount`                                                    |
| Dedicated cgroup attribution    | PASS   | matching events=20; shell-pid=523                                            |
| Short-lived process attribution | FAIL   | pid=528; events=1; resolved=0; attribution drops overall=11632               |
| Load: 2,000 files + grep sweep  | PASS   | FAN_OPEN=4000/2000; overflow=0; helper CPU≈5.4% (0.140 CPU-s / 2.594 wall-s) |
| Cleanup                         | PASS   | VM deletion is enforced in `finally`; leak check follows deletion            |

## Mark-strategy experiment

| fanotify_mark strategy | Init    | Nested coverage | Raw evidence                                                                                                                                                                             |
| ---------------------- | ------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| plain                  | started | FAIL            | no nested event                                                                                                                                                                          |
| mount                  | started | PASS            | {"mask":32,"pid":430,"path":"/home/synthetic-user/drive/nested/item.txt","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/430/cgroup'","ts":1783717380308} |
| filesystem             | started | PASS            | {"mask":32,"pid":466,"path":"/home/synthetic-user/drive/nested/item.txt","cgroup":"0::/init.scope","ts":1783717394510}                                                                           |

Exact working calls:

```
fanotify_init(FAN_CLOEXEC | FAN_NONBLOCK, 0)
fanotify_mark(fd, FAN_MARK_ADD | FAN_MARK_MOUNT,
  FAN_OPEN | FAN_MODIFY | FAN_CLOSE_WRITE |
  FAN_EVENT_ON_CHILD | FAN_ONDIR, AT_FDCWD, "/home/synthetic-user/drive")
```

The MOUNT mark covered the containing mount. Production must accept its wider event stream and discard every resolved path not prefixed by `/home/synthetic-user/drive/` (while handling deleted/renamed paths and mount aliases).

## Raw evidence snippets

Read/write:

```
{"mask":32,"pid":502,"path":"/home/synthetic-user/drive/existing.txt","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/502/cgroup'","ts":1783717408741}
{"mask":42,"pid":506,"path":"/home/synthetic-user/drive/existing.txt","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/506/cgroup'","ts":1783717411254}
{"mask":32,"pid":524,"path":"/home/synthetic-user/drive/existing.txt","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/524/cgroup'","ts":1783717419151}
{"mask":32,"pid":528,"path":"/home/synthetic-user/drive/existing.txt","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/528/cgroup'","ts":1783717422659}
```

Nested/rename-area:

```
{"mask":42,"pid":510,"path":"/home/synthetic-user/drive/nested/deeper/renamed.txt","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/510/cgroup'","ts":1783717414048}
{"mask":32,"pid":512,"path":"/home/synthetic-user/drive/nested/deeper/renamed.txt","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/512/cgroup'","ts":1783717414049}
```

Cgroup:

```
{"mask":42,"pid":523,"path":"/home/synthetic-user/drive/cgroup.txt","cgroup":"0::/spiketest","ts":1783717419150}
{"mask":32,"pid":523,"path":"/usr/bin/sleep","cgroup":"0::/spiketest","ts":1783717419151}
{"mask":32,"pid":523,"path":"/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2","cgroup":"0::/spiketest","ts":1783717419151}
{"mask":32,"pid":523,"path":"/etc/ld.so.cache","cgroup":"0::/spiketest","ts":1783717419151}
{"mask":32,"pid":523,"path":"/usr/lib/x86_64-linux-gnu/libc.so.6","cgroup":"0::/spiketest","ts":1783717419151}
```

Attribution drops (first five):

```
{"mask":32,"pid":496,"path":"/etc/login.defs","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/496/cgroup'","ts":1783717406222}
{"mask":32,"pid":501,"path":"/usr/lib/locale/C.utf8/LC_TELEPHONE","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/501/cgroup'","ts":1783717408739}
{"mask":32,"pid":501,"path":"/usr/lib/locale/C.utf8/LC_ADDRESS","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/501/cgroup'","ts":1783717408739}
{"mask":32,"pid":501,"path":"/usr/lib/locale/C.utf8/LC_NAME","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/501/cgroup'","ts":1783717408739}
{"mask":32,"pid":501,"path":"/usr/lib/locale/C.utf8/LC_PAPER","cgroup":null,"attributionDrop":"Error: ENOENT: no such file or directory, open '/proc/501/cgroup'","ts":1783717408740}
```

## Verdict and production gotchas

PASS: on this kernel, a sudo-run Bun helper can use fanotify to observe drive reads/writes recursively and attach best-effort pid/cgroup attribution. The production helper must treat pid-to-cgroup lookup as racy (processes can exit before `/proc/<pid>/cgroup` is read), count attribution drops and `FAN_Q_OVERFLOW`, drain promptly, close every event fd, validate metadata version/length, survive partial/multiple reads, and rotate/backpressure its output. Classic fd-metadata mode does not report rename names; adding rename visibility requires a separate FID/name-reporting design. The NDJSON sink must be off the watched filesystem (the trial exposed a self-amplifying event loop before moving it to /dev/shm). It must also account for deletion readlink failures, PID reuse, paths reachable through aliases, events generated by the helper itself, queue sizing/limits, graceful shutdown, privilege/capability hardening, and filtering the broader mount event scope to the workspace prefix. Event counts are notification counts, not a durable audit log; overflow is an explicit loss signal.
