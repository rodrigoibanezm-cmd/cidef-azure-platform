"""P4 MCP endpoint. Run with: python -m monthly_close_agent.mcp_server."""
import hmac
import os
from pathlib import Path

import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .runner import generate

mcp = FastMCP("cidef-p4", stateless_http=True, json_response=True)


@mcp.tool()
async def commercial_analyze(question: str) -> dict:
    """Investigate a CIDEF commercial question using certified P1/P2/P3 evidence."""
    if not isinstance(question, str) or not 0 < len(question.strip()) <= 8000:
        raise ValueError("INVALID_QUESTION")
    report = await generate(
        question,
        url=os.environ["MCP_URL"],
        model=os.environ["OPENAI_MODEL"],
        output_dir=os.getenv("P4_OUTPUT_DIR", "/tmp/p4-reports"),
    )
    return {
        "run_id": report.parent.name,
        "answer": Path(report).read_text(encoding="utf-8"),
    }


def main():
    for name in ("P4_API_TOKEN", "OPENAI_API_KEY", "OPENAI_MODEL", "MCP_URL"):
        if not os.getenv(name):
            raise RuntimeError(f"Missing required environment variable: {name}")
    app = mcp.streamable_http_app()

    async def require_token(request, call_next):
        expected = "Bearer " + os.environ["P4_API_TOKEN"]
        supplied = request.headers.get("authorization", "")
        if not hmac.compare_digest(supplied, expected):
            return JSONResponse({"error": "UNAUTHORIZED"}, status_code=401)
        return await call_next(request)

    app.add_middleware(BaseHTTPMiddleware, dispatch=require_token)

    uvicorn.run(
        app, host=os.getenv("P4_HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8080")),
    )


if __name__ == "__main__":
    main()
