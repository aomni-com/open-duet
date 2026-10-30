# Developer docs

This static app explains how external developers use Duet. MDX owns rationale
and examples; `packages/contract` owns every method, path, scope, and wire
schema shown by endpoint reference components. A route is not public merely
because an API implementation contains it.

The app has no authenticated product runtime and exports plain files for its
own Vercel project. `scripts/` guards content links, schema-tagged examples,
endpoint coverage, static output, imports, and the exact route/component visual
ledger. The root Docker visual command runs this app and `apps/web` without
either application importing the other.

The static export includes `/deployment.json`, a full-revision probe used only
to prove that deployed docs belong to the expected release. Vercel
provides the revision at build time; the route adds no application secret.

Use the workspace scripts in `package.json` for development and verification.
Deployment still requires a Vercel project rooted at `apps/docs`; no secrets are
required by the static build.

This app shares the lander's display face, and therefore its build-time font
fetch — see [that README](../lander/README.md) for why a whole sweep of
screenshots can go red without a commit, and how to tell it apart from a real
regression.
