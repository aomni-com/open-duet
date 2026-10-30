# Tab-suspension probe setup attempts

These are harness or control-plane failures, not Chrome mechanism verdicts. Every
created VM used the same immutable image and was deleted by exact name; the final
global `duet-test-*` leak check was empty after each run.

| attempt | setup failure | correction |
| --- | --- | --- |
| 1 | The new broker returned a bare result while the proven actuator client expected a `{ result }` envelope. | Preserve the established broker response envelope. |
| 2 | Extension-created tabs were visible to Chrome but did not project into Playwright's already-bound default context. | Create each page through Playwright, resolve its exact Chrome tab, then have the extension move that tab into a native window. |
| 3 | The report adapter expected `tabId` in a Chrome snapshot whose native field is `id`. | Normalize the snapshot field at the evidence boundary. |
| 4 | The active-control diagnostic assumed the tab would remain queryable and aborted before recording candidate discard evidence. | Treat active-tab API behavior as measured data; absence is a protected-tab failure, not a parser exception. |
| 5 | Candidate tabs were the sole tabs in their native windows, so discard could collapse the window before identity evidence was read. | Match the planned managed-window invariant by retaining one quiet canonical landing tab in every candidate and control window. |
| 6 | `windows.getAll({ populate: true })` did not retain discarded candidates in the populated snapshot even with landing tabs. | Treat `tabs.query({})` as the tab-state authority and join it to the normal-window snapshot by `windowId`. |
| 7 | Candidate tabs were selected (`active: true`) inside each background window, so Chrome correctly protected them from both native freeze and discard. | Select the canonical landing tab in each window and assert every candidate is inactive before either mechanism. The foreground control is policy-excluded rather than deliberately discarded. |
| 8 | Candidate tabs were inactive but still attached to Playwright's DevTools connection; Chrome protects debug-attached tabs from suspension. | Disconnect the browser-level Playwright client after fixture setup and before each native mechanism, then reconnect only after activation to inspect restored state. |
| 9 | Reconnecting Playwright after native discard reached the browser WebSocket but timed out while automatically attaching to restored targets. | Remove Playwright from the mechanism phase. The extension briefly attaches to one exact tab to read state, detaches before suspension/CPU measurement, and briefly reattaches after activation. |
| 10 | exe.dev returned HTTP 504 before creating the final evidence VM. | Confirm no matching VM or global tagged leak exists, then retry the unchanged harness. |

The final report and JSON replace these attempts as the mechanism evidence.
