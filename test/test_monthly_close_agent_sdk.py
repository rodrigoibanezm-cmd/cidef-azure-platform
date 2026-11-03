"""Exercise the real SDK loop without calling OpenAI or a business database."""

import json
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from agents import Model, ModelResponse, Usage
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText

from monthly_close_agent.runner import generate


class TwoTurnModel(Model):
    def __init__(self):
        self.calls = 0

    async def get_response(self, *args, **kwargs):
        self.calls += 1
        if self.calls == 1:
            items = [ResponseFunctionToolCall(
                id="tool1", call_id="call1", name="data_observe", type="function_call",
                arguments=json.dumps({"run_id": "wrong", "source": "SALES"}),
            )]
        else:
            items = [ResponseOutputMessage(
                id="msg1", role="assistant", status="completed", type="message",
                content=[ResponseOutputText(type="output_text", text="Informe simulado: e1", annotations=[])],
            )]
        return ModelResponse(output=items, usage=Usage(), response_id=None)

    async def stream_response(self, *args, **kwargs):
        raise NotImplementedError
        yield


class SDKLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_selects_tool_receives_evidence_and_writes_report(self):
        calls = []
        evidence = {"authority": "P1_CERTIFIED", "evidence_id": "e1"}

        async def connect(server):
            server.session = AsyncMock()
            server.session.list_tools.return_value = ListToolsResult(tools=[Tool(
                name="data_observe", inputSchema={"type": "object", "properties": {
                    "run_id": {"type": "string"}, "source": {"type": "string"},
                }, "required": ["run_id", "source"]},
            )])

        async def transport(server, name, arguments, meta=None):
            calls.append((name, arguments))
            payload = evidence if name == "data_observe" else {
                "run": {"run_id": arguments["run_id"]}, "events": [{
                    "floor": "P1", "tool_name": "data_observe", "status": "SUCCESS",
                    "output_json": evidence,
                }],
            }
            return CallToolResult(structuredContent=payload, content=[
                TextContent(type="text", text=json.dumps(payload)),
            ])

        model = TwoTurnModel()
        with tempfile.TemporaryDirectory() as root, patch(
            "monthly_close_agent.connection.CertifiedMCP.connect", connect,
        ), patch("monthly_close_agent.connection.CertifiedMCP.cleanup", new_callable=AsyncMock), patch(
            "agents.mcp.MCPServerStreamableHttp.call_tool", transport,
        ):
            report = await generate("2026-10", url="http://localhost/api/mcp",
                                    model=model, output_dir=root)
            self.assertIn("Informe simulado: e1", report.read_text())
        self.assertEqual(model.calls, 2)
        self.assertEqual([name for name, _ in calls], ["data_observe", "run_trace"])
        self.assertEqual(calls[0][1]["run_id"], calls[1][1]["run_id"])
        self.assertNotEqual(calls[0][1]["run_id"], "wrong")
