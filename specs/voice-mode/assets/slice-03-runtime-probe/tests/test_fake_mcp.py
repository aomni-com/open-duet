import socket
import time
from multiprocessing import get_context

from livekit.agents import mcp

from voice_probe.fake_mcp import run_fake_bound_server


def test_livekit_connects_to_duet_root_with_explicit_streamable_http() -> None:
    with socket.socket() as probe_socket:
        probe_socket.bind(("127.0.0.1", 0))
        port = probe_socket.getsockname()[1]

    process = get_context("spawn").Process(target=run_fake_bound_server, args=(port,))
    process.start()
    try:
        _wait_for_port(port)
        toolset = mcp.MCPToolset(
            id="fake-bound-duet",
            mcp_server=mcp.MCPServerHTTP(
                f"http://127.0.0.1:{port}/",
                transport_type="streamable_http",
            ),
        )

        async def inspect_tools() -> set[str]:
            await toolset.setup()
            try:
                return {tool.id.rsplit(".", 1)[-1] for tool in toolset.tools}
            finally:
                await toolset.aclose()

        import asyncio

        assert asyncio.run(inspect_tools()) == {"main_send", "main_read", "main_cancel"}
    finally:
        process.terminate()
        process.join(timeout=5)


def _wait_for_port(port: int) -> None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with socket.socket() as client:
            if client.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.05)
    raise TimeoutError("fake MCP server did not start")
