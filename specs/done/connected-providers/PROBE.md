# Slice 00 — live probe results

Run 2026-07-23 against Example User's ChatGPT plan (device-code login, pi-ai
`loginOpenAICodexDeviceCode`, credentials at `~/.duet/codex-probe-auth.json`).
Probe script: `duet-agent scripts/probe-connected-providers.ts` (worktree
branch `connected-providers`).

## openai-codex (ChatGPT)

| Model id | Verdict | Notes |
|---|---|---|
| `gpt-5.5` | SERVED | 1-token completion, stop=stop (synthesis donor sanity check; not a curated model) |
| `gpt-5.6-sol` | SERVED | stop=stop; tool probe: emitted correct `toolCall` (stop=toolUse) |
| `gpt-5.6-terra` | SERVED | stop=stop |
| `gpt-5.6-luna` | SERVED | stop=stop |

- **Kill gate: PASSED.** All three 5.6 curated ids are served under a plan;
  Example User's assertion confirmed; pi-ai's 4-model `openai-codex` catalog entry
  is stale, as expected.
- **Prompt parity:** a Duet-shaped multi-section system prompt with
  tool-use instructions passed unaltered (clean single-word compliance;
  tool schema honored). Formal re-check with the real prompt builder can
  ride slice 06's live smoke.
- **`store:false`:** verified in pi-ai transport code (always sent); wire
  capture deferred to slice 06's smoke.
- **Tool calls:** work end-to-end (`get_weather` probe → `toolCall` block
  with correct arguments).

## Refresh behavior (MAP confirm-fact)

- **Refresh tokens ROTATE on every refresh** (new refresh token returned;
  new access valid ~10 days). Topology B's per-VM chains and the slice-01
  locking design are therefore load-bearing, as specced.
- **pi-ai bug found:** `refreshOpenAICodexToken` omits the `scope`
  parameter and OpenAI's token endpoint returns
  401 "Could not validate your token" without it. Adding
  `scope: "openid profile email"` makes refresh succeed. Consequences:
  - Slice 05: duet-agent owns its refresh call (single standard OAuth
    fetch with scope) instead of calling pi-ai's broken helper.
  - Slice 12: upstream PR list grows — (a) configurable originator,
    (b) injectable issuer URLs, (c) the refresh `scope` fix.

## github-copilot

Probed 2026-07-23 after Example User's device login (`~/.duet/copilot-probe-auth.json`).

- **Login + token exchange: WORK** (device flow completed, GitHub token
  exchanged for a Copilot API token; pi-ai's flow is sound end-to-end).
- **Plan: NOT ELIGIBLE** — `availableModelIds: []`, `modifyModels()`
  filters out every candidate, and a live `claude-haiku-4.5` completion
  terminates `stop=error`. Example User suspected the account isn't on a Copilot
  plan; confirmed. This is precisely the state slice 02's capability probe
  must classify as `plan_not_eligible`.
- **Directive (Example User):** implement + fixture-test the copilot path fully
  anyway; he tests live with a proper plan after the spec closes.
- **Transport fact for slice 05:** the Copilot API token is short-lived
  (~25 min TTL observed) vs codex's ~10-day access token — the in-process
  token cache must handle per-provider refresh cadences this different.

## Auth artifacts

`~/.duet/codex-probe-auth.json` (mode 0600) holds
`{access, refresh, expires, accountId}` — probe-scoped file; slice 01's
store owns the real format. Never committed, never printed.
