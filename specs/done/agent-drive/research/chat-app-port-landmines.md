**1. NOT FOUND: WebSockets In The Proxy Path**

**Evidence:** [sandbox-gateway route](/Users/synthetic-user/dev/chat-app/apps/sandbox-gateway/app/[[...path]]/route.ts:235) proxies with `fetch(...)`, and only exports normal HTTP methods at [route.ts:342](/Users/synthetic-user/dev/chat-app/apps/sandbox-gateway/app/[[...path]]/route.ts:342). Agent-gateway’s public-app proxy also uses `fetch(...)` at [public-app-service.ts:364](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/public-app-service.ts:364). Grep found no `upgrade`/WS handler in these proxy paths. Vercel now supports WebSockets in Functions, but their docs show WebSockets require handling the HTTP `Upgrade` request with a Node HTTP server / WS library, and connections are pinned to a Function instance for its max duration: https://vercel.com/docs/functions/websockets.

**Why It Bites:** User apps needing WebSockets will fail through both layers. This is not “Vercel can’t ever do WS” anymore; it is “this Next route + Hono fetch proxy cannot tunnel Upgrade.”

**What To Do:** Add an explicit WebSocket path using a Node server/`ws`-style upgrade handler, or terminate WS at exe.dev/platform edge and route to an upgrade-aware agent-gateway listener. Decide what happens after max duration.

**2. SSE/Streaming Is Only Partially Supported And Hard-Capped**

**Evidence:** sandbox-gateway sets `maxDuration = 400` at [route.ts:6](/Users/synthetic-user/dev/chat-app/apps/sandbox-gateway/app/[[...path]]/route.ts:6), `PROXY_TIMEOUT_MS = 300_000` at [route.ts:36](/Users/synthetic-user/dev/chat-app/apps/sandbox-gateway/app/[[...path]]/route.ts:36), then aborts proxy fetches with that timeout at [route.ts:241](/Users/synthetic-user/dev/chat-app/apps/sandbox-gateway/app/[[...path]]/route.ts:241). It returns `new Response(proxyResponse.body, ...)` at [route.ts:263](/Users/synthetic-user/dev/chat-app/apps/sandbox-gateway/app/[[...path]]/route.ts:263). Vercel supports streaming responses, but durations still matter: https://vercel.com/docs/functions/streaming-functions.

**Why It Bites:** SSE works only as ordinary HTTP streaming and will be cut around 5 minutes by the proxy timeout. Apps with long-lived EventSource, HMR-like streams, or AI streams must reconnect cleanly.

**What To Do:** Detect streaming responses and use a deliberate timeout policy, document the reconnect requirement, and test SSE through both gateways. Avoid a blanket 300s abort for routes that are meant to stay open.

**3. `/session/public/*` Control Routes Are Unauthenticated On The Gateway Port**

**Evidence:** `createSessionRoutes` mounts cron/public config/public domains without auth middleware at [session.ts:15](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/routes/session.ts:15). `/session/public/config` accepts JSON and writes `public.config.json` at [public-config.ts:74](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/routes/public-config.ts:74) and [public-config.ts:112](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/routes/public-config.ts:112). Public-domain routes explicitly say “without needing user auth” at [public-domains.ts:17](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/routes/public-domains.ts:17).

**Why It Bites:** On exe.dev’s one public HTTPS port, exposing agent-gateway directly exposes config/domain mutation endpoints unless the platform routes only `/public/*`. The backend call uses the gateway token, but the caller to the gateway is not authenticated.

**What To Do:** Put control routes on a localhost/authenticated port, require a caller token, or have the public listener only serve `/public/*` and `/health`.

**4. E2B Per-Port Public URL Model Is Baked In**

**Evidence:** `E2BSandbox.url(port)` returns `https://${this.#sandbox.getHost(port)}` at [client.ts:105](/Users/synthetic-user/dev/chat-app/packages/services/src/e2b-sandbox/client.ts:105). Backend setup always computes gateway URLs from `sandbox.url(GATEWAY_PORT)` at [actions.ts:413](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/sandboxes/actions.ts:413). `/sandbox/resolve` returns that URL to sandbox-gateway at [routes/sandbox.ts:117](/Users/synthetic-user/dev/chat-app/packages/backend/convex/routes/sandbox.ts:117).

**Why It Bites:** exe.dev has one public hostname per VM and authenticated-only extra ports. Anything expecting provider-generated public URLs per port must be replaced with “one public gateway URL + private localhost app ports.”

**What To Do:** Introduce a provider target model: `publicGatewayUrl`, `internalGatewayPort`, provider VM id/name, and app-private ports. Stop passing generic `port` into provider URL generation.

**5. Pause/Auto-Resume Is Not An Optional Detail**

**Evidence:** E2B creation sets `lifecycle: { onTimeout: 'pause', autoResume: true }` at [client.ts:404](/Users/synthetic-user/dev/chat-app/packages/services/src/e2b-sandbox/client.ts:404). Commands and file writes rely on auto-resume at [client.ts:132](/Users/synthetic-user/dev/chat-app/packages/services/src/e2b-sandbox/client.ts:132) and [client.ts:201](/Users/synthetic-user/dev/chat-app/packages/services/src/e2b-sandbox/client.ts:201). sandbox-gateway comments assume lazy resume during `/sandbox/resolve` at [route.ts:38](/Users/synthetic-user/dev/chat-app/apps/sandbox-gateway/app/[[...path]]/route.ts:38).

**Why It Bites:** exe.dev is always-on, no pause/resume. Resolve should not be a wake path, keep-alive and runningUntil semantics become misleading, and “retry slow resume” masks different failures.

**What To Do:** Split lifecycle policy by provider. For exe.dev, remove wake-on-request behavior and replace liveness with VM/process health checks.

**6. Public Sandbox File Downloads Depend On envd**

**Evidence:** `downloadUrl()` is documented as a signed envd `/files` URL with Range support at [client.ts:238](/Users/synthetic-user/dev/chat-app/packages/services/src/e2b-sandbox/client.ts:238). `getSandboxFileDownloadUrl` returns `sandbox.downloadUrl(...)` directly at [actions.ts:2403](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/sandboxes/actions.ts:2403). The video viewer uses that URL as the media `src` at [sandbox-video-viewer.tsx:36](/Users/synthetic-user/dev/chat-app/apps/web/spa/files/components/viewers/sandbox-video-viewer.tsx:36).

**Why It Bites:** exe.dev will not have E2B envd signed URLs. Video seeking and large downloads currently rely on envd’s Range behavior.

**What To Do:** Build a provider-neutral file download endpoint, likely in agent-gateway, with auth and byte-range support.

**7. NOT FOUND: Range Handling In Public File Routes**

**Evidence:** agent-gateway static public files use `fs.readFile` and return the whole file at [public-app-service.ts:397](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/public-app-service.ts:397). Public API file download fetches storage, converts to `blob()`, then returns 200 at [files/[storageId]/route.ts:16](/Users/synthetic-user/dev/chat-app/apps/web/app/api/v1/files/[storageId]/route.ts:16) and [files/[storageId]/route.ts:24](/Users/synthetic-user/dev/chat-app/apps/web/app/api/v1/files/[storageId]/route.ts:24). No `Range`/`206` branch exists in those files.

**Why It Bites:** Large files are buffered in memory, and media clients cannot seek through these routes. This is separate from envd downloads, which did support Range.

**What To Do:** Stream files, forward/parse `Range`, return `206 Content-Range`, and preserve `Accept-Ranges`.

**8. Custom Domains Are Vercel-Project Domains**

**Evidence:** The Vercel wrapper requires `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_SANDBOX_GATEWAY_PROJECT_ID` at [vercel.ts:9](/Users/synthetic-user/dev/chat-app/packages/backend/convex/services/vercel.ts:9). It adds domains to a Vercel project at [vercel.ts:160](/Users/synthetic-user/dev/chat-app/packages/backend/convex/services/vercel.ts:160), verifies via Vercel at [vercel.ts:209](/Users/synthetic-user/dev/chat-app/packages/backend/convex/services/vercel.ts:209), and polling calls `getDomainStatus` at [customDomains/actions.ts:310](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/customDomains/actions.ts:310).

**Why It Bites:** exe.dev custom domains/TLS likely have different APIs, DNS targets, and verification states. The DB status machine is coupled to Vercel responses.

**What To Do:** Wrap domain operations behind a provider adapter and store provider-specific verification records. Do not reuse Vercel “active/verifying” semantics blindly.

**9. Gateway Token Expiry Is Inconsistent**

**Evidence:** Sandbox records get a stable `gatewayToken` at [internal.ts:75](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/sandboxes/internal.ts:75). Setup writes `credentials.json` with `expiresAt` defaulting to 24h at [setup.ts:104](/Users/synthetic-user/dev/chat-app/packages/backend/registry/sandbox/setup.ts:104). `hasValidCredentials()` checks expiry at [credentials.ts:70](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/utils/credentials.ts:70), but admin auth only compares token equality at [admin.ts:27](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/routes/admin.ts:27), and public API auth checks the DB token at [auth.ts:31](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/publicApi/auth.ts:31).

**Why It Bites:** On persistent exe.dev disks, old credential files can live forever. Some code reports expired credentials; other code accepts the same token indefinitely.

**What To Do:** Either remove file expiry or enforce it everywhere with a real rotation path. Make health/readiness reflect the same auth rule admin/API calls use.

**10. Runtime User/Home Path Is Hard-Coded**

**Evidence:** `SANDBOX_HOME_DIR = '/home/synthetic-user'` at [sandbox.ts:21](/Users/synthetic-user/dev/chat-app/packages/shared/src/constants/sandbox.ts:21). agent-gateway config defaults all state under that path at [config.ts:13](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/config.ts:13). E2B command users are typed as `'user' | 'root'` at [client.ts:86](/Users/synthetic-user/dev/chat-app/packages/services/src/e2b-sandbox/client.ts:86).

**Why It Bites:** exe.dev images may not have `/home/synthetic-user` or E2B’s user model. Persistent disk state, credentials, sessions, public config, and `.env` all depend on that path.

**What To Do:** Define the exe.dev base image contract or make home/workspace paths provider-configured from provisioning.

**11. Gateway Restart Depends On A nohup Watchdog, Not A VM Boot Service**

**Evidence:** setup writes a bash watchdog loop at [setup.ts:237](/Users/synthetic-user/dev/chat-app/packages/backend/registry/sandbox/setup.ts:237) and starts it with `nohup ... &` at [setup.ts:269](/Users/synthetic-user/dev/chat-app/packages/backend/registry/sandbox/setup.ts:269). In-memory public app process state lives in `processes = new Map(...)` at [public-app-service.ts:110](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/public-app-service.ts:110), while session metadata is persisted to disk at [session-store.ts:50](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/session-store.ts:50).

**Why It Bites:** A VM reboot kills the nohup watchdog and gateway unless exe.dev starts it via an init/supervisor. Disk state survives, but processes do not.

**What To Do:** Install agent-gateway as the VM boot service under exe.dev’s supervisor/systemd equivalent, then let it reload disk config and respawn public services.

**12. Half-Built Provider Abstraction Exists But E2B Still Owns The Paths**

**Evidence:** schema allows `deno-sandbox` providers at [internal.ts:245](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/sandboxes/internal.ts:245), but active resolution returns only E2B coordinates at [internal.ts:1270](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/sandboxes/internal.ts:1270), and setup/actions import `E2BSandbox` directly at [setup.ts:8](/Users/synthetic-user/dev/chat-app/packages/backend/registry/sandbox/setup.ts:8). README/comments still describe Fly.io Sprites at [index.ts:5](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/index.ts:5).

**Why It Bites:** There is prior provider-shaped code, but it is not a usable abstraction. Porting on top of it will produce mixed E2B/exe semantics.

**What To Do:** Delete dead provider arms or finish a real provider interface before porting flows. Treat `deno-sandbox` and Sprites references as stale until proven live.
