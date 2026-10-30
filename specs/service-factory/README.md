# Service factory

Status: planned. It waits on [service-catalog](../done/service-catalog/README.md)
slices 02–04 (catalog, probe, vault, runtime). No slice has started.

Last updated: 2026-10-11.

## Next Agent Prompt

Don't start until service-catalog slice 04 has shipped. Then begin with
[01 — Harness against a fake vendor](slices/01-harness-fake-vendor.md).

Before every behavior change, invoke `write-tests` and work red/green.
Never let a secret reach a model. Vendor keys, passwords, and TOTP seeds move
only between the harness helpers, browser-use-pi's `sensitiveData`, and the
vault. Anything the model sees carries a name or a fingerprint, never the
value.

The slice files were written before the catalog spec added shared pools and
provider hooks. Before starting, re-read the catalog's "Route admission
rules" and "Provider logic", and reconcile these slices with them: playbooks
live beside each vendor's `service.ts`, and the factory adds the
`serviceAccounts` inventory table removed from catalog slice 03.

**Global TODO:**

- [ ] [01 — Harness against a fake vendor](slices/01-harness-fake-vendor.md)
- [ ] [02 — Initial run on the existing vendors](slices/02-initial-run.md)
- [ ] Later slices, to be written when 02 lands: autonomous paid signup,
      cards, factory-drafted vendor definitions, batch maintenance.

## Goal

A local app (`apps/service-factory`) that runs on one Mac with a local
browser only. For each vendor it reads a plain-language playbook and
converges the vendor to a target state: account, plan, staging and
production keys with the right permissions, stored in the vault and proven by
the catalog's probe. Signup and maintenance are the same run. The north star
is fully autonomous, with humans clearing only parked vendors.

## Decisions (settled with the user, 2026-10-11)

| Decision | Choice | Why |
|---|---|---|
| Harness | [browser-use-pi](https://github.com/browser-use/browser-use-pi) (`@browser_use/pi`, MIT, TypeScript on Pi Mono) | The user's choice; it is updated more often than browser-harness-js. It is a separate codebase from browser-harness-js (its dependencies are the Pi packages plus `devtools-protocol`), and follows the same raw-CDP idea the user likes. |
| Browser | A **local** headed Chromium with a persistent profile per vendor (`Browser.chromium({ profileDir, headless: false })`). Never a cloud browser. Telemetry off. | User |
| Secrets | `sensitiveData` + `fillSecret` (redacted from model requests, captured text, checkpoints, results, and history). `allowedDomains` per playbook. | Built into browser-use-pi |
| Tools | No custom-tool API exists, so the agent imports **workspace helper modules**: AgentMail email wait, key capture straight to the vault (returns only a fingerprint), probe | The REPL can import workspace files |
| Instructions | Prose, not scripts: one factory-wide `llms.txt` (procedure, helper contract, a link to the catalog's admission rules) and a per-vendor `playbook.md` | The user wants an instructions file |
| Blocked vendors | Park with reason, step, and human action; continue with others; report | Autonomy everywhere else |
| Identity | Duet's legal identity from a committed `identity.json`. One AgentMail inbox per vendor. Account secrets (password, inbox id, TOTP seed) in the production vault. | |
| Cards (later slice) | A `CardIssuer` interface. **Stripe Issuing** first: it returns the full number and CVC for live virtual cards, at $0.10 per card, and needs no PCI certification for our own use. Duet's Stripe account needs Issuing approved. **Natural** later: its card issuing was "coming soon" as of 2026-10-11, and its only live path is a single-use proxy card number that breaks inside payment-provider iframes. | |
| Authoring (later slice) | The factory drafts a vendor's `service.ts`, playbook, and fixtures from its docs and probe calls | No SDLC or PR process in specs (user) |

## Research

- browser-use-pi: `docs/sessions.md` (local Chrome, profiles,
  `sensitiveData`, domain limits) and `docs/browser.md` (REPL primitives,
  `checkpoint`, `finish_from_js`).
- browser-harness-js: raw typed CDP as a skill. It is the fallback if
  browser-use-pi can't keep captured keys out of model context.
- Earlier candidates, not chosen:
  - Claude Agent SDK + Playwright MCP (needs a hand-built secret layer);
  - browser-use in Python (a second language);
  - Skyvern (AGPL, captcha solving cloud-only);
  - Stagehand;
  - raw computer use.
- Natural docs: https://docs.natural.com. Stripe Issuing virtual cards:
  https://docs.stripe.com/issuing/cards/virtual
