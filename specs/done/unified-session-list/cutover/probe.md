# Deploy-rail probe — slice 00

**Status: reasoned and verified by reading, not executed. Slice 13 executes it.**

## What was verified, by reading the tree

`apps/api/vercel.json` sets:

```json
"buildCommand": "VC_MAX_DURATION=800 node ../../scripts/run-vercel-deploy-rail.mjs"
```

and `scripts/vercel-deploy-rail.mjs`'s plan has exactly one step:

```js
{ cwd: 'packages/backend', command: 'bun', args: ['run', 'deploy:ci', …] }
```

`packages/backend`'s `deploy:ci` is `convex deploy`.

**So the API project's Vercel build *is* a Convex schema deploy.** That is the
finding that moves the cutover from a closeout step to a precondition: the branch
cannot deploy to any environment until the data matches the new schema.

## Why it was not executed here

The only deployments reachable from this machine are the personal dev deployment
(`dev:chatty-llama-452`) and shared staging. Pushing this branch's schema to
either would break a live environment, and would buy nothing: the branch has
thirteen slices remaining and four more column renames (slice 04) still to come,
so any successful push now would have to be redone anyway.

Convex validating existing documents against a schema on push — and rejecting a
required field absent from them — is documented product behaviour, not a
hypothesis this branch needs to test. The probe's real value is the *exact CLI
sequence for the fix*, and that sequence is only meaningful once the schema is
final.

An offline experiment (boot a local backend on the pre-`bucket` schema, seed
legacy rows, swap the schema, push) would reproduce a documented behaviour at
meaningful setup cost. Not worth it against a known answer.

## What slice 13 must do first

Before touching staging, run the push and capture the exact rejection. Then:

```
convex export                       # back up first — the precedent's rule
<local transform>                   # rename 4 columns, add bucket, add the read floor
convex import --replace-all
convex deploy                       # functions and schema together
```

The transform imports `bucketOf` from `@repo/contract` rather than
reimplementing the rule, so the backfill and the runtime cannot disagree.

## The race to plan around

`specs/done/schema-cleanup/cutover/staging.md` records this exact failure: an
automated deploy from a pre-cutover branch resumed the legacy writer, and the
next rail rejected the schema. Old deployed code keeps writing rows without
`bucket` between the export and the deploy.

Wiping avoids the race entirely and is pre-approved — both environments were
declared disposable by that precedent, and re-authorised for this work. Prefer
the backfill anyway when it converges: a wipe destroys the admin and
official-hub seed, which then needs its own runbook to restore.

## Environment setup note for the next agent

`.env.keys`, `.env.local`, `.env.staging`, and `packages/backend/.env.local` are
gitignored, so a fresh worktree has **none of them** and the Convex CLI has no
deployment configured. Copy them from the main checkout before any CLI work.
