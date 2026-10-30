# Private Blob transfer evidence

2026-09-29. Bun 1.3.14 and VM gateway Bun 1.4.2, `@vercel/blob` 2.8.0. The reproducible command is
`bun run backup:probe [bytes]` in apps/api with that environment's
`BLOB_READ_WRITE_TOKEN`. All inputs were generated fixture bytes; every object
was deleted afterward. No customer workspace was read.

The dedicated private `duet-workspace-backups-staging` store is attached to
duet-api for preview/development. Production storage is not configured by this
pass. Blob-generated environment variables belong to the Vercel project
connection; the secret-topology audit recognizes them without fanning them out.

| Probe | Bytes | Upload | Total | Peak process RSS |
| --- | ---: | ---: | ---: | ---: |
| Small roundtrip | 10,485,760 | 2.45 s | 6.77 s | 143,572,992 |
| Beyond old archive cap | 1,074,790,400 | 43.05 s | 127.05 s | 733,347,840 |

Both runs independently hashed downloaded bytes, refused unsigned access (403),
served a signed range (206), and refused an uncached signed read after deletion
(404). The large run's SHA-256 was
`b739b38d6fd77bed82253537e1dd0754c484190995ee4199df3a74a75361f5ae`.
No complete source object was staged on disk. Measurements are from this Mac's
Bun process using the SDK's initial automatic multipart mode. The production
Linux proof below supersedes its runtime and memory measurements.

## Production uploader on Linux

The production `uploadWorkspaceBackup` was bundled with the opt-in probe and run
in Linux Docker with Bun 1.3.14 and the pinned SDK. Its 1,074,790,400-byte fixture
passed upload, independent download checksum, unsigned denial (403), signed
range (206), and uncached read after deletion (404). Upload took 54.680 seconds;
total verification took 121.046 seconds. Peak RSS was 144,953,344 bytes. SHA-256:
`7d028de8010c7634c96e729f2f809189c142364b67cd31ce4752321f1a430b07`.

Fourteen grants were issued. The probe advances the uploader's clock after each
accepted part to exercise renewal without waiting fifteen minutes per token;
the provider receives real, newly minted per-object tokens for the same upload.
This proves renewal across multipart operations, not elapsed real-time expiry.
The exact VM gateway runtime, Linux Bun 1.4.2, then passed the same production
probe: 1,074,790,400 bytes, fifteen grants, 77.742 seconds upload, 151.566
seconds total, and 126,218,240 bytes peak RSS. Private denial, signed range,
checksum, and deletion all passed. SHA-256:
`fd22a937f900f8118a30cb4e0e7e74b385ecf4f62456afcf5529359015f7879f`.
The small deployed-workspace journey remains the VM integration gate.

A separate Linux probe exercised the largest production part directly through
the same official SDK and operation deadline:

| Part size / transport | Upload result | Peak RSS |
| --- | --- | ---: |
| 512 MiB direct Blob | Timeout; SDK settled after 92.158 s | 648,056,832 |
| 512 MiB with progress | HTTP 413 `PAYLOAD_TOO_LARGE`; reproduced on Mac | — |
| 256 MiB with progress | Full roundtrip passed; 16.159 s upload | 162,050,048 |
| **500 MiB with progress** | **Full roundtrip passed; 25.517 s upload** | **140,931,072** |

The 500 MiB object completed in 328 ms, verified and deleted in 73.055 seconds,
and returned 404 after deletion. Its SHA-256 was
`6a5cd88574ebaa51546b13f112c3f2439147ea109d1b558970db699b99fe8f41`.
Linux Bun 1.4.2 also passed the 500 MiB part boundary: 28.411 seconds upload,
303 ms completion, 76.066 seconds total, and 155,549,696 bytes peak RSS.
SHA-256: `6fe746f28c34c320f7715fa1abc52e3fed97fa8e1ff93f55221c536d9f382cec`.
Deletion returned 404. All fixtures and Docker containers were removed.
No customer data was captured.

## SDK behavior that determines the implementation

The official client-token method binds one immutable path, ZIP content type,
provider size ceiling, and expiry. The VM receives no master key. Downloads use
`issueSignedToken` + `presignUrl` with private uncached GET. The presigned-upload
helper required an unused webhook key, so it is not used.

Automatic SDK multipart uses 8 MiB parts and would exhaust the provider's part
count on large workspace disks. The production uploader instead uses an 8 MiB
first part, 64 MiB ordinary parts, and 500 MiB later parts. This schedule fits
5,008,745,562,112 bytes within 10,000 parts, above Blob's documented 5 TB limit.
At most two part files exist; scratch therefore stays below 1,000 MiB, independent
of archive size. The complete ZIP is never staged.

The SDK's `onUploadProgress` path chunks Bun file bodies into 64 KiB pieces
before sending them through undici. Without it, large Blob bodies caused much
higher memory use. Progress reports count each part's high-water mark, so SDK
retries cannot inflate or regress public byte counts. A 60-second operation
deadline remains; increasing it would only conceal the provider's 512 MiB
rejection. Intentional-failure probes disabled SDK retries to expose HTTP 413;
production operations retain the SDK retries within that deadline.

## Expiry and scope

A separate three-second-TTL live probe used the same SDK methods as the adapter.
A wrong-path upload failed with `BlobPathnameMismatchError`; an expired part
upload failed with `BlobClientTokenExpiredError`. A fresh token then completed
that same multipart upload. Signed reads returned 200 while valid, 403 for a
different existing object, 403 for PUT instead of GET, and 403 after expiry.
A refreshed read grant returned 200. Both generated fixture objects were deleted
and fresh signed reads returned 404. Only the TTL differed from production.

## Unresolved provider behavior

Completed-object deletion is proven. Local cancellation, stalled work, failed
parts, restart cleanup, and lost completion acknowledgements have deterministic
worker/control tests. However, hidden **unfinished multipart parts** cannot be
listed or aborted through this SDK, and their reclamation remains unverified.
Calling `del` on the intended object path does not prove those parts were freed.

The [official SDK docs](https://vercel.com/docs/vercel-blob/using-blob-sdk) and
[multipart source](https://github.com/vercel/storage/tree/main/packages/blob/src/multipart)
expose create/upload/complete but no multipart-abort operation.
[Issue 639](https://github.com/vercel/storage/issues/639#issuecomment-2049820186)
and [PR 650](https://github.com/vercel/storage/pull/650) establish request
cancellation, not part reclamation or a retention deadline. The implementation retains the requested provider with this limitation disclosed
in the [choices ledger](../choices.md). No provider reclamation guarantee or
user approval is inferred from the absence of a response.
