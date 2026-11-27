import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

from starlette.testclient import TestClient
from monthly_close_agent.mcp_server import create_app, commercial_analyze


class MCPTests(unittest.IsolatedAsyncioTestCase):
    @patch("monthly_close_agent.mcp_server.generate", new_callable=AsyncMock)
    async def test_direct_bypass(self, generate):
        self.assertEqual((await commercial_analyze("ventas", "DIRECT_MOTOR", ""))["status"], "DIRECT_MOTOR")
        generate.assert_not_awaited()

    @patch.dict(os.environ, {"MCP_URL": "https://example.test/api/mcp", "OPENAI_MODEL": "gpt-5.1", "P4_OUTPUT_DIR": "/tmp"})
    @patch("monthly_close_agent.mcp_server.generate")
    async def test_report_and_usage(self, generate):
        async def fake(question, **kw):
            p = Path(kw["output_dir"]) / "test-run"
            p.mkdir()
            (p / "report.md").write_text("Informe")
            (p / "trace.json").write_text(json.dumps({"run":{"run_id":"test-run"},"events":[
                {"floor":"P1","status":"SUCCESS","output_json":{"authority":"P1_CERTIFIED","evidence_id":"test"}}]}))
            (p / "usage.json").write_text(json.dumps({"budget_stopped":False,"estimated_usd":0.04}))
            return p / "report.md"
        generate.side_effect = fake
        result = await commercial_analyze("investigación", "P4_RESEARCH", "comparar hipótesis")
        self.assertEqual(result["answer"], "Informe")
        self.assertEqual(result["run_id"], "test-run")
        self.assertEqual(result["authority"], "HAS_CERTIFIED_EVIDENCE")
        self.assertEqual(result["usage"]["estimated_usd"], 0.04)
        self.assertEqual(result["trace"]["event_count"], 1)


class HTTPTests(unittest.TestCase):
    @patch.dict(os.environ, {"P4_PUBLIC_HOST":"p4.example.test","P4_API_TOKEN":"test-token","OPENAI_API_KEY":"test-key","OPENAI_MODEL":"gpt-5.1","MCP_URL":"https://example.test/api/mcp"})
    def test_authenticated_mcp_discovery(self):
        with TestClient(create_app(), base_url='https://p4.example.test') as client:
            body={"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
            headers={"Accept":"application/json, text/event-stream"}
            self.assertEqual(client.post("/mcp",json=body,headers=headers).status_code,401)
            headers["Authorization"]="Bearer test-token"
            result=client.post("/mcp",json=body,headers=headers)
            self.assertEqual(client.post("/mcp",json=body,headers={**headers,"Host":"untrusted.example"}).status_code,421)
            self.assertEqual(result.status_code,200)
            self.assertEqual([t["name"] for t in result.json()["result"]["tools"]],["commercial_analyze"])
            from mcp.types import CallToolResult
            from monthly_close_agent.evidence import decode_trace
            init = client.post("/mcp", headers=headers, json={
                "jsonrpc":"2.0","id":2,"method":"initialize","params":{
                    "protocolVersion":"2025-03-26","capabilities":{},
                    "clientInfo":{"name":"p4-test","version":"1"}}})
            self.assertEqual(init.status_code,200)
            headers["MCP-Protocol-Version"] = init.json()["result"]["protocolVersion"]
            initialized = client.post("/mcp",headers=headers,json={
                "jsonrpc":"2.0","method":"notifications/initialized"})
            self.assertEqual(initialized.status_code,202)
            direct = client.post("/mcp",headers=headers,json={
                "jsonrpc":"2.0","id":3,"method":"tools/call","params":{
                    "name":"commercial_analyze","arguments":{
                        "question":"ventas","route":"DIRECT_MOTOR","research_goal":""}}})
            self.assertEqual(direct.status_code,200)
            self.assertEqual(decode_trace(CallToolResult.model_validate(direct.json()["result"]))["status"],"DIRECT_MOTOR")
