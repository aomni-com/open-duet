# Agent Marketplace — Quadrant Map

Walked 2026-07-27/28 with Example User. **Binding input for `write-spec`: every
decision below is a given, not a discussion to reopen.**

> **SHIPPED — THIS MAP IS PROVENANCE, NOT INSTRUCTIONS.** The feature was
> built and closed 2026-07-31; `README.md` beside this file is now the
> rationale record and is authoritative for what shipped and what must stay
> true. This map stays authoritative only for *what was decided during the
> walk and why*. Two rows were corrected during drafting and read as
> corrected here: **13** (the `sourceUrl` formula was wrong) and **19** (was
> OPEN, now closed). The pre-draft build sketch and the kickoff prompt that
> once ended this file have been deleted — they described work already done.
> A fresh agent reads the README, not this file.

Feature = generalize the shipped official-agents publish → zip-poll →
materialize rail so **any signed-up user can list an agent for anyone to
install**, with official agents becoming one verified publisher on the same
rail. The publish button ships hidden behind a server-side gate.

---

## Quadrant 1 — Known knowns (settled ground)

The rail is already a general content-distribution mechanism wearing a
hardcoded costume. Rationale record: `specs/done/official-agents/README.md`.

**What exists and carries over unchanged**

- **Transport**: publish-pull over HTTP + ETag, never Syncthing (rejected for
  the 500-share cap and peer fan-out). Subscriber gateways GET
  `…/<agent>?zip` with `If-None-Match`, hourly ± SHA-derived jitter
  (`DEFAULT_POLL_INTERVAL_MS`, `packages/gateway/src/official-agents/puller.ts:27`).
- **Materializer**: three-way repair (old upstream × new upstream × local),
  quarantine + journal, Syncthing-grammar conflict copies, conservative
  manifest-loss default (`packages/gateway/src/official-agents/materializer.ts`).
  Read-only is soft and eventually consistent; every poll repairs.
- **Lifecycle**: `subscribe` vs `clone_once`; uninstall = **detach** (files
  stay, rows become local); install target `agents/<name>` with a typed
  `path_exists` refusal + rename prompt, never auto-suffix
  (`packages/contract/src/official-agents/index.ts:11`).
- **Contained apps**: install copies `command` / `installCommand` /
  `apiScopes` from the *publisher's* Convex `apps` rows — no file manifest —
  and re-seeds them when a pull report advances the applied ETag
  (`packages/backend/convex/domains/officialAgents/model.ts:395,493`). Slug
  and port collisions are already handled (`availableSharedReplicaSlug`,
  `firstAvailableAutoAssignedPort`, `:446–449`).
- **Publish anchors compose**: `createPublishImpl` reuses an existing anchor
  when its kind is `app`, `agent`, or `share-root`
  (`packages/backend/convex/domains/publishes/model.ts:50,72`) and returns the
  existing publish if one is already attached — so "publish the agent folder"
  needs no new anchor mechanics and is idempotent.
- **A publisher handle already exists**: `workspaces.slug` is unique
  (`findAvailableWorkspaceSlug`, `domains/workspaces/birth.ts:116`), derived
  from the workspace name, has **no rename path in the API**, and is already
  public as the first segment of every publish URL.
- **Metadata parser exists**: `firstMarkdownParagraph` over `AGENTS.md` plus a
  skills-directory listing already produce catalog entries
  (`apps/api/src/routes/services/official-catalog.ts:88,147`).

**The three hardcodes this feature removes**

1. **One hub, singleton.** `officialHub` is read with `.unique()`
   (`officialAgents/model.ts:288`, `:497`) and the VM wire carries a **single
   `hubBaseUrl` for all subscriptions**
   (`packages/contract/src/official-agents/index.ts:59`).
2. **One namespace.** Identity is a bare `officialName` installed at
   `agents/<name>` — no publisher qualification.
3. **Catalog by live crawl.** No catalog table: the API walks the one publish
   per read, one `?list` + three fetches *per agent*, 30 s in-process cache
   (`official-catalog.ts:12`). Fine for 3 agents from 1 publisher; not a
   marketplace index.

**Environment facts that constrain the design**

- Serving proxies to the **publisher's own VM** (`resolveForEdge`,
  `domains/publishes/model.ts:255`): `null` when the VM is gone, a paused page
  when `servicingStatus === 'paused'`.
- Idle retirement fires after **7 days** of inactivity
  (`DEFAULT_IDLE_RETIRE_MS`, `domains/workspaces/provisioningCore.ts:26`);
  only the hub is exempt via `idleRetirementExemptAt`
  (`domains/internalAdmin/officialHub.ts:224`).
- Install executes publisher-authored bash on the installer's VM:
  `spawn('bash', ['-c', app.installCommand])`
  (`packages/gateway/src/routes/apps.ts:497`), with `apiScopes` that may
  include `files:write` / `integrations` / `share` / `publish`
  (`ELEVATED_APP_CAPABILITIES`, `packages/contract/src/scopes/index.ts:41`).
- The official rail is **live in prod** (catalog at
  `service.example.invalid/v1/official-agents`, 3 seeded agents) and new-user onboarding
  installs through it.

---

## Quadrant 2 — Known unknowns (decision ledger)

| # | Question | Decision | Closed by |
|---|---|---|---|
| 1 | Where does listed content live and get served from? | **Publisher-hosted (federated).** Listing records `(publisherWorkspaceId, publishSlug, agentName)`; each subscriber's gateway polls the publisher's edge URL. Per-subscription `sourceUrl` replaces the single `hubBaseUrl`; puller and materializer are otherwise untouched | Example User |
| 2 | What may a stranger's listing do on the installer's VM? | **Full parity + explicit consent at install** — community listings ship apps, run commands, and elevated scopes exactly like official ones | Example User |
| 3 | How is a listing identified? | **`(publisherWorkspaceSlug, agentName)`** — the pair the publish URL already encodes. No new identity infra, no global-slug squatting. Install target stays `agents/<agentName>` with the shipped collision → rename refusal | Example User |
| 4 | One rail or two? | **One rail, no backward compat.** `officialHub` + `officialHubSeedRuns` deleted; official becomes a verified listing owned by `user@example.invalid`; `listingId` is required on every subscription. Existing staging/prod subscription rows are **stripped and reseeded**, never migrated | Example User |
| 5 | Where does catalog metadata come from? | **Denormalized into Convex**, refreshed on list/update + TTL + on demand, reusing `firstMarkdownParagraph`. Catalog reads never touch a publisher VM | Example User |
| 6 | What happens on update? | **Fully seamless — no re-consent, ever.** Content, new apps, changed commands, and widened scopes all apply automatically on the next poll. Current scopes are *visible* on the installed-agent detail page: inspectable, never blocking | Example User (overrode the recommended park-and-notify) |
| 7 | What keeps a listing reachable when the publisher's VM sleeps? | **Nothing — go dark, degrade loudly.** Failed refresh ⇒ `availability: 'unavailable'`: card greys out, new installs refuse with a typed error, existing subscribers keep last-good content. Add a long `origin_unreachable` backoff so a dead listing isn't polled every 5 min forever | Example User |
| 8 | Moderation and takedown? | **Instant listing, no review.** Report queue + internal-admin takedown; `state: 'removed'` hides from catalog, refuses new installs, and **detaches** existing subscriptions (files kept — the shipped uninstall semantics). Reserve `official`/`duet` in titles | Example User |
| 9 | What does "list it" do mechanically? | Creates or reuses a **folder publish on the agent's anchor** (`createPublishImpl` already accepts an `agent` anchor) plus a listing row | Territory |
| 10 | Unlist vs takedown | **Different.** Unlist hides from the catalog; existing subscribers keep pulling. Deleting the publish is what strands them | Assistant |
| 11 | Can you list an agent you installed? | **No** — an agent whose anchor is an active subscription cannot be listed. A cloned (`clone_once` → detached) agent can | Assistant |
| 12 | Ranking signal | `installs` counter on the listing (install ++ / uninstall --) — the only signal available at launch | Assistant |
| 13 | `sourceUrl`: stored or derived? | **Derived** in the projection, host-validated against the known edge origin in the contract. Survives `publishes:updateSlug`; keeps the "VMs never fetch a free-form URL" firewall. **CORRECTED during drafting — the formula in the original walk was wrong**: it read `(edgeBase, publisherWorkspaceSlug, publishSlug, agentName)`, but a publish created on the *agent's* anchor (decision 9) has the agent folder AS its root, and `publishes.ts:126` joins the URL suffix *below* the anchor — so appending `agentName` addresses `agents/<name>/<name>` → 404. Correct grammar: `https://<edge>/<wsSlug>/<publishSlug>[/<agentSubpath>]?zip`, where `agentSubpath` is stored on the listing and is `''` for the per-agent case. The listing stores `publishId`, never a copied slug | Territory + landmine ② + drafting pass (all three drafts, independently) |
| 14 | Rename or widen the vocabulary? | **Rename** `official*` → `marketplace*` / `agentListing*` across contract, backend, gateway, api, spa. One rail means one vocabulary | Assistant (no-compat makes it cheap) |
| 15 | Are marketplace reads public? | **Signed-in only** — no public lander yet, so no anonymous catalog routes, no SEO/OG surface, and the abuse surface stays closed while the button is hidden | Example User |
| 16 | Who can publish? | **Anyone who signs up** — but the button is hidden at launch behind a **server-side gate**, not just UI. A hidden button over a live `POST /v1/ws/:ws/listings` is not hidden | Example User + assistant |
| 17 | Report intake at launch? | **Deferred to the unhide slice.** Ship `state: 'removed'` takedown only (an admin can act; there is just no intake form) while no strangers can publish | Assistant — *overturn if you want the queue day one* |
| 18 | Dotfile leak guard | **None — same floor as any publish.** Listing is a folder publish and folder publishes are already public. Accepted risk, taken knowingly | Example User |
| 19 | What does "done" look like? | **Staging, flagged.** The ladder ends with the marketplace live on staging behind the server-side publish gate, official agents reseeded as verified listings on the one rail, and a registered `marketplace` staging journey green live. Prod promotion and unhiding the button are Example User's separate calls, each a one-line change | Example User |
| 20 | Placement in the SPA | Sections — "From Duet" pinned, "From the community" below, rendered only when non-empty (degrades to today's UI at launch) | Assistant — *unanswered in stage 3; overturn freely* |
| 21 | How loud is the install sheet? | Full enumeration of commands + scopes for **unverified** publishers; verified/official listings install with today's zero-friction flow. Consent ⇔ unverified publisher | Assistant — *same* |
| 22 | Publishing UX | **One-click list; the files are the listing *by default*.** Derived defaults: title/summary from `AGENTS.md` ¶1, skills from the skills dirs, "what's new" from `CHANGELOG.md`. **But the listing row carries optional `title`/`summary` overrides that the API accepts at registration** — `AGENTS.md` is a system prompt, not marketing copy, so an AI caller registering an agent can pass explicit values. No override UI yet (future work); resolution is `override ?? derived`, and metadata refresh must never clobber an override | Assistant + Example User (override amendment) |

---

## Quadrant 3 — Unknown knowns (extracted)

- **Minimum ceremony is the house style.** Across three separate answers —
  seamless updates, publisher-beware on dotfiles, hide the button rather than
  gate the feature — Example User consistently chose the option that adds no screen
  and no policy. Design accordingly: the install sheet is the *only* ceremony
  the feature is allowed to have, and even that is scoped to unverified
  publishers.
- **Trust is granted to a publisher, not to a version.** Decision 6 makes
  installing a permanent trust grant: a listing that is benign when installed
  can later add bash and widen scopes with no prompt. This is understood and
  accepted, and it is the single fact a future reviewer is most likely to
  re-litigate — it is here so they don't have to.
- **Launch is a soft launch.** "Anyone can publish, but hide the button"
  means the v1 audience is Duet's own team seeding listings. Everything whose
  cost scales with *strangers* (report intake, impersonation policing,
  anti-farming on `installs`, dotfile scanning) can be sequenced into the
  unhide slice rather than launch.
- **No public surface yet** ⇒ no lander page, no SEO, no OG cards, no
  anonymous crawl path. Revisit as its own decision when the button unhides.
- **Consumers**: in-product users browsing Agents Home; publishers are Duet's
  team first, any signed-up user later. Nothing outside the product consumes
  this in v1.

---

## Quadrant 4 — Unknown unknowns (landmine cards)

**① Ordinary dotfiles publish — all of them.** *(decided: accept)*
`packages/contract/src/publishes/index.ts:55–81` — the serving floor is only
`.env*`, `.git`, `node_modules`, `.duet-anchor`, and the comment is explicit
that *"everything else, ordinary dotfiles included, is public once its folder
is published."* A listed agent folder serves `.mcp.json`,
`.claude/settings.local.json`, service-account JSON, and working notes at the
listing URL **and zips them into every installer's drive**. Decision 18 accepts
this. **Natural checkpoint to revisit: before unhiding the button**, when the
publisher is no longer someone you know.

**② The puller's URL firewall retires with this feature.** *(decided:
derive — decision 13)*
Today the puller can only fetch `officialHub.hubBaseUrl`; the record names
*"the puller accepts only URLs derived from `officialHub`"* as a binding scope
firewall. A per-subscription URL replaces it. A stored free-form URL column
would put a fleet of VMs one bad mutation away from fetching anything, so the
URL is computed in the projection and host-validated in the contract.

**③ What runs has a change channel the ETag does not cover.** *(sharp edge)*
`syncContainedApps` copies `command` / `installCommand` / `apiScopes` from the
publisher's Convex `apps` rows (`officialAgents/model.ts:429–433`), while the
ETag is stat-derived over *files*. A publisher can widen scopes or rewrite the
install command from their own Apps UI with **no file change**; it lands on
installers at the next content-driven reseed. Consistent with decision 6 — but
the content hash a user sees never covered the dangerous part.

**④ The publisher's limits become the installer's failures.** *(sharp edge)*
`goldenAppsForSubscription` reads up to `MAX_APPS_PER_WORKSPACE + 1` rows from
the *publisher's* workspace and throws when exceeded — a prolific publisher
breaks installs of every agent they list. Installed listings also consume the
installer's `MAX_AGENTS_PER_WORKSPACE` (500,
`packages/contract/src/agents/index.ts:11`) and app budget.

**⑤ Zip bounds are an unwritten listing-eligibility rule.** *(needs build
work)*
1,000 entries / 512 MiB (`packages/contract/src/files/index.ts:3–4`);
`recursive_limit_exceeded` is typed and non-retryable. An agent with a data
folder is silently uninstallable for everyone. **Validate at listing time**,
not at every subscriber.

**⑥ Availability is milder than it first looks.** *(sharp edge)*
Idle retirement needs **7 days** of inactivity, not a nightly sleep. The
sharper case is billing: `resolveForEdge` serves a paused page the moment
`servicingStatus === 'paused'`, and archives 7 days later. An unpaid publisher
takes their listings down with them.

**⑦ The closeout gate does not exist yet.** *(needs build work)*
`STAGING_JOURNEYS` (`packages/test-harness/src/staging-e2e-synthetic`) has
**no** official-agents entry — those legs run only inside the full ~30-minute
`staging-e2e-synthetic` sweep. AGENTS.md requires a registered journey for a change
this size: add `marketplace` to the registry and fold the official legs into
it, since they are the same rail now.

**⑧ Onboarding and campaigns install by bare name.** *(needs build work)*
`completeWorkspaceOnboarding` and `officialAgentsForUser` (the campaign → agent
mapping) pass a plain name to `install`. Once names are publisher-scoped, both
must resolve to **official** listings explicitly, or a community agent named
`research-assistant` could satisfy a campaign.

**⑨ A hostile agent doesn't need an app.** *(sharp edge, disclosed at stage 2)*
The agent runs with a shell on the user's VM, so a hostile `AGENTS.md` or skill
is a prompt-injection path to that shell. Stripping apps would never have made
a listing inert; the honest framing is *"does publisher code run without anyone
choosing to"*, not *"is it safe"*.

---

## Small facts the builder must confirm before coding

- The exact edge base URL per environment and where it is read from
  (`hubBaseUrl` is stored today; derivation needs a config owner).
- Whether `apps` rows for a *community* publisher are readable by the install
  mutation without new authz plumbing (`goldenAppsForSubscription` is a
  cross-workspace read today — it works, but it was written for a workspace
  Duet owns).
- Which server-side gate mechanism to reuse for "publishing is hidden" (the
  campaign work's launch gate is the closest precedent).
- Whether `slugFromPath('agents/<name>')` collides with existing publish slugs
  in a publisher's workspace often enough to need a friendlier default than
  `findAvailablePublishSlug`'s auto-suffix.

---
