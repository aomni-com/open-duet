# Runtime API transport proof

The [receipt](receipt.json) records verification and streaming of a complete
constructed inventory through the API and its emitted Node function. The
[disk owner](../../../../../apps/api/src/runtime/release.ts) owns verification;
Vercel packaging calls that same owner before copying the constructor's output.
No component is rebuilt by the transport layer.

Successful inventory verification is cached for the API process because baked
release directories are immutable. Concurrent VM polls share that scan; failed
scans are evicted so incomplete local builds can recover. Each requested file
is checked again before streaming, without loading the executable into memory.

The [Node probe](node-function-probe.mjs) takes an emitted function directory.
It exercises the actual bundled API with a controlled backend query. Separate
selected integration tests retain the real local Convex authentication boundary.
The native capture reruns the constructor's existing release probe against a
frozen copy of the exact Vercel output, including the activation directory alias.

This pass is source work, not rollout approval. Root integration owns gateway
consumption and the shared wire schema. Existing gateways understand the prior
release envelope, so the operational bootstrap must install the transition
runtime while the old API is still deployed, verify recovery and activation
paths, and complete the fleet census before promoting the new API/backend.
The receipt records this deployment blocker rather than adding compatibility
routes to the new API.
