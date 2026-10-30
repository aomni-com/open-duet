# Live staging acceptance — 2026-08-12

Shared staging deployed commit `13fb9b54` from the `staging` branch. Vercel
deployment `dpl_BGEbrU7tuSTfnStuXXUev8eyJmKb` moved `service.example.invalid` to the
new API, deployed Convex functions to `Example User-2dce6:duet-v2:staging`, and
published gateway release `0.0.0+a00ef7614d80`. Web deployment
`dpl_Ayzn2wVnw7AStJw8ZM8Db6JXqyZu` moved `service.example.invalid` to the matching
web application. A later web-only test boundary shipped as staging commit
`7dd4325d` before the passing run.

Command:

```text
bun run e2e:staging -- --journey chat-attachments
```

Passing run: `staging-e2e-synthetic`.

The journey proved, in one ephemeral workspace:

- a text brief, valid PNG, and 26 MiB binary moved through the live composer;
- upload progress appeared and Send stayed disabled until preparation finished;
- the durable message rendered linked file cards and an inline image;
- the Files viewer opened the exact landed path;
- public file stats matched exact byte sizes, and file history attributed both
  writes to the exact signed-in user as `web:<userId>`;
- the prompt did not contain the brief's marker, while the completed agent result
  did, proving that the agent resolved and read the landed path;
- removing a second draft attachment deleted its uploaded bytes before send;
- the verified Brand Designer remained locked, accepted a valid SVG and the real
  bundled WOFF2 font, and returned the marker present only in the SVG title.

Cleanup passed with zero orphans. The ledger verified deletion of the synthetic
user, workspace, registered agent, both sessions, Brand Designer subscription,
mail message, and every uploaded file. Workspace deletion separately waited for
the VM name and teardown run to clear, proving VM teardown.

The redacted machine-readable receipt is
[`chat-attachments-live-receipt.json`](chat-attachments-live-receipt.json).

Two earlier attempts found harness defects rather than product defects. The
first waited for a `Ready` badge on inline images even though the shipped image
contract removes `Preparing`; the second hard-coded the obsolete English image
label `Attachment`. Both oracles were corrected with focused red/green tests
before the passing run.
