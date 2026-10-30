# Archive default chat

A control in the agent surface's `CHAT` sub-header that demotes the current
default chat to an ordinary session — it leaves the chat panel, enters the Jobs
dialog, and the owner's next message mints a fresh default.

[`MAP.md`](./MAP.md) is the spec: 11 settled decisions (D1–D11) and 11 landmines
(L1–L11). [`choices.md`](./choices.md) is the ledger of decisions made where the
map was silent.

## Status

Built on branch `worktree-reset-default-session`. All lanes landed.

| lane | scope | state |
| --- | --- | --- |
| contract | `SetDefaultSessionRequestSchema`, the `agents.defaultSession.set` entry, the family tuple test | done |
| backend + api | Convex `setDefaultSession`, the `PUT` route, one shared pointer writer | done |
| web | client + `SpaApi`, fixture pointer (L4), invalidation (L3), `created` clear (L1), pending-disable (L8), the header control and dialog, i18n (L7) | done |
| docs | coverage ledger 141 → 142, the alias section's binding rules | done |
| visual gate | the control given real coverage in two playgrounds; families force-regenerated from a clean build | done |

**No visual regressions.** The full web visual suite fails 18 shots on pristine
`HEAD` and 17 on this branch — all 17 are in HEAD's 18, and the shot this branch
repairs is `agent-surface-setup`. Evidence and the staleness diagnosis are in
[`choices.md`](./choices.md) entries 1–4.

## The seam

```
PUT /v1/ws/{workspaceSlug}/agents/{agentSlug}/sessions/default
    { "sessionId": string | null }  →  200 { "session": SessionSnapshot | null }
```

`null` demotes. The archived session is **not** touched — `archiveState` stays
`active`, its turn keeps running, and it simply stops being the row that
`excludeDefault` hides. `root` is an owner like any agent.

The set direction exists on the wire and is deliberately **not** surfaced in the
product (D5): there is no "Make default" affordance anywhere.

## Gates

- narrowest runner while iterating; the repo-root `bun run test` is the closeout
  gate only
- `bun run check-types` in each touched workspace
- `apps/docs`: `verify:endpoints`, `verify:content` — both green
- the visual gate is the expensive one; see L6 for the specific assertions in the
  blast radius

## Next Agent Prompt

The feature is built and its gates are green. What is left is not this feature:

1. **The 18 stale visual baselines on `HEAD`** (`choices.md` entry 1). They are
   real staleness, not flake — at least one traces to a commit that changed
   behaviour without re-approving its shot. They deserve their own pass, and
   `playwright.config.ts:6` wants `maxFailures` raised so a suite that aborts at
   the first failure stops hiding the rest.
2. **The affordance question** (`choices.md` entry 6) — the control is quiet by
   design (D7) and reads as a caption until hover. One line if the answer is
   "make it a step stronger".
3. **L2 is accepted, not fixed.** The gateway keeps writing `default-session.md`
   into a demoted thread's system prompt forever. Do not fix it here; the
   one-line change and its rationale are in `MAP.md`.

L9, L10 and L11 remain sharp edges, deliberately.
