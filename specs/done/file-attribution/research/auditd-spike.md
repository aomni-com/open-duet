# auditd file-access attribution spike

Run on 2026-07-10T20:56:10.354Z in fresh VM `duet-test-auditd-20260710t205533-irh2` (exeuntu, 1 CPU / 2 GB). Marker: SPIKE-AUDITD-9c2e.

## Verdict

auditd can attribute reads and writes to files under the drive, but PID-only post-hoc cgroup attribution is race-prone for short-lived processes.

| Criterion                        | Result |
| -------------------------------- | ------ |
| Kernel, sudo, and audit support  | PASS   |
| auditd install and active unit   | PASS   |
| Read/write/nested/rename parsing | PASS   |
| Post-hoc cgroup correlation      | FAIL   |
| 2,000-file load without loss     | PASS   |

## Kernel and audit support

- Kernel: `6.12.93`
- `sudo -n true`: PASS
- auditd unit: `active`
- kernel command line: `no-kvmapf console=hvc0 printk.time=1 root=/dev/vda init=/exe.dev/bin/exe-init rw rcupdate.rcu_cpu_stall_timeout=60 rcu_nocbs=all domain=service.example.invalid ip=192.0.2.1:192.0.2.1:192.0.2.1:255.255.0.0:duet-test-auditd-20260710t205533-irh2:eth0:none:1.1.1.1:8.8.8.8:ntp.ubuntu.com`

```
enabled 1
failure 1
pid 847
rate_limit 0
backlog_limit 8192
lost 0
backlog 0
backlog_wait_time 60000
backlog_wait_time_actual 0
loginuid_immutable 0 unlocked
```

## Final working rule

```
-w /home/synthetic-user/drive -p rwa -k duetdrive
```

The empirical operation checks were: ```
{
"read": true,
"append": true,
"nested": true,
"rename": true
}

```

## Raw audit record excerpt

```

type=USER_END msg=audit(1783716963.361:50): pid=950 uid=1000 auid=4294967295 ses=4294967295 subj=kernel msg='op=PAM:session_close grantors=pam_limits,pam_env,pam_env,pam_permit,pam_umask,pam_unix acct="root" exe="/usr/bin/sudo" hostname=? addr=? terminal=? res=success'
UID="exedev" AUID="unset"
type=CRED_DISP msg=audit(1783716963.361:51): pid=950 uid=1000 auid=4294967295 ses=4294967295 subj=kernel msg='op=PAM:setcred grantors=pam_permit acct="root" exe="/usr/bin/sudo" hostname=? addr=? terminal=? res=success'
UID="exedev" AUID="unset"
type=SYSCALL msg=audit(1783716963.361:52): arch=c000003e syscall=257 success=yes exit=3 a0=ffffff9c a1=563497d9c638 a2=241 a3=1b6 items=2 ppid=331 pid=952 auid=4294967295 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=(none) ses=4294967295 comm="sh" exe="/usr/bin/dash" subj=kernel key="duetdrive"
ARCH=x86_64 SYSCALL=openat AUID="unset" UID="exedev" GID="exedev" EUID="exedev" SUID="exedev" FSUID="exedev" EGID="exedev" SGID="exedev" FSGID="exedev"
type=CWD msg=audit(1783716963.361:52): cwd="/home/synthetic-user"
type=PATH msg=audit(1783716963.361:52): item=0 name="/home/synthetic-user/drive/spike/" inode=265295 dev=fe:00 mode=040755 ouid=1000 ogid=1000 rdev=00:00 obj=unlabeled nametype=PARENT cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
OUID="exedev" OGID="exedev"
type=PATH msg=audit(1783716963.361:52): item=1 name="/home/synthetic-user/drive/spike/readme.txt" inode=265297 dev=fe:00 mode=0100644 ouid=1000 ogid=1000 rdev=00:00 obj=unlabeled nametype=CREATE cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
OUID="exedev" OGID="exedev"
type=PROCTITLE msg=audit(1783716963.361:52): proctitle=2F62696E2F7368002D63007072696E746620276E6565646C655C6E27203E202F686F6D652F6578656465762F64726976652F7370696B652F726561646D652E7478743B2073796E63
type=SYSCALL msg=audit(1783716963.473:53): arch=c000003e syscall=257 success=yes exit=3 a0=ffffff9c a1=7ffe47429e8f a2=0 a3=0 items=1 ppid=956 pid=957 auid=4294967295 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=(none) ses=4294967295 comm="cat" exe="/usr/bin/cat" subj=kernel key="duetdrive"
ARCH=x86_64 SYSCALL=openat AUID="unset" UID="exedev" GID="exedev" EUID="exedev" SUID="exedev" FSUID="exedev" EGID="exedev" SGID="exedev" FSGID="exedev"
type=CWD msg=audit(1783716963.473:53): cwd="/home/synthetic-user/drive/spike"
type=PATH msg=audit(1783716963.473:53): item=0 name="readme.txt" inode=265297 dev=fe:00 mode=0100644 ouid=1000 ogid=1000 rdev=00:00 obj=unlabeled nametype=NORMAL cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
OUID="exedev" OGID="exedev"
type=PROCTITLE msg=audit(1783716963.473:53): proctitle=63617400726561646D652E747874
type=SYSCALL msg=audit(1783716963.473:54): arch=c000003e syscall=257 success=yes exit=3 a0=ffffff9c a1=5626c8c7cbd8 a2=441 a3=1b6 items=1 ppid=331 pid=956 auid=4294967295 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=(none) ses=4294967295 comm="sh" exe="/usr/bin/dash" subj=kernel key="duetdrive"
ARCH=x86_64 SYSCALL=openat AUID="unset" UID="exedev" GID="exedev" EUID="exedev" SUID="exedev" FSUID="exedev" EGID="exedev" SGID="exedev" FSGID="exedev"
type=CWD msg=audit(1783716963.473:54): cwd="/home/synthetic-user"
type=PATH msg=audit(1783716963.473:54): item=0 name="/home/synthetic-user/drive/spike/readme.txt" inode=265297 dev=fe:00 mode=0100644 ouid=1000 ogid=1000 rdev=00:00 obj=unlabeled nametype=NORMAL cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
OUID="exedev" OGID="exedev"
type=PROCTITLE msg=audit(1783716963.473:54): proctitle=2F62696E2F7368002D6300286364202F686F6D652F6578656465762F64726976652F7370696B652026262063617420726561646D652E747874203E2F6465762F6E756C6C293B206563686F20617070656E646564203E3E202F686F6D652F6578656465762F64726976652F7370696B652F726561646D652E7478743B20656368
type=SYSCALL msg=audit(1783716963.473:55): arch=c000003e syscall=257 success=yes exit=3 a0=ffffff9c a1=5626c8c7cbd0 a2=241 a3=1b6 items=2 ppid=331 pid=956 auid=4294967295 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=(none) ses=4294967295 comm="sh" exe="/usr/bin/dash" subj=kernel key="duetdrive"
ARCH=x86_64 SYSCALL=openat AUID="unset" UID="exedev" GID="exedev" EUID="exedev" SUID="exedev" FSUID="exedev" EGID="exedev" SGID="exedev" FSGID="exedev"
type=CWD msg=audit(1783716963.473:55): cwd="/home/synthetic-user"
type=PATH msg=audit(1783716963.473:55): item=0 name="/home/synthetic-user/drive/spike/nested/" inode=265296 dev=fe:00 mode=040755 ouid=1000 ogid=1000 rdev=00:00 obj=unlabeled nametype=PARENT cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
OUID="exedev" OGID="exedev"
type=PATH msg=audit(1783716963.473:55): item=1 name="/home/synthetic-user/drive/spike/nested/child.txt" inode=265298 dev=fe:00 mode=0100644 ouid=1000 ogid=1000 rdev=00:00 obj=unlabeled nametype=CREATE cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
OUID="exedev" OGID="exedev"
type=PROCTITLE msg=audit(1783716963.473:55): proctitle=2F62696E2F7368002D6300286364202F686F6D652F6578656465762F64726976652F7370696B652026262063617420726561646D652E747874203E2F6465762F6E756C6C293B206563686F20617070656E646564203E3E202F686F6D652F6578656465762F64726976652F7370696B652F726561646D652E7478743B20656368
type=SYSCALL msg=audit(1783716963.473:56): arch=c000003e syscall=257 success=yes exit=3 a0=ffffff9c a1=7ffd68b5be90 a2=0 a3=0 items=1 ppid=956 pid=958 auid=4294967295 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=(none) ses=4294967295 comm="cat" exe="/usr/bin/cat" subj=kernel key="duetdrive"
ARCH=x86_64 SYSCALL=openat AUID="unset" UID="exedev" GID="exedev" EUID="exedev" SUID="exedev" FSUID="exedev" EGID="exedev" SGID="exedev" FSGID="exedev"
type=CWD msg=audit(1783716963.473:56): cwd="/home/synthetic-user"
type=PATH msg=audit(1783716963.473:56): item=0 name="/home/synthetic-user/drive/spike/nested/child.txt" inode=265298 dev=fe:00 mode=0100644 ouid=1000 ogid=1000 rdev=00:00 obj=unlabeled nametype=NORMAL cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
OUID="exedev" OGID="exedev"
type=PROCTITLE msg=audit(1783716963.473:56): proctitle=636174002F686F6D652F6578656465762F64726976652F7370696B652F6E65737465642F6368696C642E747874
type=SYSCALL msg=audit(1783716963.473:57): arch=c000003e syscall=316 success=yes exit=0 a0=ffffff9c a1=7fff1e1ebe65 a2=ffffff9c a3=7fff1e1ebe8f items=4 ppid=956 pid=959 auid=4294967295 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=(none) ses=4294967295 comm="mv" exe="/usr/bin/mv" subj=kernel key="duetdrive"
ARCH=x86_64 SYSCALL=renameat2 AUID="unset" UID="exedev" GID="exedev" EUID="exedev" SUID="exedev" FSUID="exedev" EGID="exedev" SGID="exedev" FSGID="exedev"
type=CWD msg=audit(1783716963.473:57): cwd="/home/synthetic-user"
type=PATH msg=audit(1783716963.473:57): item=0 name="/home/synthetic-user/drive/spike/nested/" inode=265296 dev=fe:00 mode=040755 ouid=1000 ogid=1000 rdev=00:00 obj=unlabeled nametype=PARENT cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
OUID="exedev" OGID="exedev"
type=PATH msg=audit(1783716963.473:57): item=1 name="/home/synthetic-user/drive/spike/nested/" inode=265296 dev=fe:00 mode=040755 ouid=1000 ogid=1000 rdev=00:00 obj=unlabeled nametype=PARENT cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
OUID="exedev" OGID="exedev"

```

## Parsed JSON demonstration

The parser groups records by audit serial, reads process fields from `SYSCALL`, and reconstructs relative `PATH.name` values against `CWD.cwd`.

```

[
{
"serial": 52,
"syscall": "openat",
"pid": 952,
"ppid": 331,
"comm": "sh",
"absolute_path": "/home/synthetic-user/drive/spike/"
},
{
"serial": 53,
"syscall": "openat",
"pid": 957,
"ppid": 956,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt"
},
{
"serial": 54,
"syscall": "openat",
"pid": 956,
"ppid": 331,
"comm": "sh",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt"
},
{
"serial": 55,
"syscall": "openat",
"pid": 956,
"ppid": 331,
"comm": "sh",
"absolute_path": "/home/synthetic-user/drive/spike/nested/"
},
{
"serial": 56,
"syscall": "openat",
"pid": 958,
"ppid": 956,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/nested/child.txt"
},
{
"serial": 57,
"syscall": "renameat2",
"pid": 959,
"ppid": 956,
"comm": "mv",
"absolute_path": "/home/synthetic-user/drive/spike/nested/"
}
]

```

## Live cgroup correlation

At parse time the probe attempted to read `/proc/<pid>/cgroup` for known long-lived and short-lived cgroup members. `exited` means the PID was already gone or no longer proved membership.

```

{
"cgroup_created": true,
"create_output": "",
"long_lived": {
"resolved": 2,
"exited": 0
},
"short_lived": {
"resolved": 0,
"exited": 20
},
"samples": [
{
"serial": 78,
"syscall": "openat",
"pid": 970,
"ppid": 331,
"comm": "python3",
"absolute_path": "/home/synthetic-user/drive/spike/",
"kind": "long_lived",
"cgroup_resolved": true
},
{
"serial": 81,
"syscall": "openat",
"pid": 970,
"ppid": 331,
"comm": "python3",
"absolute_path": "/home/synthetic-user/drive/spike/cg-long.txt",
"kind": "long_lived",
"cgroup_resolved": true
},
{
"serial": 88,
"syscall": "openat",
"pid": 975,
"ppid": 331,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt",
"kind": "short_lived",
"cgroup_resolved": false
},
{
"serial": 95,
"syscall": "openat",
"pid": 980,
"ppid": 331,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt",
"kind": "short_lived",
"cgroup_resolved": false
},
{
"serial": 102,
"syscall": "openat",
"pid": 985,
"ppid": 331,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt",
"kind": "short_lived",
"cgroup_resolved": false
},
{
"serial": 109,
"syscall": "openat",
"pid": 990,
"ppid": 331,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt",
"kind": "short_lived",
"cgroup_resolved": false
},
{
"serial": 116,
"syscall": "openat",
"pid": 995,
"ppid": 331,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt",
"kind": "short_lived",
"cgroup_resolved": false
},
{
"serial": 123,
"syscall": "openat",
"pid": 1000,
"ppid": 331,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt",
"kind": "short_lived",
"cgroup_resolved": false
},
{
"serial": 130,
"syscall": "openat",
"pid": 1005,
"ppid": 331,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt",
"kind": "short_lived",
"cgroup_resolved": false
},
{
"serial": 137,
"syscall": "openat",
"pid": 1010,
"ppid": 331,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt",
"kind": "short_lived",
"cgroup_resolved": false
},
{
"serial": 144,
"syscall": "openat",
"pid": 1015,
"ppid": 331,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt",
"kind": "short_lived",
"cgroup_resolved": false
},
{
"serial": 151,
"syscall": "openat",
"pid": 1020,
"ppid": 331,
"comm": "cat",
"absolute_path": "/home/synthetic-user/drive/spike/readme.txt",
"kind": "short_lived",
"cgroup_resolved": false
}
]
}

```

## Load test

```

{
"files": 2000,
"grep_seconds": 0.034,
"records_generated": 2002,
"total_load_records_generated": 4005,
"grep_log_growth_bytes": 1862813,
"total_load_log_growth_bytes": 4654555,
"auditd_cpu_before": "00:00:00",
"auditd_cpu_after": "00:00:00",
"auditd_cpu_percent_during_grep_and_flush": 7.5,
"status_before": "enabled 1\nfailure 1\npid 847\nrate_limit 0\nbacklog_limit 8192\nlost 0\nbacklog 0\nbacklog_wait_time 60000\nbacklog_wait_time_actual 0\nloginuid_immutable 0 unlocked",
"status_after": "enabled 1\nfailure 1\npid 847\nrate_limit 0\nbacklog_limit 8192\nlost 0\nbacklog 0\nbacklog_wait_time 60000\nbacklog_wait_time_actual 0\nloginuid_immutable 0 unlocked",
"lost_delta": 0,
"backlog_after": 0,
"rate_limit": 0
}

```

## Production gotchas

- Audit records do not contain cgroup identity. A PID lookup after receipt races process exit and PID reuse; short-lived commands need an execution-time identity source (for example eBPF/cgroup hooks) or a continuously maintained PID-to-cgroup map.
- One logical access spans multiple line-oriented records joined only by the audit serial. PATH may be relative and requires CWD reassembly; multiple PATH records and rename source/destination require preserving all paths in production.
- Directory watches are recursive only for the mounted filesystem and have audit rule/filesystem constraints. Rules must be restored on boot (for example through audit rules.d), not added only with transient auditctl commands.
- Log rotation, backlog sizing, rate limits, daemon startup ordering, and privileged tampering need explicit production policy and monitoring.
```
