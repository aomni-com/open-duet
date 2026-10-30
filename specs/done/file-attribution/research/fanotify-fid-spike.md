# fanotify FID/name attribution spike

Final clean run: 2026-07-12T15:28:16.798Z on VM `duet-test-fanotify-fid-20260712t152637-phv9` (deleted after capture). Marker: SPIKE-FID-2b8e.

## Environment

- Kernel: `6.12.93`
- Bun: `1.3.14`
- Privilege: `sudo -n true: ok`
- Drive: `/home/synthetic-user/drive`

## Initialization flag matrix

Every attempted combination (`FAN_CLASS_NOTIF` is zero; every call also used `FAN_CLOEXEC | FAN_NONBLOCK`):

```
{"kind":"init","name":"FID","flags":512,"result":"ok","errno":0}
{"kind":"init","name":"FID|DFID_NAME","flags":3584,"result":"ok","errno":0}
{"kind":"init","name":"FID|DFID_NAME|TARGET_FID","flags":7680,"result":"ok","errno":0}
{"kind":"init","name":"DFID_NAME(no FID)","flags":3072,"result":"ok","errno":0}
{"kind":"init","name":"TARGET_FID(no NAME)","flags":4608,"result":"rejected","errno":22}
```

The capture group used exactly `FAN_CLASS_NOTIF | FAN_REPORT_FID | FAN_REPORT_DFID_NAME | FAN_REPORT_TARGET_FID`. `FAN_REPORT_DFID_NAME` means `FAN_REPORT_DIR_FID | FAN_REPORT_NAME`. It successfully accepted a mark containing `FAN_RENAME`; the emitted rename records below prove runtime support.

## Mark experiment

Both marks were attempted with `FAN_CREATE | FAN_DELETE | FAN_MOVED_FROM | FAN_MOVED_TO | FAN_RENAME | FAN_EVENT_ON_CHILD | FAN_ONDIR`.

| Mark       | Result       | CREATE | DELETE | Error / errno |
| ---------- | ------------ | -----: | -----: | ------------- | ---------------------- | -------- | ------------ | ---------- | -------- | ---------------- | ----------- | ------------------------ | -------- | ------------- | -------------------- | ---------------------------------------------------------------------------- | --------------- | -------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------- | ------------ | ---------- | -------- | ---------------- | ----------- | ------------------------ | -------- | ------------- | -------------------- | ---------------------------------------------------------------------------- | --------------- | -------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| filesystem | init/mark ok |      1 |      1 |               |
| mount      | rejected     |      0 |      0 | Error: 19     | const dirMask=C.CREATE | C.DELETE | C.MOVED_FROM | C.MOVED_TO | C.RENAME | C.EVENT_ON_CHILD | C.ONDIR; 20 | const contentMask=C.OPEN | C.MODIFY | C.CLOSE_WRITE | C.EVENT_ON_CHILD; 21 | const mask=maskKind==="dir"?dirMask:maskKind==="content"?contentMask:dirMask | contentMask; 22 | const markFlags=C.MARK_ADD | (markKind==="filesystem"?C.MARK_FILESYSTEM:markKind==="mount"?C.MARK_MOUNT:0); 23 | const mr=libc.symbols.fanotify_mark(fanfd,markFlags,mask,-100,Buffer.from(root+"\0")); 24 | if(mr<0)throw new Error("fanotify_mark kind="+markKind+" mask="+maskKind+" errno="+errno()); ^ error: fanotify_mark kind=mount mask=dir errno=22 at /tmp/duet-fanotify-fid/helper.ts:24:19 Bun v1.3.14 (Linux x64) 19 | const dirMask=C.CREATE | C.DELETE | C.MOVED_FROM | C.MOVED_TO | C.RENAME | C.EVENT_ON_CHILD | C.ONDIR; 20 | const contentMask=C.OPEN | C.MODIFY | C.CLOSE_WRITE | C.EVENT_ON_CHILD; 21 | const mask=maskKind==="dir"?dirMask:maskKind==="content"?contentMask:dirMask | contentMask; 22 | const markFlags=C.MARK_ADD | (markKind==="filesystem"?C.MARK_FILESYSTEM:markKind==="mount"?C.MARK_MOUNT:0); 23 | const mr=libc.symbols.fanotify_mark(fanfd,markFlags,mask,-100,Buffer.from(root+"\0")); 24 | if(mr<0)throw new Error("fanotify_mark kind="+markKind+" mask="+maskKind+" errno="+errno()); ^ error: fanotify_mark kind=mount mask=dir errno=22 at /tmp/duet-fanotify-fid/helper.ts:24:19 Bun v1.3.14 (Linux x64) |

Working call:

```
fanotify_init(FAN_CLOEXEC | FAN_NONBLOCK | FAN_CLASS_NOTIF | FAN_REPORT_FID | FAN_REPORT_DFID_NAME | FAN_REPORT_TARGET_FID, 0)
fanotify_mark(fd, FAN_MARK_ADD | FAN_MARK_FILESYSTEM, FAN_CREATE | FAN_DELETE | FAN_MOVED_FROM | FAN_MOVED_TO | FAN_RENAME | FAN_EVENT_ON_CHILD | FAN_ONDIR, AT_FDCWD, "/home/synthetic-user/drive")
```

## FID parsing and path resolution

The Bun helper parses each variable-length info header, fsid, file_handle, and trailing name. It calls libc `open_by_handle_at(mountfd, parent_handle, O_PATH)` through Bun FFI, then appends the DFID_NAME entry name. No ctypes fallback was needed. A DELETE resolves because its record identifies the surviving parent directory, not the deleted inode.

Create/delete:

```
{"event":"OPEN|MODIFY|CLOSE_WRITE|CREATE","pid":462,"cgroup":"0::/init.scope","records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"created.txt","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/created.txt"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fb0b04008b78f7c6","handleKey":"1:fb0b04008b78f7c6","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/created.txt"}]}
{"event":"DELETE","pid":464,"cgroup":null,"records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"created.txt","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/created.txt"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fb0b04008b78f7c6","handleKey":"1:fb0b04008b78f7c6","openByHandleErrno":116}]}
```

Delete parent-handle resolution: **PASS**.

Rename, including old and new sides:

```
{"event":"OPEN|MODIFY|CLOSE_WRITE|CREATE","pid":462,"cgroup":"0::/init.scope","records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"old.txt","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/old.txt"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fb0b040022aeaa0c","handleKey":"1:fb0b040022aeaa0c","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/new.txt"}]}
{"event":"RENAME","pid":462,"cgroup":null,"records":[{"type":10,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"old.txt","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/old.txt"},{"type":12,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"new.txt","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/new.txt"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fb0b040022aeaa0c","handleKey":"1:fb0b040022aeaa0c","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/new.txt"}]}
{"event":"MOVED_FROM","pid":462,"cgroup":null,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"old.txt","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/old.txt"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fb0b040022aeaa0c","handleKey":"1:fb0b040022aeaa0c","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/new.txt"}]}
{"event":"MOVED_TO","pid":462,"cgroup":null,"records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"new.txt","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/new.txt"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fb0b040022aeaa0c","handleKey":"1:fb0b040022aeaa0c","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/new.txt"}]}
```

## Atomic saves

Shell sequence (`printf > .tmp-x && mv .tmp-x report.md`):

```
{"event":"OPEN|MODIFY|CLOSE_WRITE|CREATE","pid":468,"cgroup":"0::/init.scope","records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":".tmp-x","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/.tmp-x"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fc0b04004f6e03df","handleKey":"1:fc0b04004f6e03df","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/report.md"}]}
{"event":"RENAME","pid":469,"cgroup":"0::/init.scope","records":[{"type":10,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":".tmp-x","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/.tmp-x"},{"type":12,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"report.md","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/report.md"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fc0b04004f6e03df","handleKey":"1:fc0b04004f6e03df","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/report.md"}]}
{"event":"MOVED_FROM","pid":469,"cgroup":"0::/init.scope","records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":".tmp-x","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/.tmp-x"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fc0b04004f6e03df","handleKey":"1:fc0b04004f6e03df","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/report.md"}]}
{"event":"MOVED_TO","pid":469,"cgroup":"0::/init.scope","records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"report.md","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/report.md"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fc0b04004f6e03df","handleKey":"1:fc0b04004f6e03df","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/report.md"}]}
```

Reconstruction: ```
{"target":"report.md","writerPid":462,"renamePid":469,"source":".tmp-x"}

```

Editor-style Python sequence (write temp, then `os.replace`):

```

{"event":"OPEN|MODIFY|CLOSE_WRITE|CREATE","pid":475,"cgroup":"0::/init.scope","records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"editor.tmp","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/editor.tmp"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fd0b040089d2c1d8","handleKey":"1:fd0b040089d2c1d8","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/editor.tmp"}]}
{"event":"RENAME","pid":475,"cgroup":"0::/init.scope","records":[{"type":10,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"editor.tmp","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/editor.tmp"},{"type":12,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"editor.md","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/editor.md"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fd0b040089d2c1d8","handleKey":"1:fd0b040089d2c1d8","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/editor.md"}]}
{"event":"MOVED_FROM","pid":475,"cgroup":"0::/init.scope","records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"editor.tmp","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/editor.tmp"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fd0b040089d2c1d8","handleKey":"1:fd0b040089d2c1d8","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/editor.md"}]}
{"event":"MOVED_TO","pid":475,"cgroup":"0::/init.scope","records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"editor.md","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/editor.md"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fd0b040089d2c1d8","handleKey":"1:fd0b040089d2c1d8","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/editor.md"}]}

````

Reconstruction: ```
{"target":"editor.md","writerPid":462,"renamePid":475,"source":"editor.tmp"}
````

The reconstruction joins the temp file's CLOSE_WRITE handle to the rename source handle, then assigns that writer PID to the destination name. The shell case may have a distinct `mv` PID; Python's writer and rename PID are the same.

## One group, content events, and cgroup attribution

One FID/name group accepted content and dirent masks together: content=PASS, dirent=PASS. Content records carry handles (metadata event_fd is `FAN_NOFD`) while metadata still carries PID. Live dedicated-cgroup evidence (setup succeeded):

```
{"event":"OPEN|MODIFY|CLOSE_WRITE|CREATE","pid":482,"cgroup":"0::/fidspike","records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fa0b040087892725","handleKey":"1:fa0b040087892725","name":"cgroup.txt","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested","resolvedPath":"/home/synthetic-user/drive/fid/nested/cgroup.txt"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"fe0b0400f4eb1e92","handleKey":"1:fe0b0400f4eb1e92","openByHandleErrno":0,"objectPath":"/home/synthetic-user/drive/fid/nested/cgroup.txt"}]}
{"event":"OPEN","pid":482,"cgroup":"0::/fidspike","records":[{"type":2,"len":36,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"15000000be3735d0","handleKey":"1:15000000be3735d0","name":"sleep","openByHandleErrno":0,"objectPath":"/usr/bin","resolvedPath":"/usr/bin/sleep"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"f6000000ea481ff0","handleKey":"1:f6000000ea481ff0","openByHandleErrno":0,"objectPath":"/usr/bin/sleep"}]}
{"event":"OPEN","pid":482,"cgroup":"0::/fidspike","records":[{"type":2,"len":52,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"98010000347b3983","handleKey":"1:98010000347b3983","name":"ld-linux-x86-64.so.2","openByHandleErrno":0,"objectPath":"/usr/lib/x86_64-linux-gnu","resolvedPath":"/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"a202000051614f5b","handleKey":"1:a202000051614f5b","openByHandleErrno":0,"objectPath":"/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"}]}
{"event":"OPEN","pid":482,"cgroup":"0::/fidspike","records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"01000600d16a1eb6","handleKey":"1:01000600d16a1eb6","name":"ld.so.cache","openByHandleErrno":0,"objectPath":"/etc","resolvedPath":"/etc/ld.so.cache"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"4700060066c2f9fd","handleKey":"1:4700060066c2f9fd","openByHandleErrno":0,"objectPath":"/etc/ld.so.cache"}]}
{"event":"OPEN","pid":482,"cgroup":"0::/fidspike","records":[{"type":2,"len":40,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"98010000347b3983","handleKey":"1:98010000347b3983","name":"libc.so.6","openByHandleErrno":0,"objectPath":"/usr/lib/x86_64-linux-gnu","resolvedPath":"/usr/lib/x86_64-linux-gnu/libc.so.6"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"b60200007b2c80f3","handleKey":"1:b60200007b2c80f3","openByHandleErrno":0,"objectPath":"/usr/lib/x86_64-linux-gnu/libc.so.6"}]}
{"event":"OPEN","pid":482,"cgroup":"0::/fidspike","records":[{"type":2,"len":44,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"01000600d16a1eb6","handleKey":"1:01000600d16a1eb6","name":"locale.alias","openByHandleErrno":0,"objectPath":"/etc","resolvedPath":"/etc/locale.alias"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"f00306007bcb75a1","handleKey":"1:f00306007bcb75a1","openByHandleErrno":0,"objectPath":"/etc/locale.alias"}]}
{"event":"OPEN","pid":482,"cgroup":"0::/fidspike","records":[{"type":2,"len":48,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"182600004c41591e","handleKey":"1:182600004c41591e","name":"LC_IDENTIFICATION","openByHandleErrno":0,"objectPath":"/usr/lib/locale/en_US.utf8","resolvedPath":"/usr/lib/locale/en_US.utf8/LC_IDENTIFICATION"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"1c260000f8f3d94e","handleKey":"1:1c260000f8f3d94e","openByHandleErrno":0,"objectPath":"/usr/lib/locale/en_US.utf8/LC_IDENTIFICATION"}]}
{"event":"OPEN","pid":482,"cgroup":"0::/fidspike","records":[{"type":2,"len":48,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"a0010000e78696c4","handleKey":"1:a0010000e78696c4","name":"gconv-modules.cache","openByHandleErrno":0,"objectPath":"/usr/lib/x86_64-linux-gnu/gconv","resolvedPath":"/usr/lib/x86_64-linux-gnu/gconv/gconv-modules.cache"},{"type":1,"len":28,"fsid":[-31009542,-1731037055],"handleType":1,"handle":"99020000d2efb707","handleKey":"1:99020000d2efb707","openByHandleErrno":0,"objectPath":"/usr/lib/x86_64-linux-gnu/gconv/gconv-modules.cache"}]}
```

Verdict: **one FID/name group is the simplest working arrangement**. It supplies handle-keyed content events plus named dirent/rename records, so a second fd-mode group is unnecessary unless production independently values immediately-open file descriptors or fd-readlink convenience. PID-to-cgroup lookup remains racy for short-lived processes.

## Load re-check

The loop performed 500 rename syscalls: FAN_RENAME=500, FAN_MOVED_FROM=500, FAN_MOVED_TO=500, FAN_Q_OVERFLOW=0. Result: **PASS**.

## Criteria

| Criterion                          | Result | Evidence                                                |
| ---------------------------------- | ------ | ------------------------------------------------------- |
| Required init flags and FAN_RENAME | PASS   | init matrix plus emitted rename records                 |
| Filesystem dirent mark             | PASS   | CREATE/DELETE delivered                                 |
| Parent-FID path resolution         | PASS   | deleted path reconstructed after inode removal          |
| Both rename sides                  | PASS   | old.txt and new.txt records                             |
| Shell atomic save                  | PASS   | report.md attributed to PID 462                         |
| Editor atomic save                 | PASS   | editor.md attributed to PID 462                         |
| Single group content + dirent      | PASS   | both event families emitted                             |
| Live cgroup lookup                 | PASS   | 20 events resolved                                      |
| 500-renames without overflow       | PASS   | 500 rename events; overflow=0                           |
| Cleanup                            | PASS   | finally cleanup and post-delete client.list() assertion |

## Verdict and production gotchas

PASS: production can see an atomic-save write as a write to the real filename by retaining the temp handle's CLOSE_WRITE attribution and joining it to the source/target records of FAN_RENAME. Preserve a bounded handle-to-writer cache; handle replacement of an existing destination; normalize and prefix-filter resolved names; treat names as untrusted bytes; validate record lengths/types/version; keep the mount fd alive; expect `open_by_handle_at` privilege/filesystem constraints; treat PID/cgroup lookup as racy; count queue overflow; drain quickly; and remember fanotify is notification rather than a durable audit log. FAN_RENAME can coexist with legacy MOVED_FROM/MOVED_TO bits, so avoid double-counting one rename.
