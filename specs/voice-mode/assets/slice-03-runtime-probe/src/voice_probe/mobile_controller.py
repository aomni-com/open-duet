import asyncio
import re
import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from types import TracebackType
from typing import Any

from aiohttp import WSMsgType, web

from voice_probe.browser_runtime import BrowserProbePage

_QUICK_TUNNEL_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com(?:\s|$)")
_IOS_PLATFORMS = {"iPhone", "iPad", "iPod"}
_NON_SAFARI_IOS_MARKERS = ("CriOS/", "FxiOS/", "EdgiOS/", "OPiOS/")


def extract_quick_tunnel_url(line: str) -> str | None:
    match = _QUICK_TUNNEL_URL.search(line)
    return match.group(0).rstrip() if match else None


def is_ios_safari_browser(value: object) -> bool:
    if not isinstance(value, dict) or set(value) != {
        "user_agent",
        "platform",
        "max_touch_points",
    }:
        return False
    user_agent = value["user_agent"]
    platform = value["platform"]
    max_touch_points = value["max_touch_points"]
    if (
        not isinstance(user_agent, str)
        or not user_agent
        or len(user_agent) > 1_024
        or not isinstance(platform, str)
        or isinstance(max_touch_points, bool)
        or not isinstance(max_touch_points, int)
        or max_touch_points < 1
    ):
        return False
    ios_device = platform in _IOS_PLATFORMS or (
        platform == "MacIntel" and max_touch_points > 1
    )
    return (
        ios_device
        and "AppleWebKit/" in user_agent
        and "Version/" in user_agent
        and "Mobile/" in user_agent
        and "Safari/" in user_agent
        and not any(marker in user_agent for marker in _NON_SAFARI_IOS_MARKERS)
    )


@asynccontextmanager
async def launch_quick_tunnel(
    *, executable: str | Path, local_url: str, startup_timeout: float = 30
) -> AsyncIterator[str]:
    drain_task: asyncio.Task[None] | None = None
    process = await asyncio.create_subprocess_exec(
        str(executable),
        "tunnel",
        "--url",
        local_url,
        "--no-autoupdate",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stderr = process.stderr
        if stderr is None:
            raise RuntimeError("quick tunnel did not expose its startup stream")
        try:
            async with asyncio.timeout(startup_timeout):
                while True:
                    line = await stderr.readline()
                    if not line:
                        raise RuntimeError("quick tunnel exited before publishing a URL")
                    public_url = extract_quick_tunnel_url(line.decode(errors="replace"))
                    if public_url is not None:
                        break
        except TimeoutError as error:
            raise RuntimeError("quick tunnel did not publish a URL in time") from error
        drain_task = asyncio.create_task(_drain_stream(stderr))
        await asyncio.sleep(0)
        yield public_url
    finally:
        if drain_task is not None:
            drain_task.cancel()
            with suppress(asyncio.CancelledError):
                await drain_task
        if process.returncode is None:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            process.kill()
            await process.wait()


async def _drain_stream(stream: asyncio.StreamReader) -> None:
    while await stream.readline():
        pass


class MobileProbeServer:
    def __init__(self, *, bundle: bytes, secret: str) -> None:
        if len(secret) != 64 or any(character not in "0123456789abcdef" for character in secret):
            raise ValueError("mobile probe secret must be 256-bit lowercase hex")
        self._bundle = bundle
        self._secret = secret
        self._runner: web.AppRunner | None = None
        self._site: web.SockSite | None = None
        self._socket: socket.socket | None = None
        self._websocket: web.WebSocketResponse | None = None
        self._browser_ready: asyncio.Future[BrowserProbePage] | None = None
        self._command_lock = asyncio.Lock()
        self._next_command_id = 1
        self._in_flight_command_id: int | None = None
        self._session_done = asyncio.Event()
        self._port: int | None = None

    async def __aenter__(self) -> "MobileProbeServer":
        application = web.Application()
        application.router.add_get("/", self._serve_page)
        application.router.add_get("/probe.js", self._serve_bundle)
        application.router.add_get("/control", self._control)
        self._runner = web.AppRunner(application, access_log=None)
        await self._runner.setup()

        probe_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe_socket.bind(("127.0.0.1", 0))
        probe_socket.listen(socket.SOMAXCONN)
        probe_socket.setblocking(False)
        self._socket = probe_socket
        self._port = int(probe_socket.getsockname()[1])
        self._site = web.SockSite(self._runner, probe_socket)
        await self._site.start()
        self._browser_ready = asyncio.get_running_loop().create_future()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc, traceback
        self._session_done.set()
        if self._websocket is not None:
            await self._websocket.close()
        if self._runner is not None:
            await self._runner.cleanup()
        if self._socket is not None:
            self._socket.close()

    @classmethod
    def from_bundle(cls, bundle: Path, *, secret: str) -> "MobileProbeServer":
        return cls(bundle=bundle.read_bytes(), secret=secret)

    @property
    def local_url(self) -> str:
        if self._port is None:
            raise RuntimeError("mobile probe server is not running")
        return f"http://127.0.0.1:{self._port}"

    @property
    def control_url(self) -> str:
        return self.local_url.replace("http://", "ws://") + "/control"

    @property
    def in_flight_command_id(self) -> int | None:
        return self._in_flight_command_id

    async def wait_for_browser(self, *, timeout: float) -> BrowserProbePage:
        if self._browser_ready is None:
            raise RuntimeError("mobile probe server is not running")
        return await asyncio.wait_for(asyncio.shield(self._browser_ready), timeout)

    async def evaluate(self, expression: str, argument: Any = None) -> Any:
        methods = {
            "options => window.voiceSlice03Probe.connect(options)": "connect",
            "digest => window.voiceSlice03Probe.waitForWorkerMetadata(digest)": (
                "waitForWorkerMetadata"
            ),
            (
                "([identity, sampleId]) => "
                "window.voiceSlice03Probe.collectClockSamples(identity, sampleId)"
            ): "collectClockSamples",
            "() => window.voiceSlice03Probe.startInputFixture()": "startInputFixture",
            (
                "([identity, sampleId]) => "
                "window.voiceSlice03Probe.waitForCandidateResponse(identity, sampleId)"
            ): "waitForCandidateResponse",
            (
                "identity => window.voiceSlice03Probe.interruptAtHeardBoundary(identity)"
            ): "interruptAtHeardBoundary",
            "() => window.voiceSlice03Probe.disconnect()": "disconnect",
        }
        method = methods.get(expression)
        if method is None:
            raise ValueError("unsupported mobile browser probe operation")
        return await self._call(method, argument)

    async def _call(self, method: str, argument: Any) -> Any:
        async with self._command_lock:
            websocket = self._websocket
            if websocket is None or websocket.closed:
                raise RuntimeError("mobile Safari probe is not connected")
            command_id = self._next_command_id
            self._next_command_id += 1
            self._in_flight_command_id = command_id
            try:
                await websocket.send_json(
                    {"id": command_id, "method": method, "argument": argument}
                )
                message = await websocket.receive(timeout=60)
                if message.type != WSMsgType.TEXT:
                    raise RuntimeError("mobile Safari probe disconnected during command")
                response = message.json()
                if (
                    not isinstance(response, dict)
                    or response.get("id") != command_id
                    or response.get("ok") is not True
                    or set(response) != {"id", "ok", "result"}
                ):
                    raise RuntimeError("mobile Safari probe returned an invalid response")
                return response["result"]
            finally:
                self._in_flight_command_id = None

    async def _serve_page(self, request: web.Request) -> web.Response:
        del request
        return web.Response(
            text=(
                '<!doctype html><html><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                '<script src="/probe.js" defer></script></head><body></body></html>'
            ),
            content_type="text/html",
            headers=_secure_headers(),
        )

    async def _serve_bundle(self, request: web.Request) -> web.Response:
        del request
        return web.Response(
            body=self._bundle,
            content_type="text/javascript",
            headers=_secure_headers(),
        )

    async def _control(self, request: web.Request) -> web.StreamResponse:
        websocket = web.WebSocketResponse(heartbeat=20)
        await websocket.prepare(request)
        if self._websocket is not None and not self._websocket.closed:
            await websocket.close(code=1008, message=b"controller already connected")
            return websocket
        try:
            message = await websocket.receive(timeout=10)
            if message.type != WSMsgType.TEXT:
                await websocket.close(code=1008)
                return websocket
            payload = message.json()
            if (
                not isinstance(payload, dict)
                or set(payload) != {"secret", "browser"}
                or payload["secret"] != self._secret
                or not is_ios_safari_browser(payload["browser"])
            ):
                await websocket.close(code=1008)
                return websocket
        except (TimeoutError, ValueError, TypeError):
            await websocket.close(code=1008)
            return websocket

        self._websocket = websocket
        if self._browser_ready is None:
            await websocket.close(code=1011)
            return websocket
        if not self._browser_ready.done():
            self._browser_ready.set_result(BrowserProbePage(self))
        await websocket.send_json({"kind": "authenticated"})
        await self._session_done.wait()
        return websocket


def _secure_headers() -> dict[str, str]:
    return {
        "Cache-Control": "no-store",
        "Content-Security-Policy": (
            "default-src 'none'; script-src 'self' blob:; worker-src blob:; "
            "connect-src 'self' wss: data:; style-src 'unsafe-inline'; "
            "img-src 'none'; media-src blob: data:"
        ),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    }
