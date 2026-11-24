"""SDK transport restricted to the unified certified MCP surface."""
from agents.mcp import MCPServerStreamableHttp, create_static_tool_filter

ALLOWED_TOOLS = frozenset({
    "data_query", "p2_discover", "p2_describe", "p2_execute", "run_trace",
})


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
            raise ValueError("Tool outside unified certified scope")
        args = dict(arguments or {})
        args["run_id"] = self.run_id
        return await super().call_tool(tool_name, args, meta=meta)
