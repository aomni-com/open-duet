# Slice 10 — Jobs and nested Train

**Depends on:** slice 02. May run in parallel with Agents/Drive/Integrations.

## Contract unlocked

Map the top-level Jobs concept to the only honest scheduled-work signal in the
current frontend contract: sessions whose status is `sleep`. Keep Train as a
separate utility beneath the Duet agent identity.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Add a path-backed Jobs route and query the existing session list with
  `status: "sleep"`.
- Render real session titles, links, and activity timestamps in the reference's
  responsive Jobs density.
- Preserve loading, error, empty, search, and cursor continuation states.
- Link Train from the Duet card and keep its existing route/controller intact.
- Omit cadence, next run, pause, assigned agent, recurrence health, and schedule
  editing because `SessionSummary` does not expose those fields.

## API seam

The session data module remains the Jobs query owner. The existing Train
controller retains uploads, queries, mutations, polling, and memory actions.

## Human review surface

Desktop/mobile Jobs lists plus Train placement in the Duet card.

## Verification

- Red tests first for route selection and observable scheduled-session rows.
- Retain current Train behavior tests unchanged.
- Visual variable: responsive Jobs density and Train's nested placement.
- Run Docker visual checks, `compare-screenshots`, unprimed
  `screenshot-critique`, and non-blocking `preview-shots`.

## Stays green

Every current session and Train behavior contract.

## Feedback that changes the slice

Jobs density may change. The tab remains Jobs, Train remains nested, and
unavailable scheduling fields remain omitted.

## Implementation handoff

- Jobs is a frontend-only projection of `status: "sleep"`; it adds no endpoint
  or response field.
- Rows link to the real session detail. “Waiting to resume” is state copy, not a
  fabricated wake time.
- Train is linked once from the Duet card and is deliberately absent from the
  top tablist and account menu.
