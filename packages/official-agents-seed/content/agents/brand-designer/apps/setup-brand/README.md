# Brand Setup

The Brand Designer's onboarding app, and the one place in the official set where
onboarding is a page rather than a conversation. It asks for **one thing** — the
brand's web address — reads the system already published there, writes
`brand/brand-kit.md` and the logo file, and unlocks the agent.

One field, because most of a brand system is already on the homepage. A
questionnaire the user fills in before the seat does anything is how setup
stalls, and it asks people to describe a brand they can simply point at.

`state.json` is runtime data, created on first scan and persisted atomically
beside the app; do not edit it, `page.html`, or `server.ts` to change the kit.
The kit itself lives in the agent's folder, not here, because it is the agent's
working material rather than this app's state.

## What it does with the address

1. `POST /api/scan` normalizes what was typed (`acme.com`, `www.acme.com`, a
   full URL all work), then reads the site once through the platform's Firecrawl
   proxy with the `branding` and `markdown` formats.
2. Colours arrive already assigned to roles — primary, accent, surface, ink,
   link — because a hex without a job gets used as a background by the next
   person who reads the kit.
3. One model call turns the extraction plus the page's own copy into the three
   sections a scrape cannot reach: **Voice**, **Imagery**, **Exclusions**. If
   the model is unreachable those sections say they are open rather than
   inventing rules, and setup still finishes — a kit with real colours and type
   is a working seat.
4. `POST /api/confirm` downloads the logo into `brand/assets/`, writes
   `brand/brand-kit.md`, and only then marks the agent onboarded.

The order in step 4 is the contract: **the agent is never unlocked before its
kit exists.** Unlocking first would open the card onto an agent whose own rules
make it refuse the user's first request.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | The stored kit, whether setup is complete, and whether the workspace is reachable |
| `POST` | `/api/scan` | `{site}` reads the address and returns the kit it found; nothing is written yet |
| `POST` | `/api/confirm` | Writes the kit and logo, then ends onboarding. `409` before a scan |
| `GET` | `/events` | SSE invalidations after committed changes; native `EventSource` reconnects |

A later session changes the kit by editing `brand/brand-kit.md` directly — that
is ordinary agent work and does not come back through this app.

## Where the real calls live

`duet.ts` is the app's entire outward edge; every call carries the app's own
runtime key. It needs three capabilities and uses each for one thing:

- **`services`** — the Firecrawl proxy, and the workspace model gateway at
  `$DUET_GATEWAY_BASE_URL`. The gateway attributes that spend to *this app*, so
  the app authenticates there with its own key and never receives the runner's
  workspace-wide `DUET_API_KEY`. The `services` tier bills the concrete model
  at upstream cost.
- **`files:write`** — writing the kit and the logo into the agent's folder,
  whose drive-relative path arrives as `$DUET_AGENT_DIR`. The app never assumes
  it: an installed copy is named by whoever installed the agent, so a hardcoded
  path is right only for the official hub. Absent means the platform has not
  said yet, and the app refuses to write rather than guessing.
- **`agents`** — `POST /v1/ws/:slug/app/onboarded`, which is the only thing that
  ends onboarding. No session runs during an app onboarding, so nothing else is
  present to make that call.

Run it with `bun run server.ts`; Duet injects `$PORT`, `$DUET_API_URL`,
`$DUET_APP_API_KEY`, `$DUET_GATEWAY_BASE_URL`, `$DUET_APP_DIR`, and
`$DUET_AGENT_DIR`.
