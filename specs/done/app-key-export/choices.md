# Implementation choices

These are the decisions filled in during implementation. The user's choices
about app identity, five live exports, expiration, ordinary app-management
access and visible external-host registration remain the contract.

## Lifecycle and failure recovery

- **Indexed live inventory, with expired rows left expired.** When an app has
  years of expired exports, capacity and per-app revocation read only its non-expiring
  and future-expiring keys. One purpose/expiry index serves those queries and
  managed selection; a scan or cleanup cron would add work without changing
  access. Expiry already permanently denies old rows. Future maintainers inherit
  a bounded live inventory, not a retention service. Chosen in the lifecycle pass.
- **Reuse the existing issuer and audit events.** Exports keep the workspace VM
  actor used by app authentication; the caller is recorded only as audit
  attribution. A second app-auth branch or exporter-owned credential would
  make the external deployment depend on that person's membership. Existing
  audit events gain purpose and credential ID, so there is one authority and
  one audit trail. Chosen in the lifecycle pass.
- **Recheck authority in the durable operation.** HTTP admission passes a trusted
  hash/prefix reference to the existing backend authentication owner. If access
  changes before issuance commits, the operation refuses it. Trusting only the
  earlier HTTP snapshot would allow issuance after revocation. This adds no
  credential-kind restriction or consent step. Chosen in the API pass.
- **Refuse redirects and discard failed response bodies in credential commands.**
  Export failure reports status and an inventory/revoke recovery instruction;
  the CLI does not parse or print arbitrary failed bodies. This trades detailed
  server diagnostics for predictable secret handling. It reuses the shared HTTP
  client through two request options, rather than adding another transport.
  Chosen in the current CLI pass.

## Agent workflow and delivery

- **Teach explicit `never` for ordinary production setup.** The API requires a
  lifetime choice. The build agent chooses non-expiring for a requested external
  production deployment unless the user requested a finite lifetime. An
  arbitrary expiry default would create a later outage without a renewal owner.
  Rotation and app/scope revocation still apply. Chosen in the teaching pass.
- **Keep the main skill short and link an executable example.** The existing
  build-app skill points to one reference for registration, secret transfer,
  deployment and recovery. Copying those procedures across skills would drift;
  omitting the example would leave the important stdin/in-memory handoff vague.
  Controlled acceptance executes the authored server code. Chosen in the
  teaching pass.
- **Use the current unified CLI and runtime release owners.** `packages/duet`
  owns both command composition and public npm packaging; the complete managed
  runtime delivers it to VMs. The obsolete sibling prototype is not released.
  New commands retain the CLI's existing nonsecret startup cache and never save
  returned keys. Separate publication remains on the existing main release
  workflow. Chosen when reconciling the implementation with current main.

## Verification infrastructure

- **Use a synthetic staging consumer and model catalog admission.** The live
  journey proves the installed CLI, served skill, lifecycle and gateway access
  on a disposable workspace without creating a Vercel project or generating
  billable model content. Controlled host acceptance owns deployment ordering;
  backend integration owns generation attribution. This keeps each proof at
  the seam it can observe. Chosen in the joined journey pass.
- **Isolate default agent/CLI tests by process and stdin.** Bun's shared native
  renderer state hung later subprocess tests. Each test file now gets a plain
  Bun process in the same container/install; stdin is empty so TUI tests cannot
  consume the runner's remaining file list. Host-native Linux containers avoid
  forcing x64 emulation on ARM computers; x64 CI remains native x64. The same
  pinned versions and contracts apply. Failure aggregation preserves all
  files, and focused/eval/benchmark invocation stays unchanged. A single shared
  process is cheaper but did not reliably finish this repository's gate.
  Chosen during full-suite closeout.
