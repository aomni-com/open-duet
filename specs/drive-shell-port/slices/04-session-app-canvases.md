# Slice 04 — Real session and app canvases

**Depends on:** slice 03.

## Contract unlocked

Rail selection opens real Duet session or app content inside the reference
detail-header/canvas composition, with no duplicate domain controller.

## Work

- Invoke `write-tests`, then `ui-playground`.
- Split the current Sessions route into its existing controller/data owner and
  one controlled canvas; keep list/detail/SSE/actions/query keys singular.
- Port the reference detail header, back affordance, canvas width/overflow, and
  selection transition around the real session timeline/composer.
- Keep new-session as an unpersisted composer until first submit.
- Extract the current Apps overview/detail/actions into a controlled canvas and
  apply the same header/content relationship.
- Use only `drive-routes` callbacks; remove hard-coded product destinations from
  the extracted surfaces.
- Omit mock working files, agent subtitle/owner, assistant chat editor, and
  session↔file/app relationships.
- Prove real archive/delete/rename/interrupt/answer/note/message and app
  register/update/visibility/launch/delete flows in the composed surface.

## API seam

Existing session and Apps controllers own all queries/mutations. Controlled
canvas props contain data/status/actions; no new cache or wire view model.

## Human review surface

Selected session, new session, Apps overview, and selected app fixtures inside
the approved rail/shell.

## Verification

- Red tests first for URL selection, back/forward, new-session timing, action
  delegation, and absence of mock file/agent copy.
- Retain all existing session-data and Apps behavior suites.
- Visual variable: continuity from selected rail row to detail header/canvas.
- Freeze/mask the approved top bar and rail; compare only the Agents main pane.
- Run Docker visual checks, `compare-screenshots`, unprimed
  `screenshot-critique`, and non-blocking `preview-shots`.

## Stays green

Slices 01–03 and all session/app behavior.

## Feedback that changes the slice

Canvas density and header actions may change. Adding source mock messages,
files, or agent ownership does not.
