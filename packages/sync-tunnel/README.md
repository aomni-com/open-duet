# @repo/sync-tunnel

`@repo/sync-tunnel` is the small protocol layer that lets sync traffic cross the
Duet edge path. It signs short-lived tunnel tokens, frames bytes over WebSockets,
generates Chisel command arguments, and can bridge a local TCP listener into a
tunnel WebSocket.

## Boundary

This package owns transport grammar, not share policy or Syncthing configuration.
The gateway decides when a tunnel is needed and how Syncthing should be wired;
the edge and contract agree on headers and token claims; this package keeps the
byte framing and token verification identical for both ends.

Backpressure is part of the protocol boundary. TCP reads pause while a WebSocket
is blocked; traffic arriving from a WebSocket waits only in a bounded queue for
the TCP drain. A peer that outruns that bound is disconnected so the sync
protocol can reconnect instead of hiding an unbounded backlog inside the VM.

## Pointers

- `src/index.ts` owns token derivation and verification, frame encoding,
  WebSocket send helpers, Chisel argv builders, and the TCP bridge.
- Shared header names and token claim shapes live in
  `packages/contract/src/edge`.
