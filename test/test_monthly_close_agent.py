import argparse
import unittest
from unittest.mock import AsyncMock, patch

from mcp.types import CallToolResult, ListToolsResult

from monthly_close_agent.__main__ import period_value
from monthly_close_agent.connection import ALLOWED_TOOLS, CertifiedMCP


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_identity_is_forced_without_mutating_arguments(self):
        server = CertifiedMCP("http://localhost/api/mcp", "stable-run")
        original = {"run_id": "invented-run", "source": "SALES"}
        with patch("agents.mcp.MCPServerStreamableHttp.call_tool", new_callable=AsyncMock) as call:
            call.return_value = CallToolResult(content=[])
            await server.call_tool("data_describe", original)
            call.assert_awaited_once_with(
                "data_describe", {"run_id": "stable-run", "source": "SALES"}, meta=None,
            )
        self.assertEqual(original["run_id"], "invented-run")

    async def test_raw_write_unknown_tools_and_sources_are_rejected_before_transport(self):
        server = CertifiedMCP("http://localhost/api/mcp", "stable-run")
        with patch("agents.mcp.MCPServerStreamableHttp.call_tool", new_callable=AsyncMock) as call:
            for tool in ("pg_query", "pg_execute", "pg_admin", "data_fetch", "unknown"):
                with self.assertRaises(ValueError):
                    await server.call_tool(tool, {})
            with self.assertRaises(ValueError):
                await server.call_tool("data_observe", {"source": "RAW"})
            call.assert_not_awaited()

    async def test_sdk_discovery_filters_future_tools(self):
        from mcp.types import Tool
        server = CertifiedMCP("http://localhost/api/mcp", "stable-run")
        tools = [Tool(name=name, inputSchema={"type": "object"})
                 for name in [*ALLOWED_TOOLS, "pg_query", "new_write_tool"]]
        server.session = AsyncMock()
        server.session.list_tools.return_value = ListToolsResult(tools=tools)
        visible = await server.list_tools()
        self.assertEqual({tool.name for tool in visible}, ALLOWED_TOOLS)


class PeriodTests(unittest.TestCase):
    def test_period_validation(self):
        self.assertEqual(period_value("2026-10"), "2026-10")
        for value in ("2026-00", "2026-13", "2026-1", "0000-10", "2026-10-01"):
            with self.assertRaises(argparse.ArgumentTypeError):
                period_value(value)
