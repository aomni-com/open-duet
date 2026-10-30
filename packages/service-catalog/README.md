# Service catalog

The catalog is the single owner of vendor service definitions, route admission,
pricing, provider hooks, and discovery metadata. It is pure TypeScript: no
Convex, environment variables, or network access belong here.

Every vendor account is shared by Duet workspaces. A route must therefore be
`generate`, `publicRead`, `ownedById`, or `sharedPool`. Shared-pool resources
may be listed and used by everyone, while mutation and deletion require the
workspace that created the tracked resource. Pools declare a TTL and expiry
route; untracked pre-existing or curated resources are permanent and read-only.

Pricing uses the vendor-reported cost when available. Request-derived rules are
fallbacks and should be checked by the probe against the vendor ledger. The
catalog applies the standard 20% margin exactly once in `priceCharge`.
Firecrawl browser execution is the one elapsed-time rule currently in the
catalog: Playwright/code sessions cost two credits per browser minute and
prompt-driven sessions cost seven, with a one-minute minimum. Keep provider
rates in the vendor definition and cite the upstream pricing page beside the
rule when adding another time-billed route.

Provider hooks may rewrite requests or responses, but run after route admission,
never see vendor credentials, cannot change pricing or ownership, and must
declare body buffering needs. Discovery metadata is part of each definition and
should describe the service in searchable, user-facing language.

Vendor-specific behavior belongs in the service's own README under
[`services/`](services/), not in this shared contract. The service index links
each vendor's rationale and operational boundaries.

To add or maintain a vendor, follow the repo-local [`create-service`](../../.agents/skills/create-service/SKILL.md) skill. It owns the official-doc audit, route inventory, resource boundary, definition, fixtures, probes, and skill update workflow. Each service owns its definition under `services/<id>/definition.ts` and its rationale under `services/<id>/`; `src/vendors.ts` only assembles the registry. Keep route ids
stable; removals and renames require updating `routes.lock.json` in the same
change.

The [`create-service`](../../.agents/skills/create-service/SKILL.md) skill owns the ordered maintenance workflow, including catalog-first route admission, shared-resource partitioning and expiry, official vendor documentation review, skill synchronization, and verification.

`bun run service:probe <id> --env staging` (or `--all`) runs the declared
vendor probes with credentials supplied by the selected dotenv environment and
prints one JSON result per probed route. The scrubbed replay inputs live under
`fixtures/`; they are deterministic checks of request matching and usage-unit
extraction, while live probes are the check against a vendor's current billing.

Vault credentials are seeded with `bun run service:vault put <serviceId> <name>
--env staging|production`. Pipe the value on standard input; the command only
prints the environment, service, generation, and safe fingerprint. The selected
dotenv environment must supply `DUET_API_INTERNAL_KEY` and a
`CONVEX_DEPLOY_KEY` for the target deployment; the deploy key, not the `--env`
label, determines which Convex deployment receives the write. The vendor value
can come directly from the decrypted dotenv environment without being printed.

For production, run the command under the production dotenv file and seed each
service after the production Convex deployment contains the vault schema. The
service README owns the source environment variable for that vendor:

```sh
bunx dotenvx run --strict --redact -f .env.production -fk .env.keys -- \
  sh -c 'printf "%s" "$SOURCE_ENV" | (cd packages/service-catalog && bun run service:vault put SERVICE_ID apiKey --env production)'
```

Replace `SOURCE_ENV` and `SERVICE_ID` with the values from the service README;
they are placeholders in this shared example.

The command stores the value in Convex, reports only a fingerprint, and the API
later reads it through the internal-key-gated service-vault adapter. The vault
row is not application-level ciphertext: `serviceCredentials.value` is the
logical plaintext value protected by Convex's platform controls (Convex documents
[256-bit AES at rest and TLS/SSH in transit](https://www.convex.dev/security)). The code has no encrypt/decrypt
step. `fingerprint` is a truncated
SHA-256 used to detect rotation; it cannot recover the secret. A credential is
returned only to callers that present `DUET_API_INTERNAL_KEY`, and the API uses
it at the vendor boundary without returning it to the agent.

The source-to-vault path is therefore: dotenvx decrypts `.env.production` in
memory using `.env.keys`; the shell pipes one selected value to the vault
command on stdin; `convex run` writes the value to the selected deployment; and
later the service proxy reads it through the internal-key-gated query. The
source command keeps the value out of shell history and its own output; the
seed helper necessarily hands it to the short-lived `convex run` child process
to invoke the mutation, so run it only inside the trusted deployment operator
environment and keep process inspection/logging controlled. Never put the value
in chat or committed files. `--env production` is a human-facing label;
`CONVEX_DEPLOY_KEY` selects the actual Convex deployment.

Firecrawl also remains in the API and lander environments because those
applications have direct callers outside the catalog.

Research placeholders for future data sources live with the service-catalog
specs. The current ScrapeCreators intake is
[`future-data-sources.md`](../../specs/done/service-catalog/future-data-sources.md);
it is not a catalog entry and must pass its acceptance gate before routes are
enabled.

The validator enforces URL-safe service ids, unique route ids, unambiguous
method/path matches, route admission, complete shared-pool bindings, pool TTL
and expiry declarations, and explicit hook buffering declarations.

The proxy selects a Duet workspace from `x-duet-workspace` for multi-workspace
credentials. Query strings are otherwise opaque: vendor parameters, including
`apiKey` and a vendor's own `workspace` parameter, pass through unchanged.
Only a catalog-declared query-auth scheme may add or replace its own vendor
credential parameter.
