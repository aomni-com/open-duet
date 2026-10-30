# 01 — Factory harness against a fake vendor

Status: not started. Depends on service-catalog slices 02 (catalog and probe) and 03 (vault).

## Contract unlocked

One local command drives a headed local Chrome through these steps against a
fake vendor: log in, verify by email, create a key, set its permissions, and
store it. The run reaches the target state without leaking a secret into the
model's transcript, and a second run changes nothing.

There is no payment step. Cards and autonomous paid signup belong to the next
spec.

## Harness choice

**[browser-use-pi](https://github.com/browser-use/browser-use-pi)**
(`@browser_use/pi`, MIT, TypeScript, built on Pi Mono) running on a **local
browser only**. No cloud browser and no `BROWSER_USE_API_KEY`.

- Browser: `Browser.chromium({ profileDir: ~/.duet/service-factory/profiles/<id>, headless: false })`.
  The persistent profile per vendor keeps its login, and a locked profile is
  rejected, which gives one run per vendor at a time.
- Telemetry is off: `telemetry: false`, plus `DO_NOT_TRACK=1`.
- The model comes from Pi's provider catalog, using an Anthropic model through
  a local key.
- Secrets: `sensitiveData` registers the vendor password and TOTP seed from
  the production vault, scoped to the playbook's `domains`. The model fills
  them with `fillSecret(name, backendNodeId, page)`, and their values are
  redacted from model requests, captured text, checkpoints, results, and
  history.
- Navigation is limited to the playbook's `domains` (`allowedDomains`) plus
  AgentMail's.
- The agent has no custom-tool API. It works in a persistent JS REPL, so the
  harness ships **workspace helper modules** that the agent imports and calls:

  | Helper (`apps/service-factory/workspace/helpers.ts`) | Returns to the agent |
  |---|---|
  | `waitForEmail({ pattern, timeoutS })` (AgentMail API) | `{ subject, links, codes }` |
  | `captureKey(page, backendNodeId, { env, scopes })` | `{ fingerprint }`. It reads the key through `page.cdp`, writes it to the vault (03), then overwrites the element's text in the page |
  | `vaultFingerprint(name)` | `{ fingerprint }` or `null` |
  | `probe(serviceId, env)` (02) | the probe table |
  | `checkpoint` / `finish_from_js` (built into browser-use-pi) | — |

  A captured key exists only inside `captureKey`'s local scope. Nothing the
  model can see holds it, and the transcript grep test enforces that.
- Instructions:
  - `apps/service-factory/llms.txt` is the factory-wide procedure, sent as the
    task preamble: observe the current state and then act, never assume; use
    the helpers; never type a secret yourself, use `fillSecret`; finish with a
    structured result; park with a reason when blocked.
  - `packages/service-catalog/vendors/<id>/playbook.md` holds YAML front
    matter (`service`, `loginUrl`, `domains`, `requiredScopes`, optional
    `keyApi`) followed by prose sections: Log in, Create keys, Set permissions,
    Check balance, Known blockers.
- The run result (typed, ending with `finish_from_js`) is
  `{ status: 'converged' | 'parked', parked?: { reason, step, humanAction }, keys: { staging?, production? } /* fingerprints */, scopes: string[] }`.
  It is written to `serviceAccounts` (03).
- Each run keeps its artifacts in
  `~/.duet/service-factory/runs/<id>/<timestamp>/`: the history file,
  recording or GIF, and the report.

**Fallback, if browser-use-pi can't hold this contract** (for example, the
secret redaction or the helper import model doesn't work): drive the same
local Chrome profile from Claude Code with
[browser-harness-js](https://github.com/browser-use/browser-harness-js)
(raw typed CDP as a skill), keeping the same playbooks and helpers. Record the
switch and the reason in this file.

## Fake vendor

`apps/service-factory/test/fake-vendor/` is a tiny local Bun server with:

- a login page that requires an emailed code, delivered through a fake inbox
  behind the same `waitForEmail` contract;
- a keys page that shows a new key once;
- a permissions page with checkboxes;
- a JSON endpoint that answers 403 unless the key has a given scope, so the
  probe can check permissions behaviourally.

## Run / see

`bun run --cwd apps/service-factory converge fake --headed` lets you watch
the browser do it.

## Verification

Write the tests first.

1. The run converges: the key is in the vault (by fingerprint), and the scopes
   are set and pass the probe.
2. Grepping the history file, the run artifacts, and every model request the
   harness logged finds no password, TOTP seed, or key value.
3. Killing the run halfway through and running it again resumes, rather than
   creating a second key.
4. A second full run creates no key and changes no permission.

## Delegated to the implementer

The model choice, the helper module layout, the CLI flags, and the run
artifact format.

## Must stay green

`packages/service-catalog` and vault tests.

## Feedback that would change this slice

browser-use-pi failing the secret checks. In that case use the fallback above.
Do not build our own redaction layer.
