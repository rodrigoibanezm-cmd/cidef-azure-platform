"""SDK transport restricted to existing certified MCP tools."""

from agents.mcp import MCPServerStreamableHttp, create_static_tool_filter

ALLOWED_TOOLS = frozenset({
    "data_describe", "data_inspect", "data_resolve", "data_observe",
    "sales_observe_many", "p2_discover", "p2_describe", "p2_execute", "run_trace",
})
SOURCES = frozenset({"SALES", "FORUM", "RVM", "TARGETS"})


class CertifiedMCP(MCPServerStreamableHttp):
    def __init__(self, url: str, run_id: str):
        super().__init__(
            name="cidef-certified-p1-p2-p3",
            params={"url": url, "timeout": 240},
            client_session_timeout_seconds=240,
            cache_tools_list=True,
            tool_filter=create_static_tool_filter(allowed_tool_names=sorted(ALLOWED_TOOLS)),
            max_retry_attempts=0,
        )
        self.run_id = run_id

    async def call_tool(self, tool_name, arguments, meta=None):
        if tool_name not in ALLOWED_TOOLS:
            raise ValueError("Tool outside the certified monthly-close scope")
        args = dict(arguments or {})
        if "source" in args and args["source"] not in SOURCES:
            raise ValueError("Source outside the monthly-close scope")
        args["run_id"] = self.run_id
        return await super().call_tool(tool_name, args, meta=meta)
