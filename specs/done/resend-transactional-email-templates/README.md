# Transactional email templates

Duet's four transactional messages—magic links, workspace invitations, shared
folders, and completed training jobs—form one code-owned React Email family.
They use the older Duet transactional visual language: a restrained white card
on gray, system typography, and one blue action. Production and the playground
consume the same typed presentation owner, so the screenshots audit the actual
message documents rather than lookalike fixtures.

## Why this shape

Transactional mail crosses two very different boundaries. Callers know the
recipient, destination, and idempotency identity; templates know the subject,
copy, and visual hierarchy. Keeping those responsibilities separate prevents a
caller from quietly inventing a fifth style or stale subject while keeping
React elements and rendered bodies out of Convex's serialized scheduler seam.

The templates live in code instead of Resend's dashboard because subjects,
copy, types, tests, and screenshot history need one reviewable version. The
backend still owns delivery state and the direct provider request. Resend
receives HTML without an authored `text` field and derives the plain-text
alternative, avoiding two copies that can drift. That behavior is part of the
[Resend Send Email contract](https://resend.com/docs/api-reference/emails/send-email),
not something Duet implements locally.

Personalization is deliberately limited to information already present in the
triggering flow: workspace role, sharer and folder names, training job and
recipient context, and the action URL. Email rendering must not become a reason
to add profile lookups or another data model.

## Principles and invariants

- `TransactionalEmailInput` is the only conceptual message schema. The Convex
  validator is serialization plumbing and is checked for assignability in both
  directions.
- Templates own subjects and presentation. Callers own recipients,
  environment-aware URLs, and idempotency keys; they never pass copy, HTML,
  plaintext, or React elements.
- A delivery is claimed before rendering. Duplicate claims return before render;
  render and provider failures travel through the same durable failed-delivery
  rail. Test capture renders before marking a delivery sent.
- The delivery ledger remains metadata-only. Bodies, typed inputs, and
  token-bearing action URLs must not enter rows, audit events, public results,
  or error messages.
- The provider adapter sends exactly one HTML body while retaining the existing
  sender override, bearer [REDACTED], and provider idempotency header.
- Each message has one primary action and a message-specific transactional
  footer. Marketing headers, unsubscribe UI, tracking, remote assets, and
  newsletter treatments do not belong to this family.
- The four deterministic fixtures are the semantic and visual oracle. The web
  playground frames the real documents; it does not own a second renderer or a
  parallel copy set.
- Chromium baselines are deterministic regression evidence, not certification
  of Gmail, Outlook, or Apple Mail behavior.

## Code and behavior pointers

The public presentation boundary is in `packages/email`:

- `src/contracts.ts` owns `TRANSACTIONAL_EMAIL_KINDS` and
  `TransactionalEmailInput`.
- `src/prepare.tsx` owns exhaustive dispatch and synchronous subjects;
  `src/render.tsx` owns production HTML serialization.
- `src/email-shell.tsx` owns shared styling, while the four named template
  modules own message copy.
- `src/fixtures.ts` owns deterministic preview inputs, and
  `src/prepare.test.tsx` pins representative rendered copy, actions, escaping,
  and the one-action rule.

Operational delivery remains in `packages/backend`:

- `convex/services/email.ts` owns claim/render/capture/send/failure ordering and
  the Convex validator parity checks.
- `convex/services/resendTransport.ts` owns the provider request shape.
- `convex/domains/emailDeliveries/model.ts` and `convex/schema.ts` own durable
  delivery metadata and retry state.
- `convex/auth.ts`, `convex/domains/invitations/actions.ts`,
  `convex/domains/shares/actions.ts`, and `convex/domains/train/model.ts` map the
  four triggering flows into the serializable union.
- `src/resend-transport.test.ts`, `src/share-email.test.ts`,
  `src/invitations.test.ts`, `src/auth-workspaces.test.ts`, and
  `src/train.test.ts` pin provider shape, replay, cleanup, failure, secrecy, and
  caller behavior.

The browser audit surface is under
`apps/web/components/playground/email/`. Its four registry entries produce one
desktop and one mobile baseline each in
`apps/web/tests/visual/__screenshots__/`. Coverage and registry-union checks
prevent an entry from silently disappearing; the checked-in desktop/mobile
project configuration and eight named baselines record the two-viewpoint
contract.

## Decisions that differed from the reference

The sibling `chat-app` reference used an older split React Email dependency
stack. Duet uses the current unified `react-email` package instead; copying the
old package layout would preserve incidental dependency history rather than the
visual and behavioral contract.

The reference's generic invitation copy was not copied wholesale. It supplied
the shell, spacing, type hierarchy, and blue action; each Duet message received
purpose-specific, warmer copy and only the personalization its caller already
had. The final footer color was strengthened after screenshot critique because
the first gray was too weak at normal viewing size.

Convex code generation also reformatted every generated declaration under the
newer local generator. Only removal of the obsolete share-email module belongs
to this feature; the unrelated generated formatting churn was intentionally
discarded.

## Rejected paths

- Resend-hosted templates split ownership between code and a dashboard.
- Caller-authored plaintext or subjects recreate competing presentation owners.
- A temporary `text | html` action, compatibility wrapper, or dual send weakens
  the hard cutover and leaves cleanup work with no product value.
- Caller-side React elements cannot cross the serialized scheduler boundary.
- A backend-only preview renderer or copied playground markup would let the
  audited image diverge from production.
- New profile lookups, stored bodies, marketing lifecycle mail, cross-client
  certification, and an SDK migration solve different problems.

## Visual provenance

The accepted target is copied from sibling `chat-app` commit
`f8390c896c91e922c5462a515932053f93548db8`, specifically its generic-invite
template and email playground. These images drove the light-gray canvas, white
600px card, restrained border and radius, system type scale, mobile padding,
and blue CTA:

- [desktop reference](assets/reference/chat-app-generic-invite-desktop.png)
- [mobile reference](assets/reference/chat-app-generic-invite-mobile.png)

The accepted Duet family and the comparison telemetry used to judge it are
also preserved:

- [desktop family montage](assets/visual-review/slice-01/desktop-family.png)
- [mobile family montage](assets/visual-review/slice-01/mobile-family.png)
- [desktop candidate/reference comparison](assets/visual-review/slice-01/comparison/share-desktop-side-by-side.png)
- [mobile candidate/reference comparison](assets/visual-review/slice-01/comparison/share-mobile-side-by-side.png)

Those artifacts record the standard and the accepted result together; the
remaining crops, edge maps, and pixel diffs in the same directory are objective
telemetry behind that decision.

The user's attached broadcast screenshot is preserved as rejected context:

- [broadcast context, not the target](assets/context/attached-broadcast-not-target.png)

It prompted the audit but did not define the result. Its rounded newsletter
card, black button, unsubscribe treatment, and personal sign-off belong to
broadcast mail, not this transactional family.
