#!/usr/bin/env python3
"""Exact-image renderer freeze experiment; invoked only by probe-chrome-freeze.ts."""

from __future__ import annotations

import contextlib
import ctypes
import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import threading
import time
from typing import Any

from playwright.sync_api import sync_playwright


CDP_ENDPOINT = "http://127.0.0.1:9222"
SAMPLE_SECONDS = 4.0
BUSY_PAGE_COUNT = 3
TIMER_INTERVAL_MS = 50
STATE_MARKER = "duet-freeze-state-survives"

BUSY_HTML = f"""<!doctype html>
<meta charset="utf-8">
<title>Duet freeze busy page</title>
<button id="popup">popup</button><button id="dialog">dialog</button><button id="download">download</button>
<div id="drive-state">initial</div>
<script>
const navigationCount = Number(sessionStorage.getItem('navigationCount') || 0) + 1;
sessionStorage.setItem('navigationCount', String(navigationCount));
window.__duetProbe = {{ marker: {json.dumps(STATE_MARKER)}, ticks: 0, navigationCount }};
setInterval(() => {{
  window.__duetProbe.ticks += 1;
  const deadline = performance.now() + 36;
  let value = 0;
  while (performance.now() < deadline) value += Math.sqrt(value + Math.random());
}}, {TIMER_INTERVAL_MS});
document.querySelector('#popup').onclick = () => window.open('/popup.html', 'duet-freeze-popup');
document.querySelector('#dialog').onclick = () => alert('duet-freeze-dialog');
document.querySelector('#download').onclick = () => {{
  const link = document.createElement('a');
  link.download = 'duet-freeze.txt';
  link.href = URL.createObjectURL(new Blob(['freeze-download'], {{type: 'text/plain'}}));
  link.click();
}};
navigator.serviceWorker.register('/sw.js');
const audio = new AudioContext();
const oscillator = audio.createOscillator();
oscillator.connect(audio.destination); oscillator.start();
window.__duetProbe.audioState = audio.state;
</script>"""

POPUP_HTML = """<!doctype html><title>Duet freeze popup</title><script>
window.__duetPopupTicks = 0; setInterval(() => window.__duetPopupTicks += 1, 50);
</script>"""

SERVICE_WORKER = """self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});"""


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/sw.js":
            body, content_type = SERVICE_WORKER.encode(), "application/javascript"
        elif self.path == "/popup.html":
            body, content_type = POPUP_HTML.encode(), "text/html"
        else:
            body, content_type = BUSY_HTML.encode(), "text/html"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextlib.contextmanager
def fixture_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        thread.join(timeout=5)


def proc_snapshot() -> dict[int, tuple[int, int, bool]]:
    """Return Chrome-tree pid -> (cpu ticks, RSS bytes, is_renderer)."""
    processes: dict[int, tuple[int, int, str]] = {}
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().split()
            cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            pid, ppid = int(fields[0]), int(fields[3])
            ticks = int(fields[13]) + int(fields[14])
            rss = int(fields[23]) * os.sysconf("SC_PAGE_SIZE")
            processes[pid] = (ppid, ticks, rss, cmdline)
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError):
            continue

    roots = {
        pid
        for pid, (_ppid, _ticks, _rss, cmdline) in processes.items()
        if "--remote-debugging-port=9222" in cmdline and "--type=" not in cmdline
    }
    if not roots:
        raise RuntimeError("could not identify the Chrome process owning CDP port 9222")

    selected = set(roots)
    changed = True
    while changed:
        before = len(selected)
        selected.update(pid for pid, (ppid, *_rest) in processes.items() if ppid in selected)
        changed = len(selected) != before
    return {
        pid: (processes[pid][1], processes[pid][2], "--type=renderer" in processes[pid][3])
        for pid in selected
    }


def sample_processes(duration_seconds: float) -> dict[str, float | int]:
    start = proc_snapshot()
    started_at = time.monotonic()
    time.sleep(duration_seconds)
    elapsed = time.monotonic() - started_at
    end = proc_snapshot()
    ticks_per_second = os.sysconf("SC_CLK_TCK")
    common = set(start) & set(end)
    total_ticks = sum(max(0, end[pid][0] - start[pid][0]) for pid in common)
    renderer_ticks = sum(
        max(0, end[pid][0] - start[pid][0]) for pid in common if end[pid][2]
    )
    return {
        "rendererCpuCores": renderer_ticks / ticks_per_second / elapsed,
        "totalChromeCpuCores": total_ticks / ticks_per_second / elapsed,
        "rendererRssBytes": sum(value[1] for value in end.values() if value[2]),
        "totalChromeRssBytes": sum(value[1] for value in end.values()),
    }


def find_window_xid(unique_title: str) -> int:
    deadline = time.monotonic() + 5
    output = ""
    while time.monotonic() < deadline:
        output = subprocess.check_output(
            ["xwininfo", "-root", "-tree"], env={**os.environ, "DISPLAY": ":1"}, text=True
        )
        for line in output.splitlines():
            if unique_title in line:
                return int(line.strip().split()[0], 16)
        time.sleep(0.05)
    chrome_lines = "\n".join(line for line in output.splitlines() if "Chrome" in line)
    raise RuntimeError(
        f"could not find X11 window containing title {unique_title!r}; Chrome windows:\n{chrome_lines}"
    )


def focus_x11_window(xid: int) -> None:
    x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    display = x11.XOpenDisplay(b":1")
    if not display:
        raise RuntimeError("XOpenDisplay(:1) failed")
    try:
        x11.XMapRaised(ctypes.c_void_p(display), ctypes.c_ulong(xid))
        x11.XSetInputFocus(ctypes.c_void_p(display), ctypes.c_ulong(xid), 1, 0)
        x11.XFlush(ctypes.c_void_p(display))
    finally:
        x11.XCloseDisplay(ctypes.c_void_p(display))


def focus_x11_desktop() -> None:
    x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    display = x11.XOpenDisplay(b":1")
    if not display:
        raise RuntimeError("XOpenDisplay(:1) failed")
    try:
        root = x11.XDefaultRootWindow(ctypes.c_void_p(display))
        x11.XSetInputFocus(ctypes.c_void_p(display), ctypes.c_ulong(root), 1, 0)
        x11.XFlush(ctypes.c_void_p(display))
    finally:
        x11.XCloseDisplay(ctypes.c_void_p(display))


def diagnose_target_freeze(page, session, duration_seconds: float = 1.0) -> dict[str, Any]:
    lifecycle_events: list[str] = []
    session.send("Page.enable")
    session.on("Page.lifecycleEvent", lambda event: lifecycle_events.append(event["name"]))
    before = page.evaluate(
        "() => ({ ticks: window.__duetProbe.ticks, visibility: document.visibilityState })"
    )
    session.send("Page.setWebLifecycleState", {"state": "frozen"})
    time.sleep(duration_seconds)
    session.send("Page.setWebLifecycleState", {"state": "active"})
    after = page.evaluate(
        "() => ({ ticks: window.__duetProbe.ticks, visibility: document.visibilityState })"
    )
    return {
        "timerDeltaDuringFreeze": after["ticks"] - before["ticks"],
        "visibilityBefore": before["visibility"],
        "visibilityAfter": after["visibility"],
        "lifecycleEvents": lifecycle_events,
    }


def page_ticks(pages) -> int:
    return sum(page.evaluate("window.__duetProbe?.ticks ?? window.__duetPopupTicks ?? 0") for page in pages)


def diagnose_minimized_background(browser_cdp, page_sessions) -> dict[str, Any]:
    background = page_sessions[1:]
    windows: list[int] = []
    lifecycle_events: list[str] = []
    for _page, session in background:
        session.send("Page.enable")
        session.on("Page.lifecycleEvent", lambda event: lifecycle_events.append(event["name"]))
        target_id = session.send("Target.getTargetInfo")["targetInfo"]["targetId"]
        window_id = browser_cdp.send("Browser.getWindowForTarget", {"targetId": target_id})[
            "windowId"
        ]
        windows.append(window_id)
        browser_cdp.send(
            "Browser.setWindowBounds", {"windowId": window_id, "bounds": {"windowState": "minimized"}}
        )
    time.sleep(0.5)
    chrome_states_while_minimized = [
        browser_cdp.send("Browser.getWindowBounds", {"windowId": window_id})["bounds"].get(
            "windowState", "normal"
        )
        for window_id in windows
    ]
    minimized_pages = [page for page, _session in background]
    visibility_while_minimized = [page.evaluate("document.visibilityState") for page in minimized_pages]
    marker_before = [page.evaluate("window.__duetProbe?.marker ?? 'popup'") for page in minimized_pages]

    timer_before_minimized = page_ticks(minimized_pages)
    minimized_only = sample_processes(SAMPLE_SECONDS)
    timer_after_minimized = page_ticks(minimized_pages)

    timer_before_frozen = page_ticks(minimized_pages)
    for _page, session in background:
        session.send("Page.setWebLifecycleState", {"state": "frozen"})
    minimized_and_frozen = sample_processes(SAMPLE_SECONDS)
    for _page, session in background:
        session.send("Page.setWebLifecycleState", {"state": "active"})
    timer_after_frozen = page_ticks(minimized_pages)

    for window_id in windows:
        browser_cdp.send(
            "Browser.setWindowBounds", {"windowId": window_id, "bounds": {"windowState": "normal"}}
        )
    chrome_states_after_restore = [
        browser_cdp.send("Browser.getWindowBounds", {"windowId": window_id})["bounds"].get(
            "windowState", "normal"
        )
        for window_id in windows
    ]
    resume_before = page_ticks(minimized_pages)
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline and page_ticks(minimized_pages) <= resume_before:
        time.sleep(0.05)
    visibility_after_restore = [page.evaluate("document.visibilityState") for page in minimized_pages]
    marker_after = [page.evaluate("window.__duetProbe?.marker ?? 'popup'") for page in minimized_pages]

    return {
        "minimizedOnly": minimized_only,
        "minimizedAndFrozen": minimized_and_frozen,
        "timerDeltaMinimizedOnly": timer_after_minimized - timer_before_minimized,
        "timerDeltaMinimizedAndFrozen": timer_after_frozen - timer_before_frozen,
        "visibilityWhileMinimized": visibility_while_minimized,
        "visibilityAfterRestore": visibility_after_restore,
        "chromeWindowStatesWhileMinimized": chrome_states_while_minimized,
        "chromeWindowStatesAfterRestore": chrome_states_after_restore,
        "lifecycleEvents": lifecycle_events,
        "restoreResumedTimers": page_ticks(minimized_pages) > resume_before,
        "stateSurvivedRestore": marker_after == marker_before,
    }


def main() -> dict[str, Any]:
    image_ref = os.environ["IMAGE_REF"]
    with fixture_server() as fixture_url, sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(CDP_ENDPOINT)
        context = browser.contexts[0]
        browser_cdp = browser.new_browser_cdp_session()

        primary = context.pages[0]
        primary.goto(fixture_url, wait_until="domcontentloaded")
        pages = [primary]
        for created_count in range(1, BUSY_PAGE_COUNT):
            with context.expect_page() as page_info:
                primary.evaluate(
                    "([url, name]) => window.open(url, name, 'popup=yes,width=900,height=650')",
                    [fixture_url, f"duet-freeze-busy-{created_count}"],
                )
            created_page = page_info.value
            created_page.wait_for_load_state("domcontentloaded")
            pages.append(created_page)
        for page in pages:
            page.wait_for_function("window.__duetProbe && window.__duetProbe.ticks > 4")

        unique_title = f"Duet freeze focus {time.time_ns()}"
        primary.evaluate("title => document.title = title", unique_title)
        xid = find_window_xid(unique_title)

        popup_seen = False
        with context.expect_page() as popup_info:
            primary.click("#popup")
        popup = popup_info.value
        popup.wait_for_load_state("domcontentloaded")
        popup_seen = True

        dialog_seen = False
        primary.once("dialog", lambda dialog: (globals().__setitem__("_dialog_seen", True), dialog.accept()))
        primary.click("#dialog")
        dialog_seen = bool(globals().pop("_dialog_seen", False))

        with primary.expect_download() as download_info:
            primary.click("#download")
        download = download_info.value
        download_path = download.path()
        download_completed = bool(download_path and pathlib.Path(download_path).exists())

        target_snapshot = browser_cdp.send("Target.getTargets")["targetInfos"]
        service_worker_targets = [target for target in target_snapshot if target["type"] == "service_worker"]

        page_sessions = [(page, context.new_cdp_session(page)) for page in [*pages, popup]]
        focus_x11_window(xid)
        background_title = f"Duet freeze background {time.time_ns()}"
        pages[1].evaluate("title => document.title = title", background_title)
        background_diagnostic = diagnose_target_freeze(pages[1], page_sessions[1][1])
        background_xid = find_window_xid(background_title)
        focus_x11_window(background_xid)
        focused_diagnostic = diagnose_target_freeze(pages[1], page_sessions[1][1])
        focus_x11_window(xid)
        active = sample_processes(SAMPLE_SECONDS)
        minimized_diagnostic = diagnose_minimized_background(browser_cdp, page_sessions)
        focus_x11_window(xid)
        state_before = primary.evaluate("window.__duetProbe")

        focus_x11_desktop()
        for _page, session in page_sessions:
            session.send("Page.setWebLifecycleState", {"state": "frozen"})
        frozen = sample_processes(SAMPLE_SECONDS)

        thaw_started = time.monotonic()
        focus_x11_window(xid)
        for _page, session in page_sessions:
            session.send("Page.setWebLifecycleState", {"state": "active"})
        primary.wait_for_function(
            "before => window.__duetProbe.ticks > before", arg=state_before["ticks"], timeout=1_000
        )
        thaw_latency_ms = (time.monotonic() - thaw_started) * 1_000
        state_immediate = primary.evaluate("window.__duetProbe")
        time.sleep(0.75)
        primary.evaluate("document.querySelector('#drive-state').textContent = 'driven-after-thaw'")
        state_after = primary.evaluate("window.__duetProbe")
        drive_observed = primary.locator("#drive-state").text_content() == "driven-after-thaw"
        targets_after = browser_cdp.send("Target.getTargets")["targetInfos"]
        primary_target = next(
            target for target in targets_after if target["type"] == "page" and unique_title in target["title"]
        )
        thawed = sample_processes(SAMPLE_SECONDS)

        audio_state = primary.evaluate("window.__duetProbe.audioState")
        popup_target_seen = any(target["type"] == "page" and "Duet freeze popup" in target["title"] for target in targets_after)
        worker_still_discoverable = bool(service_worker_targets) and any(
            target["type"] == "service_worker" for target in targets_after
        )

        for page in [*pages, popup]:
            page.close()
        browser.close()

        return {
            "schemaVersion": 1,
            "chromeVersion": subprocess.check_output(
                ["google-chrome-stable", "--version"], text=True
            ).strip(),
            "imageRef": image_ref,
            "workload": {
                "pageCount": len(page_sessions),
                "sampleDurationMs": int(SAMPLE_SECONDS * 1_000),
                "timerIntervalMs": TIMER_INTERVAL_MS,
            },
            "active": active,
            "frozen": frozen,
            "thawed": thawed,
            "state": {
                "markerBeforeFreeze": state_before["marker"],
                "markerAfterThaw": state_after["marker"],
                "timerCountBeforeFreeze": state_before["ticks"],
                "timerCountImmediatelyAfterThaw": state_immediate["ticks"],
                "timerCountAfterResume": state_after["ticks"],
                "thawLatencyMs": thaw_latency_ms,
                "targetDiscoverableAfterThaw": bool(primary_target),
                "driveMutationObserved": drive_observed,
                "navigationCountBeforeFreeze": state_before["navigationCount"],
                "navigationCountAfterThaw": state_after["navigationCount"],
            },
            "boundaries": {
                "media": f"AudioContext state before freeze was {audio_state}; audio/service processes are outside the page-renderer CPU promise.",
                "dialog": f"Native dialog event observed and dismissed before freeze: {dialog_seen}; an open modal is outside this gate's safety promise.",
                "popup": f"Popup observed as a separate page target and explicitly frozen: {popup_seen and popup_target_seen}.",
                "download": f"Download completed before freeze: {download_completed}; in-flight browser-service transfer behavior is outside the page lifecycle promise.",
                "serviceWorker": f"Service worker was a separate target and remained discoverable without being frozen: {worker_still_discoverable}.",
            },
            "diagnostics": {
                "backgroundPage": background_diagnostic,
                "focusedPage": focused_diagnostic,
                "minimizedBackground": minimized_diagnostic,
            },
        }


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="duet-freeze-downloads-"):
        print(json.dumps(main(), sort_keys=True))
