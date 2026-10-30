# NewEra agent rollout prompt

Use this only after the exported-app-credential API and actual CLI release have
passed the platform gates. This prompt grants no new production verification
permission beyond NewEra's existing authorized workflow.

> Inspect NewEra's existing app registrations and production source first.
> Fix the externally hosted deployment's Duet authentication using the shipped
> build-apps external-host workflow. Preserve the production source/release
> project and existing app row. If no appropriate row exists, create a normal
> tracking app under your own agent folder; use `newera-production` only after
> confirming that slug is appropriate and available. Declare `services`.
>
> Serve a short static page using the build-app skill's static-server command.
> Say that NewEra is externally hosted, describe its purpose from its actual
> project, and link to https://jointhenewera.com with an external-tab link.
> This entry tracks the app identity and AI access used by the deployment.
>
> Export a new app credential with explicit non-expiration, capturing the
> response only in memory. Transfer `DUET_APP_API_KEY` through stdin to the
> existing Vercel production project's server secret store. Configure
> `DUET_API_URL` and `DUET_GATEWAY_BASE_URL` from the returned metadata before
> deploying. Use the actual `duet app credentials export` command if installed;
> otherwise use the public API exactly as the build-app reference teaches.
> No human Duet key creation or copying is required. Never print tokens, read
> VM private keys, persist a secret to Drive/source, or set browser/public env.
>
> Inspect both `/api/nova/ask` and `/api/profile/onboarding/generate` and every
> runtime credential branch. Authenticate with the exported app key using
> standard bearer [REDACTED]
> Preserve the selected models. Make a failed credential setup visible rather
> than silently selecting the legacy credential branch.
>
> Deploy through NewEra's established release workflow. The incident review
> barred new production requests and member-content inspection; honor those
> limits. Use only the workspace's already authorized safe verification. If
> proving either route requires new production requests, record that precise
> prerequisite and do not ask members to retest. Keep previous production
> configuration until replacement validation supports cleanup. Report only
> status/category, opaque IDs, version and safe lifecycle booleans.
>
> After validating the replacement, revoke only the intended old exported
> credential by its ID. Do not revoke an old human workspace key through this
> API or assume it has no other consumers. Keep the tracking folder and app row;
> deleting/recreating them or changing scopes invalidates exported credentials.
> At the five-live limit, inspect safe inventory and deliberately clean up;
> never loop exports or retry an ambiguous secret-issuing request.

The platform feature does not establish the cause of the October 5 incident or
claim either production route has been repaired.
