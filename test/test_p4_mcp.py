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
    @patch.dict(os.environ, {"P4_API_TOKEN":"test-token","OPENAI_API_KEY":"test-key","OPENAI_MODEL":"gpt-5.1","MCP_URL":"https://example.test/api/mcp"})
    def test_authenticated_mcp_discovery(self):
        with TestClient(create_app()) as client:
            body={"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
            headers={"Accept":"application/json, text/event-stream"}
            self.assertEqual(client.post("/mcp",json=body,headers=headers).status_code,401)
            headers["Authorization"]="Bearer test-token"
            result=client.post("/mcp",json=body,headers=headers)
            self.assertEqual(result.status_code,200)
            self.assertEqual([t["name"] for t in result.json()["result"]["tools"]],["commercial_analyze"])
