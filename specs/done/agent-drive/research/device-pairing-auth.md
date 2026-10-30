# Device Pairing Auth Findings

Slice 03 implements Duet API keys plus a device-code pairing flow. This is not a
full OAuth authorization server yet; it deliberately borrows the proven device
authorization semantics so CLI/agent clients get familiar behavior while MCP and
web launch slices can grow toward standard OAuth surfaces later.

## Parameters Chosen

- `user_code`: 8 characters displayed as `XXXX-XXXX`, using
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. The length and hyphen grouping match the
  GitHub device-flow convention, while the alphabet drops ambiguous `I`, `O`,
  `0`, and `1` for manual transcription.
- `device_code`: 32 random bytes encoded as 64 lowercase hex characters. This is
  only used by the polling client, never typed by the human.
- Expiry: 15 minutes (`expires_in: 900`). RFC 8628 requires finite device/user
  code lifetime, and GitHub's documented device flow defaults to 900 seconds.
- Poll interval: 5 seconds. GitHub documents `interval: 5` as the default minimum
  polling interval; RFC 8628 requires clients to respect the returned interval.
- `slow_down`: polling before the current interval returns `slow_down` and adds
  5 seconds to the minimum interval. This follows RFC 8628 and GitHub's stated
  behavior.
- Single-use: the first approved poll returns a scoped `duet_sk_...` key and
  moves the device code to `consumed`; later polls return `consumed` and never
  replay the key.
- Unknown `device_code`: returns the same shape as an unapproved pending code,
  so polling cannot be used as a code oracle.

## Invariants

- Human approval is non-bypassable: device-code creation is public, but approval
  is an authenticated Convex mutation that rechecks the approving user's current
  workspace role against every requested scope.
- API keys are scoped bearer [REDACTED], not workspace-admin sessions. A key can
  satisfy only its exact `ws:{slug}:{capability}` scopes, except `admin`, which
  implies all capabilities within the same workspace only.
- The full API key is returned exactly once at issuance or approved polling. Only
  SHA-256 hashes are persisted; audit provenance stores display prefixes only.
- Device approval/denial and key issuance/revocation write through the single
  workspace audit stream.
- The temporary `/device` page is only a code-entry shell in this slice. Real
  human identity is pinned at the authenticated Convex approval seam until the
  slice 20 web app replaces the page.

## Source-Backed Rationale

- RFC 8628 defines the core device authorization states used here:
  `authorization_pending`, `slow_down`, `access_denied`, and `expired_token`, and
  says `slow_down` increases the polling interval by 5 seconds. It also requires
  clients to wait at least the returned `interval` between polling attempts.
  Source: https://datatracker.ietf.org/doc/html/rfc8628
- GitHub's device flow is the closest agent/CLI precedent for developer tools:
  it returns a 40-character device code, an 8-character user code with a middle
  hyphen, `expires_in: 900`, `interval: 5`, and sends users to a stable browser
  verification page. Duet mirrors the human-facing length/grouping, expiry, and
  polling cadence, while using Duet-owned scoped keys instead of GitHub tokens.
  Source: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- GitHub App device-flow docs specify that a `slow_down` response adds 5 seconds
  to the minimum poll interval and that expired codes require restarting the flow.
  Source: https://docs.github.com/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- Current MCP authorization practice is OAuth-based: protected MCP servers act as
  resource servers, clients act as OAuth clients, and implementations should use
  OAuth 2.1 security measures plus discovery metadata. Slice 03's scoped bearer
  keys are intentionally narrower than full MCP OAuth, but the device-code shape
  keeps the future hosted MCP auth path aligned with those expectations.
  Source: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
