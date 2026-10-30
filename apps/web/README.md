# web

`web` owns Duet's product app, authentication surfaces, and browser-session
transport. It is an API consumer: ordinary product UI never reads or mutates
Convex directly. The SPA owns the product host root; `/app` is not a mount,
alias, or compatibility route.

Server boundaries that consume unexpected session or proxy failures must retain
their cause in diagnostics before returning a stable public error. The
[request-failure owner](src/server/request-failure.ts) attaches request context
and redacts error details without copying cookies, request bodies, or URL queries.
Expected missing identity and caller cancellation remain quiet; a temporary
rotation failure still falls back to an unexpired credential.

## Vocabulary

The container a person works in is a **workspace** — it holds sessions, apps,
members, billing, and a VM. **Drive** is one feature of it: the file tree, and
the tab that shows it. Copy that names the container says workspace; copy that
names the file tree says Drive, capitalised as the product noun. The `drive*`
identifiers throughout `spa/` mean files and are correct as they stand; the
container is `workspace*` everywhere. Getting these two backwards is the most
likely mistake when adding user-facing strings, and no type will catch it.

## Boundaries

- `app/` owns the root product composition, identity surfaces, and the
  transparent browser-session API proxy. Device approval crosses that proxy;
  direct backend identity access is limited to session bootstrap and auth.
  Device login and named API keys identify the person; current workspace
  membership determines access. Synced Macs are separately removable machines,
  so stopping one Mac’s mirrors preserves the person’s login and other Macs.
  The [human login review evidence](../../specs/done/unified-duet/assets/human-ui/README.md)
  records the product choices and local verification behind these account surfaces.
- Invitation acceptance owns its destination: email session completion and
  in-app acceptance both navigate to the accepted workspace, independent of
  the default workspace or unfinished personal onboarding. A rejected email
  invitation clears its pending token so it cannot poison ordinary sign-in;
  an accepted invitation retains context until browser-session issuance succeeds.
  Incoming invitations belong to account chrome in `spa/shell/`, above both
  workspace pages and onboarding. Signup is open; an invitation grants access
  to the inviter's workspace and stays visible whichever workspace the person
  chooses. Workspace billing surfaces occupy the space below this chrome and disable only that
  workspace; they must not trap focus away from account-level invitations.
  The workspace they disable includes its own switcher, so every blocking
  billing surface offers the viewer's other workspaces itself — someone waiting
  on another person's payment, or with no plan of their own, would otherwise
  have no way to reach a workspace that still runs.
- `spa/` owns browser routing and presentation. Its data layer is the only ordinary product network owner.
  Next owns one persistent authenticated product entry and the cold-document loading shell; after
  hydration, product navigation stays inside the browser router so workspace chrome, query state,
  and live connections survive a change of subject. Only the destination pane may crossfade, keyed
  by the semantic destination rather than the raw URL, and internal actions navigate through the
  router instead of replacing the document. This keeps one owner for cold loading and one owner for
  in-app transitions without enabling Next's experimental document view transitions.
- The workspace's home is a canvas, not a list, and it has rules of its own about
  geometry, colour and what may be drawn at what fleet size — they live in
  [`spa/knowledge-map/README.md`](spa/knowledge-map/README.md). Everything under
  that folder is pure or presentational: the route above it owns every query and
  every destination, and the map reports what was clicked.
- Workspace switching is account navigation: an unfinished setup or unavailable
  workspace must still let the reader reach another workspace they belong to,
  even when the normal workspace shell is absent.
- Onboarding is a shell-free sibling of the workspace app routes. Completion
  stamps the workspace identity before handing off to the app shell; the root
  Duet's display name therefore comes from that workspace identity, not from an
  installable agent record. Its wizard is tap-only by construction: picking a
  goal seeds every follow-up answer, so the initial state is already a complete
  answer set. **This app is the only composer of the workspace `purpose`** — one
  paragraph built by `spa/onboarding/onboarding-purpose.ts` out of the localized
  labels the user actually tapped, which is why the server stores it as opaque
  text and never learns a goal id. Step presence and the minimum-team floor have
  one owner each in `spa/onboarding/onboarding-flow.ts`, and the floor fails open
  so a marketplace outage cannot dead-end a signup.
- Agents is a composite product section: Home owns the marketplace catalog, while installed-agent
  identity and training remain under each agent's own route. An agent whose config declares
  onboarding collapses to one onboarding surface until this workspace completes it: the action
  while setup can be started, then a bounded startup expectation while its declared app or chat is
  arriving. That pending app surface keeps the app list live because an absent app has no runtime
  status that could trigger ordinary reconciliation polling. An agent may opt out of training
  entirely; both behaviors derive from one projection over `agent.json`
  (`spa/drive/agent-onboarding-projection.ts`) that fails open when the config cannot be read. The
  static `marketplace` route segment keeps those identities disjoint without restoring a separate
  top-level tab, and a listing is addressed by `(publisherSlug, agentName)` — a bare agent name
  cannot address one, because two publishers may ship the same name. Cards, query keys, and
  installed-state matching therefore key on the listing id, never the name. A confirmed agent
  creation enters that live roster before its URL can name it: route resolution treats a settled
  roster absence as real and warns accordingly, so navigation cannot lead the registration fact.
- The agents map is a canvas rather than a page, and it has its own doc:
  [`spa/knowledge-map/`](spa/knowledge-map/README.md) — what draws it, what moves it, and the
  rule that everything able to start the motion loop has to wake it.
- **What the reader can see on the map, they can send.** The zoom and the card are path
  segments under `/w/:ws/agents/:agentSlug` — the whole
  grammar is owned by one pure module, [`spa/drive/agents-map-url.ts`](spa/drive/agents-map-url.ts),
  and every question about it (is this the canvas, which tab lights, which skeleton a cold
  landing draws) is asked of that module rather than of a regex of one's own. The bare
  **Bare `/agents` is the root agent's conversation, not the drive's picture of itself** — the
  section's front door, and the grammar keeping its one rule rather than making an exception to
  it: every agent surface is addressed by an agent segment, and `root` is a real subject with a
  real place. The picture has a segment of its own. `/agents/:agentSlug` is an entry point only:
  it renders no implicit card and replaces itself with the explicit URL for the first usable
  item in that reader's arranged row. The agent's configuration document is at `…/settings`.
  One thing on that surface deliberately gets no segment, and it fails the test the grammar
  applies — it names no subject a link could be about: whether the roster is out is furniture,
  a reader preference rather than a place. The whole product's address space, and the reasoning,
  is [`specs/done/url-map`](../../specs/done/url-map/README.md).
  The agent page is mounted through **one** splat rather than a pattern per shape: React Router
  reconciles by position, so two sibling patterns for one element remount it whenever a path
  crosses between them — which the entry rewrite does on every cold landing, and which the
  persistent roster in that subtree cannot afford.
- Build keeps the same fixed sidebar footprint as Work. The mode switch therefore stays in one
  place while the navigation beneath it changes subject: Work exposes conversations and apps;
  Build exposes the map, the agent roster, and agent creation. On desktop the sidebar is permanent,
  so switching agents never reflows the shell; below the desktop breakpoint it becomes a dismissible
  drawer because it would otherwise cover the selected destination. The roster under
  `spa/routes/agents-map/agents-rail/` projects the map's existing records rather than issuing a
  second read. Its compact rows are intentionally identity-first: the map and selected agent surface
  own the detailed apps and work, while the sidebar stays fast to scan and stable across every
  `/agents` destination.
- **A session belongs to exactly one mode, and the split is which conversation it is.** An owner's
  own chat is Build's: a roster row *is* that conversation, and every mark the row wears — its
  state dot, its unread — reads `agent.chat` and nothing else. Every other session is Work's, in
  all its statuses, whatever it is running. Build's Recent jobs modal discovers the direct
  children of its displayed default chat across assigned agents; selecting one opens Work.
  Parentage owns discovery here, not the child's agent. The paginated children query keeps older
  delegated work reachable without turning Build into a second session viewer. A non-default
  session has one address and it is Work's (`workSessionUrl`, `…/sessions/:id`); the session path
  itself selects Work.
  Everything that belongs to a conversation rather than to a mode —
  its title and rename, archive, delete, audience, and its app open beside the thread — lives on
  Work's conversation header and surface, which is the one host whose whole subject is a single
  conversation. Child sessions are addressable in Work regardless of whether their parent
  is an ordinary conversation, a default chat, or another child. Session metadata owns
  that relationship; session URLs require no query parameters and ignore stale query strings.
- Work keeps its primary Chats section present even before the first conversation, because that is
  where a reader starts one. Its secondary Other chats section is evidence-driven instead: the
  workspace activity response already says which agents own a canonical chat or session, so that
  one bounded read controls both the section and its agent groups without an empty roster or a
  request per agent.
- Portraits share one identity geometry under `spa/identity/`: agent and person portraits are
  deliberately squarish, while status dots, badges, and brand marks keep their own semantic shapes.
  Agent image selection remains owned under `spa/agents/`: Duet keeps its authored brand art, while
  every other agent-facing surface prefers an uploaded portrait and otherwise derives the same
  deterministic local fallback from the package name or installed-agent slug, never editable
  display copy. This keeps identity stable across navigation and authored session messages without
  turning the shared UI package into a product-identity owner. The transport/identity split is
  recorded in the [`schema-cleanup` rationale](../../specs/done/schema-cleanup/README.md).
- Waiting has one owner and one rule — one navigation, one skeleton, and it is the shape of the
  destination the reader is actually going to. Which wait a path owns, why an unknown path is not
  a destination, and the single attribute every page-level wait carries live in
  [`spa/loading/README.md`](spa/loading/README.md); loading must never substitute an unrelated
  product surface or a disconnected full-page spinner.
- Product destinations share one workspace-page vocabulary for type hierarchy, gutters, and
  real interaction boundaries. Route modules compose that presentation owner while keeping
  their data and mutation seams local; a new destination should not recreate page chrome or
  card policy from raw utility classes.
- Train is one control center at `/w/:ws/train/:agentSlug`, root included: its selected
  root-or-agent scope drives
  both the stable training pane and the memory library, while the root library also provides the
  agent directory. Memory reading and editing stay on dedicated nested routes, and each record
  path retains its owning scope so bookmarks and inherited-memory links cannot disagree with the
  visible memory. Legacy agent-detail Train URLs only redirect into this owner. The storage and
  inheritance rationale lives in
  [`specs/done/train-files`](../../specs/done/train-files/README.md).
- An app is always shown as itself, and it has exactly one address: the card of the agent whose
  folder encloses it. There is no workspace-level app page — an app the drive holds directly
  belongs to the drive's own agent — so every door into an app resolves that owner and builds
  the agent URL. The card frames the running app through the launch redirect that mints an
  access grant, never at the app's public URL, which by design refuses everyone while the app
  is private. Visibility governs whether a public link is offered, never whether a member can
  use the app, and what a member may change comes from the app's own server-resolved controls
  rather than from workspace role, because a shared replica's permissions come from its share.
  Those controls live in the menu on the chip that names the app; a broken folder link is
  explained there rather than repaired, because repairing one meant naming a Drive path, and
  "anchor" is the product's word rather than a reader's.
  The in-frame viewer of a **private** app works only on deployed hosts, not `localhost`: the
  grant cookie is `SameSite=Lax`, so it flows in the frame only when the shell and the edge are
  same-site (both `duet.so` on staging/prod), which `localhost:3000` is not. Test private-app
  framing on a deployed preview. The rationale record is [`specs/done/shared-app-viewer`](../../specs/done/shared-app-viewer/README.md).
- App domains belong to the local app binding. The [domain management owner](spa/apps/app-domain-dialog.tsx)
  uses the same REST-backed slot in app menus and Settings; browser presentation follows
  server-projected permissions and provider observations. A removal keeps that slot visible
  until cleanup finishes, so another hostname cannot hide outstanding work. Domain changes
  refresh standalone app links, while embedded frames always use Duet's launch host.
  Settings consumes the paged domain inventory without per-app reads; explicit app
  navigation shares the Drive's app-location owner and cached agent roster. A queued
  recheck adds observable work without changing serving readiness: the current
  address stays visible while mounted managers and loaded inventory rows wait for
  the next observation. The inventory continues after a manager closes and refreshes
  app address caches when readiness changes, without fetching each app.
  The aggregate carries app identity rather than runtime health; its manager shows
  domain evidence, while the app view owns service availability. A manager opened
  with full app context can also explain an unavailable service.
- The gap before an app paints belongs to the product, and the white canvas belongs to the app.
  Every opening spends the grant redirect and the app's boot on a document that does not exist
  yet, and an empty frame is transparent — so the frame is layered: a themed placeholder
  underneath, the frame over it carrying no colour until it has loaded. A loaded app then gets
  the opaque white canvas a browser tab would have given it, because a document that sets no
  background of its own is written for one. Colour on the frame itself is what made a dark drive
  open every app through a white flash.
- `app/publish/` + `spa/publish/` own the anonymous public publish viewer. The
  route lives outside `(product)`, classifies as unprotected, and reads only
  its params plus the edge-injected viewer descriptor header — never cookies,
  `AuthProvider`, or an authenticated API call (pinned by tests). Its data
  flows solely through `PublicFileSystemProvider` (read-only, same-origin,
  `credentials: 'omit'`); presentation reuses the same `DriveBrowser`/
  `PreviewPane` the authenticated Drive mounts, driven through their explicit
  public/read-only capability contracts, with text always shown as source.
- The authenticated Drive is assembled in exactly one place, `spa/files/workspace-drive.tsx`.
  `FilesSurface` is presentation over seams it does not build, and one of them — the workspace's
  app list, which is how an app's anchor folder draws as that app — arrives through context whose
  hooks _throw_ when it is absent. So a second mount point that brings the file system and forgets
  the apps does not degrade to a Drive without apps; it takes the whole destination down to the
  route boundary. Every surface that shows the Drive (its own destination, the agent card on the
  map) composes `WorkspaceDrive`; both keep the current path in their own URL grammar so an agent
  can name the exact file or folder without sending the reader away from its conversation.
- A text document in the Drive has no Save control: `spa/files/use-text-document.ts`
  owns the whole write rail — the draft, the folding of remote reads into it, the
  debounce, the parting flush when the reader leaves, and what a rejected write
  means — and the pane that renders the document holds none of it. Two rules keep
  that rail honest. A conflict is a disagreement about _content_, so the bytes
  decide it and never the identity alone: the drive's ETag is
  [stat identity, not a content hash](../../packages/gateway/README.md), so ordinary churn would
  otherwise raise a banner accusing the only author of racing themselves — a
  rejected write re-reads before it says a word to anyone. That identity is
  always the one `stat` reports, never the one a content read carried: the same
  value reaches the browser in a JSON body and in an `ETag` header, and only the
  header is rewritable in transit — build `If-Match` from the header and every
  conditional write is compared against a value the drive never minted. And the
  baseline a
  landed write establishes is the text that was _written_, not whatever the
  textarea holds when the response arrives; under autosave the reader keeps
  typing through the round trip, and claiming those later words were saved is how
  an editor loses a sentence and reports success.
- `app/playground/` and `components/playground/` own hermetic visual fixtures. They may render production presentation, and may READ the product's own API through a `spa/api` client, but they never mount backend, auth, or Convex providers, and they never trigger a call that costs money or writes. The app frame is substituted through its own source seam so a fixture never reaches a workspace. A fixture that reads live must degrade to a deterministic fallback: the visual gate photographs these pages with no session, so the signed-out path is the one under test, and a live-only fixture would make baselines depend on a deployment.
- The REST fake those fixtures mount the signed-in product against lives in one
  place, `components/playground/spa-fixture.ts`, and it holds no JSX on purpose:
  the coverage inventory reads `.tsx` only, so two fixtures can share the fake
  without either one claiming ownership of the other's components. A fixture
  that needs a _journey_ rather than a state composes that fake with its own
  mutable facts — see `onboarding-journey-fixture.ts`, which holds only the
  workspace's onboarding stamp and the subscriptions an install produces, and
  lets the product's own redirects walk from a just-registered root to the Drive.
- The SPA can stay mounted across deployments, so it asks its own origin which
  build is serving it: `GET /api/version` answers the opaque, uncached
  deployment identity, plus the full release revision and persisted-query cache
  schema used by deployment acceptance. The opaque identity changes on
  promotion and on nothing else; it is never a semantic
  version anything may parse or compare for ordering. It is
  anonymous by classification and carries no workspace state, which is why it is
  the shell's only network call outside the Duet API. A tab that sees the answer
  disagree with the one it booted on is running stale code and says so once;
  reloading is always the user's decision, never forced.
- **A payment is provisional until the webhook says otherwise.** Stripe moves the
  wallet from a webhook that lands seconds _after_ it redirects the browser back, so
  every surface that gates on the balance would otherwise still be demanding money
  the payer has already sent. Two facts make that awkward: the low-credit gate opens
  checkout in a tab of its own, so a half-typed session survives the trip and the
  `?billing=success` return lands somewhere the gate cannot see; and credit belongs
  to the payer's own wallet, not to a workspace. So the return is carried between
  tabs of one browser as a same-origin fact with a bounded life, stamped with
  the payer it belongs to because browser storage outlives a sign-out
  ([`spa/entitlements/checkout-success-signal.ts`](spa/entitlements/checkout-success-signal.ts)):
  inside that window the gate steps aside on the payer's word and the wallet is
  polled hard enough to make good on it, and when the window lapses with no credit
  the gate comes back rather than stranding someone behind a payment that never
  settled. The entitlement wall is deliberately not waved through the same way —
  it stands for a workspace whose servicing is actually stopped, and admitting
  someone early would hand them a workspace that still cannot run anything.
  Payment recovery must remain reachable from that wall: the payer can open
  their existing Stripe portal without entering the blocked workspace or waiting
  for its billing overview to load. The user-bound billing API owns portal access.
  Owners can also reach the Backups tab in Settings to manage retained backups while the
  VM is paused or gone; that path cannot start an export until the workspace is
  active, and the other workspace destinations keep their execution gate.

The import firewall, visual ownership ledger, and build-output assertion live
under `scripts/`. They make API-first product access and the absence of public
site ownership mechanically checkable.

Private app documents use a protected handoff under `/w/.../open`. It reuses the
browser proxy to mint the existing edge grant and returns a redirect; it renders
no app page. Explicit handoff routes must win over the SPA, so product rewrites
are fallbacks. The app launch endpoint owns host/path validation, and its default
Duet destination remains the source of every embedded frame.

## Server-state cache

`spa/api/` owns the product cache contract. Query keys form a compound hierarchy from broad
ownership prefixes to exact serializable parameters, so invalidation can target one user, one
workspace, one resource family, or one result without string parsing. A query's key and fetcher
stay together in its options factory; this preserves response inference for hooks, prefetching,
and direct cache updates instead of asking callers to repeat result types.

Session events use the same API-first boundary but need an explicit reconnect
owner. The browser reads SSE through `fetch` so every attempt can send the
durable `Last-Event-ID` header; the session data owner holds the cursor, backoff,
deduplication, cache reconciliation, and cancellation. It never smuggles resume
state through a public query parameter.

A session input is locally committed across both views the reader can still see:
the timeline and the activity rail. The rail preview uses the contract's same
message-materialization rule as the backend, and its in-flight activity read is
cancelled before the optimistic write so an older answer cannot erase the new
words. A rejected write restores the preceding preview only while its optimistic
value is still current; a newer input or durable event always wins.

The first input to a new Work conversation follows the same visible-commit rule
before the conversation has an address. Its creation mutation temporarily owns
the sidebar row; the server response gives that row its real identity, and the
canonical collection retires it only after observing the same identity. This
handoff prevents both a blank sidebar during creation and a refresh-shaped blink.

Session titles have the same monotonic handoff: an excerpt may stand in while
generation runs, but it cannot replace an automatic or manually chosen title a
cache has already observed. Live frames may still advance status and recency;
only the provisional title is withheld.

Desktop viewer admission is deliberately not a lease-renewal cache. The mounted
viewer keeps its admitted iframe even after the URL's admission deadline; a new
capability is minted only for a new mount/page reload or browser reconnect.
Independent status polling can update presentation but never replaces the frame.

Large browser uploads are the deliberate exception to the ordinary same-origin data path:
`spa/api/vm-uploads.ts` owns the direct-to-workspace-VM transfer so file bodies never cross the
hosting proxy's request limit, and `spa/api/drive-upload-sessions.ts` owns the credential that
transfer needs — one grant per folder, reused for every file that lands in it. Product-specific
upload clients say which folder and which files; they mint nothing themselves, and they do not
reimplement grant renewal, progress, cancellation, or error behavior.

Reuse is by closure identity, which is easy to break silently: the transport caches a grant
against the exact function it was handed, so building a fresh one per call re-mints for every
file and no test fails. The mint per folder is held, and pinned by a test.

The browser deliberately names no actor. Every other call reaches the workspace through the API,
which stamps the authenticated caller on the way past; these bytes take a different door, so the
API stamps the actor into the **grant** instead. A direct upload therefore cannot claim an
identity and cannot forget to carry one — forgetting is exactly what once recorded these writes
as `system`.

Every file a person picks takes that rail, composer and drive alike — which is why the file system
provider separates `upload` from `write`. `write` carries bytes that are already in memory, and a
picked file's may be gigabytes: materializing one to send it is what takes the tab down, before
any request limit is even reached. So `upload` takes the `File` itself, and the two verbs cannot
share a transport.

Session composers keep one draft attachment owner across creation and live input modes. It chooses
the inline-image or direct-VM rail, exposes readiness to the send gate, and hands transport-ready
references to every input mutation. The composer surface renders that state but never acquires a
second upload model. Retrying an unchanged draft preserves its idempotent request identity;
changing its attachment set or landed paths changes that identity, so different durable content
can never reuse the old request.

Files introduced by a conversation stay inspectable in that conversation. The session borrows
Drive's provider and preview engine through a read-only capability rather than inventing another
file transport or sending the reader to a new tab. The logical Drive path and its canonical stat
own file identity and size; message labels are presentation only, and an Office document is never
decoded inline until its bounded size is known. Editing, attribution, and folder navigation remain
Drive concerns.

Workspace changes treat the cache as part of the access boundary: data owned by the workspace
being left is canceled and removed, while user-level and peer-workspace state stays intact.
Within a workspace, a resource owned by a child scope places that scope before its cache-family
prefix. This keeps root and child invalidation disjoint without weakening workspace-wide removal.

Opening an agent is warmed before it happens. Flying between agents is the product's ordinary
gesture, and every page-gating read — plus the line the roster prints under each agent's
name — is predictable the moment the roster answers, so
`spa/knowledge-map-data/preload-agent-pages.ts` prefetches the fleet once per workspace visit —
through the same options factories the pages mount, because a prefetch under any other key warms
nobody. The preload is a bounded burst that respects the workspace-transition boundary above,
skips a paused workspace, and never polls: keeping a mounted page live stays the job of that
page's own queries. It is a recorded exception to the per-agent fan-out rule in
`specs/performance-hardening`.

That warmth used to end with the tab. **A read this browser has already paid for is kept** and
restored before the first frame of the next sitting, so a reload, a second tab, or a morning after
does not re-draw the same skeletons for rows the browser was already told. It is TanStack's own
persistence rather than a sync engine of ours, because the key hierarchy above is already the shape
a persister needs. [`spa/api/query-persistence.ts`](spa/api/query-persistence.ts) is the single
owner of that policy — where the cache lives, and which reads are deliberately not allowed to
outlive the tab that got them, which is any read whose answer describes a live connection rather
than a record, and any the server can only give once.

Two of its rules reach beyond that file. The cache belongs to **one user**: the signed-in id is the
buster, so another reader's browser discards it rather than drawing it, and signing out drops it
outright. And it is **shape-versioned** — a restored answer is drawn before the network can correct
it, so a persisted response that loses or renames a field costs a bump of
`QUERY_CACHE_SCHEMA_VERSION` and every reader one cold load. Additive fields are free; that
asymmetry is why this app tolerates unknown fields rather than rejecting them.

Cached data is what the reader sees; the request is what corrects it — and coming back from an
outage is not a clock, so queries refetch on reconnect unconditionally rather than on whether some
number of seconds has passed. The other corollary is that a failure has to say which kind it is.
A response carrying an HTTP status is the server speaking and becomes a view — including the
unhappy ones. A failure carrying no status is not an answer about the thing at all, and is thrown
rather than returned, so the folder or the roster the reader already has stays on screen instead of
being overwritten by an error card about something nothing has actually said anything about.
The whole promise is walked with the network taken away in
[`tests/visual/cache-continuity.spec.ts`](tests/visual/cache-continuity.spec.ts), which carries its
own control: a browser that has read nothing must not be able to draw a workspace it has never
seen.

The session skill and reachable-agent pickers follow the collection rule without giving up that
warmth: their first bounded page is prefetched with the composer, further pages load only after a
reader asks, and a picker-open refresh revalidates the prefix already loaded rather than
discovering unseen pages. A failed continuation leaves cached rows usable and retries the same
cursor explicitly.

Audience and lifecycle controls are response-driven too. The composer presents the current caller
and agent as fixed context, then sends only the additional selected member ids. After creation,
the browser renders the audience, archive causes, and available actions returned by the public API;
it never reconstructs authority from workspace roles or internal attribution.

Session input optimism is presentation layered over pending mutations, not invented durable
history. This distinction is critical because durable event sequence numbers are also SSE resume
cursors; inserting a synthetic event into that cache could cause the browser to skip the real
server event. `spa/sessions/` owns the projection and reconciliation rules.

The transcript pages the history route's transcript view, not the raw timeline: a subagent-heavy
turn is thousands of task rows around a few dozen a reader sees, and paging the raw rows hands the
reader page after page that renders to nothing. Those pages skip rows by design, so a hole between
two cached rows is not a gap. The cache remembers the newest sequence a page delivered; below that
line holes are normal, above it every row arrived by stream and a hole is a real gap the
projection stops at. A refetched page joins the cache when it overlaps what the cache already
holds, and replaces it otherwise.

An ordered stream append reuses the browser's canonical projection. The history cache owns that
append lineage because a new array or unchanged endpoints cannot establish whether a page's
middle changed. Page merges and backfills reset it. Live and optimistic tails are reversible
presentation over that canonical state: settling a tool replaces only the affected slots,
while changing a historical overlay or replacing a page replays the affected view in timeline
order. This keeps a long tool-heavy turn from rebuilding its whole transcript for every completed
call.

Every durable input carries a typed sender — a person, a registered app, another session, or Duet
itself — and the transcript shows that author rather than whoever is reading it. Names are current
lookups, never anything the event stored: one page-level directory answers who an id is right now,
from the workspace roster, registered apps, and the sending sessions themselves. Reads are priced
per distinct identity in view rather than per row, so a transcript of a thousand rows costs what one
costs — and a sending session is worth its own read, because it belongs to another agent and so is
in no list this page has loaded. A session inside an agent speaks as that agent: "who messaged me"
is a question about the author, not about the conversation they wrote from, and its category chip is
the way to that conversation. The session's own agent obeys the same rule: its message rows and
the working status line are named by the live agent profile, and the name the session row stamped
at creation speaks only for an agent the workspace no longer holds. How that identity reads has a
second, single owner beside it: one resolver turns
a sender into the row's category, visible label, announced name, and identity mark, so a message
component never looks anything up and a mark can never disagree with the name beside it. A human
sender the loaded roster does not know is an invariant failure shown as one — never the reader's own
name, and never an internal user id, which is not a person and tells a reader nothing they can act
on. Apps and sessions do degrade to their stable short id, because that id is the handle their owner
can still look up — but only once a read has come back empty. An identity still on its way holds the
row's place with a placeholder instead, since an id that appears and is then replaced by a name is
the failure the fallback exists to avoid, not an instance of it. Identity includes the mark, not
just the name: an app is recognized by its own
icon, addressed by a URL the directory hands over rather than a lookup the row performs, and Duet's
own rows carry whatever this workspace renamed its assistant to. Every one of those degrades in
place — an unnameable app, a missing icon, a workspace with no file access at all — because a
portrait that changes size when data is missing is a worse answer than a generic one.

The shared session timeline projects the owned agent's public messages into the transcript.
Parent tool-call steps remain visible—including subagent and state-machine tools—while task
lifecycle events and child-origin steps stay out of the message list. State-machine snapshots have
a separate presentation owner in the session header and sleeping composer; treating them as
transcript rows as well would show the same operation twice.

Tool disclosures mount their stored payload only while expanded. A closed row must
not serialize historical input or details, or mount output bodies; hiding them
with browser disclosure styling alone still pays that cost for the whole transcript.

A terminal event contributes only what the transcript does not already show. Its result field
repeats the turn's last text step, so the projection drops it and the timeline renders a terminal
row only when the turn failed — otherwise a settled turn ends by echoing its own answer.

The internal operator fleet view reports the managed runtime release as one unit.
Its convergence tally and live VM version come from the canonical operator contract;
the browser does not reconstruct component versions or infer deployment targets.
Image provenance remains separate from the release currently running.

The model-router editor keeps rule order and header values together in one draft;
only an audited save replaces the active policy. Saved rules use the shared
contract, while eligibility and fallback belong to the
[model gateway](../model-gateway/README.md). JSON import edits that same draft;
exports preserve header values so a policy can be restored, while the inline
preview masks credentials.

## Visual verification

The committed Docker screenshots are review evidence, not just test output. Every rendered web symbol is assigned to one exact fixture, concrete route, owner, or reviewed nonvisual reason. Root `ui:*` scripts are the public entry point; their exact commands live in the root and web manifests.

Deployment quirks remain documented in the root [Vercel section](../../README.md#deployment-vercel).
