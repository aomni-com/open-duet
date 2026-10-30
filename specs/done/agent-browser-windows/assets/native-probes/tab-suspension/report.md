# Extension-native tab suspension kill gate

Date: 2026-08-13T23:04:07.269Z

## Verdict

- Native tab freeze: **MECHANISM RED** — -13.0% renderer CPU reduction; renderer CPU did not fall by at least 60% and 0.20 CPU cores; tab 1886468310 did not report frozen; tab 1886468310 timers advanced while frozen; tab 1886468313 did not report frozen; tab 1886468313 timers advanced while frozen; tab 1886468316 did not report frozen; tab 1886468316 timers advanced while frozen
- Tab discard: **MECHANISM PASS** — 100.0% renderer CPU reduction; Chrome atomically replaced each native tab id and target while preserving the same window/URL/logical tab; activation reloaded each page, lost in-memory/DOM state, and preserved session/local storage.
- Product policy: **UNDECIDED.** A mechanism pass does not authorize production freeze or discard.

## Exact substrate

- Immutable image: `ghcr.io/aomni-com/duet-vm-image@sha256:71285a0068a6ed54ca33dd48791d0fe5ad2c3ccf69738ed5b25c9f9bd5c327dd`
- Chrome: `Google Chrome 151.0.7922.137`
- Extension: probe-only CRX, packed by exact-image Chrome and force-installed through the proven loopback update-policy channel
- Workload: 3 busy background tabs plus one quiet protected foreground control; 4000 ms CPU windows
- Full credential-free result: [result.json](result.json)
- Identity interpretation: `chrome.tabs.discard()` returned a replacement tab id for
  each candidate. The replacement was already `discarded: true` in the same native
  window and URL, so `tabRetained` means the logical Chrome tab survived; the
  gateway would have to atomically rebind both runtime ids if discard is ever
  selected as production policy.

## CPU / memory telemetry

| phase | renderer cores | all-Chrome cores | renderer RSS | all-Chrome RSS |
| --- | ---: | ---: | ---: | ---: |
| active | 1.712 | 1.860 | 2314.5 MiB | 3149.5 MiB |
| frozen | 1.935 | 1.942 | 2238.4 MiB | 3054.3 MiB |
| discarded | 0.000 | 0.167 | 1767.8 MiB | 2609.5 MiB |

## Identity and state boundary

Native freeze commands returned: `TypeError: Error in invocation of tabs.update(optional integer tabId, object updateProperties, optional function callback): Error at parameter 'updateProperties': Unexpected property: 'frozen'.`; `TypeError: Error in invocation of tabs.update(optional integer tabId, object updateProperties, optional function callback): Error at parameter 'updateProperties': Unexpected property: 'frozen'.`; `TypeError: Error in invocation of tabs.update(optional integer tabId, object updateProperties, optional function callback): Error at parameter 'updateProperties': Unexpected property: 'frozen'.`.

- Freeze tab 1886468310 / window 1886468309: URL `http://192.0.2.1:34351/candidate?index=0`; target `F39AB6C3A5D5F5A4C5021E22C482F833` → `F39AB6C3A5D5F5A4C5021E22C482F833` → `F39AB6C3A5D5F5A4C5021E22C482F833`; nav 1 → 1; timers 3 → 7 → 15; DOM, memory, sessionStorage, and localStorage survived.
- Freeze tab 1886468313 / window 1886468312: URL `http://192.0.2.1:34351/candidate?index=1`; target `E5980765A653C1FCE54DDE9CD9044290` → `E5980765A653C1FCE54DDE9CD9044290` → `E5980765A653C1FCE54DDE9CD9044290`; nav 1 → 1; timers 3 → 7 → 14; DOM, memory, sessionStorage, and localStorage survived.
- Freeze tab 1886468316 / window 1886468315: URL `http://192.0.2.1:34351/candidate?index=2`; target `9CC32B7CB74C1C8C4D33117AA25855FB` → `9CC32B7CB74C1C8C4D33117AA25855FB` → `9CC32B7CB74C1C8C4D33117AA25855FB`; nav 1 → 1; timers 2 → 6 → 13; DOM, memory, sessionStorage, and localStorage survived.

- Discard tab 1886468310 → replacement tab 1886468318 / window 1886468309: URL `http://192.0.2.1:34351/candidate?index=0`; target `F39AB6C3A5D5F5A4C5021E22C482F833` → `B7924347E908A85D0C77E7B4ED6A8B21` → `B7924347E908A85D0C77E7B4ED6A8B21`; nav 1 → 2; memory `memory-25fb8bcf-b45c-449b-baa0-e5d6c28ff4ea` → `memory-b6ac69ee-bce8-4558-b72d-ec91ddf3de45`; session/local storage `session-persistent`/`local-persistent` → `session-persistent`/`local-persistent`.
- Discard tab 1886468313 → replacement tab 1886468319 / window 1886468312: URL `http://192.0.2.1:34351/candidate?index=1`; target `E5980765A653C1FCE54DDE9CD9044290` → `950F6BB7729663A89A245F0B04E00AB1` → `950F6BB7729663A89A245F0B04E00AB1`; nav 1 → 2; memory `memory-d9bbbe5e-ff53-4b82-afda-75ab35107c68` → `memory-f73fb3ff-c588-4ead-a5a3-6afa08f9a167`; session/local storage `session-persistent`/`local-persistent` → `session-persistent`/`local-persistent`.
- Discard tab 1886468316 → replacement tab 1886468320 / window 1886468315: URL `http://192.0.2.1:34351/candidate?index=2`; target `9CC32B7CB74C1C8C4D33117AA25855FB` → `F11C31A4CF81E7B7CCCDB9969C3063FF` → `F11C31A4CF81E7B7CCCDB9969C3063FF`; nav 1 → 2; memory `memory-fcf981ae-85a1-4fba-a556-f39eb5831020` → `memory-365f3a3c-db1c-4a64-9566-4b3da110e9ab`; session/local storage `session-persistent`/`local-persistent` → `session-persistent`/`local-persistent`.

## Cleanup

- Exact VM deleted: `duet-test-chrome-tab-suspension-20260813t230341-pxw2`
- Global `duet-test-*` leak check: PASS (none remain)
