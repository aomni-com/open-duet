# @repo/email

`@repo/email` is the presentation boundary for transactional email. It owns
message copy, React Email documents, and deterministic preview fixtures without
knowing about recipients, secrets, delivery providers, persistence, or product
runtime state.

The root export prepares a typed message for browser previews and delivery.
`@repo/email/contracts` is React-free so schedulers can carry only serializable
inputs, while `@repo/email/render` is the production HTML boundary. Keeping the
renderer on an explicit subpath prevents browser fixtures from importing the
server-oriented rendering path.

Delivery callers remain responsible for recipients, environment-aware action
URLs, and idempotency keys. The backend delivery service owns claim/send/failure
ordering; this package never persists or logs token-bearing content.

The [transactional email rationale](../../specs/done/resend-transactional-email-templates/README.md)
records why these boundaries and the blue visual family were chosen, including
the reference and comparison screenshots.
