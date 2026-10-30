# Workspace backup encoding

The backup producer owns the complete configured Drive, independently of publish
selection. It reads files through open directory descriptors and refuses to
follow substituted symlinks, so concurrent renames cannot redirect traversal
outside the captured tree. Observed changes and omissions make the result
partial; the archive never claims an atomic snapshot.

Python's [standard-library ZIP writer](https://docs.python.org/3/library/zipfile.html) owns compression, CRCs, descriptors and
ZIP64 framing. It already ships in the VM image. Bun bundles the encoder and
[recovery instructions](recovery.md) as text, so there is no runtime source-file
lookup or additional image dependency. The archive schema belongs to
`@repo/contract`; the Python process reports a manifest that Bun validates
before its completion promise can succeed.

The output stream and portable-entry input apply backpressure. The encoder stages its report spools outside Drive; Drive contents and the
complete ZIP stream directly. File reads stop at the observed size so an append-only
writer cannot prevent completion, and hashes describe the actual captured bytes.
Python retains central-directory metadata proportional to entry count, not file
bytes. This is an explicit memory cost, measured by the separate ZIP64 boundary
probe, rather than a hidden file-count ceiling.

Portable producers yield files under `workspace/` and warning records. They must
page upstream data and stream each file body. A producer failure fails the whole
archive; known recoverable omissions should be yielded as warnings. Cancellation
interrupts pending reads, kills the encoder and settles completion even if an
upstream iterator never returns. Callers must consume or cancel the body and
await `completed` before publishing a successful backup. The upload worker owns
the final ZIP checksum and byte count.

The package's `backup:fixture` script writes a reviewable example archive.
`backup:probe` explicitly runs the expensive ZIP64 boundary check with an
independent libarchive reader; it stays outside the ordinary test loop.

[Portable metadata](metadata.ts) captures each canonical page once. The same
event records feed structured history and the readable transcript; task rail
exclusions follow the shared transcript policy. One category or session is
spooled at a time outside Drive, so heap use does not grow with history. Image
bytes are verified before yielding an entry and staged individually. Small
on-disk image markers let event references resolve without retaining every
attachment in memory. Cancellation removes the producer's private temporary
directory.

Archive-local session and image path components encode source keys as base64url.
Source keys remain in the metadata for mapping; captured event image references
carry relative archive paths. Transient download URLs never enter archive
records. A failed image capture remains an explicit warning, and a page that
fails or cannot advance fails the capture rather than silently stopping.

The [worker](worker.ts) acknowledges control commands before capture starts.
Its private atomic journal distinguishes an interrupted stream from an uploaded
artifact awaiting acknowledgement: only the latter can resume, by reporting the
same digest and byte count without recapturing. Existing VM sync carries progress
and retries terminal reports with backoff; there is no additional permanent
polling service. Active work temporarily keeps that sync responsive and defers
gateway updates. The shared stall interval measures data/page progress rather
than successful heartbeats.
Captured byte counts advance as entry chunks are compressed, while entry counts
advance on close. Throttled reports therefore keep a large compressible file
observable even before it produces another upload part.

The [multipart uploader](upload.ts) uses the official Blob client API with a
fresh per-object grant when needed. Bounded part files make retries independent
of a one-shot archive stream. Small early parts keep ordinary exports responsive;
larger later parts leave enough of the provider's part budget for its full object
limit. At most two part files exist concurrently, and restart removes abandoned
scratch. SDK operations have a deadline; cancelling the worker stops local work
while control-plane cleanup owns any remote artifact that finishes late. The SDK
has no multipart-abort method, and provider reclamation of unfinished parts has
not been independently established.
