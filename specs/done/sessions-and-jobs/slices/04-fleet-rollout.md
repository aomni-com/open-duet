# 04 — Fleet: pin, image, envs, staging → prod

**Repo:** Duet. **Conditional on slice 02 having published 0.3.8.** On the green
branch this collapses to "confirm the fleet pin is unchanged and no stray 0.3.8
reference exists" — no image rebuild, no env push, no deploy.

## Contract unlocked

D28: new and existing VMs actually run the tested wake behavior, in both
environments.

## API seam — one lever for the pin

`package.json:10` is the Bun catalog entry (`"@duetso/agent": "0.3.7"`).
`apps/api/src/config.ts:5, 94` reads `agentPackage.version` into
`DEFAULT_AGENT_VERSION`; `resolveAgentVersion` (`:97-102`) hands it to desired
state (`apps/api/src/routes/vm.ts:520` → `VmUpdatesSchema`,
`contract/src/vm/index.ts:229`), and the gateway's CLI rail reconciles each VM
onto that exact version.

So: **bump the catalog, `bun install`, deploy the API** — the type surface and
the fleet pin move together.

Two traps:

- `DUET_AGENT_VERSION` is a per-environment override (`config.ts:101`). Check it
  is unset on both environments before assuming the catalog wins.
- `packages/vm-image/scripts/build.ts:38` resolves the **same** catalog
  dependency to seed the image's initial CLI candidate. Image and pin move
  together, or a fresh VM boots one version and self-heals to another.

## API seam — the image is a separate axis

Per `packages/vm-image/README.md`: the provisioner ref is an **immutable
digest**, never a tag, because exe.dev caches by tag and would silently boot
stale VMs. Production is a **promotion of the exact staging digest**, never a
rebuild.

Order: build `:staging` → `verify-image` → `recordDigestRef` writes the digest
into `.env.staging` → `secrets:push` → deploy → probe → promote that digest to
`:production` → record `.env.production` → `secrets:push` → deploy → probe.

## What the human can run or see

`GET /v1/vm/sync` on staging showing `updates.agent.version === '0.3.8'`;
`duet --version` over ssh on a live workspace VM; the same version observation
on one *newly provisioned* VM (fresh-image rail) and one *existing* VM
(desired-state rail).

## Verification gates

`bun run check-types` — the contract's
`satisfies z.ZodType<StateMachineDefinition>` (`contract/src/agent/index.ts:75,
93`) is the tripwire for a breaking upstream type change. Then `bun run test`,
`bun run build` per app, image verification, and both rails probed in staging
before promotion.

## Must stay green

Image verification, gateway health and rollback, VM sync, and the existing
staging agent-continuity coverage.

## Fixed by this slice

The catalog is the only pin. Prod runs the exact staging digest. Both the
fresh-image and desired-state rails are proven, not assumed.

## Delegated to the implementer

The disposable staging probe workspace; image rebuild timing relative to deploy
— except that the image must never be *older* than the pin.

## What feedback would change this slice

If convergence fails, record which rail broke — npm availability, image
install, digest fanout, API desired state, gateway activation, or runtime — and
repair before any product slice ships behind it.
