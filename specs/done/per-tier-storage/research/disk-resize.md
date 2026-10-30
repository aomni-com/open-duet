# Probe: exe.dev disk resize (per-tier storage)

- create 10GB: 1734 ms; ssh ready: 8866 ms
- resize 10GB -> 20GB (running): 650 ms
- restart after grow: 2533 ms; root fs 10464022528 -> 21024600064 bytes
- payload checksum MATCHES across the resize
- cleanup deleted: duet-test-diskresize-20260721t162335-enl4

### Baseline at 10GB

```
df: /home/synthetic-user/drive: No such file or directory
Filesystem      Size  Used Avail Use% Mounted on
/dev/root       9.8G  4.2G  5.1G  46% /
Filesystem      Size  Used Avail Use% Mounted on
/dev/root       9.8G  4.2G  5.1G  46% /
```

```
NAME         SIZE TYPE MOUNTPOINT
nbd0            0 disk 
nbd1            0 disk 
nbd2            0 disk 
nbd3            0 disk 
nbd4            0 disk 
nbd5            0 disk 
nbd6            0 disk 
nbd7            0 disk 
vda   10737418240 disk /
nbd8            0 disk 
nbd9            0 disk 
nbd10           0 disk 
nbd11           0 disk 
nbd12           0 disk 
nbd13           0 disk 
nbd14           0 disk 
nbd15           0 disk
```
### After writing 3GB to the drive

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/root       9.8G  7.2G  2.1G  78% /
/dev/root       9.8G  7.2G  2.1G  78% /
```
### resize --disk=20GB response

```
{
  "disk_new_bytes": 21474836480,
  "disk_old_bytes": 10737418240,
  "vm_name": "duet-test-diskresize-20260721t162335-enl4"
}
```
### Immediately after resize, no reboot (live grow: NO)

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/root       9.8G  7.2G  2.1G  78% /
/dev/root       9.8G  7.2G  2.1G  78% /
```

```
NAME         SIZE TYPE MOUNTPOINT
nbd0            0 disk 
nbd1            0 disk 
nbd2            0 disk 
nbd3            0 disk 
nbd4            0 disk 
nbd5            0 disk 
nbd6            0 disk 
nbd7            0 disk 
vda   10737418240 disk /
nbd8            0 disk 
nbd9            0 disk 
nbd10           0 disk 
nbd11           0 disk 
nbd12           0 disk 
nbd13           0 disk 
nbd14           0 disk 
nbd15           0 disk
```
### After reboot

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/root        20G  7.3G   12G  39% /
/dev/root        20G  7.3G   12G  39% /
```

```
NAME         SIZE TYPE MOUNTPOINT
nbd0            0 disk 
nbd1            0 disk 
nbd2            0 disk 
nbd3            0 disk 
nbd4            0 disk 
nbd5            0 disk 
nbd6            0 disk 
nbd7            0 disk 
vda   21474836480 disk /
nbd8            0 disk 
nbd9            0 disk 
nbd10           0 disk 
nbd11           0 disk 
nbd12           0 disk 
nbd13           0 disk 
nbd14           0 disk 
nbd15           0 disk
```
### resize --disk=5GB (shrink attempt)

```
REJECTED: exe.dev command failed: resize duet-test-diskresize-20260721t162335-enl4 --disk=5GB (http 422)
{"error":"--disk must be larger than current provisioned disk size (20 GB)"}
```
### resize --disk=20GB (same size, no-op downgrade)

```
REJECTED: exe.dev command failed: resize duet-test-diskresize-20260721t162335-enl4 --disk=20GB (http 422)
{"error":"--disk must be larger than current provisioned disk size (20 GB)"}
```
### stat --json (control-plane usage reporting)

```
stat failed: exe.dev command failed: stat duet-test-diskresize-20260721t162335-enl4 --range=24h (http 403)
{"error":"command not allowed by token permissions"}
```
### cp --disk=10GB from a 20GB VM holding 3GB

```
REJECTED: exe.dev command failed: cp duet-test-diskresize-20260721t162335-enl4 duet-test-diskresize-20260721t162335-enl4-small --disk 10GB (http 422)
{"error":"disk size cannot be smaller than source (21474836480 bytes)"}
```
