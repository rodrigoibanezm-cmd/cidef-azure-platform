import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from mcp.types import CallToolResult

from monthly_close_agent.runner import generate


class RunnerTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, root, payload, text="Informe con evidencia e1"):
        server = AsyncMock()
        server.__aenter__.return_value = server
        server.call_tool.return_value = CallToolResult(content=[], structuredContent=payload)
        with patch("monthly_close_agent.runner.uuid4", return_value="test"), patch(
            "monthly_close_agent.runner.CertifiedMCP", return_value=server,
        ), patch(
            "monthly_close_agent.runner.Runner.run", new_callable=AsyncMock,
            return_value=SimpleNamespace(final_output=text),
        ) as run:
            report = await generate("2026-10", url="http://localhost/api/mcp",
                                    model="test-model", output_dir=root)
            self.assertEqual(run.call_args.args[0].name, "cidef-monthly-close")
            self.assertTrue(run.call_args.kwargs["run_config"].tracing_disabled)
            server.call_tool.assert_awaited_once_with("run_trace", {})
            return report

    async def test_markdown_and_original_p3_trace_are_saved(self):
        payload = {"run": {"run_id": "monthly-close-2026-10-test"}, "events": [{
            "floor": "P1", "tool_name": "data_observe", "status": "SUCCESS",
            "output_json": {"authority": "P1_CERTIFIED", "evidence_id": "e1"},
        }]}
        with tempfile.TemporaryDirectory() as root:
            report = await self.invoke(root, payload)
            self.assertIn("2026-10", report.read_text())
            self.assertIn("Informe con evidencia e1", report.read_text())
            self.assertEqual(json.loads(report.with_name("trace.json").read_text()), payload)

    async def test_missing_or_failed_evidence_never_publishes_report(self):
        cases = [[], [{"floor": "P1", "tool_name": "data_describe", "status": "SUCCESS"}],
                 [{"floor": "P1", "tool_name": "data_observe", "status": "FAILED",
                   "output_json": {"authority": "P1_CERTIFIED", "evidence_id": "e1"}}]]
        for events in cases:
            with tempfile.TemporaryDirectory() as root:
                with self.assertRaisesRegex(RuntimeError, "Sin evidencia P1"):
                    await self.invoke(root, {"run": {"run_id": "monthly-close-2026-10-test"}, "events": events})
                self.assertEqual(list(Path(root).rglob("report.md")), [])
                self.assertEqual(len(list(Path(root).rglob("trace.json"))), 1)
