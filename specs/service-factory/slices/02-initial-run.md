# 02 — Initial factory run on the existing vendors

Status: not started. Depends on service-catalog slice 04 (runtime on vault) and slice 01 here (harness).

## Contract unlocked

The factory maintains the vendors Duet already has accounts for. For each of
Firecrawl, Crustdata, FullEnrich, DataForSEO, ElevenLabs, and SocialAPI,
one unattended run:

- mints separate staging and production keys with the playbook's required
  permissions;
- writes them to both vaults;
- proves them with the probe;
- revokes the old shared key.

Blocked vendors are parked with an actionable reason.

## Seam

- One `playbook.md` per vendor, next to its `service.ts`.
- `bun run --cwd apps/service-factory converge <id|--all> --env staging,production`.
  With `--all`, each vendor runs on its own, one vendor's park or crash never
  stops the others, and the run writes `report.md` with one row per vendor
  (status, keys rotated, scopes fixed, probe verdict, and the human action if
  parked).

## Human prerequisite (once per vendor)

Log in to each vendor once in its factory profile:
`bun run --cwd apps/service-factory login <id>` opens the headed profile, you
sign in, and you close it. Alternatively, seed `password` (and `totpSeed`)
into the production vault with `service:vault put`. This is the only human
step. Autonomous signup comes in the next spec.

## Order

Start with ElevenLabs: its measured permission bug is the first real target.
Its key lacks `voices_read` and `models_read`, so the skill's voice search
fails in production. Prefer ElevenLabs' service-account key API over the UI if
the account permits it. Then run the other five with `--all`.

The key swap leaves no window without a working key. For each environment the
order is: write the new key to the vault, run the probe until green, wait out
the proxy's 60-second credential cache, then revoke the old key.

## Run / see

The command above, then the run's `report.md`, then
`bun run service:probe --all --env staging`.

## Verification

- The probe is green for all six vendors on staging and production,
  including ElevenLabs `GET /v2/voices` and `GET /v1/models`.
- Staging and production fingerprints differ for each vendor.
- `serviceAccounts.<id>.status` is `converged`. Any vendor that isn't
  converged is `parked`, with a human action in the report.
- A second `--all` run is a no-op.

## Delegated to the implementer

Whether each vendor's keys are managed over its HTTP API or its UI, and the
report layout.

## Must stay green

Staging proxy traffic during key swaps.

## Feedback that would change this slice

A vendor whose plan allows only one key. Then that vendor keeps one shared key
across both environments; record it in its playbook's front matter.
