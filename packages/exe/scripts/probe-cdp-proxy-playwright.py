import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        page = {
            "/main": """<!doctype html><title>Proxy main</title>
                <button id=popup onclick=\"window.open('/popup', 'first-popup')\">popup</button>""",
            "/popup": """<!doctype html><title>Proxy popup</title>
                <button id=nested onclick=\"window.open('/nested', 'nested-popup')\">nested</button>""",
            "/nested": "<!doctype html><title>Proxy nested popup</title><h1>nested</h1>",
        }.get(self.path)
        if page is None:
            self.send_error(404)
            return
        body = page.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f"http://127.0.0.1:{server.server_port}"

try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(os.environ["PROXY_WS"])
        context = browser.contexts[0]
        browser_cdp = browser.new_browser_cdp_session()
        before = browser_cdp.send("Target.getTargets")["targetInfos"]
        unrelated = {target["targetId"] for target in before if target["type"] == "page"}

        page = context.new_page()
        page_cdp = context.new_cdp_session(page)
        page_info = page_cdp.send("Target.getTargetInfo")["targetInfo"]
        page_cdp.detach()
        page.goto(origin + "/main", wait_until="domcontentloaded")

        with context.expect_page() as popup_info:
            page.locator("#popup").click()
        popup = popup_info.value
        popup.wait_for_load_state("domcontentloaded")
        with context.expect_page() as nested_info:
            popup.locator("#nested").click()
        nested = nested_info.value
        nested.wait_for_load_state("domcontentloaded")

        after = browser_cdp.send("Target.getTargets")["targetInfos"]
        by_id = {target["targetId"]: target for target in after}
        popup_cdp = context.new_cdp_session(popup)
        popup_target = popup_cdp.send("Target.getTargetInfo")["targetInfo"]
        popup_cdp.detach()
        nested_cdp = context.new_cdp_session(nested)
        nested_target = nested_cdp.send("Target.getTargetInfo")["targetInfo"]
        nested_cdp.detach()

        assert page_info["targetId"] in by_id
        assert unrelated.issubset(by_id.keys())
        assert popup_target["openerId"] == page_info["targetId"]
        assert nested_target["openerId"] == popup_target["targetId"]
        assert page.title() == "Proxy main"
        assert popup.title() == "Proxy popup"
        assert nested.title() == "Proxy nested popup"

        proof = {
            "contextCount": len(browser.contexts),
            "synthesizedTargetId": page_info["targetId"],
            "visiblePageTargetsBefore": sorted(unrelated),
            "visibleTargetCountAfter": len(by_id),
            "popupTargetId": popup_target["targetId"],
            "popupOpenerId": popup_target["openerId"],
            "nestedTargetId": nested_target["targetId"],
            "nestedOpenerId": nested_target["openerId"],
            "titles": [page.title(), popup.title(), nested.title()],
        }
        print("PLAYWRIGHT_PROOF=" + json.dumps(proof, separators=(",", ":")))
        browser.close()
        print("DISCONNECTED=true")
finally:
    server.shutdown()
