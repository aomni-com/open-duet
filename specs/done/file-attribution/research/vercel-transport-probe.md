# Vercel transport probe: SSE segment lifetime, buffering, keepalives (slice 14)

Probe run: 2026-07-12T21:38:58.931Z against the **deployed staging runtime**
(`https://service.example.invalid`, `x-vercel-id: sfo1::iad1::…` — Vercel edge →
Fluid Node function → exe.dev edge → in-VM gateway). Runner:
`packages/test-harness/scripts/sse-soak-probe.ts` (durable; re-probe
instructions below). Synthetic identity `staging-e2e-synthetic…@agentmail.to`;
all resources (session, workspace + VM, user) torn down in the same run
(`cleanup: complete`).

## Verdict: **SSE is viable — slice 17 ships SSE.**

Events reach the client immediately (no proxy buffering anywhere in the
chain), keepalives arrive at their exact 15s cadence, and the platform ends a
segment with a **clean stream close** at the function's `maxDuration` — which
the consumer treats as an ordinary reconnect (`Last-Event-ID` resume proven
live). Capped segments + resume is exactly the model slice 17's cursor grammar
already assumes, so neither kill criterion (segments dying young, events
buffered for seconds) was met. No long-poll fallback needed.

## Method

The probe drives the existing agent-session SSE — the one production consumer
of this transport — end to end:

1. Programmatic login (`POST /v1/admin/login-as`, same path as
   `staging-e2e-synthetic`), mark paid, grant credits, wait for the seed workspace VM
   to become active (~7s on staging's warm pool).
2. Start an agent session whose turn is deliberately long (the prompt makes
   the agent run `sleep 900` via its shell tool), so the SSE segment stays
   open with nothing but gateway keepalives (15s cadence,
   `packages/gateway/src/routes/agentSessions.ts`) — the worst case for
   intermediary buffering and idle cutoffs.
3. Record every received chunk with wall-clock arrival: bytes, keepalive
   count, `id:` frames, event types. Read until the segment dies (cap 1000s,
   past every plausible `maxDuration`).
4. Reconnect with `Last-Event-ID` to prove resume semantics on a second
   segment.

## Measurements

### Segment lifetime

| | |
|---|---|
| HTTP status / headers | `200`, `content-type: text/event-stream`, `transfer-encoding: chunked` |
| Time to first event bytes | 4.9s (includes gateway live-attach through the edge) |
| Segment lifetime | **300.4s**, ended by **clean stream close** (no error, no RST) |
| Terminal seen | no (agent was mid-`sleep 900`) |

The 300s cutoff is the **Vercel platform default `maxDuration`** — the
deployed staging build predates this slice's fix (apps/api's `vercel.json`
did not set `VC_MAX_DURATION`, so the emitted `.vc-config.json` carried no
`maxDuration`; that is MAP-SYNC L3's live agent-SSE decapitation bug,
measured here precisely). This slice adds `VC_MAX_DURATION=800` to
`apps/api/vercel.json`; **on the next staging deploy the same probe should
report a ~800s lifetime**. The cutoff semantics (clean close, resumable) are
the platform's and do not change with the number.

### Proxy buffering (event-to-client latency)

- The opening burst (session_created / user_prompt / turn_started / steps,
  ids 1–4) arrived in three chunks at +4.90s, +5.10s, +5.25s — flushed as
  produced, not accumulated.
- Every keepalive arrived as its own 13-byte chunk (`: keepalive\n\n`).
  Nothing in the chain (Vercel edge, Fluid runtime, exe.dev edge) held bytes
  back; there is no threshold-buffering and no coalescing.

### Keepalive delivery

18 measured inter-keepalive gaps against the gateway's nominal 15 000ms:
min 14 932ms, max 15 067ms (all raw gaps: 14969, 15000, 15000, 15001, 15003,
14997, 15000, 14999, 15001, 15001, 15000, 15001, 15067, 14932, 15001, 14998,
15002, 15040). Jitter ≤ 68ms over a 5-minute segment — cadence is delivered
essentially untouched.

### Reconnect / resume

`Last-Event-ID: 4` reconnect returned `200` and attached to the live tail;
first bytes arrived after 16.7s — that is the *next scheduled keepalive*, not
buffering (there were no durable events after id 4 to backfill, and the
gateway's keepalive timer starts per-subscription). The second segment then
delivered keepalives at the same 15s cadence until the probe cap. Sequence
continuity across segments is separately pinned by
`proveStreamingAndReconnect` in `packages/test-harness/src/staging-e2e-synthetic`
(canonical ids must be gap-free across reconnect), which runs in the staging
acceptance gate.

## Implications for slice 17 (file-events SSE feed)

- **Ship SSE** on the file-activity route with the slice-01 cursor grammar as
  `Last-Event-ID`/`?cursor=`. Treat segment end as routine: the platform will
  close cleanly at `maxDuration` (800s once the fix deploys; any intermediate
  redeploy without the env would regress to 300s — the
  `vercel-bundle-config` test pins the config so it can't silently drop).
- Emit keepalive comments on the same 15s cadence the agent feed uses; the
  chain delivers them punctually, so both sides' idle timeouts stay fed.
- No server-side batching workaround is needed; frames may be flushed as
  produced.

## Honesty notes / limits

- Measured on 2026-07-12 against the then-deployed staging build, i.e.
  **before** this slice's `VC_MAX_DURATION=800` landed anywhere. The 300s
  lifetime is the platform default, not the post-fix ceiling. Nothing was
  deployed by this probe.
- One soak run (plus one resume segment). Cadence/buffering numbers were
  unambiguous (68ms max jitter over 18 intervals); lifetime matched the
  documented platform default exactly, so repeated runs were not bought.
- The multi-GB streamed-response half of the original escalation was dropped
  with Direction C (bulk transfer rides Syncthing); this probe deliberately
  covers only the SSE/control-plane transport.

## Re-probe instructions (run after the next staging deploy)

```sh
# from the repo root (needs .env.keys for dotenvx)
bunx dotenvx run -f .env.staging -- bun packages/test-harness/scripts/sse-soak-probe.ts
```

Expected after a deploy that includes this slice: `soak.lifetimeMs` ≈ 800 000
(±grace), still `endedBy: clean_close`, keepalive gaps still ~15 000ms. The
script provisions and fully tears down its own synthetic user/workspace/VM and
prints a machine-readable `SSE_SOAK_REPORT {json}` line; if cleanup ever
reports `INCOMPLETE`, sweep with the staging-e2e-synthetic cleanup helpers using the
printed email.
