"""Manual live SDK acceptance test; no commercial data is printed or uploaded."""
import asyncio
import json
import os
import re
import tempfile
from datetime import datetime
from time import monotonic

from .runner import generate
from .evidence import evidence_status
from .routing import RESEARCH, validate_route


async def main():
    period = os.environ["PERIOD"]
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", period):
        raise ValueError("INVALID_PERIOD")
    datetime.strptime(period, "%Y-%m")
    goal = "Contrastar hipótesis de desempeño mediante SALES y FORUM."
    assert validate_route(RESEARCH, goal)
    question = (
        f"Investiga en {period} las ventas y cotizaciones de tiendas propias. "
        "Contrasta si las sucursales con más ventas también tienen mayor actividad "
        "de cotización. Usa evidencia independiente de SALES y FORUM, resuelve "
        "identidades si corresponde, distingue universos y cortes, no inventes "
        "conversiones ni causalidad y usa P2 solo si existe un contrato aplicable. "
        "Entrega hallazgos con evidence_id y limitaciones."
    )
    start = monotonic()
    with tempfile.TemporaryDirectory() as tmp:
        report = await generate(
            question, url=os.environ["MCP_URL"], model=os.environ["OPENAI_MODEL"],
            output_dir=tmp, max_turns=18,
        )
        trace = json.loads(report.with_name("trace.json").read_text())
        events = trace["events"]
        run_id = report.parent.name
        if any(event.get("run_id") != run_id for event in events):
            raise RuntimeError("RUN_ID_MISMATCH")
        sources = set()
        for event in events:
            if evidence_status([event]) != "NO_EVIDENCE":
                output = event.get("output_json") or {}
                source = output.get("source") or (event.get("input_json") or {}).get("source")
                if source:
                    sources.add(source)
        print(json.dumps({"run_id": run_id, "sources": sorted(sources),
                          "authority": evidence_status(events),
                          "events": len(events), "elapsed_s": round(monotonic()-start, 2)}))
        if not {"SALES", "FORUM"}.issubset(sources):
            raise RuntimeError("MISSING_CROSS_SOURCE_EVIDENCE")
        print("PASS: SDK report and same-run cross-source P3 evidence")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        raise SystemExit(f"P4 acceptance failed: {type(exc).__name__}") from None
