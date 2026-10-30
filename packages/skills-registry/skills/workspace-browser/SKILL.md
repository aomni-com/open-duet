---
name: workspace-browser
target: sandbox
description: Drive the workspace's visible shared Chrome through a fresh browser batch in this agent's window. Use by default to interact with one specific page, inspect tabs the human opened, use shared logins, show a page to the human, or hand over a login or action. Use Firecrawl for unattended search, crawling, bulk extraction, or a datacenter IP fallback only when no human-visible interaction is required.
---

# Workspace Browser

Drive the visible Chrome already running on the workspace desktop. The human
and every agent share its profile, logins, tabs, and windows. The gateway gives
each browsing batch a fresh initial tab in this agent identity's window.

Choose the path before browsing: use this headed browser so the human can watch
or interact with the page, including login. Use Firecrawl for unattended
multi-page collection or a datacenter IP fallback only when no human-visible
interaction is required.

## Workflow

1. Run `duet-browser` at the start of each browsing batch. Every
   `duet-browser` call creates and focuses a fresh tab; parse its JSON
   `{targetId, webSocketDebuggerUrl}` output and retain that exact target id.
2. Attach Playwright to `webSocketDebuggerUrl`. For new work, select the page
   whose `Target.getTargetInfo` id equals `targetId`. For a question about what
   is already open, follow **Discover existing tabs** instead.
3. Navigate the exact batch target for new work. Use `context.new_page()` when
   that batch needs more tabs; the gateway keeps them in this agent's window.
4. Close the automation connection at batch end. Leave the shared browser and
   its default context running.

```bash
TARGET_URL='https://example.com' python3 - <<'PY'
import json
import os
import subprocess
from playwright.sync_api import sync_playwright

handle = json.loads(subprocess.check_output(['duet-browser'], text=True))

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(handle['webSocketDebuggerUrl'])
    page = None
    for context in browser.contexts:
        for candidate in context.pages:
            cdp = context.new_cdp_session(candidate)
            info = cdp.send('Target.getTargetInfo')['targetInfo']
            cdp.detach()
            if info['targetId'] == handle['targetId']:
                page = candidate
                break
        if page is not None:
            break
    if page is None:
        raise RuntimeError('session-owned browser tab disappeared')

    page.goto(os.environ['TARGET_URL'], wait_until='domcontentloaded')
    print(page.title())
PY
```

## Discover existing tabs

The returned `targetId` identifies the fresh batch tab; it is not evidence that
other human or agent tabs are absent. When asked what is open or to inspect a tab
the human opened:

1. Create one browser-level session with `browser.new_browser_cdp_session()`,
   call `Target.getTargets`, and keep every `type: "page"` target. For each,
   record its `targetId`, title, and URL; call `Browser.getWindowForTarget` on
   that same session for its `windowId`; mark whether it is the fresh batch
   target; detach the browser session in `finally`.
2. Cross-check every page in every exposed context only when mapping target ids
   back to Playwright pages for content inspection: use a temporary page CDP
   session to call `Target.getTargetInfo`, then detach it in `finally`. Use target
   metadata before page content. An empty or missing URL/title is
   partial evidence, not proof that the tab is blank or absent. Keep that tab in
   the inventory and continue.
3. Isolate failures per tab: if one tab times out or fails, preserve its metadata
   and continue with the other tabs. Read content only from the requested tab or
   the strongest URL/title match.
4. Report every meaningful tab and label or omit the fresh blank batch tab. If
   several tabs could match, list them and ask which one the human means.
5. After discovery, clean each returned batch target, including one created by
   a retry, independently. Re-read `Target.getTargetInfo` for the exact returned
   `targetId`. A missing target is already clean. Otherwise call
   `Target.closeTarget` only when its current URL is exactly `about:blank` and
   the latest `Target.getTargets` inventory contains at least one other page
   target. Leave it open if any condition is uncertain or false.

If the target list or connection is unavailable, retry discovery at most once
with one fresh `duet-browser` batch. Do not create a trail of blank tabs. Say “I
can detect this tab but cannot read its contents yet” when metadata succeeds but
content inspection does not. Never select a cleanup target by position or title,
or by choosing the first blank or an approximate match.

## Hand a page to the human

The presentation surface is this agent's desktop:
`/w/{workspaceSlug}/agents/{agentSlug}/desktop`. Use the `duet` skill to resolve
the slugs and emit the root-relative link; `root` is a real agent slug, not a
workspace-level desktop shortcut.

Before linking, activate the exact page the human should see. The batch's
`targetId` identifies this agent owner's native window. Use CDP
`Browser.getWindowForTarget` for that target and every candidate, require the
same `windowId`, then call Playwright `page.bring_to_front()` (CDP
`Page.bringToFront`) on the exact URL/title/visible-witness match. You may inspect
pages across windows, but never present a tab in another owner's window. If the
only match is elsewhere, navigate or recreate it in this owner's window first.
Never select the first context, page, or approximate match.

For show-only handoff, foreground the page and send a normal Markdown desktop
link. Do not call `ask_user_question` merely to show something.

For login or another human action, foreground the page and send the normal
Markdown link first. Then, as a separate terminal operation, call
`ask_user_question` with one question and exactly the option labels `Done` and
`I'm stuck`, using
`{questions:[{question:"Are you done?",options:[{label:"Done"},{label:"I'm stuck"}]}]}`.
The link belongs in the ordinary message, never only inside the question. The
tool terminates the turn; do not continue or answer it yourself.
The handoff is incomplete until the `ask_user_question` call succeeds. A
plain-text question does not count; do not end the turn with only prose.

The ask ends the turn. On resume, run `duet-browser` again to establish
the fresh owner window and rediscover the intended page by its URL, title, and
current visible witness before continuing. Never remember, retain, or reuse a
target id across turns.

## Rules

- Never launch another browser or call `Target.createBrowserContext`; both would
  lose the human's shared login state.
- Never guess with the first context or page. Other agents and the human have
  tabs and windows in the same browser, and the connection intentionally exposes
  all of them.
- Never close the shared browser or its default context. Close a page only when
  the task explicitly requires it or under the exact blank inspection-tab cleanup
  above; the gateway retires other inactive batch tabs.
- Start a new `duet-browser` batch for a later turn instead of reusing a prior
  connection or remembered target id; rediscover the intended page from current
  browser state.
- If the socket or target becomes unavailable, retry once with a new `duet-browser`
  batch and rediscover by URL, title, and visible witness. If that fresh batch also
  fails, report the blocker instead of looping.
- Keep broad search, crawling, and multi-page extraction in Firecrawl.
