import { DRIVE_UPLOAD_MAX_BYTES } from '@repo/contract'

/** Room above the cap for headers and framing, so the route always answers first. */
const TRANSPORT_HEADROOM_BYTES = 1024 ** 3

/**
 * The two ceilings the VM's HTTP server runs under.
 *
 * Both are transport limits, and both cut a request off before any route can
 * answer it — which is why they live together and why neither may be the thing
 * that decides whether a legitimate upload succeeds.
 */
export const gatewayServeLimits = {
  // Derived from the Drive's per-file cap, and deliberately in that direction.
  // Bun refuses an oversize body on its declared Content-Length alone, before
  // `fetch` and therefore before any CORS header — so its refusal reaches a
  // browser as an unexplained network failure rather than a status. Keeping the
  // ceiling strictly above the cap means the route, which can say why, always
  // answers first. Raising the cap past this ceiling would resurrect exactly
  // the bug this arrangement exists to prevent, which is why the number is
  // computed here and not written down twice.
  maxRequestBodySize: DRIVE_UPLOAD_MAX_BYTES + TRANSPORT_HEADROOM_BYTES,
  // Long-lived SSE (agent event stream) must not be killed by the default 10s
  // idle timeout during a gap between events; keepalive pings in the SSE route
  // reset this, but raise the ceiling to Bun's hard max as a backstop. A fully
  // stalled Train upload beyond 255s is dropped; Drive PUT explicitly disables
  // this timeout while streaming its request body.
  idleTimeout: 255,
} as const
