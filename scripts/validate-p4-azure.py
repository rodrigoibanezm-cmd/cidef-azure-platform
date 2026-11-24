"""Read existing P4 configuration, run the candidate locally, never change Azure."""
import json
import os
import re
import subprocess
import sys


def az(*args):
    result = subprocess.run(
        ["az", *args, "--only-show-errors", "-o", "json"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise RuntimeError("AZURE_READ_FAILED")
    return json.loads(result.stdout)


def main():
    app = ["--name", "cidef-p4", "--resource-group", "rg-cidef-prod"]
    config = az("containerapp", "show", *app)
    containers = config["properties"]["template"]["containers"]
    candidates = [c for c in containers if any(
        e["name"] == "OPENAI_API_KEY" for e in c.get("env", [])
    )]
    if len(candidates) != 1:
        raise RuntimeError("P4_CONTAINER_NOT_UNIQUE")
    entries = {e["name"]: e for e in candidates[0]["env"]}
    env = os.environ.copy()
    for name in (("MCP_URL",) if env.get("MCP_ONLY") == "true" else ("OPENAI_API_KEY", "OPENAI_MODEL", "MCP_URL")):
        if name == "OPENAI_MODEL" and env.get("MODEL_OVERRIDE"):
            value = env["MODEL_OVERRIDE"]
        else:
            entry = entries.get(name, {})
            if entry.get("secretRef"):
                secret = az("containerapp", "secret", "show", *app,
                            "--secret-name", entry["secretRef"])
                value = secret.get("value")
            else:
                value = entry.get("value")
        if not isinstance(value, str) or not value.strip():
            raise RuntimeError("MISSING_AZURE_" + name)
        if name == "OPENAI_API_KEY" or entries.get(name, {}).get("secretRef"):
            escaped = value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print("::add-mask::" + escaped, flush=True)
        env[name] = value
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", env["PERIOD"]):
        raise RuntimeError("INVALID_PERIOD")
    subprocess.run([sys.executable, "-m", "monthly_close_agent.probe_mcp"], env=env, check=True)
    if env.get("MCP_ONLY") == "true":
        return
    # Do not send credentials to logs, artifacts, or shell command arguments.
    subprocess.run([sys.executable, "-m", "monthly_close_agent.validate_research"],
                   env=env, check=True)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from None
    except Exception as exc:
        raise SystemExit("P4 validation failed: " + type(exc).__name__) from None
