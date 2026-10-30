# netlink proc-connector over bun:ffi probe (slice 13)

Run: 2026-07-13T03:18:18.955Z on VM `duet-test-proc-connector-20260713t031739-2aji` (deleted after capture).
Question (pass/fail only): can a sudo-run Bun process, using nothing but
`bun:ffi` libc calls (`socket`/`bind`/`sendto`/`recv`), open
`AF_NETLINK`/`NETLINK_CONNECTOR`, subscribe with `PROC_CN_MCAST_LISTEN`,
and receive fork/exec/exit events for a process tree it spawns? Full helper
integration (pid→session map at scale) stays in slice 09.

## Environment

- Kernel: `6.12.93`
- Bun: `1.3.14`
- Privilege: `sudo -n true: ok`

## Root run (sudo) — raw output

Exit code: 1

```
{"fatal":"socket","errno":93,"uid":0}
```

## Unprivileged control run (plain exedev user)

Netlink connector needs CAP_NET_ADMIN; recording where it fails without root.
Exit code: 1

```
{"fatal":"socket","errno":93,"uid":1000}
```

## Kernel-surface evidence (runtime-independent)

python3 control (`socket.socket(AF_NETLINK, SOCK_DGRAM, NETLINK_CONNECTOR)`
as root — a failure here proves the result is not a bun:ffi artifact), exit
code 1:

```
Traceback (most recent call last):
  File "<string>", line 1, in <module>
  File "/usr/lib/python3.12/socket.py", line 233, in __init__
    _socket.socket.__init__(self, family, type, proto, fileno)
OSError: [Errno 93] Protocol not supported
```

Kernel config / proc surface:

```
ls: cannot access '/proc/net/connector': No such file or directory
# CONFIG_CONNECTOR is not set
```

## Result

| Check | Result |
| --- | --- |
| socket + bind (nl_pid=self, groups=CN_IDX_PROC) | FAIL |
| PROC_CN_MCAST_LISTEN acked (proc_event none/ack) | FAIL |
| fork events for the spawned tree | FAIL |
| exec events for the spawned tree (incl. the spawned pid) | FAIL |
| exit events for the spawned tree (incl. the spawned pid) | FAIL |

Verdict: **RED** — socket(AF_NETLINK, SOCK_DGRAM, NETLINK_CONNECTOR) fails with EPROTONOSUPPORT (errno 93) even as root, and the python3 control fails identically — the exe.dev kernel is built without CONFIG_CONNECTOR/CONFIG_PROC_EVENTS, so NO userspace runtime can use the proc connector on this image. This also kills step one of the pre-decided fallback chain (python3-ctypes uses the same kernel interface). Per slices/13-kernel-probe-pack.md: escalate first (a kernel-config request to exe.dev is the cheapest cure), then reslice 09 to a non-connector mechanism (blocking FAN_OPEN_PERM, or cgroup-based attribution without a live fork map) before 07/08 assumptions bake in.
