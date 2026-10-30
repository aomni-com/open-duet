# Slice 00 — source topology proof

Generated from packages/contract/src/marketplace/index.ts. The drive path is
what the gateway resolves, proved in packages/gateway/src/routes/publishes.test.ts
(`publish anchor placement decides whether the agent name is in the URL`).

| layout | publish anchor | agentSubpath | derived sourceUrl | resolves to |
|---|---|---|---|---|
| listing (agent anchor) | agents/sec-triage | (empty) | `https://staging.example.invalid/acme-labs/sec-triage?zip` | `agents/sec-triage` |
| official hub (parent anchor) | agents | research-assistant | `https://staging.example.invalid/official-agents-hub/official-agents/research-assistant?zip` | `agents/research-assistant` |

## Rejected by the schema (a handed URL a VM must refuse)

- `https://evil.com/a/b?zip` → rejected
- `https://staging.example.invalid.evil.com/a/b?zip` → rejected
- `http://staging.example.invalid/a/b?zip` → rejected
- `https://staging.example.invalid:8443/a/b?zip` → rejected
- `https://user:user@example.invalid/a/b?zip` → rejected
- `https://staging.example.invalid/a/b?raw` → rejected
- `https://staging.example.invalid/a/b` → rejected
