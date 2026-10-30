# 60-second demo runbook

Marker: `SLICEDEMO-9K4T`.

This runbook is the launch operator guide for the slice 20 demo gate. The current
probe proves the live Duet spine from real VM provisioning through duetfs install,
device approval, file write, publish registration, and public edge/gateway fetch.
The train and agent-answer steps are intentionally mocked at the frozen
`@duetso/agent` contract until Example User ships that CLI surface.

## What The Probe Owns

The acceptance probe lives in `packages/test-harness/src/demo-60s.ts`, with the
gated test in `packages/test-harness/src/demo-60s.test.ts` and a direct runner at
`packages/test-harness/scripts/demo-60s.ts`.

It must keep these boundaries:

- Real infrastructure: Convex local dev, the API app, an exe.dev VM from the
  configured image, duetfs installed inside a fresh Docker container, the device
  code flow, the files API, publish metadata, and edge/gateway serving.
- Deferred-agent seam: `duet train`, `duet --rpc`, and the memory records they
  produce or consume. The mock must stay shaped like the frozen contract in
  `agent-cli-contract.md` so the real binary can replace it without changing the
  demo story.
- Security invariant: the device token endpoint must not yield a key before the
  human approval mutation runs. The probe asserts this before approving.

## Running The Mock-Agent Probe

Run from the repository root after `bun install`:

```bash
EXE_TOKEN=... \
DUET_REAL_VM_IMAGE_REF=... \
RUN_DOCKER_TESTS=1 \
bun run --cwd packages/test-harness demo:60s
```

The runner skips without the real-VM and Docker opt-ins. Passing output includes
`SLICEDEMO-9K4T_TIMELINE` with per-step timings, the public Duet URL that was
fetched through the edge app, the VM names created and deleted, and the leak
check result.

## Flipping Mock To Real

The real `@duetso/agent@0.1.202` contract is the one recorded in
`agent-cli-contract.md`:

- `duet capabilities` does not exist; Duet must not preflight capabilities.
- `duet memory add` writes `kind: "note"` rows and uses
  `--source <user|agent|system|api|import>`.
- `duet memory recall` replaces the deleted `memory search` command and emits a
  bare best-first JSON array when `--json` is set.
- `duet train <folder> [--slug <slug>] [--model <model>] [--db <path>] [--wait <seconds>]`
  has no `--json` or NDJSON create stream; success is exit `0`, followed by
  `duet train show <slug> --json`.
- `duet --rpc --session <id> --workdir <cwd>` receives a separate
  `{ "type": "prompt" }` command after start. RPC events have no
  `protocolVersion`; terminal event types are `complete`, `ask`, `interrupted`,
  and `sleep`.

Run with `DUET_DEMO_AGENT_MODE=real`. That flag removes the mock train
dispatcher and mock gateway fetch intercepts, so the API route calls the gateway
on the VM for train, memory, and agent session traffic. It also enables the
model-gateway leg: the API delivers `DUET_API_KEY` and `DUET_GATEWAY_BASE_URL`
credentials through VM register/heartbeat responses when
`DUET_MODEL_GATEWAY_URL` is configured. The hermetic probe boots a local
model-gateway backed by the fake Vercel AI Gateway; live deployed-gateway runs
can set `DUET_MODEL_GATEWAY_URL` directly.

The pass criteria are the same user story plus billing proof: the train job
reaches `done`, searchable system train memories exist, the agent turn reaches a
terminal state, the answer cites the seeded memory, at least one model-gateway
generation for the demo workspace settles with a `usage` or `reservation` debit
in `creditTransactions`, and the published artifact is fetched live at
`service.example.invalid/{workspace}/{slug}`.

Do not edit `/Users/synthetic-user/dev/duet-agent` from this repo. The flip is a Duet
probe configuration/code change only after the agent binary is available in the
VM image.

## Real Demo Operator Flow

The public launch demo is the same chain a user should see:

1. Start from a fresh machine or fresh container.
2. Ask the coding agent to set up Duet.
3. The agent reads the install path, installs `duetfs`, and runs device pairing.
4. A human approves the displayed code once in the browser.
5. The agent bootstraps memory from a company URL.
6. The agent answers a business question using that seeded memory.
7. The agent writes an on-brand artifact, publishes it, and opens the public URL.

The launch gate passes only when this completes against real train and real
agent RPC inside sixty seconds, with no raw API key shown to the agent or human.

## Launch Checklist

These gates must be explicitly reviewed before public launch:

- Abuse controls: live from slice 20e, including caps, metering, endpoint rate
  limiting, takedown behavior, and robots headers.
- Billing review: still a human review gate from slice 19 before real money
  moves.
- WebSocket limits: slice 11 Vercel WS-limit go/no-go remains open until the
  deployment experiment confirms the edge posture or selects the relay fallback.
- Write-share sign-off: slice 13/15 graph semantics need final human sign-off
  before launch.
- Model gateway: deploy `service.example.invalid` or use the hermetic local gateway;
  set `DUET_MODEL_GATEWAY_URL` for deployed-gateway runs, and confirm VM
  heartbeats request model credentials.
- Agent/image order: release the agent with dedicated `DUET_GATEWAY_BASE_URL`
  support, rebuild the VM image with that release, then run real mode.
- Demo gate: flip to `DUET_DEMO_AGENT_MODE=real` and require the live
  sixty-second run plus the reconciled ledger debit assertion to pass.
