# API artifact delivery proof

**Decision: authenticated API streams.** The compiled Linux executable, four
PGlite sidecars and Photon image-processing WASM fit the existing API deployment
and downloaded intact through its deployed Node24 streaming function. Blob and
the large-functions beta are unnecessary for this payload.

Measured on 2026-10-03 PDT. [receipt.json](receipt.json) records the complete
artifact inventory, independent client hashes, byte counts, response timings,
Vercel request identities, function configuration and exact preview identity.
The function contained 145,740,400 uncompressed bytes, including the frozen API
bundle, current gateway release and entire 132,127,618-byte Linux payload. The
116,000,896-byte executable completed in 8.820 seconds; all six downloads
matched their source SHA-256 and complete length. Missing synthetic bearer
REDACTED_TOKEN returned 401; a deliberately wrong artifact body returned 503
from the production file verifier. The disposable deployment was deleted and
its lookup subsequently returned not found.

## Evidence boundary

[probe.mjs](probe.mjs) uses the actual API release reader's verification and
`createReadStream` → `Readable.toWeb` response body. It deploys prebuilt output to
the existing API project as a preview, without the Convex deployment rail, git
branch metadata or a production promotion. The full API bundle is included in
the function to measure its deployment closure; the synthetic probe handler
serves the payload. No workspace or VM was provisioned or accessed.

The synthetic bearer gate avoids depending on customer credentials and backend
state. This establishes deployed file-size and streaming feasibility, not the
final runtime manifest endpoint, real VM authorization, activation or rollback.
Those remain the runtime-release and fleet acceptance gates. It also makes no
claim about executable parity; the packaging proof owns that result.

## Reproduction

Use a disposable checkout of the receipt's `sourceRevision`, install its frozen
lockfile, and run `bun run build:vercel` from `apps/api`. This directly builds the
API/gateway output and deliberately does **not** run `buildCommand`, which would
deploy Convex. Then run the preserved probe from this evidence directory:

```sh
node probe.mjs /absolute/linux-payload /absolute/api/.vercel/project.json \
  /absolute/new-receipt.json /absolute/frozen-api-checkout
```

The existing project link and authenticated Vercel CLI select the API project.
The payload is the packaging proof's flat directory of executable and sidecars.
The probe generates a fresh synthetic token, retains only its digest in the
preview, checks refusal controls and every download, and deletes the exact
deployment. A failed check throws; a partial receipt does not mean success.
An interrupted or failed deployment command can leave a preview: remove only the exact deployment
identity printed by Vercel, never the project or environment domains.

The [platform limits](https://vercel.com/docs/functions/limitations) distinguish
ordinary function size from opt-in large functions. The
[streaming documentation](https://vercel.com/docs/functions/streaming-functions)
describes the response transport. The decision rests on the accepted preview
and complete bytes above, rather than assuming that a documented non-streamed
response limit applies to this streamed path.
