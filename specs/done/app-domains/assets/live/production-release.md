# Production release

Production deployment completed on 2026-09-30 after the user-authorized release
and the completed shape, code and documentation reviews. The
[read-only readiness receipt](production-ready.json) records production revision
`41b75a05ccfec4f7040132ecff7ff58f2b5a7112`, matching across API, Convex, edge, web
and docs. This revision contains the staging-accepted production code plus
production credential preparation; subsequent source-only configuration and
receipt commits change no production implementation.

## Release and configuration

The previous production revision was the feature's starting point. The API-owned
rail deployed Convex and the gateway artifact before API promotion. `main` then
fast-forwarded to the reviewed release, and its Git-connected Vercel projects
completed production builds. Unrelated staging-only work was not promoted.

A separate edge-project-restricted domain token is encrypted in `.env.production`
and routed only to production Convex. Source/runtime comparison passed without
printing credentials. Production secrets preflight and delivery passed with 76
managed writes, six optional/missing values skipped and zero failures; the target
retained its deployment-owned identity signing keys.

Production-target provider cases passed 14 tests; deployment/secrets/promotion
rail cases passed 25 tests. This release changes no production dependencies or
implementation from the already accepted staging behavior.

## Read-only production verification

- The four public serving owners and Convex report the same full revision.
- The production edge alias belongs to the intended edge project/deployment on
  `main`; all selected Vercel production builds reached Ready.
- Backend schema is `1`, browser cache generation is `15`, and API manifest,
  gateway health and the probe workspace row agree on `0.0.0+6a5618fea06f`.
- Deployed Apps docs include the domain inventory and recheck-progress contract;
  existing sessions/events documentation contracts also pass.
- A signed-out request to the deployed protected app-return route redirects to
  Duet sign-in and preserves the exact return host and deep path/query.

The configured `lottieb2b` probe was paused and archived, with no live VM. It was
not revived. The already existing `official-agents-hub`, used by prior production
smokes, reported the new gateway; the source-only probe configuration now uses it.
Its first health request returned a transient 503; a subsequent complete check
passed. These checks made no product mutations or new production fixtures; they changed
no customer documents, servicing policy, identity, app or domain binding.

The full custom-domain/TLS/private-browser policy journey remains the
[staging acceptance](README.md). Production verification did not create a new app
or attach a domain. `aomni.co` remains detached, with its registration and DNS
unchanged. Readiness on the designated workspace proves that observed gateway;
it is not a claim that every idle or archived VM has already adopted the release.
