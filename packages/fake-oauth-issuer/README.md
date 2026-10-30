# @repo/fake-oauth-issuer

`@repo/fake-oauth-issuer` owns Duet's dependency-free OAuth test issuer. Its
`Request`/`Response` handler carries two unrelated wire contracts used by both
hosted staging routes and local integration tests:

- the **RFC 8628 device flow** with its deterministic model-completion seam, for
  connected providers, and
- the **MCP OAuth 2.1 authorization-code flow** in front of a small real MCP
  server, for custom MCP servers.

They share `/token` and nothing else. The profile a grant belongs to is carried
inside the grant, because the two answer with different response shapes and a
credential minted by one is not accepted by the other.

Every credential — device codes, authorization codes, access and refresh tokens,
client ids, registration access tokens — is a signed, self-contained value.
That boundary is deliberate: hosted requests may land on unrelated serverless
instances, so validity, timed approval, and quota state must never depend on
process memory. Nothing here is ever stored.

## What a stateless issuer cannot fake

It can accept a revocation or an RFC 7592 registration delete, and answer
exactly as the RFCs require, but it can never **forget**. A 200 from `/revoke`
or a 204 from the registration URI proves that the client sent a well-formed,
correctly authenticated request — never that the credential stopped working.
Tests that want proof of forgetting need a real server.

For the same reason the fixture rotates refresh tokens only on every *other*
refresh. That is useful — it exercises both the "the AS returned a new refresh
token" and the "it did not, keep the old one" branches — but it means anything
asserting that a token *changed* is asserting a coin flip.

## The mount is part of the contract

`apps/api` mounts the issuer under a path and strips the prefix before the
request arrives, so the handler cannot recover it from the URL — yet every
document it serves must advertise absolute URLs that include it. The router
therefore accepts **both** forms, stripping the prefix when it is still present.
An issuer hosted at a root answers the very same URLs it advertises.

Path-mounting also decides which discovery documents can exist. The MCP SDK's
`buildDiscoveryUrls` puts two of its three candidates at the host's own root,
where a fixture must never answer — Duet's real authorization server lives
there. Only the OIDC-style appended path lands inside the mount, so that is the
one the client reaches, and it is parsed as an OpenID provider document. The
`jwks_uri`, `subject_types_supported` and `id_token_signing_alg_values_supported`
fields exist purely to satisfy that schema; nothing here issues an id token.

That parse is lossy in a way clients need to know about: the SDK's OpenID
discovery schema drops every OAuth-only field, `revocation_endpoint` and
`authorization_response_iss_parameter_supported` included, and its registration
schema drops `registration_client_uri` and `registration_access_token`. The
fixture serves all four — a client that needs them must read the raw documents
rather than the SDK's parsed ones.

## Two ways a client can identify itself

Registration is the default because it is the branch that needs a fixture most:
the RFC 7592 credentials only exist if someone issues them. But every
OAuth-capable server measured prefers **Client ID Metadata Documents**, where an
https URL *is* the client id and nothing is ever registered. Supplying the seam
that reads such a document turns that branch on — the document is read through
the seam rather than off the network, the same way time is read through an
injected clock, because a serverless instance must not depend on reaching a
client's host. The issuer then advertises the capability, accepts a URL client
id without prior registration, and refuses one whose document does not list the
redirect being used.

Advertising it is not free, which is why it is off unless asked for: a client
that can use CIMD never registers, so the registration and cleanup path would
have nothing to exercise.

## What the fixture asserts about the client

Deliberate divergences from every real server measured, each one there so a
client-side MUST has something to fail against: it emits RFC 9207 `iss` on every
authorization response and advertises it; it refuses `plain` PKCE; its
registration response always carries the RFC 7592 management credentials; and
its MCP endpoint answers `text/event-stream` — the framing real servers actually
use, including for `initialize` and `tools/list`.

Its oversized tool returns a result far past any sane response cap, duplicated
into `structuredContent` the way real servers duplicate theirs, so a client's cap
is exercised end to end instead of only in theory.

## What lives elsewhere

Runtime-specific hosting and environment safety do not belong here. The API
mounts the handler behind its explicit test-only flag — which is the only thing
between the internet and an unauthenticated registration endpoint, so that gate
is load-bearing; `@repo/test-harness` owns the Bun loopback server and staging
guards.
