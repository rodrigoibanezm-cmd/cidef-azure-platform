"""Per-run conservative reservation and actual usage accounting."""
import json
import os
from decimal import Decimal
from pathlib import Path

D = Decimal
MILLION = D(1000000)


class BudgetStop(Exception):
    pass


class Budget:
    def __init__(self, model):
        config = json.loads(Path(__file__).with_name("budget.json").read_text())
        self.limit = D(os.getenv("P4_BUDGET_USD") or str(config["budget_usd"]))
        rates = json.loads(os.getenv("P4_MODEL_RATES_JSON") or "{}")
        rate = rates.get(model, config["rates"].get(model))
        if not rate:
            raise ValueError("P4_MODEL_PRICE_NOT_CONFIGURED")
        self.input, self.output, self.cached = (D(str(rate[k])) for k in ("input", "output", "cached"))
        if not all(v.is_finite() and v > 0 for v in (self.limit, self.input, self.output)):
            raise ValueError("INVALID_BUDGET_OR_RATE")
        if not self.cached.is_finite() or not 0 <= self.cached <= self.input:
            raise ValueError("INVALID_CACHED_RATE")
        self.cap = int(config["max_output_tokens"])
        self.minimum = int(config["minimum_output_tokens"])
        self.factor = D(str(config["input_safety_factor"]))
        self.cost = D(0)
        self.charged = D(0)
        self.calls = self.in_tokens = self.out_tokens = self.cached_tokens = 0
        self.stopped = False

    def allowance(self, count):
        reserved_input = D(count) * self.factor * self.input / MILLION
        remaining = self.limit - self.charged - reserved_input
        cap = min(self.cap, int(remaining * MILLION / self.output))
        if cap < self.minimum:
            self.stopped = True
            raise BudgetStop("P4_BUDGET_STOP")
        return cap

    def record(self, usage):
        if usage is None:
            raise RuntimeError("P4_USAGE_UNAVAILABLE")
        i, o = usage.input_tokens, usage.output_tokens
        cached = getattr(getattr(usage, "input_tokens_details", None), "cached_tokens", 0) or 0
        if not 0 <= cached <= i or i < 0 or o < 0:
            raise RuntimeError("P4_INVALID_USAGE")
        self.calls += 1
        self.in_tokens += i
        self.out_tokens += o
        self.cached_tokens += cached
        self.cost += ((i-cached)*self.input + cached*self.cached + o*self.output)/MILLION
        # No cache discount in the enforcement ledger; allow for cache-write premiums.
        self.charged += (D(i)*self.input*self.factor + D(o)*self.output)/MILLION

    def summary(self):
        return {"budget_usd": float(self.limit), "estimated_usd": float(self.cost),
                "control_usd": float(self.charged), "requests": self.calls,
                "input_tokens": self.in_tokens, "output_tokens": self.out_tokens,
                "cached_tokens": self.cached_tokens, "budget_stopped": self.stopped}
