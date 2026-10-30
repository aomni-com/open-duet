from typing import Literal

from mcp.server.fastmcp import FastMCP


def run_fake_bound_server(port: int = 8765) -> None:
    server = FastMCP(
        "fake-bound-duet",
        host="127.0.0.1",
        port=port,
        streamable_http_path="/",
        stateless_http=True,
        json_response=True,
        log_level="ERROR",
    )

    @server.tool()
    def main_send(
        kind: Literal["request", "answer"], text: str, client_request_id: str
    ) -> dict[str, object]:
        """Accept one request for the already-bound Main session."""
        return {
            "mainSessionId": "fake-main",
            "created": kind == "request",
            "delivery": "accepted",
            "requestIdPresent": bool(client_request_id and text),
        }

    @server.tool()
    def main_read(client_request_id: str, cursor: int | None = None) -> dict[str, object]:
        """Read the result correlated to one request id."""
        return {
            "state": "complete",
            "cursor": 1 if cursor is None else cursor + 1,
            "text": "Bound fake response.",
            "requestIdPresent": bool(client_request_id),
        }

    @server.tool()
    def main_cancel() -> dict[str, str]:
        """Cancel work in the already-bound Main session."""
        return {"state": "idle"}

    server.run(transport="streamable-http")
