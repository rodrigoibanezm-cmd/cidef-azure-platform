import unittest
from unittest.mock import patch, AsyncMock
from types import SimpleNamespace
from monthly_close_agent.budget import Budget, BudgetStop
from monthly_close_agent.budget_client import BudgetedResponses


class BudgetTests(unittest.IsolatedAsyncioTestCase):
    @patch.dict("os.environ", {"P4_BUDGET_USD": "0.50", "P4_MODEL_RATES_JSON": "{}"})
    async def test_reserve_record_and_block(self):
        budget = Budget("gpt-5.1")
        response = SimpleNamespace(usage=SimpleNamespace(input_tokens=1000,
            output_tokens=100, input_tokens_details=SimpleNamespace(cached_tokens=500)))
        api = SimpleNamespace(input_tokens=SimpleNamespace(count=AsyncMock(
            return_value=SimpleNamespace(input_tokens=1000))), create=AsyncMock(return_value=response))
        guarded = BudgetedResponses(api, budget)
        await guarded.create(model="gpt-5.1", input="test")
        self.assertEqual(budget.calls, 1)
        self.assertEqual(api.create.call_args.kwargs["max_output_tokens"], 4096)
        self.assertAlmostEqual(float(budget.cost), 0.0016875)
        api.input_tokens.count.return_value = SimpleNamespace(input_tokens=500000)
        with self.assertRaises(BudgetStop):
            await guarded.create(model="gpt-5.1", input="large")
        self.assertEqual(api.create.await_count, 1)

    @patch.dict("os.environ", {"P4_MODEL_RATES_JSON": "{}"})
    def test_unknown_model_blocked(self):
        with self.assertRaises(ValueError):
            Budget("unknown")


    def test_real_mcp_result_fields(self):
        from mcp.types import CallToolResult, TextContent
        from monthly_close_agent.evidence import decode_trace
        payload = {"run": {"run_id": "test"}, "events": []}
        self.assertEqual(decode_trace(CallToolResult(content=[], structuredContent=payload)), payload)
        self.assertEqual(decode_trace(CallToolResult(content=[
            TextContent(type="text", text='{"events": []}') ])), {"events": []})
        with self.assertRaises(RuntimeError):
            decode_trace(CallToolResult(content=[], isError=True))
