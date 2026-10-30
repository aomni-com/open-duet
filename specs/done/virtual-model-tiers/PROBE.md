# Slice 00 — probe verdicts

Run 2026-07-27. Three kill gates from `slices/00-probes.md`.

## (a) Cached-token telemetry — **SETTLED LIVE 2026-07-30**

Measured with two real calls through the gateway (large stable prefix,
`caching: 'auto'`, sonnet-5): **the generation record's counts are
disjoint.** The cache-read call returned `tokens_prompt: 2` with
`native_tokens_cached: 11974`; the write call returned `tokens_prompt: 2`
with `native_tokens_cache_creation: 11974`. Prompt tokens exclude both cache
reads and cache writes. (The chat-completion `usage` object DOES fold cached
tokens into `prompt_tokens` — 11976 — but settlement reads the generation
record, where they are exclusive.)

Normalization now shipped: `uncached = tokens_prompt +
native_tokens_cache_creation` (cache writes bill at the input rate; their
1.25x upstream write premium sits inside the tier margin), `cached =
native_tokens_cached`, nothing subtracted. The earlier subtractive reading
and its disjoint-counts `charge_failed` guard are deleted — that payload is
the steady state of every multi-turn session, not an anomaly.

## (b) Pinned-agent bare-tier boot — **PASS**

The image-pinned agent is `@duetso/agent` **0.3.5** (root `package.json:10`),
and it already ships virtual tiers — no Train-1 blocker for local development.

```
$ duet --help
  -m, --model <name>   Virtual tier (frontier|balanced|economy) or concrete model pin

$ DUET_API_KEY=… node -e "resolveCliModel('frontier', new Set())"
frontier {"modelName":"frontier","source":"explicit","routed":true}
balanced {"modelName":"balanced","source":"explicit","routed":true}
economy  {"modelName":"economy","source":"explicit","routed":true}
providers configured: ["duet-gateway"]
```

With **only** `DUET_API_KEY` set, `configuredRouterProviders()` resolves to
`["duet-gateway"]` — bare tiers route through the gateway on the VM-delivered
credential alone, as slice 09's bare spawn requires.

**Bonus — closure ids independently confirmed.** `pinnedModelReference` on the
pinned agent resolves every routing-table shorthand to the same gateway ids
slice 01 hand-seeded:

| shorthand | resolves to |
|---|---|
| fable | `anthropic/claude-fable-5` |
| opus | `anthropic/claude-opus-5` |
| sonnet | `anthropic/claude-sonnet-5` |
| sol | `openai/gpt-5.6-sol` |
| terra | `openai/gpt-5.6-terra` |
| luna | `openai/gpt-5.6-luna` |
| glm | `zai/glm-5.2` |
| kimi | `moonshotai/kimi-k3` |

The live legs — a real VM boot and a real request carrying `x-duet-tier` — are
slice 04's capture step, which needs the rebuilt image to be meaningful.

## (c) Self-heal convergence bound — **MEASURED 2026-07-31**

After the staging api deploy went Ready (advertising 0.3.7), the single
active staging VM reported agent 0.3.7 within ~30 minutes end to end
(including the deploy pipeline; the npm rail's own convergence is bounded by
its 5s poll + install/smoke-test time). Good enough for the cutover window;
stale e2e workspaces (deleted/unhealthy rows) never converge and don't need
to.

## (c) original notes (pre-measurement)

Cannot be measured locally: it requires observing a real desired-version change
converge on (1) an idle VM and (2) a VM with an active runner. Slice 04 already
owns a live staging step and is the natural place; it must record idle and
post-runner-exit convergence times there.

Not a blocker for slices 01–03 or 05–08. It bounds the *cutover window* only
(slice 14 step 3), so it must be answered before Train 3 promotes — not before
the code is written.

Relevant mechanics, read from code:
- desired-state poll defaults to 5s (`apps/api/src/config.ts`,
  `packages/gateway/src/vm/sync-client.ts:213-232`), with error backoff to 300s
  (`sync-client.ts:161-206`).
- The npm rail refuses activation while a runner is active, then installs,
  smoke-tests, and atomically activates (`packages/gateway/src/runner/npm-rail.ts:73-153`).
  So "5 seconds" is the poll interval, never the convergence bound.
