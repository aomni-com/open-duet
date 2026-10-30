<!-- DOCS-FIRST DRAFT (slice 20), revision 2 — edited after the unprimed
     review (findings + resolutions recorded in
     specs/file-attribution/slices/20-sync-credential.md). Full revised text
     of the repo-root SECURITY.md, amending the workspace-scoped-key
     invariant for the sync_device credential kind and adding its
     blast-radius write-up. Lands with the slice-20 implementation in the
     same diff. -->

# Security model

How access is controlled across the platform, and why the deployment-level
protection (Vercel SSO) is a second lock rather than the primary one. This is the
canonical home for the auth _principles_; the mechanisms live in the packages
pointed to at the end.

## The gate is account creation

Identity enters the system in exactly one conceptual place — creating an account —
and there are two doors onto the _same_ implementation
(`createOrLinkUserForAuth`), so an account is identical however it was made:

- **Real signup/login** — Convex Auth (email magic-link + Google OAuth), browser
  straight to Convex. This is the only path a normal user takes; `duet-api` has no
  signup route.
- **Programmatic** — `POST /v1/admin/login-as` on `duet-api`, gated by a dedicated
  secret (`DUET_PROGRAMMATIC_LOGIN_SECRET`) at the HTTP layer; the underlying Convex
  mint (`mintImpersonationKey`) is separately gated by the server-to-server internal
  key (`DUET_API_INTERNAL_KEY`), so holding _either_ the login secret (via the route)
  or the internal key (direct) can impersonate. Creates-or-reuses the account and
  mints a session — a controlled backdoor onto the real creation path, not a parallel
  one. Treat both secrets as impersonation-grade and rotate on exposure.

Protect these two doors and everything downstream is protected, because nothing
downstream can be reached without an account.

## Everything downstream authenticates with workspace-scoped keys — with one exception

Once an account exists, _every_ request carries a credential scoped to a
workspace — a Duet API key for the REST surface, or a per-workspace VM model key
for the model gateway — with exactly one deliberate exception (`sync_device`,
next section). No ambient trust, no "you reached the URL so you're in":

- `duet-api` validates a Duet API key on every `/v1/*` route; the auth-bypass
  routes (`login-as`, `vm/*`, device flow) each carry their own secret or token
  instead.
- **The model gateway validates the caller's workspace key before it will forward
  anything** to the upstream Vercel AI Gateway (where the real, billable
  `AI_GATEWAY_API_KEY` lives). It is not an open proxy — the workspace key is the
  gate, and it is minted per workspace.

So the chain to spend an AI-gateway credit is: valid workspace key → provisioned
workspace → account. Break the first link and there is nothing to spend.

**The key invariant, precisely:** every credential kind except `sync_device` is
single-workspace — `assertSingleWorkspaceScopes` binds at mint and the `ws:` scope
grammar binds at use. `sync_device` (next section) is the one deliberate exception:
user-wide, and in exchange capability-floored to files.

## The exception: sync-device credentials, user-wide but floored to files

Drive mirroring (`duetfs sync`) needs one credential that follows the user across
workspaces and identifies the machine holding it. The `sync_device` kind is that
credential — user-wide by design, capability-floored to files in exchange:

- **The credential _is_ the device identity**, minted through the device flow with
  a browser approval — a new approval mints a new device, and the device name is
  self-asserted by the requesting tool. That approval screen is the sole gate on
  issuing a user-wide grant, which is why its wording names the breadth. The
  credential document id is the `mirror:<deviceId>` actor in file activity; the
  device's Syncthing device ID is bound later, at mirror registration, not proven
  at mint. There is no second device registry to protect.
- **Scopes are exactly `user:files:read` + `user:files:write`** — the only kind
  allowed the `user:` scope form, and the only scopes grantable on it
  (`assertSyncDeviceScopes` at mint, parallel to `assertSingleWorkspaceScopes` for
  every other kind). Workspace access is evaluated from live membership on each
  request: joining a workspace extends the device to it; leaving one removes it by
  more than the per-request `403` — the same cascade as revocation pulls the
  device from that workspace's mirror folders and invalidates its tunnel access.
- **Blast radius of a stolen sync credential — treat it as severe:** read and
  write on the files of every workspace the user belongs to at time of use. File
  write is execution-adjacent: written source and config is later executed by
  agents and apps in those workspaces. File read includes every synced `.env*` and
  credential file across all the user's mirrored workspaces — treat a stolen sync
  credential as potential compromise of everything those files reach, not "just
  files". What the key itself can never do: no agent execution, no workspace
  administration, no membership changes, no shares or publishes, no billing, no
  model-gateway spend. The ceiling is enforced at mint _and_ on every request, so
  no issuance path can widen a live key.
- **Read-only use leaves no per-file trail:** mirror reads emit no file-activity
  markers (they are replication, not attention), so read-only exfiltration is not
  visible in any file's history. Detection is the credential's last-used timestamp
  and the web device list — nothing finer.
- **Containment is per-device and web-visible:** each device is listed in the web
  app (name, created, last used) and revoked individually — losing one laptop never
  forces rotating the others. A revoked key fails `401` everywhere within the
  server's credential-cache TTL, and revocation cascades through sync
  orchestration: the device is removed from every mirror folder and its tunnel
  access is invalidated.
- **The floor is load-bearing:** the files-only ceiling is never widened without a
  change to this file in the same diff. A future capability on this kind is a
  security-model change, not a feature flag.

## Why Vercel Deployment Protection is defense-in-depth, not the control

Every deployed service enforces its own key auth (above). Vercel's SSO/deployment
protection sits _in front of_ that as a coarse outer gate. The consequence:

- **Disabling SSO on a service makes it internet-reachable but grants no access** —
  the app-level key auth still gates every route. An unauthenticated caller gets a
  401, not a free ride.
- The one thing SSO was a genuine _second_ lock on: the secret-gated endpoints,
  above all `login-as` (which mints a session, and a session can spend credits).
  With SSO off, those secrets become the sole gate — so they must stay strong
  (32–64-char random) and be **rotated if ever exposed** (e.g. handled in a support
  session).
- Therefore: **staging may run with SSO disabled**, relying on app-level auth, _as
  long as account creation stays locked_. **Production should keep SSO on** as a
  cheap extra layer — there's no reason to remove it there.

The load-bearing invariant, stated once: _the strength of the whole system equals
the strength of the account-creation gate._ Everything else is a key check that
chains back to it.

## Where the mechanisms live

- **Convex Auth** (real signup/login providers + the shared `createOrLinkUserForAuth`
  account bootstrap) — `packages/backend/convex/auth.ts` and `domains/users`.
- **Session credentials** (Duet API keys: mint, hash-at-rest, validate, and the
  per-workspace capability scopes) — `packages/backend/convex/domains/apiKeys`; the
  browser carries one as the `duet_session` cookie. Scope grammar lives in
  `packages/contract/src/scopes`.
- **Sync-device credentials** (the `sync_device` kind: device-flow issuance,
  per-device revocation, files-only ceiling) — same `domains/apiKeys`; the `user:`
  scope grammar and its ceiling assertion live beside the `ws:` grammar in
  `packages/contract/src/scopes`.
- **Programmatic login / impersonation** — `apps/api/src/routes/admin.ts`
  (secret-gated) calling the mint above.
- **Model-gateway key validation + AI-gateway forwarding** —
  [`apps/model-gateway`](apps/model-gateway/README.md).
- **Trust-root internal key** (server-to-server, e.g. api → Convex acting as a
  user) — `requireApiInternalKey` in `domains/apiKeys`.
