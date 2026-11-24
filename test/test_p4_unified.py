import unittest
from unittest.mock import AsyncMock, patch

from monthly_close_agent.connection import ALLOWED_TOOLS, CertifiedMCP
from monthly_close_agent.evidence import evidence_status
from monthly_close_agent.routing import validate_route


class RoutingTests(unittest.TestCase):
    def test_direct_bypass(self):
        self.assertFalse(validate_route("DIRECT_MOTOR", None))
        with self.assertRaises(ValueError):
            validate_route("P4_RESEARCH", "")
        self.assertTrue(validate_route("P4_RESEARCH", "Investigate competing hypotheses"))


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_unified_transport(self):
        self.assertEqual(ALLOWED_TOOLS, {"data_query", "p2_discover", "p2_describe", "p2_execute", "run_trace"})
        server = CertifiedMCP("http://localhost/mcp", "test-run")
        with patch("agents.mcp.MCPServerStreamableHttp.call_tool", new_callable=AsyncMock) as call:
            await server.call_tool("data_query", {"source": "INVENTORY", "run_id": "other"})
            call.assert_awaited_once_with("data_query", {"source": "INVENTORY", "run_id": "test-run"}, meta=None)
            with self.assertRaises(ValueError):
                await server.call_tool("data_observe", {})


class EvidenceTests(unittest.TestCase):
    def test_authority(self):
        def event(output):
            return {"floor": "P1", "status": "SUCCESS", "output_json": output}
        full = {"authority": "P1_CERTIFIED", "evidence_id": "full"}
        partial = {"authority": "P1_PARTIAL_SOURCE", "evidence_id": "partial"}
        self.assertEqual(evidence_status([]), "NO_EVIDENCE")
        self.assertEqual(evidence_status([event(partial)]), "PARTIAL_ONLY")
        self.assertEqual(evidence_status([event({"results": [{"evidence": full}]})]), "HAS_CERTIFIED_EVIDENCE")
        self.assertEqual(evidence_status([event(full), event(partial)]), "MIXED_OR_PARTIAL")
