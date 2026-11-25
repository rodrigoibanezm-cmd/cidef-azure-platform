"""Guard every Responses generation before submission, with provider token count."""
from .budget import BudgetStop


class BudgetedResponses:
    def __init__(self, responses, budget):
        self.responses = responses
        self.budget = budget

    def __getattr__(self, name):
        return getattr(self.responses, name)

    async def create(self, **kwargs):
        if kwargs.get("stream") is True:
            raise RuntimeError("P4_BUDGET_REQUIRES_NONSTREAMING")
        # Count exactly the input/history/tool definitions to be submitted.
        keys = ("model", "input", "instructions", "tools", "tool_choice", "text",
                "reasoning", "previous_response_id", "conversation", "truncation")
        from openai import Omit, NotGiven
        params = {k: kwargs[k] for k in keys if k in kwargs
                  and kwargs[k] is not None and not isinstance(kwargs[k], (Omit, NotGiven))}
        count = await self.responses.input_tokens.count(**params)
        cap = self.budget.allowance(count.input_tokens)
        original = kwargs.get("max_output_tokens")
        if isinstance(original, int):
            cap = min(cap, original)
        kwargs["max_output_tokens"] = cap
        response = await self.responses.create(**kwargs)
        self.budget.record(response.usage)
        return response
