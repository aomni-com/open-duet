> Historical preservation inputs and pre-implementation research; the [shipped rationale](README.md) owns the completed design.

# Research and preservation contract

## Frozen source

[Source reference](assets/source-reference.json) pins the clean agent checkout at
`cad4c4ee7ab6ad822e11e9f64bf296cc2acd05b4` and Duet baseline at
`a2fcdd2d03a1108579fd779dc776132908f15e61`. It records hashes of the source
manifest, lock, Pi patch, Linux packaging implementation, and PGlite loader.
Recover the source from the local checkout or that exact upstream Git revision.
Before import, inventory tracked files and preserve original license/authorship;
do not copy nested Git metadata, caches, secrets, or generated install trees.

The source's SWE-bench `prepareDuetArtifact` is the reproduction reference. It
installs Linux x64 optional packages in a scratch source tree, compiles the CLI,
and copies four PGlite sidecars. Its injected-runner test is packaging-unit
coverage, **not** evidence of target-runtime parity. There is no accepted Linux
artifact, delivery probe, or live fleet census from this planning session.

| Preserved behavior | Existing evidence owner | Owning slice and parity gate |
| --- | --- | --- |
| CLI/RPC acknowledgements, resume and local defaults | Source test/cli-rpc.test.ts and test/cli.test.ts | 00 controlled source/binary output comparison; 01 workspace entrypoint comparison |
| Memory data paths, migrations, reopen, pgvector | Source test/memory-pglite.test.ts and src/memory/pglite.ts | 00 scratch databases and relocated payload; 01 same source fixtures |
| Isolated memory-store import | Source test/memory-store-build.test.ts; gateway train/memory-store.test.ts | 01 dependency/export and caller parity |
| Routing reaches nested cwd and resumed turns | Gateway runner/routing-release.test.ts | 01 preserved routing; 06 agent-only complete-release rollout |
| Workflow oracle/archive/manifest | Source scripts/build-workflow-fixtures.ts; test-harness fixtures/workflow/dependency.ts | 01 rebuild/consume locally without registry pin |
| Existing local provider env and connections | Source cli/shared.ts and cli/connect.ts | 05 canonical user-key transfer without provider-state loss |
| Syncthing mirroring and daemon lifecycle | Duetfs sync tests and scripts/sync-e2e-probe.ts | 04 identity/key separation; 05 moved orchestration and byte convergence |
| VM integrity and recovery | Gateway release/bootstrap/boot-health tests | 06 full artifacts; 07 old-layout interruption/restoration |

Matched comparisons use the same source commit, model/routing fixture, scratch
home, controlled network responses, inputs, and workspace runtime. Record full
outputs/requests and permitted differences, not merely exit codes. User-required
differences are unified remote dispatch, user authentication, release metadata,
and deletion of npm updating inside VMs. Compiler migration, storage redesign,
and prompt/routing changes are not implicit cleanup permissions.

## Primary-source research

Checked 2026-10-03. Recheck runtime/provider capabilities when implementing if
platform configuration differs from the frozen probe.

- [Bun standalone executables](https://bun.sh/docs/bundler/executables) document
  cross-platform compile targets, inclusion of the Bun runtime, and embedding
  assets/native addons. This establishes available mechanisms, not that the
  current agent's native dependency graph works. Reproduce the existing source
  packaging before changing its asset strategy.
- [Bun workspaces](https://bun.sh/docs/pm/workspaces) document local linking and
  replacement of workspace version ranges when publishing. That replacement
  does not make a private package publicly installable: the public CLI must
  bundle its private workspace code and prove installation from a tarball.
- [Vercel function limits](https://vercel.com/docs/functions/limitations) describe
  standard bundle-size and request/response limits, plus the large-function path
  and its configuration. [Streaming](https://vercel.com/docs/functions/streaming-functions)
  documents streaming support. Neither local byte size nor streamed local fetch
  proves actual deployed delivery. Slice 00 measures deployment output and tests
  the artifact path; do not categorically reject compiled payloads on size alone.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) ties publisher
  configuration to a repository/workflow and repository metadata. Moving the
  workflow is insufficient without the matching account configuration. Verify
  the available publishing setup; do not invent an authentication workaround.
- [npm deprecation](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/) updates
  registry metadata with an installation warning and requires package ownership.
  Deprecate duetfs after the replacement is available; do not unpublish it.

## Decisions and genuine alternatives

The independent drafts agreed on whole-artifact identity, one release manager,
separate user/machine identity, and a measured Linux packaging gate. A compact
four-rung plan hid independent auth, billing, and deployment failure modes; this
ladder separates their acceptance surfaces while retaining the same small set
of permanent owners.

A single harness/CLI workspace would introduce a contract dependency cycle.
The private core/public composition split removes that cycle without a separate
protocol or remote-client SDK package. Renaming the existing npm package is
unnecessary; the binary and public instructions become duet while publication
stays @duetso/agent. The user's follow-up requires a new major: the unified
CLI ships as 1.0.0, replacing the current 0.3.x release line. The command remains
duet; the [published CLI metadata](https://registry.npmjs.org/@duetso%2fagent/latest)
was checked on 2026-10-03 and reported 0.3.36 with bin duet. The unscoped npm
package duet is an unrelated library; do not confuse its version with this CLI.

Compiled executable plus the existing sidecars is the preferred candidate,
conditional on 00's runtime and delivery evidence. A complete bundled-JS/native
closure under the workspace Bun is the bounded fallback. Transport stays in the
existing authenticated API path if measured deployment/delivery works; only an
observed platform constraint justifies using the existing Blob capability for
immutable bytes. Both choices feed the same descriptor and release manager.

Three independent drafts were used, including Claude Opus. Claude could inspect
repo files but its tool permissions blocked the external checkout; source
packaging claims were therefore checked separately against the actual local
source. Unsupported assumptions about categorical Vercel size failure and VM
image provenance were rejected. No draft's runtime claims are accepted evidence.
