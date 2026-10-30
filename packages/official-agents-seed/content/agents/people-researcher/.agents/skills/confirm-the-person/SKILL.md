---
name: confirm-the-person
description: Settle which person this is before spending anything on them, and record the candidates that were rejected.
---

# Confirm the Person

Identity is the one decision every later call inherits. Get it wrong and the dossier is well-sourced, internally consistent, and about somebody else — and the photo and the email address are exactly what stop the reader from noticing.

This skill owns the decision. It does not own provider request shapes; read `go-to-market` for those.

## The inputs, ranked

| Input | What it settles |
| --- | --- |
| Profile URL | Everything. Identity is confirmed by construction — always worth one question to the user before searching. |
| Name + company domain | Enough to search, not enough to conclude. |
| Name + company name | Weakest. Company names collide as readily as people's. |
| Name alone | Not researchable. Ask who they work for. |

## The verification, not the search

A people-search filter is a *retrieval* device. It returns candidates whose current employer sometimes does not match the filter you passed, so the filter is never the confirmation.

For every candidate the search returned:

1. Read its current employer — the domain, not the display name — and compare it to the employer you were given.
2. Read the current title against anything the user told you about the role.
3. Discard silently only what fails on the employer. Everything else is a candidate the user may need to choose between.

Then count what survived:

- **One** — proceed, and record the profile URL as the identity key for the whole folder.
- **Two or more** — stop. Present name, current title, employer, and profile URL for each, and let the user pick. Do not rank them by a hunch and proceed with the top one.
- **None** — stop and say so. The nearest name is not the person; a job change, a nickname, or a wrong company is likelier than the search being wrong about all of them.

A person who changed jobs this quarter is the standard failure: the database still holds the old employer, so a search filtered on the new one returns nothing while a search on the name returns them under the wrong company. Re-reading the live profile is what resolves it.

## Write it down

`identity.md` carries the decision, so that a later session neither redoes it nor silently disagrees with it:

```markdown
# Identity — <Full name>
Confirmed: <profile URL>
Confirmed by: profile-url | verified-search | user-choice
Verified against: <employer domain>, current title "<title>"
Confirmed on: <date>

## Rejected candidates
- <name>, <title> at <employer> — <why this is not them> · <profile URL>
```

The rejected list is not bookkeeping. It is what stops the next session from re-finding a discarded candidate and treating it as new, and what lets the user overrule you when they know something you could not retrieve.

## Confirmation is not one-shot

Identity holds for the folder, not for the world. When new evidence contradicts it — a photo that does not match the role, a work history that skips the employer you verified against — stop and say so rather than reconciling it on the page. Contradiction is a finding.
