# fanotify link-semantics probe (slice 13, MAP-SYNC L11)

Run: 2026-07-13T03:15:37.965Z on VM `duet-test-fanotify-links-20260713t031506-kdqj` (deleted after capture).
Group: the proven FID/name group from
[fanotify-fid-spike.md](fanotify-fid-spike.md) — `FAN_CLASS_NOTIF |
FAN_REPORT_FID | FAN_REPORT_DFID_NAME | FAN_REPORT_TARGET_FID`, one
`FAN_MARK_FILESYSTEM` mark on `/home/synthetic-user/drive` with dirent + content mask.
Events below are filtered to records under `/home/synthetic-user/drive/links`; each record carries
two `open_by_handle_at` attempts: `openByHandleErrno` (O_PATH) and
`openPlainErrno` (plain O_RDONLY).

## Environment

- Kernel: `6.12.93`
- Bun: `1.3.14`
- Privilege: helper ran as uid 0 (sudo)

## Raw captures

### Symlink create (`ln -s target.txt link1`)

```
{"event":"CREATE","pid":379,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"link1","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/link1"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fd0b04006a3f3883","handleKey":"1:fd0b04006a3f3883","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/link1","openPlainErrno":40}]}
```

### Read + write through the link (`cat link1; printf >> link1`)

```
{"event":"OPEN","pid":386,"records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"target.txt","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/target.txt"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fb0b040002c9431f","handleKey":"1:fb0b040002c9431f","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/target.txt","openPlainErrno":0}]}
{"event":"MODIFY|CLOSE_WRITE|OPEN","pid":385,"records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"target.txt","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/target.txt"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fb0b040002c9431f","handleKey":"1:fb0b040002c9431f","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/target.txt","openPlainErrno":0}]}
```

### Symlink rename (`mv link1 link1r`)

```
{"event":"RENAME","pid":393,"records":[{"type":10,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"link1","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/link1"},{"type":12,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"link1r","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/link1r"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fd0b04006a3f3883","handleKey":"1:fd0b04006a3f3883","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/link1r","openPlainErrno":40}]}
{"event":"MOVED_FROM","pid":393,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"link1","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/link1"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fd0b04006a3f3883","handleKey":"1:fd0b04006a3f3883","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/link1r","openPlainErrno":40}]}
{"event":"MOVED_TO","pid":393,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"link1r","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/link1r"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fd0b04006a3f3883","handleKey":"1:fd0b04006a3f3883","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/link1r","openPlainErrno":40}]}
```

### Symlink retarget (`ln -sfn target2.txt link1r`)

```
{"event":"MOVED_FROM|CREATE","pid":400,"records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"CuXhFRSA","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/CuXhFRSA"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fe0b0400bbbbd243","handleKey":"1:fe0b0400bbbbd243","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/link1r","openPlainErrno":40}]}
{"event":"RENAME","pid":400,"records":[{"type":10,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"CuXhFRSA","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/CuXhFRSA"},{"type":12,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"link1r","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/link1r"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fe0b0400bbbbd243","handleKey":"1:fe0b0400bbbbd243","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/link1r","openPlainErrno":40}]}
{"event":"MOVED_TO","pid":400,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"link1r","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/link1r"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fe0b0400bbbbd243","handleKey":"1:fe0b0400bbbbd243","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/link1r","openPlainErrno":40}]}
```

### Symlink delete (`rm link1r`)

```
{"event":"DELETE","pid":408,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"link1r","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/link1r"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fe0b0400bbbbd243","handleKey":"1:fe0b0400bbbbd243","openByHandleErrno":116,"openPlainErrno":116}]}
```

### Dangling link: create, failed read, delete

```
{"event":"CREATE","pid":415,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"dangle","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/dangle"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fd0b0400337e47c2","handleKey":"1:fd0b0400337e47c2","openByHandleErrno":116,"openPlainErrno":116}]}
{"event":"DELETE","pid":417,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"dangle","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/dangle"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fd0b0400337e47c2","handleKey":"1:fd0b0400337e47c2","openByHandleErrno":116,"openPlainErrno":116}]}
```

### Hardlink create (`ln target.txt hard1`)

```
{"event":"CREATE","pid":424,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"hard1","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/hard1"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fb0b040002c9431f","handleKey":"1:fb0b040002c9431f","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/hard1","openPlainErrno":0}]}
```

### Write via the second hardlinked name (`printf >> hard1`)

```
{"event":"MODIFY|CLOSE_WRITE|OPEN","pid":430,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040093f6cb45","handleKey":"1:fa0b040093f6cb45","name":"hard1","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links","openPlainErrno":0,"resolvedPath":"/home/synthetic-user/drive/links/hard1"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fb0b040002c9431f","handleKey":"1:fb0b040002c9431f","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/links/hard1","openPlainErrno":0}]}
```

### Inode evidence after the run

```
265211 2 regular file 'target.txt'
265212 1 regular file 'target2.txt'
265211 2 regular file 'hard1'
```

## Observations

- Symlink create surfaces as a named dirent CREATE (`link1`): **PASS**.
  The TARGET_FID object record is the symlink inode itself; `open_by_handle_at`
  with `O_PATH` resolves it (errno 0, path `/home/synthetic-user/drive/links/link1`);
  plain `O_RDONLY` on the same handle returns errno 40 (ELOOP — you cannot open a symlink inode for content, only O_PATH it).
- Read/write **through** the link produce content events on the **target**
  inode only (no content event references `link1`): **PASS**.
  The DFID_NAME on those content events is `target.txt` — the kernel
  reports the resolved target's own parent+name, so through-link content
  attribution needs no link awareness at all.
- Symlink rename is a normal FAN_RENAME with both names: **PASS**.
- Retarget via `ln -sfn` surfaced as: MOVED_FROM|CREATE, RENAME, MOVED_TO —
  coreutils created a temp symlink and renamed it over the old one, so retarget is dirent CREATE+RENAME of the link name, never a MODIFY.
- Symlink delete is a named dirent DELETE: **PASS**.
- Dangling link: create **PASS**, delete **PASS**,
  content events from the failed `cat`: 0 (open of a
  dangling link fails before any fanotify content event exists).
- Hardlink create surfaces as a named dirent CREATE (`hard1`): **PASS**,
  whose object FID is the *existing* inode (handleKey `1:fb0b040002c9431f`).
- Write via the second hardlinked name emits content events keyed by that same
  shared inode handle (matches the target's content handle: **yes**);
  `open_by_handle_at` + `/proc/self/fd` readlink resolved it to
  `/home/synthetic-user/drive/links/hard1` — the kernel picks one alias, so per-name hardlink
  attribution is impossible from FID events (consistent with MAP-SYNC Q14:
  hardlinks are content copies, no inode fidelity promised).
- Queue overflow during the run: none.

## Implications for slices 09 / 11 / 16

- Link *name* operations (create/delete/rename/retarget) arrive as ordinary
  named dirent events — the slice-07 codec and slice-11 resolver need no
  special symlink path beyond kind-tagging; the parent-dir + name join from
  the FID spike covers them unchanged.
- Content through a link attributes to the target file's real path — exactly
  what attribution wants; never resolve through the link yourself.
- When the watcher needs to distinguish "symlink created" from "file created",
  `open_by_handle_at(O_PATH)` + `fstatat`/`readlinkat` on the object handle
  works; plain opens of link inodes fail with ELOOP by design.

## Criteria

| Criterion | Result |
| --- | --- |
| Symlink create/delete/rename surface as named dirent events | PASS |
| Retarget observable via dirent events | PASS |
| Through-link content resolves to the target FID/path | PASS |
| Symlink object handle resolvable with O_PATH | PASS |
| Dangling link create/delete visible | PASS |
| Hardlink create visible; second-name write shares the inode handle | PASS |
| No queue overflow | PASS |

Verdict: **GREEN** — link operations are attributable through the existing FID/name group: named dirent events for link-name ops, target-FID resolution for through-link content, O_PATH handle resolution for link inodes. No fallback needed; 09/11/16 can trust link events.
