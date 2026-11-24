"""Read-only MCP handshake diagnostics; no model calls or business queries."""
import asyncio
import json
import os
from importlib.metadata import version
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from .connection import ALLOWED_TOOLS, CertifiedMCP


def rpc(client, url, method, params, headers):
    response = client.post(url, headers=headers, json={
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params,
    })
    print(json.dumps({"phase": method, "http": response.status_code,
                      "content_type": response.headers.get("content-type", "").split(";")[0]}), flush=True)
    response.raise_for_status()
    if "text/event-stream" in response.headers.get("content-type", ""):
        payload = next(json.loads(line[6:]) for line in response.text.splitlines()
                       if line.startswith("data: "))
    else:
        payload = response.json()
    if payload.get("error"):
        print(json.dumps({"phase": method, "rpc_error_code": payload["error"].get("code")}), flush=True)
        raise RuntimeError("MCP_RPC_ERROR")
    return payload["result"], response.headers.get("mcp-session-id")


async def sdk_probe(url):
    print("phase=SDK_CONNECT", flush=True)
    async with CertifiedMCP(url, "p4-probe-" + str(uuid4())) as server:
        print("phase=SDK_LIST_TOOLS", flush=True)
        result = await server.session.list_tools()
        names = {tool.name for tool in result.tools}
        if not ALLOWED_TOOLS.issubset(names):
            raise RuntimeError("SDK_MISSING_TOOLS")
        print("PASS: SDK initialize and list_tools", flush=True)


def main():
    url = os.environ["MCP_URL"]
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("INVALID_MCP_URL")
    print(json.dumps({"endpoint_host": parsed.hostname, "endpoint_path": parsed.path,
                      "mcp_version": version("mcp"), "agents_version": version("openai-agents")}), flush=True)
    headers = {"accept": "application/json, text/event-stream"}
    with httpx.Client(timeout=30, follow_redirects=False) as client:
        init, session = rpc(client, url, "initialize", {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "p4-diagnostic", "version": "1"},
        }, headers)
        headers["MCP-Protocol-Version"] = init["protocolVersion"]
        if session:
            headers["Mcp-Session-Id"] = session
        print(json.dumps({"negotiated_protocol": init["protocolVersion"],
                          "session_present": bool(session)}), flush=True)
        notification = client.post(url, headers=headers, json={
            "jsonrpc": "2.0", "method": "notifications/initialized",
        })
        print(json.dumps({"phase": "initialized", "http": notification.status_code}), flush=True)
        notification.raise_for_status()
        result, _ = rpc(client, url, "tools/list", {}, headers)
        names = {tool["name"] for tool in result["tools"]}
        print(json.dumps({"tool_count": len(names), "missing": sorted(ALLOWED_TOOLS - names)}), flush=True)
        if not ALLOWED_TOOLS.issubset(names):
            raise RuntimeError("REMOTE_MISSING_UNIFIED_TOOLS")
    asyncio.run(sdk_probe(url))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        error = getattr(exc, "error", None)
        print(json.dumps({"error_type": type(exc).__name__,
                          "rpc_code": getattr(error, "code", None)}), flush=True)
        raise SystemExit(1) from None
