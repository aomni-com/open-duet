# exe.dev WebSocket tunnel proof

Date: 2026-07-06
Marker: SLICE01B-PROBES-5T8V

## Verdict

Bytes pass over the authenticated WebSocket tunnel, and unauthenticated requests are rejected.

VM B dialed VM A at `wss://service.example.invalid:7444/` with `X-Exedev-Authorization: Bearer <vm-scoped token>`. The token was generated with `ssh-key generate-api-key --vm=<vm-a> --label=<label> --exp=1d` and was not written to this report.

## Evidence

- positive handshake: `HTTP/1.1 101 Switching Protocols`
- echoed payloads: `alpha, beta`
- positive round-trip latencies: 3 ms, 2 ms
- no auth header: `HTTP/1.1 307 Temporary Redirect`
- garbage auth header: `HTTP/1.1 401 Unauthorized`

Key observed lines:

```
url=wss://service.example.invalid:7444/
header=X-Exedev-Authorization: Bearer <vm-scoped token>
positive=HTTP/1.1 101 Switching Protocols; echoes=alpha,beta
negative-no-header=HTTP/1.1 307 Temporary Redirect
negative-garbage-header=HTTP/1.1 401 Unauthorized
duet-test leak check=none
```

## Mechanics pinned

- exe VMs expose private HTTPS proxy URLs as `https_url`; additional authenticated-only ports 3000-9999 are reached by adding the port to the VM hostname.
- For WebSocket transport, the URL form is `wss://<vm>.service.example.invalid:7444/`.
- The preferred VM proxy auth header is `X-Exedev-Authorization: Bearer <token>`.
- VM-scoped proxy tokens are generated through `ssh-key generate-api-key --vm=<vm-name>`; these are distinct from lobby `/exec` tokens.
- This probe pins the 2026-07-06 sharing-semantics conclusion as a repeatable transport check; it does not treat raw VM-to-VM TCP as available.

## Timings

- VM A create/ready: 1067 ms / 6458 ms
- VM B create/ready: 1014 ms / 3430 ms
- server listen readiness: 2851 ms

## Cleanup

- deleted: duet-test-tunnel-b-20260705t211829-31w0, duet-test-tunnel-a-20260705t211829-qxj2
- final `duet-test-*` leak check: none

## Addendum 2026-07-06 — sync-tunnel package probe (via @repo/sync-tunnel)

Green after retries (first attempts hit the known custom-image 504/boot-time
issue recorded in slice 04, plus a peer-image PATH fix). Two real VMs, peer B
dials peer A's gateway through exe's edge using the sync-tunnel package:

- image: `ttl.sh/duet-sync-tunnel-20260706t004907-gc8i:1h`
- route: `wss://service.example.invalid:3000/v1/tunnel/accept/<accept-id>`
- bytes: `alpha-from-b, beta-from-b`
- latencies: 44 ms, 3 ms
- missing TunnelToken: HTTP 401
- bad TunnelToken: HTTP 401
- create/ready A: 3753 ms / 3241 ms
- create/ready B: 4308 ms / 3055 ms
- gateway ready: 1199 ms
- cleanup: deleted duet-test-sync-b-20260706t010116-iocf, duet-test-sync-a-20260706t010116-fu6q; leak check none
