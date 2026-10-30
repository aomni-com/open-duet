# Custom image + systemd boot proof

Date: 2026-07-06
Marker: SLICE01B-PROBES-5T8V

## Verdict

works: custom image boots with systemd as PID1 in auto mode.

The image was pushed anonymously to ttl.sh as `ttl.sh/duet-test-image-mr8agza9-cj753l:1h`. The private-registry path is `new --image <registry>/<image>:<tag> --registry-auth USERNAME:PASSWORD`; the credential value is a single flag argument for the registry hosting `--image`. This probe did not log in to a registry and did not write registry credentials.

## Evidence

- auto: works, vm=duet-test-image-auto-20260705t211414-6wa3, pid1=systemd, unit=active, new=2302 ms, ssh-ready=3304 ms, service-ready=2884 ms, restart=1300 ms, restart-ssh-ready=4987 ms, restart-service-ready=3558 ms, deleted=duet-test-image-auto-20260705t211414-6wa3

Key observed lines:

```
/proc/1/comm=systemd
systemctl is-active hello-exedev.service=active
first boot curl=http 200 "hello from systemd"
after restart curl=http 200 "hello from systemd"
duet-test leak check=none
```

## Mechanics pinned

- `ssh exe.dev help new` exposes `--command` values `auto`, `none`, or a custom command, `--image`, `--tag`, `--cpu`, `--memory`, and `--registry-auth USERNAME:PASSWORD`.
- The systemd proof requires both an HTTP response on a 3000-9999 port and `/proc/1/comm=systemd` with the unit active after first boot and after `restart`.
- All VMs created by this probe used `--cpu 1 --memory 2GB --tag duet-test` and names starting `duet-test-`.

## Local image build

```
docker build --platform linux/amd64 -t ttl.sh/<unique-name>:1h <generated-context>
docker push ttl.sh/<unique-name>:1h
Successfully built b61067cdbf9c
Successfully tagged ttl.sh/duet-test-image-mr8agza9-cj753l:1h

DEPRECATED: The legacy builder is deprecated and will be removed in a future release.
            Install the buildx component to build images with BuildKit:
            https://docs.docker.com/go/buildx/
635b260caedf: Mounted from duet-test-image-mr8abfch-bpkvsx
ca2678b20700: Mounted from duet-test-image-mr8abfch-bpkvsx
d6323e5a4fec: Mounted from duet-test-image-mr8abfch-bpkvsx
ef58bead8959: Mounted from duet-test-image-mr8abfch-bpkvsx
be2b093f11ec: Mounted from duet-test-image-mr8abfch-bpkvsx
1h: digest: sha256:b61067cdbf9c43aacc0420fe460b079870bf6f592a027be0fe380be9d15b24db size: 1405
```
