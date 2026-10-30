#!/usr/bin/env python3
"""Ask the shared Chrome to flush its profile before systemd tears down X."""

import signal

from playwright.sync_api import sync_playwright


class StopTimeout(Exception):
    pass


def timeout(_signal: int, _frame: object) -> None:
    raise StopTimeout()


signal.signal(signal.SIGALRM, timeout)
signal.alarm(10)
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(
            "http://127.0.0.1:9222", timeout=5_000
        )
        for context in browser.contexts:
            for page in context.pages:
                page.close(run_before_unload=True)
except Exception:
    # Chrome may already have exited or CDP may never have become ready. The
    # unit's bounded mixed-mode kill remains the fallback in either case.
    pass
finally:
    signal.alarm(0)
