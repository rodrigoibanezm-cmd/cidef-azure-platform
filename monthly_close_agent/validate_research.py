"""Generic live research acceptance; no fixed domain, date or study."""
import asyncio
import json
import os
import traceback
from pathlib import Path
from time import monotonic

from .runner import generate
from .evidence import evidence_status
from .routing import RESEARCH, validate_route


async def main():
    question = os.environ.get("QUESTION", "").strip()
    goal = os.environ.get("RESEARCH_GOAL", "").strip()
    if not question or not validate_route(RESEARCH, goal):
        raise ValueError("QUESTION_AND_RESEARCH_GOAL_REQUIRED")
    start = monotonic()
    tmp = Path(os.environ.get('P4_OUTPUT_DIR', 'p4-research-output'))
    report = await generate(
        question + "\nObjetivo de investigación: " + goal,
        url=os.environ["MCP_URL"], model=os.environ["OPENAI_MODEL"],
        output_dir=tmp, max_turns=18,
    )
    trace = json.loads(report.with_name("trace.json").read_text())
    events = trace["events"]
    run_id = report.parent.name
    if any(event.get("run_id") != run_id for event in events):
        raise RuntimeError("RUN_ID_MISMATCH")
    usage = json.loads(report.with_name("usage.json").read_text())
    if usage["budget_stopped"]:
        print("PARTIAL: budget stopped; run_id=" + run_id)
        return
    status = evidence_status(events)
    if status == "NO_EVIDENCE":
        raise RuntimeError("NO_EVIDENCE")
    sources = set()
    for event in events:
        if evidence_status([event]) != "NO_EVIDENCE":
            output = event.get("output_json") or {}
            source = output.get("source") or (event.get("input_json") or {}).get("source")
            if source:
                sources.add(source)
    print(json.dumps({"run_id": run_id, "sources": sorted(sources),
                      "authority": status, "events": len(events),
                      "elapsed_s": round(monotonic()-start, 2)}))
    print("PASS: SDK execution and same-run P3 evidence; semantic review still required")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        for frame in traceback.extract_tb(exc.__traceback__):
            print(f"{Path(frame.filename).name}:{frame.lineno} in {frame.name}")
        raise SystemExit(f"P4 acceptance failed: {type(exc).__name__}") from None
