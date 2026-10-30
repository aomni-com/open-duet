# Production rollout evidence

## Exact-byte promotion

- Accepted staging image: `ghcr.io/aomni-com/duet-vm-image@sha256:1d1dbcb4af6bd796ec28ba74fbea9f4c339717f9ca36bfa1d664d6e6f7731c93`
- Previous production image: `ghcr.io/aomni-com/duet-vm-image@sha256:71285a0068a6ed54ca33dd48791d0fe5ad2c3ccf69738ed5b25c9f9bd5c327dd`
- `promote-image:production` copied the accepted staging image to the production tag without rebuilding it.
- Registry inspection and an internal decrypted-environment comparison both confirmed that the production tag and `.env.production` select the accepted staging digest.

The following sections retain the completed configuration, deploy, fleet, and smoke evidence.

## Configuration and application release

- Production secret/config dry-run and apply completed with 75 managed values set, 6 documented optional placeholders skipped, and 0 failures.
- Internal comparisons confirmed both the Vercel API production environment and production Convex deployment select the accepted immutable image ref; no values were printed.
- `origin/staging` at `2b60932e70b0e6298ba83a987cbf3aaa6c128e4f` was promoted to `origin/main` as merge commit `0c0ec7cb72f7bcc347cd525cf946bab438ef7665`.
- The exact-SHA API deployment `dpl_CWSQS4e8ELsh7sPqvoJcfMgTsqQL` and web deployment `dpl_8sb5AnA5CQBSFcmuonAw2GBZpue7` reached Ready. Machine checks confirmed `service.example.invalid` and `service.example.invalid` resolve to those deployment IDs.

## Fleet convergence

- The initial production dry-run selected two active workspaces: `official-agents-hub` and `Example User-zhang-s-workspace`.
- The normal state-preserving rail upgraded `official-agents-hub` successfully.
- `Example User-zhang-s-workspace` failed its archive request with HTTP 503. A second dry-run proved it was the only remaining candidate before the user-authorized prelaunch `--discard-state` retry.
- The scratch retry completed for that workspace. Its prior VM filesystem state was not archived and is not recoverable through Duet. No other production workspace discarded state.
- The final production dry-run reported that every attached live VM already uses the target image.

## Production smoke

A read-mostly smoke used `official-agents-hub` and created no browser batch. It proved:

- desktop phase `ready`;
- browser extension connected;
- Chrome bootstrap window adopted as the managed root window;
- one managed window and zero test batches.
