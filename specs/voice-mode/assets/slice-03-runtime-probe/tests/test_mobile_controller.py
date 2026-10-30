import asyncio

import aiohttp
import pytest

from voice_probe.browser_runtime import BrowserInputWindow
from voice_probe.mobile_controller import (
    MobileProbeServer,
    extract_quick_tunnel_url,
    is_ios_safari_browser,
    launch_quick_tunnel,
)

IOS_SAFARI = {
    "user_agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 "
        "Mobile/15E148 Safari/604.1"
    ),
    "platform": "iPhone",
    "max_touch_points": 5,
}


def test_quick_tunnel_url_accepts_only_cloudflare_https() -> None:
    assert (
        extract_quick_tunnel_url(
            "INF Your quick Tunnel has been created! https://safe-name.trycloudflare.com"
        )
        == "https://safe-name.trycloudflare.com"
    )
    assert extract_quick_tunnel_url("https://example.com") is None
    assert extract_quick_tunnel_url("http://unsafe.trycloudflare.com") is None


def test_browser_floor_accepts_only_ios_safari() -> None:
    ipad_desktop_mode = IOS_SAFARI | {"platform": "MacIntel"}
    chrome_ios = IOS_SAFARI | {
        "user_agent": IOS_SAFARI["user_agent"].replace("Version/18.5", "CriOS/140.0")
    }

    assert is_ios_safari_browser(IOS_SAFARI) is True
    assert is_ios_safari_browser(ipad_desktop_mode) is True
    assert is_ios_safari_browser(chrome_ios) is False
    assert is_ios_safari_browser(IOS_SAFARI | {"max_touch_points": 0}) is False


async def test_mobile_probe_serves_no_secret_and_requires_websocket_authentication() -> None:
    secret = "a" * 64
    async with (
        MobileProbeServer(bundle=b"probe-bundle", secret=secret) as server,
        aiohttp.ClientSession() as client,
    ):
        response = await client.get(server.local_url + "/")
        html = await response.text()
        assert response.status == 200
        assert secret not in html
        assert 'src="/probe.js"' in html
        assert "script-src 'self' blob:" in response.headers["Content-Security-Policy"]
        assert "worker-src blob:" in response.headers["Content-Security-Policy"]

        bundle = await client.get(server.local_url + "/probe.js")
        assert await bundle.read() == b"probe-bundle"

        rejected = await client.ws_connect(server.control_url)
        await rejected.send_json({"secret": "wrong"})
        message = await rejected.receive()
        assert message.type == aiohttp.WSMsgType.CLOSE

        wrong_browser = await client.ws_connect(server.control_url)
        await wrong_browser.send_json(
            {
                "secret": secret,
                "browser": {
                    "user_agent": "Mozilla/5.0 Chrome/140 Safari/537.36",
                    "platform": "MacIntel",
                    "max_touch_points": 0,
                },
            }
        )
        message = await wrong_browser.receive()
        assert message.type == aiohttp.WSMsgType.CLOSE

        accepted = await client.ws_connect(server.control_url)
        await accepted.send_json(
            {
                "secret": secret,
                "browser": IOS_SAFARI,
            }
        )
        assert await accepted.receive_json() == {"kind": "authenticated"}
        browser = await server.wait_for_browser(timeout=0.1)

        input_task = asyncio.create_task(browser.start_input_fixture())
        command = await accepted.receive_json()
        assert command == {
            "argument": None,
            "id": 1,
            "method": "startInputFixture",
        }
        await accepted.send_json(
            {
                "id": 1,
                "ok": True,
                "result": {"startedAtMs": 100, "endsAtMs": 550},
            }
        )
        assert await input_task == BrowserInputWindow(started_at_ms=100, ends_at_ms=550)


async def test_mobile_probe_allows_only_one_in_flight_browser_command() -> None:
    secret = "b" * 64
    async with (
        MobileProbeServer(bundle=b"probe-bundle", secret=secret) as server,
        aiohttp.ClientSession() as client,
    ):
        socket = await client.ws_connect(server.control_url)
        await socket.send_json({"secret": secret, "browser": IOS_SAFARI})
        await socket.receive_json()
        browser = await server.wait_for_browser(timeout=0.1)

        first = asyncio.create_task(browser.start_input_fixture())
        first_command = await socket.receive_json()
        second = asyncio.create_task(browser.start_input_fixture())
        await asyncio.sleep(0)
        assert server.in_flight_command_id == first_command["id"]

        await socket.send_json(
            {
                "id": first_command["id"],
                "ok": True,
                "result": {"startedAtMs": 100, "endsAtMs": 550},
            }
        )
        await first
        second_command = await socket.receive_json()
        assert second_command["id"] == first_command["id"] + 1
        await socket.send_json(
            {
                "id": second_command["id"],
                "ok": True,
                "result": {"startedAtMs": 600, "endsAtMs": 1_050},
            }
        )
        await second


async def test_quick_tunnel_uses_only_the_bound_loopback_server_and_is_torn_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Stderr:
        read_count = 0

        async def readline(self) -> bytes:
            self.read_count += 1
            if self.read_count == 1:
                return b"INF https://bound-name.trycloudflare.com\n"
            return b""

    class Process:
        stderr = Stderr()
        returncode: int | None = None
        terminated = False
        waited = False

        def terminate(self) -> None:
            self.terminated = True
            self.returncode = 0

        async def wait(self) -> int:
            self.waited = True
            return 0

        def kill(self) -> None:
            raise AssertionError("a cooperative tunnel must not be killed")

    process = Process()
    observed: tuple[object, ...] | None = None

    async def create_subprocess(*command: object, **options: object) -> Process:
        nonlocal observed
        observed = command
        assert options["stdout"] == asyncio.subprocess.DEVNULL
        assert options["stderr"] == asyncio.subprocess.PIPE
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_subprocess)

    async with launch_quick_tunnel(
        executable="/usr/local/bin/cloudflared",
        local_url="http://127.0.0.1:43210",
        startup_timeout=0.1,
    ) as public_url:
        assert public_url == "https://bound-name.trycloudflare.com"
        assert observed == (
            "/usr/local/bin/cloudflared",
            "tunnel",
            "--url",
            "http://127.0.0.1:43210",
            "--no-autoupdate",
        )
        assert process.terminated is False

    assert process.terminated is True
    assert process.waited is True
    assert process.stderr.read_count == 2
