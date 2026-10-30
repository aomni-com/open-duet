# MCP file resources

## Purpose

Duet has one description of a readable durable Drive file:

```ts
type FileResource = {
  uri: string
  name: string
  mimeType: string
  size: number
}
```

`uri` is a short-lived HTTPS URL that works with an ordinary `GET` or `HEAD`.
It needs no special request headers. `name` is the full durable Drive path, not
a display label. The other fields describe the representation available when
the resource was created.

REST returns `FileResource` directly. MCP adds only its standard content-block
discriminator:

```json
{
  "type": "resource_link",
  "uri": "https://vm.example/v1/files/mcp/generated-media/example.mp4?grant=…",
  "name": "mcp/generated-media/example.mp4",
  "mimeType": "video/mp4",
  "size": 123456
}
```

For binary files, `read_file` returns that one `ResourceLink`. For text files,
it returns the complete `TextContent` followed by the same link. Generated
images and videos become ordinary Drive files under
`mcp/generated-media/<uuid>.<canonical-extension>` and `generate_media` returns
the same one-link result.

The raw download API remains HTTP: the response body is the file, accompanied
by `Content-Type`, `Content-Length`, `ETag`, `Last-Modified`, and
`Accept-Ranges`. A JSON envelope does not replace the byte response.

## Why this shape

The API deliberately separates a file reference from a file transfer.
`FileResource` is the smallest portable promise a client needs to find and
download a file. HTTP already owns version validators, ranges, byte lengths at
transfer time, and cache behavior. The short-lived grant already owns expiry.
Repeating ETag or expiry in every resource would create two snapshots that can
disagree with the eventual download.

The URI is renewable, while the Drive path is durable. A later `read_file`
creates a fresh URI for the same path. A still-valid URI reads the latest bytes
at that path rather than pinning an old ETag. This latest-at-click behavior is
why the descriptive metadata is advisory and the eventual HTTP response is
authoritative.

Text is different only because MCP can use it immediately as model context.
Keeping the link beside inline text preserves the same durable-file contract
without duplicating those fields in `structuredContent`. Binary and generated
results carry no base64, success `structuredContent`, or `_meta` projection.

Generated media uses the general Drive transfer seams. It does not have a
generated-media download service. The dedicated `mcp/generated-media`
namespace keeps MCP-created media distinct from files agents or the product
place elsewhere. See `persistGeneratedFile` for the transfer mechanics.

## Invariants

- `FileResource` has exactly `uri`, `name`, `mimeType`, and `size`; MCP adds only
  `type: "resource_link"`.
- A resource URI is usable by a generic HTTP/MCP client without custom headers.
- Download grants authorize one normalized path for `GET` and `HEAD`. Upload
  grants authorize `PUT` and `DELETE` beneath one normalized prefix. These are
  constrained grant kinds, not caller-selected method lists.
- Grant tokens are opaque, hashed at rest, omitted from request logs, and
  short-lived. Upload and download grants bind the authenticated actor when
  minted; a transfer caller cannot replace that trusted identity.
- `HEAD` returns full-representation metadata without a body or file-read
  event. Successful grant-backed writes and `GET`s record the actor captured
  when the API minted the grant.
- Grant-backed reads are `private, no-store`; a cache must not defeat
  latest-at-click behavior.
- `serveDriveGet` remains the one owner of Drive bytes, ranges, ETags, content
  headers, symlink containment, and read events. Authenticated reads, granted
  reads, and raw public-publish reads reuse it with their own policies.
- Full valid UTF-8 text remains inline. A declared text file whose bytes are
  not valid UTF-8 falls back to its resource link.
- `generate_media` verifies `services`, `files:write`, and `files:read` before
  invoking a billable model. Its durable extension comes from the shared Drive
  MIME registry, with aliases resolved lexically.
- There is no compatibility result, alternate grant store, file API byte
  relay, generated-media retention policy, ETag-bound grant, `resources/list`,
  or subscription mechanism.
- Per `SECURITY.md`, a workspace VM is one trust domain. Drive grants bound
  accidental exposure and cost; they do not imply internal multi-user
  isolation.

## Contract boundaries

| Surface | Result | Authority |
|---|---|---|
| `GET|HEAD /v1/ws/{workspaceSlug}/files/{path}` | raw HTTP file response | authenticated API proxy |
| `GET|HEAD /v1/files/{path}?grant=…` | raw HTTP file response | exact-path download grant |
| `POST /v1/ws/{workspaceSlug}/file-downloads` | `FileResource` | `files:read` |
| `POST /v1/ws/{workspaceSlug}/file-uploads` | direct VM upload session | `files:write` |
| MCP `read_file` | text plus link, or link only | `files:read` |
| MCP `generate_media` | link only | `services`, `files:write`, `files:read` |

The upload-session response is intentionally not a `FileResource`: it is a
write capability used during transfer, not a readable-file description.

## Code and verification map

- `packages/contract/src/files/index.ts`: `FileResourceSchema`,
  `FileDownloadRequestSchema`, `FileUploadRequestSchema`, and
  `driveFileExtensionForMimeType` own the shared schema and MIME projection.
- `packages/gateway/src/auth/drive-grants.ts`: `DriveGrants` owns hashed upload
  and download credentials and their path authorization.
- `packages/gateway/src/runtime/http.ts`: the private `/v1/drive-grants` mint
  seam and granted raw-file routes.
- `packages/gateway/src/routes/files.ts`: `serveDriveGet` owns byte serving,
  full and single-range responses, metadata, containment, and activity.
- `apps/api/src/gateway/client.ts`: `createDriveFileResource`,
  `createDriveUploadGrant`, and `mintDriveGrant` join a workspace's public VM
  origin to the gateway-owned credentials.
- `apps/api/src/routes/workspaces.ts`: the authenticated public download and
  upload-session endpoints and the existing raw-file proxy.
- `apps/mcp/src/file-resources.ts`: `createFileResource`,
  `createFileUploadGrant`, and `toResourceLink` form the single MCP adapter.
- `apps/mcp/src/tools/files.ts` and `apps/mcp/src/tools/media.ts`: the two tool
  entry points. `persistGeneratedFile` owns the generation-to-Drive handoff.
- `apps/mcp/scripts/file-resource-probe.ts`: fast protocol proof through the
  repository's pinned official MCP SDK client.
- `packages/test-harness/src/staging-e2e-synthetic`:
  `runMcpFileResourceAcceptance` is the deployed gate through that same generic
  SDK client, including a real video, bare downloads, URI renewal, overwrite
  behavior, ranges, and grant-backed upload and GET attribution. The enclosing
  workspace journey owns resource cleanup.

The focused deployed acceptance run
[`32932656913`](https://github.com/aomni-com/duet/actions/runs/32932656913)
completed against commit `3981ee0ac`. Through the official MCP SDK client it
persisted an 850,865-byte MP4, found it through ordinary list/read operations,
and downloaded both the original and renewed links without headers. The two
downloads produced the same SHA-256 digest. The run recorded one upload write
and one bare-GET read, both attributed to the OAuth credential that minted the
respective grant; HEAD produced no read event. Cleanup completed without
orphans. ChatGPT is an example consumer, not a separate release oracle.

## Decisions and dead ends

The detailed [choices ledger](choices.md) records implementation decisions
that were not predetermined by the contract, including the official SDK test
client, honest end-to-end timing, canonical extension selection, and stable
storage-stage errors.

Rejected alternatives were:

- base64 or duplicate `content` and `structuredContent`, which make large media
  expensive and create competing owners;
- ETag, expiry, `_meta`, or a nested `file` projection in tool results, which
  duplicate HTTP or credential state;
- a generated-media-specific or API-relayed byte route, which duplicates the
  existing Drive server and preserves body-size bottlenecks;
- public publish URLs, whose lifetime and sharing semantics are different;
- ETag-bound grants, which contradict latest-at-click behavior;
- a token-only pathname, which hides the durable filename and needs another
  routing and content-disposition policy;
- one public discriminated transfer endpoint, because upload and download have
  different declarative OAuth scopes;
- adding a second OSS MCP client solely for acceptance, because the pinned
  official SDK already validates the standard result and transport boundary.

There is no visual provenance: this is a protocol and storage change with no
user-interface output or visual acceptance target.
