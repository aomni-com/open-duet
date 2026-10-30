# Upstream earendil-works/pi report — FILED as https://github.com/earendil-works/pi/issues/7001 (2026-07-23)

Three changes duet-agent needs from `@earendil-works/pi-ai`, discovered
building connected-providers (all currently worked around):

1. **Bug — `refreshOpenAICodexToken` omits `scope` and always 401s.**
   OpenAI's token endpoint rejects `grant_type=refresh_token` without
   `scope: "openid profile email"` ("Could not validate your token").
   Fix: add the scope param in `refreshAccessToken`
   (`utils/oauth/openai-codex.ts`). Workaround: duet-agent owns its
   refresh fetch.
2. **Feature — configurable request `originator`.** `buildBaseCodexHeaders`
   (`providers/openai-codex-responses.ts`) hardcodes `originator: "pi"`
   after header merge, so embedders can't identify themselves. Fix: read
   from `OpenAICodexResponsesOptions` (default "pi").
3. **Feature — injectable OAuth issuer base URLs.** `AUTH_BASE_URL` etc.
   are module constants; embedders can't point login/refresh at a test
   issuer. Fix: optional override on the login/refresh entry points.
   Workaround: fakes registered via `registerOAuthProvider`.

Repro details and wire evidence: duet `specs/done/connected-providers/PROBE.md`.
