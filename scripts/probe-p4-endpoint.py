"""Authenticated MCP smoke check using the installed MCP client; no paid calls."""
import asyncio
import os
import sys
from pathlib import Path

import httpx
from agents.mcp import MCPServerStreamableHttp

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from monthly_close_agent.evidence import decode_trace


async def verify():
    url = os.environ["P4_TEST_URL"]
    token = os.environ["P4_TEST_TOKEN"]
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(url, headers={"Accept":"application/json, text/event-stream"},
            json={"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}})
        if response.status_code != 401:
            raise RuntimeError("UNAUTHENTICATED_REQUEST_NOT_REJECTED")
    async with MCPServerStreamableHttp(name="p4-smoke", params={
        "url":url,"headers":{"Authorization":"Bearer "+token},"timeout":30,
    }, client_session_timeout_seconds=30, max_retry_attempts=0) as server:
        tools = await server.session.list_tools()
        if {t.name for t in tools.tools} != {"commercial_analyze"}:
            raise RuntimeError("UNEXPECTED_MCP_TOOLS")
        result = await server.call_tool("commercial_analyze", {
            "question":"consulta directa","route":"DIRECT_MOTOR","research_goal":"",
        })
        if result.isError:
            raise RuntimeError("MCP_DIRECT_CALL_FAILED")
        if decode_trace(result).get("status") != "DIRECT_MOTOR":
            raise RuntimeError("DIRECT_BYPASS_FAILED")
    print("PASS: authenticated MCP discovery, unauthenticated rejection and direct bypass")


if __name__ == "__main__":
    asyncio.run(verify())
