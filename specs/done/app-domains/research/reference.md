# Reference evidence and preservation ledger

The reference is `~/dev/chat-app` at commit
`3a9000f4f714c1c699df79cd608afc01ccd920c6`; Duet was inspected at
`577bcbf38b0515d00a20aca4fcc7a425c24b8d9e`. Relevant reference files had no
uncommitted changes when frozen. Source snapshots and their SHA-256/Git blob
identities live in the [frozen-reference manifest](../assets/reference/manifest.json),
described by the [reference input owner](../assets/reference/README.md). The snapshots include the
provider, actions/storage/queries, per-app UI, gateway host routing and agent API;
dependency/config identities are captured without secrets.

**Evidence level: controlled provider and action-handler reproduction.** The
[probe](reference-probe.ts) executes the frozen provider exports; the
[action harness](reference-actions.ts) bundles unchanged frozen action/storage
handlers with controlled framework boundaries. The complete
[transcript](../assets/reference/probe-transcript.json) captures HTTP requests,
outputs/errors, query/mutation calls, resulting rows and swallowed-removal logs.
The [manifest](../assets/reference/manifest.json) freezes runners, fixtures,
transcript, Bun identity and the fixed action clock. The runner verifies these
identities before replaying. No live requests or old-stack deployment were made.

Use `bun specs/done/app-domains/research/reference-probe.ts` to replay, and
`bun test specs/done/app-domains/research/reference-probe.test.ts` for the narrow gate.
[Provider fixtures](provider-fixtures.json) are the matched-input corpus for
slice 02; [action fixtures](action-fixtures.json) describe handler-level outcomes.
Undefined return values/fields are recorded as `{ "$undefined": true }`, rather
than disappearing from JSON. Only the request credential is masked.

The action harness controls authentication, generated references/constructors,
argument validators and an in-memory database transport. Actual provider,
normalization, action decisions and storage-update logic run unchanged. It does
**not** prove real Convex transactions/index order, old authentication, UI,
host-routing, deployment or TLS. Those remain source-inspected or unmeasured;
Duet's entry-point gates own them.

## Source findings → evidence → owner → parity

The relative source paths below refer to the reference snapshot, not current
Duet files. Slice 01 fills transcript links against this fixed inventory; later
production tests consume the matched inputs and account for listed differences.

| Preservation claim from source | Evidence owner | Port slice | Early parity gate | Runtime verdict / transcript case |
| --- | --- | --- | --- | --- |
| Trim/lowercase/optional HTTP(S)/trailing-slash normalization and DNS syntax | `actions.ts:normalizeDomain` | 03 | Matched input/output corpus; reserved bare roots/IP refusal are named deltas. | Reproduced through `add-immediate-activation` and `normalize-reject-*`; IPv4/bare-root allowance remains source-inspected. |
| Add uses POST project-domain, then GET domain config | `vercel.ts:addDomainToProject` | 02 | Complete computed HTTP sequence/body/query and normalized observation. | Reproduced: `add-ready`, `add-apex-txt-a`, `add-conflict`, `config-provider-failure`. |
| Read uses GET project-domain, null on 404, then config | `vercel.ts:getDomainStatus` | 02 | Successful/missing/error traces and full outputs. | Reproduced: `read-*`, including missing/429/503. |
| Manual verify uses POST verify, then config | `vercel.ts:verifyDomain` | 02, 03 | Matched POST/config output; action status/error transitions. | Reproduced: `verify-ready`, `verify-both-pending`, `verify-provider-failure`, `refresh-*`. |
| Ready means ownership verified AND not misconfigured | `vercel.ts:buildDomainInfo` | 02, 03 | All four truth-table inputs through actual adapter; slot eligibility through real API. | Reproduced: `add-ready`, `read-subdomain-txt-cname`, `read-ownership-pending-routing-ready`, `read-ownership-ready-routing-pending`. |
| TXT ownership records precede ranked routing A/CNAME; trailing-dot stripping | `vercel.ts:buildRoutingRecords` | 02, 06 | Full ordered records/conflicts, apex/subdomain fixtures; UI shows complete instructions. | Reproduced: `read-subdomain-txt-cname`, `add-apex-txt-a`, `read-subdomain-a-fallback`, `read-no-recommendations`. |
| Add creates pending, then active/verifying or failed | `actions.ts:addDomain` | 03 | Persisted public-entry-point state and unchanged app visibility. | Sandbox add reproduced: `add-immediate-activation`, `add-verifying`, `add-failed`, `add-duplicate`; member-add wrapper source-inspected. |
| Automatic poll reads verifying records; remote absence fails, transient error keeps verifying | `actions.ts:pollVerifications` | 03 | Controlled clock/HTTP state trace; explicit fair-due and ownership-verify deltas below. | Reproduced: `poll-active`, `poll-missing`, `poll-transient`, `poll-unverified-get-only`, `poll-prefix-limit`. |
| Manual recheck clears errors/conflicts on success; manual failure marks failed | `actions.ts:refreshDomain`, `internal.ts:updateDomain` | 03 | Full diagnostic transition trace, with intentional stale-record clearing correction. | Reproduced: `refresh-clears-diagnostics`, `refresh-failure`; stale TXT remains after readiness. |
| Provider DELETE 404 succeeds; old removal swallows provider failure and deletes local row | `vercel.ts:removeDomainFromProject`, `actions.ts:removeDomain` | 02, 03 | Exact provider-delete parity; domain-owned durable cleanup is an explicit difference. | Reproduced: `remove-missing`, `remove-present`, `remove-provider-failure-local-delete`, `remove-provider-404-local-delete`. |
| Custom host resolves a registered app; default-host grammar takes its own route | `sandbox-gateway route.ts` | 04 | Compare target/path/query/response outcomes with permitted stack/auth changes. | Source-inspected only; no legacy route runtime. |
| Default hosts get noindex; custom-host content can be indexed | `sandbox-gateway route.ts:proxyToSandbox` | 04 | Public custom preserves directives/no header; default/private/auth errors remain excluded. | Source-inspected only; no legacy route runtime. |
| Per-app instructions, conflicts, recheck/remove and failed/active states | `app-custom-domains.tsx` | 06, 07 | Semantic per-state fixture parity; Duet UI uses current primitives, not pixel duplication. | Source-inspected only; no legacy browser capture. |
| Agents can list/add/remove through workspace gateway credentials | `public-domains.ts` | 03 | Same capabilities through ordinary apps-scoped REST; no port of special gateway auth. | Sandbox add handler reproduced; actual gateway auth/list/remove routes source-inspected only. |

## Reproduced limitations and evidence boundaries

- `read-multilabel-apex-heuristic` returns CNAME for `example.co.uk` even when
  provider `apexName` identifies the queried name as the apex. This is the
  two-label heuristic's measured limitation.
- `poll-unverified-get-only` never invokes ownership verification. Prefix-limited
  work leaves the first row verifying; repeated natural index selection fairness
  is source-inspected, since the memory transport is not Convex's index engine.
- `refresh-clears-diagnostics` and `poll-active` retain old TXT records while
  deleting conflicts/errors. `refresh-failure` marks an active record failed but
  retains its prior verified timestamp and DNS diagnostics.
- `remove-provider-failure-local-delete` records the swallowed provider error and
  proves local deletion; no retry or durable cleanup exists in the reference.
- Provider deadlines, response-size bounds, environment-target validation,
  staging branch selection, one-domain-per-app enforcement and same-target add
  replay are **absent** from the reference source, not reproduced guarantees.
- Authentication/validator/database-framework stubs are bounded harness seams,
  not proof of the old service's authorization or transaction behavior.

## Intentional differences, not hidden cleanup

User-required: workspace/durable-app identity, one domain slot, both management
entry points and exact settings label, active custom primary URL, continued Duet
alias, always-standard embedded views, ordinary REST agents/browser, conditional
general private sign-in-return, and no migration/compatibility layer.

Architecture/correctness differences selected for this port:

- Add/reconcile explicitly carries the staging branch. The reference `{ name }`
  request alone would default to production in Duet’s shared project.
- Validate remote project/branch on every provider observation and before removal;
  the extra target-inspection reads prevent another environment’s assignment from
  being activated or deleted. Complete trace parity names these extra calls.
- Bind to app ID and reserve the hostname through removal; old slug bindings and
  best-effort cleanup cannot provide the deletion/race contract.
- Use indexed due work that advances every attempted row, rather than repeatedly
  selecting the first verifying prefix. Retry missing initial registrations and
  coalesce repeated recheck requests.
- When ownership remains unverified, automatic checks invoke the existing verify
  endpoint; the old GET-only poll is not proof a new TXT challenge is redeemed.
- Replace stale records as well as clearing conflicts/errors on success; the old
  optional patch could retain instructions after readiness.
- Use provider `apexName` instead of counting labels, so a multi-label suffix apex
  receives the correct A record guidance. No public-suffix dependency is needed.
- Refuse IP literals and bare platform-owned roots as well as the reference’s
  platform subdomain suffix check. This is input/route sanity, not a new security
  model. No extra provider ownership-TXT tier or broad hostname-provider bans.
- A recheck failure cannot silently keep a definitively invalid binding active;
  transient transport failure preserves prior knowledge. New internal lifecycle
  states support immediate local removal and bounded durable cleanup.

Each delta gets a consumer test in its owning slice. Compare complete preserved
outputs before expensive live verification; do not weaken a gate to make the port
pass. If the replay exposes another difference, update the ledger before proceeding.

## Primary-source research

- [Vercel add-domain API](https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project)
  documents project-domain creation, verification challenges and branch targeting.
- [Vercel verify-domain API](https://vercel.com/docs/rest-api/projects/verify-project-domain)
  distinguishes the ownership verification operation from a status read.
- [Assign a domain to a Git branch](https://vercel.com/docs/domains/working-with-domains/assign-domain-to-a-git-branch)
  supports the environment assignment observed in the actual Aomni project.
- [Domain troubleshooting](https://vercel.com/docs/domains/troubleshooting)
  describes routing records and ownership challenges. Use provider recommendations,
  not a hardcoded CNAME/IP copied from an example.
- The authenticated `/v6/domains/aomni.co/config` read in deployment evidence
  confirms the live configuration grammar/recommendations used by the reference.

These sources and the account inspection inform the plan. They are not evidence
that the new implementation has passed its provider or live gates.
