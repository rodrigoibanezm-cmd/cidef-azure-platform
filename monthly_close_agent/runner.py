"""One manual SDK run, Markdown output and the existing P3 trace."""

import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from agents import Agent, ModelSettings, RunConfig, Runner

from openai import AsyncOpenAI
from agents.models.openai_responses import OpenAIResponsesModel
from .budget import Budget, BudgetStop
from .budget_client import BudgetedResponses
from .connection import CertifiedMCP
from .evidence import evidence_status, decode_trace


async def generate(question, *, url, model, output_dir, max_turns=40):
    question = question.strip()
    if not question:
        raise ValueError("La pregunta no puede estar vacía")
    run_id = "p4-" + str(uuid4())
    destination = Path(output_dir) / run_id
    print(json.dumps({"run_id": run_id, "model": model}), flush=True)
    mission = Path(__file__).with_name("mission.md").read_text(encoding="utf-8")
    budget = Budget(model)
    async with AsyncOpenAI(max_retries=0) as client, CertifiedMCP(url, run_id) as server:
        client.responses = BudgetedResponses(client.responses, budget)
        guarded_model = OpenAIResponsesModel(model=model, openai_client=client)
        agent = Agent(
            name="cidef-p4",
            instructions=mission, model=guarded_model,
            mcp_servers=[server], model_settings=ModelSettings(parallel_tool_calls=False),
        )
        result = None
        try:
            result = await Runner.run(
                agent, question + f" run_id: {run_id}. Prioriza evidencia útil y responde sin consultas redundantes.",
                max_turns=max_turns, run_config=RunConfig(tracing_disabled=True),
            )
        except BudgetStop:
            pass
        finally:
            print(json.dumps({"p4_usage": budget.summary()}), flush=True)
        trace = await server.call_tool("run_trace", {})
        payload = decode_trace(trace)
        if (payload.get("run") or {}).get("run_id") != run_id:
            raise RuntimeError("P3 no confirmó la identidad de esta ejecución")
        events = payload.get("events", [])
        status = evidence_status(events)
        destination.mkdir(parents=True, exist_ok=False)
        (destination / "trace.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8",
        )
        (destination / "usage.json").write_text(json.dumps(budget.summary(), indent=2))
        if budget.stopped:
            report = destination / "report.md"
            report.write_text("# Investigación parcial: límite presupuestario\n\n"
                              f"Run: {run_id}. Autoridad observada: {status}.\n\n"
                              "Se interrumpió antes de otra llamada al modelo. "
                              "La evidencia disponible se conserva en trace.json. "
                              "No se generó una conclusión completa.\n", encoding="utf-8")
            return report
        if status == "NO_EVIDENCE":
            raise RuntimeError(f"Sin evidencia P1 reconocida. Traza: {destination / 'trace.json'}")
        if not isinstance(result.final_output, str) or not result.final_output.strip():
            raise RuntimeError("El agente no devolvió Markdown; se conservó la traza")
        header = (
            "# CIDEF — Investigación comercial\n\n"
            f"Borrador ejecutivo generado por IA; requiere revisión.\n\n"
            f"- Ejecución: `{run_id}`\n- Modelo: `{model}`\n"
            f"- Generado UTC: {datetime.now(timezone.utc).isoformat()}\n"
            f"- Autoridad observada: `{status}` (no certifica el informe completo)\n"
            f"- Evidencia: [trace.json](trace.json)\n\n"
        )
        report = destination / "report.md"
        report.write_text(header + result.final_output + "\n", encoding="utf-8")
        return report
