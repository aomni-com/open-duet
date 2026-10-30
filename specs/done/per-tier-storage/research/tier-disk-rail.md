# Per-tier storage rail probe

- Date: 2026-07-22T17:45:42.274Z
- VM: duet-test-tier-disk-20260722t174115-3ry1
- Image: ghcr.io/aomni-com/duet-vm-image@sha256:8ecb0dc409fc69397f29e2906d71d8635e70f02d99d126f88210b863b59da8e2

## Verdict 1 — staging token scope

**VERDICT:** PASS

```
new: ACCEPTED
ls: ACCEPTED
share set-public: ACCEPTED
resize: ACCEPTED
restart: ACCEPTED
rm: ACCEPTED

attempt 1 — new — accepted
{
  "value": {
    "vm_name": "duet-test-tier-disk-20260722t174115-3ry1",
    "tags": [
      "duet-test"
    ],
    "ssh_command": "ssh service.example.invalid",
    "ssh_dest": "service.example.invalid",
    "ssh_port": 22,
    "https_url": "https://service.example.invalid",
    "proxy_port": 3000,
    "shelley_url": "https://service.example.invalid",
    "vscode_url": "vscode://vscode-remote/ssh-remote+service.example.invalid/home/synthetic-user",
    "xterm_url": "https://service.example.invalid"
  },
  "durationMs": 2782.628084
}
attempt 2 — share set-public — accepted
command returned successfully
attempt 3 — resize — accepted
{
  "disk_new_bytes": 62277025792,
  "disk_old_bytes": 30064771072,
  "vm_name": "duet-test-tier-disk-20260722t174115-3ry1"
}
attempt 4 — restart — accepted
command returned successfully
attempt 5 — ls — accepted
[
  {
    "access": {
      "admin": true,
      "shell": true,
      "web": true
    },
    "allocated_cpus": 1,
    "created_at": "2026-07-22T17:41:16Z",
    "disk_capacity_bytes": 62277025792,
    "domains": [],
    "email_receive_enabled": false,
    "emoji": "🎲",
    "has_creation_log": false,
    "https_url": "https://service.example.invalid",
    "image": "aomni-com/duet-vm-image@sha256:8ecb0dc4",
    "is_team_shared": false,
    "memory_capacity_bytes": 2147483648,
    "proxy_port": 3000,
    "proxy_share": "public",
    "region": "nyc",
    "region_display": "New York, USA",
    "route_known": true,
    "share_link_count": 0,
    "share_links": [],
    "shared_emails": [],
    "shared_user_count": 0,
    "sharing": {
      "group": "external",
      "named_user_count": 0,
      "named_user_shares": [],
      "named_users": [],
      "public_proxy": true,
      "share_link_count": 0,
      "share_links": [],
      "team_access": false,
      "team_shared": false
    },
    "shelley_url": "https://service.example.invalid",
    "ssh_command": "ssh service.example.invalid",
    "ssh_dest": "service.example.invalid",
    "status": "running",
    "tags": [
      "duet-test"
    ],
    "terminal_url": "https://service.example.invalid",
    "total_share_count": 0,
    "updated_at": "2026-07-22T17:45:29Z",
    "vm_name": "duet-test-tier-disk-20260722t174115-3ry1",
    "vscode_url": "vscode://vscode-remote/ssh-remote+service.example.invalid/home/synthetic-user"
  }
]
attempt 6 — rm — accepted
deleted duet-test-tier-disk-20260722t174115-3ry1
```

## Verdict 2 — public share and reboot survival

**VERDICT:** PASS

```
One resize/restart supplies both verdict 2 and verdict 5.
before URL: https://service.example.invalid
ls URL after restart: https://service.example.invalid
before unauthenticated GET: HTTP 200; body="ok"
after unauthenticated GET: HTTP 200; body="ok"
```

## Verdict 3 — empty-drive headroom

**VERDICT:** 21,242,064,896 available bytes

```
Filesystem       1B-blocks       Used   Available Use% Mounted on
/dev/root      29479792640 6717714432 21242064896  25% /home/synthetic-user/drive

Filesystem      Size  Used Avail Use% Mounted on
/dev/root        28G  6.3G   20G  25% /home/synthetic-user/drive

available: 21,242,064,896 bytes (21.242 GB; 19.783 GiB)
delta vs advertised decimal 20GB: +1,242,064,896 bytes (+1.242 GB; +1.157 GiB)
available after 1GiB reserve: 20,168,323,072 bytes
delta vs advertised decimal 20GB after reserve: +168,323,072 bytes (+0.168 GB; +0.157 GiB)
```

## Verdict 4 — `du` cost

**VERDICT:** cold 178 ms; warm 170 ms in-VM at 10,000,000,000 bytes / 100,005 files

```
empty drive: 0 files
cold (in-VM): 17 ms (0 bytes)
warm min of runs 2-3 (in-VM): 3 ms
run 1: in-VM 16.7 ms (exec incl. SSH 2415 ms); output: 0	/home/synthetic-user/drive | invm_ns=16738567
run 2: in-VM 3.0 ms (exec incl. SSH 2404 ms); output: 0	/home/synthetic-user/drive | invm_ns=3024692
run 3: in-VM 7.9 ms (exec incl. SSH 2765 ms); output: 0	/home/synthetic-user/drive | invm_ns=7908440

five 1GB files: 5 files
cold (in-VM): 7 ms (5,000,000,000 bytes)
warm min of runs 2-3 (in-VM): 5 ms
run 1: in-VM 7.4 ms (exec incl. SSH 5917 ms); output: 5000000000	/home/synthetic-user/drive | invm_ns=7437574
run 2: in-VM 5.7 ms (exec incl. SSH 2754 ms); output: 5000000000	/home/synthetic-user/drive | invm_ns=5734912
run 3: in-VM 4.9 ms (exec incl. SSH 2410 ms); output: 5000000000	/home/synthetic-user/drive | invm_ns=4890574

five 1GB files plus 100k 50KB files: 100,005 files
cold (in-VM): 178 ms (10,000,000,000 bytes)
warm min of runs 2-3 (in-VM): 170 ms
run 1: in-VM 178.3 ms (exec incl. SSH 3078 ms); output: 10000000000	/home/synthetic-user/drive | invm_ns=178333239
run 2: in-VM 170.4 ms (exec incl. SSH 2733 ms); output: 10000000000	/home/synthetic-user/drive | invm_ns=170412416
run 3: in-VM 182.4 ms (exec incl. SSH 2713 ms); output: 10000000000	/home/synthetic-user/drive | invm_ns=182374282



Extrapolations use in-VM du time only (SSH transport excluded).

100GB byte-linear extrapolation from the final state (10,000,000,000 measured bytes; factor 10.000): cold 1783 ms, warm 1704 ms.

100GB file-linear extrapolation assumes 50KB files (2,000,000 target files) from the final state's 100,005 files (factor 19.999): cold 3566 ms, warm 3408 ms.
```

## Verdict 5 — resize/restart blip

**VERDICT:** 9902 ms

```
health path: public https_url
resize returned: 573 ms
restart returned: 4669 ms
ssh-ready: 8038 ms
healthz-ok: 9902 ms
total resize-to-healthz: 9902 ms

post-reboot df grew: yes
post-reboot filesystem size: 61,178,351,616 bytes (58GB requested)
Filesystem       1B-blocks        Used   Available Use% Mounted on
/dev/root      61178351616 16972394496 41397485568  30% /home/synthetic-user/drive
```

## Cleanup and unexpected errors

```
deleted: duet-test-tier-disk-20260722t174115-3ry1
delete errors: none
assertNoDuetTestVms: PASS
unexpected errors: none
raw probe notes:
create response:
{
  "vm_name": "duet-test-tier-disk-20260722t174115-3ry1",
  "tags": [
    "duet-test"
  ],
  "ssh_command": "ssh service.example.invalid",
  "ssh_dest": "service.example.invalid",
  "ssh_port": 22,
  "https_url": "https://service.example.invalid",
  "proxy_port": 3000,
  "shelley_url": "https://service.example.invalid",
  "vscode_url": "vscode://vscode-remote/ssh-remote+service.example.invalid/home/synthetic-user",
  "xterm_url": "https://service.example.invalid"
}

initial SSH ready: 6851 ms

public health before resize: 1 attempts; HTTP 200; body="ok"

post-restart public https_url health: 9 attempts; HTTP 200; body="ok"
```
