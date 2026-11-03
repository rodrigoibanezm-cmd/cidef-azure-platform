"""Usage: python -m monthly_close_agent 2026-10."""

import argparse
import asyncio
import os
import re
import sys
from urllib.parse import urlsplit


def period_value(value):
    if not re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", value) or value.startswith("0000"):
        raise argparse.ArgumentTypeError("El período debe ser YYYY-MM")
    return value


def main():
    parser = argparse.ArgumentParser(description="Cierre mensual CIDEF con P1/P2/P3")
    parser.add_argument("period", type=period_value)
    parser.add_argument("--model", default=os.getenv("OPENAI_MODEL"))
    parser.add_argument("--output-dir", default="monthly-close-reports")
    parser.add_argument("--max-turns", type=int, default=40)
    args = parser.parse_args()
    missing = [name for name in ("OPENAI_API_KEY", "MCP_URL") if not os.getenv(name)]
    if not args.model:
        missing.append("OPENAI_MODEL (o --model)")
    if missing:
        parser.error("Falta configuración: " + ", ".join(missing))
    url = os.environ["MCP_URL"]
    parts = urlsplit(url)
    if not parts.netloc or parts.scheme not in {"http", "https"}:
        parser.error("MCP_URL debe ser el endpoint HTTP(S) MCP existente")
    if args.max_turns < 1:
        parser.error("--max-turns debe ser positivo")
    from .runner import generate
    try:
        report = asyncio.run(generate(
            args.period, url=url, model=args.model, output_dir=args.output_dir,
            max_turns=args.max_turns,
        ))
    except Exception as error:
        # Transport/provider exceptions may contain credentials or request content.
        print(f"Cierre no generado ({type(error).__name__}). Verifica configuración, "
              "conexión MCP y acceso al modelo; revisa la traza local si existe.", file=sys.stderr)
        return 1
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
