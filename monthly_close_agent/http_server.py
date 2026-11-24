"""Private HTTP entrypoint for the existing P4 SDK runner.

Run: P4_API_TOKEN=... OPENAI_API_KEY=... OPENAI_MODEL=... MCP_URL=... \
python -m monthly_close_agent.http_server
"""
import asyncio
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from .runner import generate
from .routing import validate_route

MAX_BYTES = 16_384


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/analyze":
            return self.reply(404, {"error": "NOT_FOUND"})
        token = os.environ["P4_API_TOKEN"]
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied, "Bearer " + token):
            return self.reply(401, {"error": "UNAUTHORIZED"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BYTES:
                return self.reply(413, {"error": "INVALID_BODY_SIZE"})
            payload = json.loads(self.rfile.read(length))
            question = payload.get("question")
            if not isinstance(question, str) or not 0 < len(question.strip()) <= 8000:
                return self.reply(400, {"error": "INVALID_QUESTION"})
        except (ValueError, AttributeError, TypeError, json.JSONDecodeError):
            return self.reply(400, {"error": "INVALID_JSON"})
        try:
            if not validate_route(payload.get("route"), payload.get("research_goal")):
                return self.reply(200, {"status": "DIRECT_MOTOR"})
        except ValueError:
            return self.reply(400, {"error": "INVALID_RESEARCH_ROUTE"})
        try:
            report = asyncio.run(generate(
                question + "\nObjetivo de investigación: " + payload["research_goal"], url=os.environ["MCP_URL"],
                model=os.environ["OPENAI_MODEL"],
                output_dir=os.getenv("P4_OUTPUT_DIR", "p4-reports"),
            ))
            return self.reply(200, {
                "run_id": report.parent.name,
                "answer": Path(report).read_text(encoding="utf-8"),
            })
        except Exception:
            return self.reply(502, {"error": "ANALYSIS_FAILED"})

    def log_message(self, format, *args):
        pass  # Do not log potentially sensitive request information.


def main():
    for name in ("P4_API_TOKEN", "OPENAI_API_KEY", "OPENAI_MODEL", "MCP_URL"):
        if not os.getenv(name):
            raise RuntimeError(f"Missing required environment variable: {name}")
    host = os.getenv("P4_HOST", "127.0.0.1")
    port = int(os.getenv("P4_PORT", "8080"))
    HTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
