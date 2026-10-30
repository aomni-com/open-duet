# Edge WebSocket limits experiment

Date: 2026-07-06
Marker: SLICE11-EDGE-4D7W

## Scope

Measure the deployed Vercel edge project, not local/in-process tests. Local tests can prove
Upgrade forwarding and framing, but they cannot observe Vercel Fluid Compute WebSocket
duration, idle, or proxy buffering behavior.

## Setup

1. Deploy `apps/edge` to the Vercel project that will own `service.example.invalid`.
2. Provision two `duet-test` exe VMs from the gateway image built from this tree.
3. Configure VM A with `/v1/tunnel/accept` targeting a local TCP echo server on port 9555.
4. Have VM B connect through the public edge URL using `@repo/sync-tunnel` with:
   - `X-Exedev-Authorization: Bearer <vm-a-scoped-token>`
   - `X-Duet-Tunnel-Token: <short-lived TunnelToken>`
5. Run three connection profiles:
   - active stream: one 1 KiB frame every second for 45 minutes
   - idle stream: connect, complete auth, then send no data for 45 minutes
   - burst stream: 10 MiB total in 64 KiB frames with backpressure enabled

## Measurements

- active stream max connected duration: TO-MEASURE
- idle disconnect duration: TO-MEASURE
- close code/reason for active stream: TO-MEASURE
- close code/reason for idle stream: TO-MEASURE
- burst throughput and max `bufferedAmount`: TO-MEASURE
- reconnect success after edge-side close: TO-MEASURE
- bad/absent TunnelToken response at deployed edge: TO-MEASURE

## Pass/fail threshold

Pass Vercel edge for slice 15 only if all are true:

- active stream remains connected for at least 30 minutes or reconnects transparently within 5 seconds
- idle stream remains connected for at least 10 minutes or keepalive prevents idle closure at <=25 seconds
- burst stream completes 10 MiB without unbounded `bufferedAmount` growth beyond the package cap
- bad and absent TunnelToken attempts never establish a WebSocket
- reconnect preserves byte exchange after a forced close

Fallback to the named external Syncthing relay if any are true:

- deployed edge has a hard connection duration below 30 minutes without reliable reconnect
- deployed edge idle timeout cannot be avoided by ping/pong keepalive
- burst behavior requires a bufferedAmount cap so low that Syncthing throughput is unusable
- deployed edge strips or blocks the required auth headers before the gateway sees them

## Chisel verdict for this slice

Chisel remains the preferred production candidate because it is a single-binary TCP/UDP tunnel
over HTTP/WebSocket with SSH security, client auth, custom client headers, keepalive, and
auto-reconnect. This slice ships the minimal framing substrate instead of making chisel the live
probe path because `/v1/tunnel/accept` must prove Duet-owned TunnelToken verification at the
gateway boundary before slice 15 builds on it. The package still wraps chisel command construction
so a later pass can swap the transport without changing token/header ownership.
