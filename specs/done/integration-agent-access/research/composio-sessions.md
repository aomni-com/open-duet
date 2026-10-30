# Composio session and Sandbox research

Research captured 2026-08-01 and verified live on 2026-08-02. This note records
the external provider facts behind [the closed rationale](../README.md); Duet's
code remains the owner of product semantics.

## What persistent provider context means

Composio describes a Tool Router session as a persistent remote Sandbox. The
SDK retains a Workbench compatibility alias, and the meta-tool retains the
Workbench name. Reusing one session preserves provider-side execution context
such as variables, imports, helper functions, and files in that session's
persistent file area. The environment can execute Python or Bash and call
Composio tools and APIs.

It does not contain Duet's model transcript, workspace-VM filesystem, runner
process memory, or agent identity. Those remain Duet-owned. A provider session
is therefore suitable for reuse within one Duet conversation, but not across
unrelated conversations merely because their permissions match.

Primary sources:

- [Remote Sandbox](https://docs.composio.dev/docs/sandbox/remote)
- [How Composio sessions work](https://docs.composio.dev/docs/how-composio-works)
- [Configuring Tool Router sessions](https://docs.composio.dev/docs/configuring-sessions)

## Lifetime and identity

Tool Router sessions persist and should be reused when the caller wants the
same conversation/Sandbox context. Duet does not impose a ready-session clock
expiry. Each Duet conversation owns one provider session; permission changes
update that same session instead of selecting or creating another one.

The installed `@composio/core` SDK exposes the provider session ID and
`sessions.use(id, { mcp: true })`. Duet stores the provider ID plus the current
and applied permission fingerprints. MCP URLs and transport headers obtained
from creation or `sessions.use` stay in memory.

## Toolkit composition

The SDK accepts Tool Router toolkit configuration in enable or disable form. A
disable projection matches Duet's default-open policy: only explicit policy
rows deny a toolkit, missing policies remain open, and Duet need not enumerate
the provider catalog. An empty disabled set omits the `toolkits` option rather
than depending on an empty-filter interpretation.

The focused live staging journey confirmed that disabling the connected
Firecrawl toolkit removes it for the denied principal while preserving
`COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_REMOTE_WORKBENCH`, and
`COMPOSIO_REMOTE_BASH_TOOL`. It also wrote and recovered a Workbench sentinel
within one conversation, rejected the sentinel in another conversation, and
recovered it after changing that conversation's permissions in place while the
provider session ID remained unchanged. The durable evidence record is
[staging-e2e-synthetic](../evidence/staging-e2e-synthetic).

## Connection-link lifetime is separate

The [session-link API](https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSessionBySessionIdLink)
creates a link for a user to open and authorize a connection. A fresh link can
be generated from a durable Tool Router session, so the link's lifetime does
not require the session itself to expire.

Duet gives a user-requested connection return descriptor a fixed ten-minute
expiry. A Tool Router session instead receives a signed, non-expiring return
descriptor bound to its workspace and a server-derived Integrations
destination. The callback validates and redirects; it is not a reusable grant
and performs no provider token exchange.

## Security interpretation

`SECURITY.md` defines one trust domain inside a workspace VM. Toolkit
composition improves the normal agent tool surface and expresses user intent;
it is not an authorization boundary against arbitrary code holding the existing
workspace key. The direct workspace execute route remains unchanged. No new
key kind, capability split, provider credential, or per-tool enforcement is
part of this feature.
