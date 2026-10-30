# Deployment and authorized live fixture

Read-only inspection and one user-authorized alias removal were performed on
2026-09-30 with Vercel CLI 54.21.1. No feature was deployed or domain attached to
Duet during planning. No decrypted credential values were printed or retained.

## Confirmed account topology

| Fact | Observed value / evidence |
| --- | --- |
| Team | Aomni, slug `aomni`, ID `team_I18zdvAznXXwqq1PcIampT1t`; scoped CLI access succeeds. |
| Edge project | `duet-edge`, ID `prj_mPNx8yJ4JRlThnK3NMZOIpeenJjM`, root `apps/edge`. |
| Staging aliases | `staging.example.invalid` and its wildcard on the same project with `gitBranch: "staging"`. |
| Production aliases | `service.example.invalid` and its wildcard on that project with `gitBranch: null`. |
| Test domain | `aomni.co`, registered with a third party, accessible in the Aomni team. |
| DNS authority | `jay.ns.cloudflare.com` and `nucum.ns.cloudflare.com`. Vercel DNS listing is not the authoritative Cloudflare zone. |
| Apex routing | Public DNS A `76.76.21.21`; Vercel config `configuredBy: "A"`, `misconfigured: false`, no conflicts, `ipStatus: "optional-change"`. |
| Previous assignment | `aomni-app`, project ID `prj_2eQjeC5GmUPPO6pLhFTdnWfYZxzt`, production branch. |
| Current assignment | Removed from aomni-app; post-removal `domains inspect` reports domain ownership but no Projects section. |

The provider currently recommends newer IPv4 values at rank 1 and the existing
address at rank 2; it explicitly accepts the existing routing. Do not rewrite DNS
merely because a different recommendation ranks first. The apex avoids requiring
a Cloudflare token for this live fixture. No DNS record, nameserver or domain
registration was changed.

## Authorization and completed preparation

The user said there is no existing destination and authorized use of aomni.co
however needed, then explicitly authorized removing it from any assigned project.
The completed mutation was only:

```text
DELETE /v9/projects/aomni-app/domains/aomni.co
team: aomni
result: success ({})
```

Follow-up inspection confirms the assignment is absent. No new alias was created.
The planned journey was authorized to attach aomni.co to Duet staging through the feature and remove
that fixture assignment afterward, retaining domain ownership and existing DNS.
No extra permission is required for the already-authorized test-domain preparation.

## Planning limits

CLI authentication does not imply a Convex action has the runtime token. Existing
`scripts/secret-topology.mjs` deliberately keeps `VERCEL_TOKEN` local-only. Deliver
the separately named `DUET_VERCEL_DOMAINS_TOKEN` to Convex through the existing
secrets editor/push rail. Typed backend configuration owns team/project constants
and derives the branch from the existing edge-host environment discriminator;
do not add competing branch knobs or silently select production.

At planning time, live activation still needed to prove the deployed Host, TLS handshake, staging code
and backend association, app identity, auth behavior, and cleanup. API DNS readiness
alone proves none of those. If the selected staging release is not deployed yet,
keep the domain unattached until slice 08 rather than bypassing product admission.

This is an apex fixture with already-configured DNS. Controlled slice-01/02/03
evidence owns waiting-DNS, TXT ownership, subdomain CNAME and provider-failure cases;
the live journey should not claim it exercised those just because HTTPS succeeds.

## Runtime credential delivery — 2026-09-30

A separately named app-domain runtime token was created through Vercel's supported
[v3 token API](https://github.com/vercel/sdk/blob/main/docs/sdks/authentication/README.md#createauthtoken),
restricted to the existing `duet-edge` project. Its bearer passed in memory directly
to the repository secrets editor; only encrypted staging source was written.
The token can read the configured staging project-domain and its domain config
(HTTP 200). The detached `aomni.co` config returns 404 under this narrower token;
assignment and domain readiness remain the feature's later live proof.

The new topology destination is Convex only. Local deploy `VERCEL_TOKEN` routing
is unchanged. The existing staging secrets-push preflight and delivery completed
(80 values delivered, seven optional/missing values skipped, no failures); the
new key reached Convex and the target audit retained the deployment-owned auth
keypair. No domain alias was added and no functions/service deployment occurred.
Production runtime credentials remain unprovisioned until production release.

## Completed acceptance

The preceding notes preserve planning-time observations, not current pending work.
The [live acceptance receipt](../assets/live/README.md) records the coherent staging
release, activated apex, actual browser/TLS behavior and verified final cleanup.

## Production release preparation — 2026-09-30

The user authorized production deployment after the completed review. Production
preflight confirmed all existing public owners at the feature's starting revision
and their Git projects on `main`. A separate production domain token is restricted
to the existing edge project and saved only in encrypted `.env.production`; the
local deployment token remains local. The known production project-domain read
succeeded. Secret delivery and the final production identities are recorded in the
[production release receipt](../assets/live/production-release.md).
