# Team Space

Team Space makes collaborative work the normal workspace front door while
keeping Build as the operational view of agents, apps, files, and jobs. It is a
frontend composition over the existing API: conversations are sessions owned by
Duet, delegated work is represented by child sessions, and apps remain owned by
their existing agents.

The playground mock established the hierarchy and interaction model. Production
uses its own session, app, identity, and permission contracts rather than
promoting fixture objects into a second data model.

## Why it is shaped this way

Work and Build are presentations of the same workspace. The existing
`DriveWorkspaceShell` remains the only authenticated shell so billing, paused
state, workspace transitions, account controls, and handoff behavior continue to
have one owner. The Work frame changes the composition inside that boundary; it
does not layer a parallel shell over Drive.

A Team conversation is an ordinary, top-level, non-default session owned by
Duet. The first Home message creates the session, optionally with a specific
audience, and then opens the production conversation surface. This gives the
workspace multiple durable conversations without introducing a room schema or
mutating Duet's default-chat pointer.

Recent jobs come from the selected session's exact child collection. Only
machine-backed children are presented as jobs, grouped by the API's real state.
This is both more accurate and cheaper than reconstructing lineage from activity
or crawling every session page.

Apps and sessions keep the existing agent-owned pathname grammar. Work links add
presentation context in the query string: `mode=work` for top-level Duet
conversations and apps, and `workParent=<sessionId>` for child jobs. Those hints
are never treated as authorization or identity. The loaded session, parent,
default-session alias, and app owner must all validate before Work renders;
missing or failed ownership and session-classification data fails closed. Agent
setup state deliberately follows the existing agent-route rule: a readable
locked configuration blocks the app, while an unreadable configuration does not
invent a lock.

## Invariants

- There is one authenticated workspace shell. Hidden Work and Build trees are
  unmounted rather than kept alive behind each other.
- Playground fixture types never enter production data flow. Work projects the
  typed session, agent, app, identity, and audience contracts directly.
- A Work conversation is root-owned, top-level, non-default, parentless, and
  machine-less. A Work job is machine-backed and must have a validated Work
  conversation as its direct parent.
- The URL's agent slug is a claim to validate, not an ownership fact. Session
  ownership uses the returned session owner; app ownership uses nearest anchor
  containment across the complete loaded roster. An unresolved owner is never
  guessed to be Duet.
- Capabilities and returned `SessionSummary.permissions` control actions. UI
  roles are presentation hints, not browser-side authorization.
- Specific audiences use the shipped session audience contract. The production
  picker and manager own creation, updates, self-removal, and loss-of-access
  cache behavior.
- Conversations use `SessionsProduct` and apps use `AppFrameBody`; Team Space
  does not fork transcript, composer, streaming, attachment, app-launch, or app
  action semantics.
- Recent lists remain bounded. Because Work conversation/job kind is a frontend
  projection rather than an API filter, the client may advance through a small,
  capped prefix to fill the visible rail; it never drains an unbounded history.
  The jobs rail discloses when older children remain, and the compact Chats
  navigation is not presented as search or an archive. Unread is a
  boolean signal, never a fabricated count; unsupported mentions, grading,
  participant roles, app blurbs, and synthetic artifact metadata are omitted.
- Motion explains selection or spatial change, respects reduced motion, and
  stays out of long-running transcript content.

## Durable API seams

The Home composer calls the ordinary root session creation endpoint and may send
`audience: { kind: "specific", memberUserIds }`. The Work conversation list uses
the session list's `topLevel` filter with Duet ownership and default-session
exclusion. The Recent jobs rail reads the nested session-children endpoint and
discloses when older children remain. Both classified collections stop at a
fixed request budget when ineligible rows occupy their server pages.

Those filters are part of the web client's query keys as well as its requests,
so differently scoped collections cannot alias in cache. Child collections live
under the session-list cache family, allowing existing rename, archive, delete,
and refresh behavior to update an open rail. Selected conversations continue to
own their paged history and realtime stream.

## Deliberate omissions

The current API does not provide a durable room kind, mention inbox, numeric
unread count, custom participant role, human dispatcher, answer verdict, or
mock-specific app and artifact metadata. Team Space does not infer those facts.
If a durable session kind becomes necessary, it should replace the current
top-level Duet convention rather than add another client heuristic.

That convention can reclassify a legacy root-owned, parentless, non-default,
machine-less session as a Work conversation. No migration or workspace-wide
staging-data audit is part of this frontend change; rollout owners should inspect
that population before enabling Work broadly if legacy root sessions are common.

## Dead ends avoided

- A standalone production `TeamSpaceShell` would duplicate product boundaries.
- Copying the mock transcript or composer would lose production streaming,
  history, questions, uploads, errors, and audience behavior.
- Flattening workspace activity cannot prove an exact parent-child relationship.
- Intercepting every root session or app URL as Work regresses existing Build
  deep links. Presentation hints plus point validation preserve both contexts.
- Falling back to the root owner when roster or ownership resolution fails can
  expose the wrong destination or app controls. Owner-dependent surfaces remain
  unavailable until their dependencies succeed.

## Where the implementation lives

The Work composition and projections live in `apps/web/spa/team-space/`.
`apps/web/spa/drive/drive-workspace-shell.tsx` owns the Work/Build branch, while
`apps/web/spa/routes/agent-route.tsx` remains the single host for canonical
agent, session, and app paths. Session creation stays in
`apps/web/spa/routes/sessions.tsx`; list and child-collection contracts live in
`apps/web/spa/sessions/session-data.ts` and `apps/web/spa/api/`.

Behavior is pinned by the focused Team Space, route, query-key, session-data,
and API-client tests. Composition coverage is registered in the web playground
for Home, error, conversation, app, Build, recent-jobs, and selected-job states
on desktop and mobile, with a separate mobile breakpoint/overflow check.

This change deliberately does not add a second two-principal or Team-specific
staging journey. Team Space introduces no new realtime or visibility contract:
the existing specific-people staging journey owns the audience and
cross-principal proof, while deterministic Team Space browser fixtures own the
new Home, Work-routing, app, and delegated-child composition. A Team-specific
live journey would duplicate those two owners and cannot exercise this UI until
the branch is deployed, so it is outside this frontend delivery rather than an
unfinished closeout gate.

## Visual provenance

The hermetic playground mock remains as `team-space.png` under both the desktop
and mobile screenshot directories. The shipped composition is recorded beside
it as the `team-space-home`, `team-space-home-error`, `team-space-chat`,
`team-space-app`, `team-space-build`, `team-space-recent-jobs`, and
`team-space-job` desktop and mobile screenshots. The implementation preserves
the mock's full-height workbench, compact navigation rhythm, restrained Cobalt
accent, focused reading measures, responsive drawer behavior, and app dock while
removing fixture-only claims.
