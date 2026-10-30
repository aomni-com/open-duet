# Slice 03 — Agents rail with real Sessions and Workspace Apps

**Depends on:** slice 02.

## Contract unlocked

Port the reference rail's visual hierarchy around Duet, the product's default
workspace AI, without fabricating an installed-agent backend entity.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Port the reference 20rem rail, local header, selected rows, edge fades,
  session preview/expand affordance, app tiles, dividers, and density.
- Present a single static Duet identity and redraw the controlled data contract
  around real `sessions` and `workspaceApps`; do not retain agent/role/skills/
  app-membership fields from `InstalledAgentsSidebar`.
- Add the one pure SPA projection from existing session and Apps query results.
- Render Sessions with a new-session action and truthful cursor/load-more state.
- Render Workspace Apps and Train inside the Duet card. Train is an agent
  utility, not a workspace-level tab.
- Omit installed counts, Discover, skills, agent ownership, and fake totals.
- Exercise loading, partial error, empty, populated, long-label, selected
  session, selected app, and next-page states in the typed playground.

## API seam

The shared rail primitive consumes real session/App rows plus callbacks only.
The SPA projection owns relative-time labels. Existing session/Apps query
owners retain fetching and pagination; “Duet” and its default-AI description
are static product copy, not API data.

## Human review surface

Desktop rail and mobile-drawer content states that preserve the source rhythm
while showing only real Duet concepts.

## Verification

- Red projection tests prove no `agentId`, role, skill, app ownership, installed
  count, or session total is derivable or rendered.
- Test selection, new-session callback, cursor load-more, empty/error states,
  and accessible groups.
- Visual variable: rail width, hierarchy, and density.
- Crop the left 20rem plus divider; mask top bar and main canvas.
- Run Docker visual checks, `compare-screenshots`, unprimed
  `screenshot-critique`, and a non-blocking `preview-shots` checkpoint.

## Stays green

Session and Apps data/controller tests; slice-02 top-bar shots.

## Feedback that changes the slice

Any request for multiple installed agents, skills, or agent↔app/session
ownership triggers the report/stop condition rather than a frontend
approximation.

**This condition fired on 2026-07-21 and is discharged.** The
[`agents`](../../done/agents/README.md) feature shipped the real entity
(`agents` Convex rows, anchored agent folders, `SessionSummary.agent`), so the
roster is no longer an approximation. It is owned by
[`agents-ui`](../../done/agents-ui/README.md), which **shipped** the real roster:
`AgentRosterRail` (`apps/web/spa/drive/agent-roster-rail.tsx`) replaced this
slice's single static Duet card, deleted the old `AgentsRail`, and restored the
`role`/`skills`/app-and-session-ownership fields this slice deliberately stripped
from `InstalledAgentsSidebar` (role/skills derived from agent files, D10). Do not
re-approximate it here, and do not treat this slice's data contract as the rail's
end state — `agents-ui` superseded it.

## Implementation handoff

- Sessions and Apps share one `AgentsWorkspace` owner; the former internal
  sidebars were removed, so no route can render two navigation rails.
- Desktop uses the reference-width rail. Mobile uses a modal navigation surface
  with Escape close, focus trap, and focus restoration.
- The rail renders only real session/App rows and a real Train route. It does
  not import fixture data or introduce a network contract.
- [Desktop and mobile evidence](../assets/03-agents/README.md) records the final
  browser review and the critique-driven title/Train placement fixes.
