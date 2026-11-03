"""One manual SDK run, Markdown output and the existing P3 trace."""

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from agents import Agent, ModelSettings, RunConfig, Runner

from .connection import CertifiedMCP


async def generate(period, *, url, model, output_dir, max_turns=40):
    run_id = f"monthly-close-{period}-{uuid4()}"
    destination = Path(output_dir) / run_id
    mission = Path(__file__).with_name("mission.md").read_text(encoding="utf-8")
    async with CertifiedMCP(url, run_id) as server:
        agent = Agent(
            name="cidef-monthly-close", instructions=mission, model=model,
            mcp_servers=[server], model_settings=ModelSettings(parallel_tool_calls=False),
        )
        result = await Runner.run(
            agent, f"Prepara el cierre mensual de {period}. run_id: {run_id}.",
            max_turns=max_turns, run_config=RunConfig(tracing_disabled=True),
        )
        trace = await server.call_tool("run_trace", {})
        if trace.is_error:
            raise RuntimeError("P3 no devolvió una traza válida; no se publicó informe")
        payload = trace.structured_content
        if not payload:
            payload = json.loads(next(c.text for c in trace.content if c.type == "text"))
        if (payload.get("run") or {}).get("run_id") != run_id:
            raise RuntimeError("P3 no confirmó la identidad de esta ejecución")
        events = payload.get("events", [])
        has_evidence = any(
            e.get("floor") == "P1" and e.get("status") == "SUCCESS"
            and e.get("tool_name") == "data_observe"
            and (e.get("output_json") or {}).get("authority") == "P1_CERTIFIED"
            and (e.get("output_json") or {}).get("evidence_id")
            for e in events
        )
        destination.mkdir(parents=True, exist_ok=False)
        (destination / "trace.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8",
        )
        if not has_evidence:
            raise RuntimeError(f"Sin evidencia P1 certificada. Traza: {destination / 'trace.json'}")
        if not isinstance(result.final_output, str) or not result.final_output.strip():
            raise RuntimeError("El agente no devolvió Markdown; se conservó la traza")
        header = (
            f"# CIDEF — Cierre mensual {period}\n\n"
            f"Borrador ejecutivo generado por IA; requiere revisión.\n\n"
            f"- Ejecución: `{run_id}`\n- Modelo: `{model}`\n"
            f"- Generado UTC: {datetime.now(timezone.utc).isoformat()}\n"
            f"- Evidencia: [trace.json](trace.json)\n\n"
        )
        report = destination / "report.md"
        report.write_text(header + result.final_output + "\n", encoding="utf-8")
        return report
